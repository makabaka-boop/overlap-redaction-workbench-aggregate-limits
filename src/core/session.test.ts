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
  INVALID_PATTERN,
  LIMITS,
  MaskError,
  maskText,
  type PatternEntry,
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
  type Snapshot,
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

// ---------------------------------------------------------------------------
// 聚合约束：导入与所有编辑成功后的工作集遵守同一组契约（1..50000 条、
// 总长 ≤ 300000）；越界动作在重算前被 INVALID_PATTERN 拒绝，最近一次
// 成功的列表 / 计数 / 预览 / 采纳稿完整保留，且任何成功快照都可再次载入。
// ---------------------------------------------------------------------------

/** 生成 n 条定长 len、互不重复的短语（调用方保证 n ≤ 10^len）。 */
function uniquePatterns(n: number, len: number): string[] {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(String(i).padStart(len, '0'))
  return out
}

function expectCode(code: string, fn: () => unknown): void {
  try {
    fn()
    throw new Error('应当抛错')
  } catch (e) {
    expect(e).toBeInstanceOf(MaskError)
    expect((e as MaskError).code).toBe(code)
  }
}

function totalOf(entries: readonly PatternEntry[]): number {
  return entries.reduce((sum, e) => sum + e.value.length, 0)
}

/**
 * 成功快照必须可按原输入契约**再次载入**：采纳 / 下载固化的工作集也不
 * 例外。重新载入后的短语序列与快照一一对应（值与启停态）。
 */
function expectReloadable(snapshot: Snapshot): void {
  const json = JSON.stringify({
    text: snapshot.text,
    patterns: snapshot.entries.map((e) => e.value),
  })
  const reparsed = loadSession(json)
  expect(reparsed.snapshot.entries.map((e) => e.value)).toEqual(
    snapshot.entries.map((e) => e.value),
  )
  expect(reparsed.snapshot.entries.every((e) => e.enabled)).toBe(true)
  expect(snapshot.entries.length).toBeGreaterThanOrEqual(LIMITS.minPatterns)
  expect(snapshot.entries.length).toBeLessThanOrEqual(LIMITS.maxPatterns)
  expect(totalOf(snapshot.entries)).toBeLessThanOrEqual(LIMITS.maxTotalPatternLength)
}

describe('聚合约束边界：导入与编辑同一契约，越界只拒绝当前动作', () => {
  it('数量上界：49,999→50,000 成功；50,000 时再增拒绝且不重算、快照原样', () => {
    const loaded = loadSession(file('zero zero', uniquePatterns(LIMITS.maxPatterns - 1, 6)))
    const s49999 = loaded.snapshot
    expect(totalOf(s49999.entries)).toBe(299_994)

    const atLimit = addPattern(s49999, String(49_999).padStart(6, '0'))
    expect(atLimit.entries).toHaveLength(50_000)
    expect(totalOf(atLimit.entries)).toBe(300_000)

    const callsBefore = mockedMaskText.mock.calls.length
    expectCode(INVALID_PATTERN, () => addPattern(atLimit, '999999'))
    // 聚合违规发生在重算之前：未再调用 maskText
    expect(mockedMaskText.mock.calls.length).toBe(callsBefore)
    // 旧快照的列表 / 计数 / 预览全部原样
    expect(atLimit.entries).toHaveLength(50_000)
    expect(atLimit.result.counts.length).toBe(50_000)

    // 恰好边界：启停、筛选、窗口化取数均兼容
    const off = setPatternEnabled(atLimit, 0, false)
    expect(countByEntry(off.entries, off.result)[0]).toBeNull()
    expect(filterEntries(off.entries, '049999')[0].index).toBe(49_999)
    expectReloadable(off)
  })

  it('最小数量：两条删一条成功；删除唯一条目被 INVALID_PATTERN 拒绝', () => {
    const { snapshot } = load('abc def', ['abc', 'def'])
    const one = removePattern(snapshot, 0)
    expect(one.entries.map((e) => e.value)).toEqual(['def'])
    expect(one.result.masked).toBe('abc ###')

    const callsBefore = mockedMaskText.mock.calls.length
    expectCode(INVALID_PATTERN, () => removePattern(one, 0))
    expect(mockedMaskText.mock.calls.length).toBe(callsBefore) // 不触发重算
    // 被拒后工作集仍非空、预览仍是“一条短语”的那次成功重算
    expect(one.entries).toHaveLength(1)
    expect(one.result.masked).toBe('abc ###')
    expectReloadable(one)
  })

  it('总长上界：改长 / 新增使总长超过 300,000 被拒；缩短后再增长到恰好边界成功', () => {
    const { snapshot } = loadSession(file('z', uniquePatterns(3000, 100)))
    expect(totalOf(snapshot.entries)).toBe(300_000)

    // 改长 1（值本身合法、唯一）→ 300,001：拒绝；新增任何值也拒绝
    expectCode(INVALID_PATTERN, () => updatePattern(snapshot, 0, 'z'.repeat(101)))
    expectCode(INVALID_PATTERN, () => addPattern(snapshot, 'w'))

    const calls = mockedMaskText.mock.calls.length
    // 等长改写：总长不变，成功
    const same = updatePattern(snapshot, 0, 'y'.repeat(100))
    expect(totalOf(same.entries)).toBe(300_000)
    // 缩短 1 → 299,999；再补 1 长恰好回到 300,000
    const shorter = updatePattern(snapshot, 0, 'y'.repeat(99))
    expect(totalOf(shorter.entries)).toBe(299_999)
    const refilled = addPattern(shorter, 'z')
    expect(totalOf(refilled.entries)).toBe(300_000)
    // 回到边界后继续新增被拒；期间只有三次成功动作触发了重算
    expectCode(INVALID_PATTERN, () => addPattern(refilled, 'q'))
    expect(mockedMaskText.mock.calls.length - calls).toBe(3)

    // 被拒路径不修改旧快照；所有成功快照可再载入
    expect(snapshot.entries[0].value).toBe(String(0).padStart(100, '0'))
    expectReloadable(refilled)
  })

  it('连续增删改混合：失败动作从不提交，列表/计数/预览/采纳稿始终成套', () => {
    let s = loadSession(file('abc abc', uniquePatterns(2999, 100))).snapshot
    expect(totalOf(s.entries)).toBe(299_900)
    // 加一条 100 长 → 恰好 300,000，并采纳边界工作集
    s = addPattern(s, 'z'.repeat(100))
    expect(totalOf(s.entries)).toBe(300_000)
    const draft = adopt(s)
    expect(draft.entries).toHaveLength(3000)
    expect(draft.masked).toBe(s.result.masked)

    // 越过边界的修改被拒；旧采纳稿不变
    expectCode(INVALID_PATTERN, () => updatePattern(s, 0, 'z'.repeat(101)))
    expect(adopt(s).entries).toHaveLength(3000)

    // 缩短一条（-50）后新增 50 长，仍恰好 300,000（条数 3001，合法）
    s = updatePattern(s, 0, 'a'.repeat(50))
    s = addPattern(s, 'b'.repeat(50))
    expect(totalOf(s.entries)).toBe(300_000)
    expectCode(INVALID_PATTERN, () => addPattern(s, 'c'))

    // 删除末条回到边界以下；计数与启用条目同序，快照可再载入
    s = removePattern(s, s.entries.length - 1)
    expect(s.entries).toHaveLength(3000)
    expect(s.result.counts.length).toBe(s.entries.filter((e) => e.enabled).length)
    expectReloadable(s)
    // 首次采纳稿不受任何后续编辑影响
    expect(draft.entries).toHaveLength(3000)
    expect(draft.entries[0].value).toBe(String(0).padStart(100, '0'))
  })
})

describe('聚合边界 × 重算故障：COUNT_FAILED 时四类快照成套保留', () => {
  it('边界新增重算异常 → COUNT_FAILED，列表/计数/预览/采纳稿停在上一成功状态', () => {
    const { snapshot } = loadSession(file('zero zero', uniquePatterns(49_999, 6)))
    const draft = adopt(snapshot)

    mockedMaskText.mockImplementationOnce(() => {
      throw new Error('boom at boundary build')
    })
    expectCode(COUNT_FAILED, () => addPattern(snapshot, String(49_999).padStart(6, '0')))

    // 工作集停在 49,999 条；计数/预览仍是上一次成功重算；采纳稿不变
    expect(snapshot.entries).toHaveLength(49_999)
    expect(snapshot.result.counts.length).toBe(49_999)
    expect(draft.entries).toHaveLength(49_999)
    expectReloadable(snapshot)

    // 自动恢复：下一次同动作成功，增长到恰好 50,000 条
    const atLimit = addPattern(snapshot, String(49_999).padStart(6, '0'))
    expect(atLimit.entries).toHaveLength(50_000)
    expectReloadable(atLimit)
  })

  it('边界处采纳交错：重算失败时采纳仍固化最近成功快照；恢复后采纳才更新', () => {
    const { snapshot } = loadSession(file('z', uniquePatterns(3000, 100)))
    adopt(snapshot)

    // 等长改写本身合法（总长不变），但重算异常 → 拒绝当前动作
    mockedMaskText.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    expectCode(COUNT_FAILED, () => updatePattern(snapshot, 0, 'y'.repeat(100)))

    // 采纳不重算：固化的仍是最近一次成功快照（旧值），不对应任何越界候选
    const draftAfterFail = adopt(snapshot)
    expect(draftAfterFail.entries[0].value).toBe(String(0).padStart(100, '0'))
    expect(draftAfterFail.masked).toBe(snapshot.result.masked)

    // 恢复：缩短改写成功后再采纳，新稿与可见列表 / 计数 / 预览成套
    const next = updatePattern(snapshot, 0, 'y'.repeat(99))
    const draftNext = adopt(next)
    expect(draftNext.entries[0].value).toBe('y'.repeat(99))
    expect(draftNext.masked).toBe(next.result.masked)
    expectReloadable(next)

    // 以当前工作集为基线回滚重算：总长 299,999，满足契约且重算成功
    const rolled = rollback(next.text, next.entries)
    expect(totalOf(rolled.entries)).toBe(299_999)
    expectReloadable(rolled)
  })
})
