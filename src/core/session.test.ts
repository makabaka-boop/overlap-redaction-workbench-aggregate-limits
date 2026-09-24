import { afterEach, describe, expect, it, vi } from 'vitest'

// 故障注入：遮蔽/计数阶段（maskText）按用例需要抛错，其余符号走真实实现。
// loadSession/applyChange 必须把它归一为 COUNT_FAILED 且保留旧快照。
// 工厂里用真实 maskText 作为 mock 的默认实现；mockClear 只清调用记录、
// 不重置实现，因此各用例默认仍走真实算法。
vi.mock('./masker', async () => {
  const actual = await vi.importActual<typeof import('./masker')>('./masker')
  return {
    ...actual,
    maskText: vi.fn(actual.maskText),
  }
})

import {
  COUNT_FAILED,
  INVALID_INPUT,
  MaskError,
  maskText,
} from './masker'
import {
  adopt,
  addPattern,
  applyChange,
  countByEntry,
  loadSession,
  recompute,
  removePattern,
  rollback,
  setPatternEnabled,
  updatePattern,
} from './session'
import { filterEntries } from './patternList'

const mockedMaskText = vi.mocked(maskText)

function file(text: string, patterns: string[]): string {
  return JSON.stringify({ text, patterns })
}

function load(text = 'alpha alpha beta', patterns = ['alpha', 'beta']) {
  return loadSession(file(text, patterns))
}

afterEach(() => {
  // mockClear 清调用记录但保留工厂给定的真实 maskText 默认实现
  mockedMaskText.mockClear()
})

describe('载入', () => {
  it('合法文件：快照包含工作集、预览与同序计数', () => {
    const { session, snapshot } = load('aaaa', ['a', 'aa'])
    expect(session.initial.map((e) => e.value)).toEqual(['a', 'aa'])
    expect(snapshot.entries.map((e) => e.enabled)).toEqual([true, true])
    expect(snapshot.result.counts[0]).toBe(4)
    expect(snapshot.result.counts[1]).toBe(3)
    expect(snapshot.result.masked).toBe('####')
  })

  it('非法文件：INVALID_INPUT 向上抛，由页面清会话', () => {
    expect(() => loadSession('not json')).toThrow(MaskError)
    try {
      loadSession(JSON.stringify({ text: 'a', patterns: ['a', 'a'] }))
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as MaskError).code).toBe(INVALID_INPUT)
    }
  })

  it('载入期重算抛错 → COUNT_FAILED（非法文件路径不被误归为 COUNT_FAILED）', () => {
    mockedMaskText.mockImplementationOnce(() => {
      throw new Error('boom in build')
    })
    try {
      loadSession(file('abc', ['a']))
      throw new Error('应当抛错')
    } catch (e) {
      expect(e).toBeInstanceOf(MaskError)
      expect((e as MaskError).code).toBe(COUNT_FAILED)
    }
  })
})

describe('原子提交：重算异常保留上一次成功快照', () => {
  it('增改时 maskText 抛错 → COUNT_FAILED，工作集/预览/计数/采纳稿不变', () => {
    const { snapshot } = load('aaaa', ['a', 'aa'])
    const before = snapshot
    const beforeCounts = [...before.result.counts]

    mockedMaskText.mockImplementationOnce(() => {
      throw new Error('count exploded')
    })

    try {
      addPattern(before, 'aaa')
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as MaskError).code).toBe(COUNT_FAILED)
    }
    // 旧快照引用与内容原样保留（调用方据此不替换状态）
    expect(before.entries.map((e) => e.value)).toEqual(['a', 'aa'])
    expect([...before.result.counts]).toEqual(beforeCounts)
    expect(before.result.masked).toBe('####')
  })

  it('故障后下一次正常编辑仍可成功提交（自动恢复）', () => {
    const { snapshot } = load('aaaa', ['a'])
    mockedMaskText.mockImplementationOnce(() => {
      throw new Error('transient')
    })
    expect(() => addPattern(snapshot, 'aa')).toThrow(MaskError)
    // 下一次调用走真实实现：成功
    const next = addPattern(snapshot, 'aaa')
    expect(next.entries.map((e) => e.value)).toEqual(['a', 'aaa'])
    expect(next.result.counts[0]).toBe(4)
    expect(next.result.counts[1]).toBe(2)
  })

  it('INVALID_PATTERN（空串/重复/越界）不计入 COUNT_FAILED 且不触发重算', () => {
    const { snapshot } = load('abc', ['a'])
    // load 本身做过一次成功重算；记录基线，之后三次失败都不应再调用 maskText
    const callsAtLoad = mockedMaskText.mock.calls.length
    expect(() => addPattern(snapshot, 'a')).toThrow(MaskError)
    expect(() => addPattern(snapshot, '')).toThrow(MaskError)
    expect(() => updatePattern(snapshot, 9, 'z')).toThrow(MaskError)
    expect(mockedMaskText.mock.calls.length).toBe(callsAtLoad)
  })

  it('已是 MaskError 的异常原样传播，不被重复包装', () => {
    const { snapshot } = load('abc', ['a'])
    const code = COUNT_FAILED
    mockedMaskText.mockImplementationOnce(() => {
      throw new MaskError(code)
    })
    try {
      recompute('abc', snapshot.entries)
      throw new Error('应当抛错')
    } catch (e) {
      expect(e).toBeInstanceOf(MaskError)
      expect((e as MaskError).code).toBe(COUNT_FAILED)
    }
  })
})

describe('停用再启用：计数随同一原文重算恢复', () => {
  it('停用项不参与遮蔽且计数映射为 null；重新启用后计数与预览恢复', () => {
    const { snapshot } = load('aaaa', ['a', 'aa'])
    // 停用 'a'（下标 0）
    const off = setPatternEnabled(snapshot, 0, false)
    expect(off.entries[0].enabled).toBe(false)
    expect(off.result.counts).toHaveLength(1) // 只剩 'aa' 参与
    expect(off.result.counts[0]).toBe(3)
    expect(off.result.masked).toBe('####') // 'aa' 仍全覆盖

    const mapped = countByEntry(off.entries, off.result)
    expect(mapped[0]).toBeNull() // 停用 → 未统计
    expect(mapped[1]).toBe(3)

    // 重新启用：从同一原文重算，两条计数恢复，且与首次相同
    const on = setPatternEnabled(off, 0, true)
    expect(on.result.counts.length).toBe(2)
    expect(on.result.counts[0]).toBe(4)
    expect(on.result.counts[1]).toBe(3)
    expect(on.result.masked).toBe(snapshot.result.masked)
  })

  it('全部停用时遮蔽为原文、计数数组为空，映射全部 null', () => {
    const { snapshot } = load('abc', ['a'])
    const off = setPatternEnabled(snapshot, 0, false)
    expect(off.result.masked).toBe('abc')
    expect(off.result.counts).toHaveLength(0)
    expect(countByEntry(off.entries, off.result)).toEqual([null])
  })
})

describe('筛选后编辑：原始下标保证计数与条目对应', () => {
  it('筛到窗口外唯一条目后，按原始下标启停/删除/修改仍作用于正确条目', () => {
    const { snapshot } = load('abcdef', ['aa', 'bc', 'cde', 'x'])
    // 模拟页面：先对全集筛选，结果携带原始下标
    const filtered = filterEntries(snapshot.entries, 'cde')
    expect(filtered).toHaveLength(1)
    const originalIndex = filtered[0].index
    expect(originalIndex).toBe(2)

    // 用原始下标停用 'cde'
    const off = setPatternEnabled(snapshot, originalIndex, false)
    const mapped = countByEntry(off.entries, off.result)
    expect(mapped[2]).toBeNull()
    expect(mapped[1]).toBe(1) // 'bc' 仍统计
    // 'cde' 停用后只剩 'bc' 遮蔽位置 1..2：a##def
    expect(off.result.masked).toBe('a##def')
    expect(off.result.coveredCount).toBe(2)

    // 用原始下标删除
    const removed = removePattern(off, originalIndex)
    expect(removed.entries.map((e) => e.value)).toEqual(['aa', 'bc', 'x'])

    // 用原始下标修改另一条（'bc' 下标 1）
    const updated = updatePattern(snapshot, 1, 'BC')
    expect(updated.entries[1].value).toBe('BC')
    expect(updated.result.counts[1]).toBe(0) // 区分大小写：BC 在原文零命中
  })

  it('筛选后新增的条目携带正确全集中下标，计数随之出现', () => {
    const { snapshot } = load('aaaa', ['a'])
    const next = addPattern(snapshot, 'aa')
    // 在筛选视图里找 'aa'：其原始下标应为 1（而非显示序号错位）
    const filtered = filterEntries(next.entries, 'aa')
    const idx = filtered.find((r) => r.entry.value === 'aa')!.index
    expect(idx).toBe(1)
    expect(countByEntry(next.entries, next.result)[idx]).toBe(3)
  })
})

describe('采纳只固化下载稿与快照，后续统计不改变采纳稿', () => {
  it('采纳后再增改/停用/删除，已采纳稿字符串与格式逐字符不变', () => {
    // 选部分覆盖文本，使后续编辑确实改变工作预览，才能区分“预览变了、采纳稿没变”
    const { snapshot } = load('aXaY', ['X'])
    const draft = adopt(snapshot)
    const frozen = draft.masked
    expect(frozen).toBe('a#aY')

    let s = addPattern(snapshot, 'Y')
    s = setPatternEnabled(s, 0, false) // 停用 'X'，只剩 'Y' 遮蔽
    expect(s.result.masked).toBe('aXa#') // 工作预览确实变了
    s = removePattern(s, 1) // 再删掉 'Y' → 无启用短语，预览回到原文
    expect(s.result.masked).toBe('aXaY')
    // 采纳稿仍是当时字符串与长度（格式不变），不受任何后续统计影响
    expect(draft.masked).toBe(frozen)
    expect(draft.masked.length).toBe(4)
    expect(draft.entries.map((e) => e.value)).toEqual(['X']) // 快照停在采纳时
  })

  it('放弃改动回滚到已采纳稿（或载入态）并重算计数', () => {
    const { session, snapshot } = load('aaaa', ['a'])
    let s = addPattern(snapshot, 'aa')
    expect(s.entries).toHaveLength(2)
    // 无采纳稿 → 回滚到文件载入态
    const rolled = rollback(session.text, session.initial)
    expect(rolled.entries.map((e) => e.value)).toEqual(['a'])
    expect(rolled.result.counts[0]).toBe(4)
  })
})

describe('applyChange 泛型变更与计数顺序', () => {
  it('计数永远与启用短语同序（停用造成的压缩不影响映射）', () => {
    const { snapshot } = load('abcabcabc', ['abc', 'bca', 'cab'])
    // 停掉中间 'bca'
    const off = applyChange(snapshot, (es) =>
      es.map((e, i) => (i === 1 ? { ...e, enabled: false } : e)),
    )
    expect([...off.result.counts]).toEqual([3, 2]) // abc, cab
    const mapped = countByEntry(off.entries, off.result)
    expect(mapped).toEqual([3, null, 2])
  })
})
