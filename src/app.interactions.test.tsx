// @vitest-environment jsdom
/**
 * 连续交互的集成验收：真实失焦后点击的手势顺序。
 *
 * 浏览器在一次“点别处”的手势中同步派发：mousedown → focusout/blur →
 * mouseup → click。行内文本框的失焦提交（重算 A）与随后的启停 / 增删 /
 * 采纳（重算 B）因此可能发生在同一次连续操作里。本套件在 jsdom 中按这一
 * 真实顺序派发原生事件，核对：
 *
 * 1. 每次连续操作都以“用户刚确认的最新工作集”为唯一输入，成功动作不被
 *    后续动作静默覆盖；
 * 2. 行值、匹配计数、遮蔽预览、采纳快照、下载文本始终成套一致；
 * 3. 任一失败（注入 maskText 抛错）只拒绝自身，保留最近一次完整成功状态；
 * 4. 现有筛选、窗口化、停用“未统计”显示与下载格式保持兼容。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// 故障注入：App 通过 session 间接调用 maskText，给它包一层可按调用序号
// 抛错的 mock（默认走真实算法）。真实实现同时被捕获到 hoisted holder，供
// 条件失败时兜底，从而精确制造“前一动作重算成功、后一动作重算异常”的
// 交错序列（vi.mock 工厂会被提升，外部普通变量处于 TDZ，故必须用 hoisted）。
const maskHolder = vi.hoisted(() => ({
  realMaskText: null as null | ((text: string, patterns: readonly string[]) => unknown),
}))
vi.mock('./core/masker', async () => {
  const actual = await vi.importActual<typeof import('./core/masker')>('./core/masker')
  maskHolder.realMaskText = actual.maskText as never
  return {
    ...actual,
    maskText: vi.fn(actual.maskText),
  }
})

import { LIMITS, maskText, type MaskResult } from './core/masker'
import App from './App'

const mockedMaskText = vi.mocked(maskText)
const realMaskText = (text: string, patterns: readonly string[]): MaskResult =>
  (maskHolder.realMaskText as (t: string, p: readonly string[]) => MaskResult)(text, patterns)

const mounted: Array<{ root: Root; container: HTMLElement }> = []

afterEach(() => {
  // 每个用例后还原为真实实现并卸载，避免失败注入串到后续用例
  mockedMaskText.mockReset()
  mockedMaskText.mockImplementation(((...args) => realMaskText(...args)) as typeof maskText)
  for (const m of mounted) {
    act(() => m.root.unmount())
    m.container.remove()
  }
  mounted.length = 0
})

// ---------------------------------------------------------------------------
// 渲染与事件工具
// ---------------------------------------------------------------------------

async function renderApp(text: string, patterns: string[]): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => {
    root.render(React.createElement(App))
  })
  const input = container.querySelector<HTMLInputElement>('input[type=file]')!
  Object.defineProperty(input, 'files', {
    value: [new File([JSON.stringify({ text, patterns })], 'in.json', { type: 'application/json' })],
    configurable: true,
  })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await Promise.resolve()
  })
  return container
}

const rows = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('.pattern-row')]
const rowText = (r: HTMLElement) => r.querySelectorAll<HTMLInputElement>('input')[1]
const rowCheck = (r: HTMLElement) => r.querySelectorAll<HTMLInputElement>('input')[0]
const rowCount = (r: HTMLElement) => r.querySelector<HTMLElement>('.count')!
const rowDelete = (r: HTMLElement) =>
  [...r.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '删除')!

/**
 * 用原生 setter 改写受控输入并派发 input（React 受控组件要求）。
 * focus 与键入分属两个 act：浏览器中聚焦（mousedown）与按键本就是跨渲染的
 * 离散事件；同批处理时，onFocus 对草稿的重置可能与紧随的 input 互相覆盖，
 * 尤其是上一次编辑被拒绝、草稿值与工作集值不一致时。
 */
function typeInto(el: HTMLInputElement, value: string) {
  act(() => {
    el.focus()
  })
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** 普通点击（按钮 / 复选框），click 是否真的派发到了已挂载节点。 */
function click(el: Element): boolean {
  let reached = false
  el.addEventListener('click', () => (reached = true), { once: true })
  act(() => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  return reached
}

/**
 * 一次连续操作的真实手势：在 textEl 失焦提交的同时按下别处控件 ——
 * mousedown 先触发失焦（focusout）提交，随后 mouseup/click 触发第二个动作。
 * 两个动作同属一次 act（同一连续操作）。jsdom 的 mousedown 可能已自行移动
 * 焦点（与浏览器一致），因此只在文本框仍是活动元素时补一次 blur()，保证
 * 恰好失焦一次，不产生重复提交。
 */
function blurThenClick(textEl: HTMLElement, target: Element): boolean {
  let reached = false
  target.addEventListener('click', () => (reached = true), { once: true })
  act(() => {
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    if (document.activeElement === textEl) textEl.blur()
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  return reached
}

function setFilter(c: HTMLElement, value: string) {
  typeInto(c.querySelector<HTMLInputElement>('input.filter')!, value)
}

function buttonByText(c: HTMLElement, text: string): HTMLButtonElement {
  return [...c.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent!.includes(text),
  )!
}

const workPreview = (c: HTMLElement) => c.querySelectorAll('pre.text-view')[0]!.textContent!
const adoptedPreview = (c: HTMLElement) =>
  c.querySelectorAll('pre.text-view')[1]?.textContent ?? null
const notice = (c: HTMLElement) => c.querySelector('[role=alert]')?.textContent ?? null

// 预览统计条（“启用 X / Y 条 …”）与列表统计条（“显示 F / Y 条…”）
const workStats = (c: HTMLElement) =>
  [...c.querySelectorAll('p.stats')].find((p) => p.textContent!.includes('启用'))!.textContent!
const listStats = (c: HTMLElement) =>
  [...c.querySelectorAll('p.stats')].find((p) => p.textContent!.includes('显示'))!.textContent!

/** 从“启用 X / Y 条”统计条解析启用数与总条数。 */
function enabledOverTotal(c: HTMLElement): { enabled: number; total: number } {
  const m = workStats(c).match(/启用\s*([\d,]+)\s*\/\s*([\d,]+)\s*条/)!
  return { enabled: Number(m[1].replace(/,/g, '')), total: Number(m[2].replace(/,/g, '')) }
}

/** 从“显示 F / Y 条”统计条解析筛选数与总条数。 */
function shownOverTotal(c: HTMLElement): { shown: number; total: number } {
  const m = listStats(c).match(/显示\s*([\d,]+)\s*\/\s*([\d,]+)\s*条/)!
  return { shown: Number(m[1].replace(/,/g, '')), total: Number(m[2].replace(/,/g, '')) }
}

/** 生成 n 条定长 len、互不重复的短语（n ≤ 10^len 时数字零填充即唯一）。 */
function uniquePatterns(n: number, len: number): string[] {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(String(i).padStart(len, '0'))
  return out
}

/** 末尾新增框输入并点击“添加”；返回是否成功（成功后输入框清空）。 */
function addPatternViaUI(c: HTMLElement, value: string): boolean {
  const addInput = c
    .querySelector<HTMLElement>('.add-row')!
    .querySelector<HTMLInputElement>('input')!
  typeInto(addInput, value)
  click(buttonByText(c, '添加'))
  return addInput.value === ''
}

/** 仅失焦提交某一行（不带随后点击）。 */
function commitRow(c: HTMLElement, index: number, value: string): void {
  typeInto(rowText(rows(c)[index]), value)
  act(() => rowText(rows(c)[index]).blur())
}

/** 截获下载 Blob（沿用全仓约定：jsdom 不实现 createObjectURL）。 */
function stubDownload(): { blobs: Blob[]; restore: () => void; downloaded: () => boolean } {
  const blobs: Blob[] = []
  let didDownload = false
  const create = vi.fn((b: Blob | MediaSource) => {
    blobs.push(b as Blob)
    return 'blob:test'
  })
  const revoke = vi.fn()
  Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true, writable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: revoke, configurable: true, writable: true })
  const anchorClick = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('redacted.txt')
      expect(this.href).toBe('blob:test')
      didDownload = true
    })
  return {
    blobs,
    downloaded: () => didDownload && create.mock.calls.length === 1 && revoke.mock.calls.length === 1,
    restore: () => anchorClick.mockRestore(),
  }
}

/**
 * 成套一致性断言：列表行（值 / 启停 / 计数文案）与工作预览同源于一次
 * 成功快照；零命中为 0，停用为“未统计”。
 */
function expectRowsCoherent(
  c: HTMLElement,
  expected: Array<{ value: string; enabled: boolean; count: number | null }>,
) {
  const rs = rows(c)
  expect(rs.length).toBe(expected.length)
  for (let i = 0; i < expected.length; i++) {
    expect(rowText(rs[i]).value).toBe(expected[i].value)
    expect(rowCheck(rs[i]).checked).toBe(expected[i].enabled)
    expect(rowCount(rs[i]).textContent).toBe(
      expected[i].count === null ? '未统计' : String(expected[i].count),
    )
  }
}

// ---------------------------------------------------------------------------
// 验收用例
// ---------------------------------------------------------------------------

describe('连续交互：失焦提交与随后点击不互相覆盖', () => {
  it('行内改值后立即勾选启停：值与勾选都生效，计数/预览成套重算', async () => {
    const c = await renderApp('aaaa bbbb', ['aa', 'bb'])
    typeInto(rowText(rows(c)[0]), 'aaaa')
    expect(blurThenClick(rowText(rows(c)[0]), rowCheck(rows(c)[0]))).toBe(true)

    // 'aaaa'（停用，未统计）+ 'bb'（启用，'bb' 在 bbbb 中命中 3）
    expectRowsCoherent(c, [
      { value: 'aaaa', enabled: false, count: null },
      { value: 'bb', enabled: true, count: 3 },
    ])
    // 停用项不遮蔽：只有 b 段被盖
    expect(workPreview(c)).toBe('aaaa ####')
    expect(notice(c)).toBeNull()
  })

  it('行内改值后立即添加另一条：两个动作都成功且以编辑后的工作集为输入', async () => {
    const c = await renderApp('aaaa bbbb', ['aa', 'bb'])
    // 先填好新增框，再到行里编辑并失焦到“添加”按钮
    const addInput = c
      .querySelector<HTMLElement>('.add-row')!
      .querySelector<HTMLInputElement>('input')!
    typeInto(addInput, 'xx')
    typeInto(rowText(rows(c)[1]), 'b')
    expect(blurThenClick(rowText(rows(c)[1]), buttonByText(c, '添加'))).toBe(true)

    expectRowsCoherent(c, [
      { value: 'aa', enabled: true, count: 3 },
      { value: 'b', enabled: true, count: 4 },
      { value: 'xx', enabled: true, count: 0 },
    ])
    // 'aa' 盖满 aaaa，'b' 盖满 bbbb；'xx' 零命中
    expect(workPreview(c)).toBe('#### ####')
    expect(notice(c)).toBeNull()
  })

  it('连续手势中先编辑（第 0 行）再删除另一条（第 1 行）：两者都保留，下标不错位', async () => {
    const c = await renderApp('aaaa bbbb', ['aa', 'bb'])
    typeInto(rowText(rows(c)[0]), 'aaaa')
    expect(blurThenClick(rowText(rows(c)[0]), rowDelete(rows(c)[1]))).toBe(true)
    // 编辑只改值（仍启用）；删除作用于原下标 1 的 'bb'
    expectRowsCoherent(c, [{ value: 'aaaa', enabled: true, count: 1 }])
    expect(workPreview(c)).toBe('#### bbbb')
  })

  it('同一行编辑后立即删除该行：手势后半段不丢，编辑不留残，删除生效', async () => {
    const c = await renderApp('aaaa bbbb', ['aa', 'bb'])
    typeInto(rowText(rows(c)[0]), 'aaaa')
    expect(blurThenClick(rowText(rows(c)[0]), rowDelete(rows(c)[0]))).toBe(true)
    expectRowsCoherent(c, [{ value: 'bb', enabled: true, count: 3 }])
    expect(workPreview(c)).toBe('aaaa ####')
  })

  it('编辑后立即“采纳为下载稿”：采纳快照固化编辑后的工作集与预览', async () => {
    const c = await renderApp('aaaa bbbb', ['aa', 'bb'])
    typeInto(rowText(rows(c)[0]), 'aaaa')
    expect(blurThenClick(rowText(rows(c)[0]), buttonByText(c, '采纳为下载稿'))).toBe(true)

    const expected = '#### ####'
    expect(workPreview(c)).toBe(expected)
    expect(adoptedPreview(c)).toBe(expected)
    expectRowsCoherent(c, [
      { value: 'aaaa', enabled: true, count: 1 },
      { value: 'bb', enabled: true, count: 3 },
    ])
  })

  it('采纳后继续编辑不改采纳稿；再次采纳才更新；下载文本即屏幕采纳串', async () => {
    const c = await renderApp('aaaa bbbb', ['aa', 'bb'])
    click(buttonByText(c, '采纳为下载稿'))
    const firstDraft = '#### ####'
    expect(adoptedPreview(c)).toBe(firstDraft)

    // 停用 'aa'：工作预览变化，采纳稿保持第一次的串
    click(rowCheck(rows(c)[0]))
    expect(workPreview(c)).toBe('aaaa ####')
    expect(adoptedPreview(c)).toBe(firstDraft)

    // 下载内容必须是屏幕采纳区的同一字符串（UTF-8 无转换）。
    // jsdom 不实现 createObjectURL，按接口最小打桩并截获 Blob；同时打桩
    // 合成锚点点击（避免 jsdom 导航告警）并核对下载属性。
    const blobs: Blob[] = []
    const create = vi.fn((b: Blob | MediaSource) => {
      blobs.push(b as Blob)
      return 'blob:test'
    })
    const revoke = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true, writable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revoke, configurable: true, writable: true })
    let downloaded = false
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        expect(this.download).toBe('redacted.txt')
        expect(this.href).toBe('blob:test')
        downloaded = true
      })
    click(buttonByText(c, '下载 redacted.txt'))
    anchorClick.mockRestore()
    expect(downloaded).toBe(true)
    expect(create).toHaveBeenCalledTimes(1)
    expect(revoke).toHaveBeenCalledTimes(1)
    expect(blobs).toHaveLength(1)
    expect(await blobs[0].text()).toBe(firstDraft)

    // 再次采纳：下载稿更新到当前工作预览
    click(buttonByText(c, '采纳为下载稿'))
    expect(adoptedPreview(c)).toBe('aaaa ####')
  })

  it('注入重算失败：编辑成功、随后的勾选重算异常时只拒绝勾选，编辑不回滚', async () => {
    const c = await renderApp('aaaa bbbb', ['aa', 'bb'])
    // 连续手势内依次发生两次重算：第 1 次（失焦编辑）成功，第 2 次（勾选）抛错
    let calls = 0
    mockedMaskText.mockImplementation(((text: string, pats: readonly string[]) => {
      calls += 1
      if (calls === 2) throw new Error('boom on toggle recompute')
      return realMaskText(text, pats)
    }) as typeof maskText)

    typeInto(rowText(rows(c)[0]), 'aaaa')
    expect(blurThenClick(rowText(rows(c)[0]), rowCheck(rows(c)[0]))).toBe(true)

    // 权威状态停在“编辑成功”这一完整快照；勾选被自身失败拒绝。
    // 合成 click 会把复选框视觉状态拨到“未勾选”，但 React 重渲染会按
    // 权威工作集（仍启用）拨回；输入框提交成功后也显示新值。
    expectRowsCoherent(c, [
      { value: 'aaaa', enabled: true, count: 1 },
      { value: 'bb', enabled: true, count: 3 },
    ])
    expect(workPreview(c)).toBe('#### ####')
    expect(notice(c)).toBe('COUNT_FAILED')
    expect(calls).toBe(2)
  })

  it('失败后下一次正常启停成功：错误清除，自动恢复到完整一致状态', async () => {
    const c = await renderApp('aaaa bbbb', ['aa', 'bb'])
    mockedMaskText.mockImplementationOnce(() => {
      throw new Error('transient')
    })
    click(rowCheck(rows(c)[0]))
    expect(notice(c)).toBe('COUNT_FAILED')
    expectRowsCoherent(c, [
      { value: 'aa', enabled: true, count: 3 },
      { value: 'bb', enabled: true, count: 3 },
    ])

    // 单次注入已耗尽；下一次点击走真实实现，停用成功
    click(rowCheck(rows(c)[0]))
    expect(notice(c)).toBeNull()
    expectRowsCoherent(c, [
      { value: 'aa', enabled: false, count: null },
      { value: 'bb', enabled: true, count: 3 },
    ])
    expect(workPreview(c)).toBe('aaaa ####')
  })

  it('编辑为非法值（重复）后立即勾选：编辑被拒绝，勾选照常生效', async () => {
    const c = await renderApp('aaaa bbbb', ['aa', 'bb'])
    typeInto(rowText(rows(c)[0]), 'bb') // 与第 1 行重复
    expect(blurThenClick(rowText(rows(c)[0]), rowCheck(rows(c)[0]))).toBe(true)

    // 编辑被拒绝：工作集条目仍是 'aa'，但输入框按约定保留草稿值便于继续修改；
    // 同一手势中的停用成功（失败的编辑不回滚它），计数映射为“未统计”。
    const rs = rows(c)
    expect(rowText(rs[0]).value).toBe('bb') // 输入框保留当前输入（非法值未固化）
    expect(rowCheck(rs[0]).checked).toBe(false)
    expect(rowCount(rs[0]).textContent).toBe('未统计')
    // 第 1 行工作集不受影响
    expect(rowText(rs[1]).value).toBe('bb')
    expect(rowCheck(rs[1]).checked).toBe(true)
    expect(rowCount(rs[1]).textContent).toBe('3')
    // 工作预览只反映停用：aa 不遮蔽，只剩 bb
    expect(workPreview(c)).toBe('aaaa ####')
    // 连续手势里后一个勾选成功；成功动作按约定清除之前的错误提示，
    // 非法拒绝由“输入框保留草稿 + 工作集未变”可见。

    // 单独失焦一个非法值时，错误提示会持续显示（没有后续成功动作覆盖）
    typeInto(rowText(rs[0]), 'bb')
    act(() => rowText(rs[0]).blur())
    expect(notice(c)).toBe('INVALID_PATTERN')
    expect(rowText(rows(c)[0]).value).toBe('bb')

    // 把草稿改成合法值（与第 1 行不同）后提交成功：输入框与工作集重新一致，
    // 错误清除，且仍是停用状态（启停不被编辑覆盖）
    typeInto(rowText(rows(c)[0]), 'aaa')
    act(() => rowText(rows(c)[0]).blur())
    expectRowsCoherent(c, [
      { value: 'aaa', enabled: false, count: null },
      { value: 'bb', enabled: true, count: 3 },
    ])
    expect(notice(c)).toBeNull()
  })

  it('筛选兼容：筛到窗口外唯一条目后行内编辑并启停，仍作用于正确原始下标', async () => {
    const c = await renderApp('abcdef cdef', ['aa', 'bc', 'cdef', 'x'])
    setFilter(c, 'cdef')
    expect(rows(c)).toHaveLength(1)
    const only = rows(c)[0]
    typeInto(rowText(only), 'cde')
    expect(blurThenClick(rowText(only), rowCheck(only))).toBe(true)

    setFilter(c, '')
    expectRowsCoherent(c, [
      { value: 'aa', enabled: true, count: 0 },
      { value: 'bc', enabled: true, count: 1 },
      { value: 'cde', enabled: false, count: null },
      { value: 'x', enabled: true, count: 0 },
    ])
    // 只有启用的 'bc' 遮蔽位置 1..2；停用的 'cde' 不遮蔽
    expect(workPreview(c)).toBe('a##def cdef')
  })

  it('失焦后的添加重算失败：编辑保留、添加被拒，随后单独添加可成功', async () => {
    const c = await renderApp('aaaa bbbb', ['aa', 'bb'])
    const addInput = c
      .querySelector<HTMLElement>('.add-row')!
      .querySelector<HTMLInputElement>('input')!
    typeInto(addInput, 'zz')
    typeInto(rowText(rows(c)[0]), 'aaaa')

    // 连续手势内：第 1 次重算（失焦编辑）成功，第 2 次（添加）失败
    let calls = 0
    mockedMaskText.mockImplementation(((text: string, pats: readonly string[]) => {
      calls += 1
      if (calls === 2) throw new Error('boom on add')
      return realMaskText(text, pats)
    }) as typeof maskText)
    expect(blurThenClick(rowText(rows(c)[0]), buttonByText(c, '添加'))).toBe(true)

    expectRowsCoherent(c, [
      { value: 'aaaa', enabled: true, count: 1 },
      { value: 'bb', enabled: true, count: 3 },
    ])
    expect(workPreview(c)).toBe('#### ####')
    expect(notice(c)).toBe('COUNT_FAILED')
    expect(calls).toBe(2)

    // 添加框保留 'zz'；恢复真实实现后单独点击添加成功
    mockedMaskText.mockReset()
    mockedMaskText.mockImplementation(((...args) => realMaskText(...args)) as typeof maskText)
    click(buttonByText(c, '添加'))
    expectRowsCoherent(c, [
      { value: 'aaaa', enabled: true, count: 1 },
      { value: 'bb', enabled: true, count: 3 },
      { value: 'zz', enabled: true, count: 0 },
    ])
    expect(notice(c)).toBeNull()
    expect(addInput.value).toBe('') // 成功后输入框清空
  })

  it('失焦编辑重算失败后同手势采纳：不得固化编辑前的工作集，旧采纳稿不变', async () => {
    const c = await renderApp('aaaa bbbb', ['aa', 'bb'])
    // 先有一份旧采纳稿
    click(buttonByText(c, '采纳为下载稿'))
    const oldDraft = adoptedPreview(c)
    expect(oldDraft).toBe('#### ####')

    // 失焦编辑（'aa'→'aaaa'）这一次重算即失败；同手势随后点击采纳
    mockedMaskText.mockImplementationOnce(() => {
      throw new Error('boom on edit recompute')
    })
    typeInto(rowText(rows(c)[0]), 'aaaa')
    expect(blurThenClick(rowText(rows(c)[0]), buttonByText(c, '采纳为下载稿'))).toBe(true)

    // 编辑被自身失败拒绝：工作集仍是旧值；输入框按约定保留草稿 'aaaa' 便于
    // 重试，但计数/预览来自上一次成功快照（'aa' 命中 3 次）。采纳不得固化
    // 任何编辑前/编辑后的“半提交”工作集——已采纳稿保持上一份。
    const rs0 = rows(c)[0]
    expect(rowText(rs0).value).toBe('aaaa') // 草稿保留（未固化）
    expect(rowCheck(rs0).checked).toBe(true)
    expect(rowCount(rs0).textContent).toBe('3') // 上次成功计数
    expect(rowText(rows(c)[1]).value).toBe('bb')
    expect(workPreview(c)).toBe(oldDraft)
    expect(adoptedPreview(c)).toBe(oldDraft)
    // 采纳本身不重算、总是成功，因此清除前一个动作的错误提示；拒绝只体现在
    // “工作集/计数/预览/采纳稿均未变、草稿保留”上。
    expect(notice(c)).toBeNull()

    // 恢复后再次编辑 + 采纳（真实手势顺序），新采纳稿与可见列表/预览成套
    mockedMaskText.mockReset()
    mockedMaskText.mockImplementation(((...args) => realMaskText(...args)) as typeof maskText)
    typeInto(rowText(rows(c)[0]), 'aaaa')
    expect(blurThenClick(rowText(rows(c)[0]), buttonByText(c, '采纳为下载稿'))).toBe(true)
    expect(workPreview(c)).toBe('#### ####')
    expect(adoptedPreview(c)).toBe('#### ####')
    expectRowsCoherent(c, [
      { value: 'aaaa', enabled: true, count: 1 },
      { value: 'bb', enabled: true, count: 3 },
    ])
    expect(notice(c)).toBeNull()
  })

  it('停用成功后同手势删除重算失败：停用保留，删除被自身失败拒绝', async () => {
    const c = await renderApp('aaaa bbbb', ['aa', 'bb'])
    // 第 1 次重算（停用第 0 行）成功，第 2 次（删除第 1 行）失败
    let calls = 0
    mockedMaskText.mockImplementation(((text: string, pats: readonly string[]) => {
      calls += 1
      if (calls === 2) throw new Error('boom on remove')
      return realMaskText(text, pats)
    }) as typeof maskText)
    // 手势：点第 0 行复选框（mousedown 无失焦编辑）——为制造“连续两次重算”，
    // 先停用第 0 行，再在同一 act 内删除第 1 行
    act(() => {
      const checks = [rowCheck(rows(c)[0]), rowDelete(rows(c)[1])]
      checks[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
      checks[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(calls).toBe(2)
    // 停用成功（第 0 行未统计）；删除被拒绝，第 1 行仍在
    expectRowsCoherent(c, [
      { value: 'aa', enabled: false, count: null },
      { value: 'bb', enabled: true, count: 3 },
    ])
    expect(workPreview(c)).toBe('aaaa ####')
    expect(notice(c)).toBe('COUNT_FAILED')
  })
})

// ---------------------------------------------------------------------------
// 聚合约束（条目数 1..50,000、总长 ≤ 300,000）的页面级验收：导入与编辑
// 共用同一组契约。越界增改 / 删除唯一条目只拒绝当前动作（INVALID_PATTERN，
// 且发生在重算之前），列表、计数、预览、采纳稿四类快照成套保留；恰好边界、
// 启停、筛选 / 窗口化与合法下载保持兼容。
// ---------------------------------------------------------------------------

describe('聚合约束：越界动作只拒绝自身，四类快照成套一致', () => {
  it('数量上界：增至恰好 50,000 成功，第 50,001 条被拒；启停/筛选/窗口化兼容', async () => {
    const c = await renderApp('zzz', uniquePatterns(LIMITS.maxPatterns - 1, 6))
    expect(shownOverTotal(c)).toEqual({ shown: 49_999, total: 49_999 })
    expect(enabledOverTotal(c)).toEqual({ enabled: 49_999, total: 49_999 })

    // 增长到恰好 50,000：成功，输入框清空，统计更新
    expect(addPatternViaUI(c, String(49_999).padStart(6, '0'))).toBe(true)
    expect(shownOverTotal(c)).toEqual({ shown: 50_000, total: 50_000 })
    expect(enabledOverTotal(c)).toEqual({ enabled: 50_000, total: 50_000})
    expect(notice(c)).toBeNull()

    // 第 50,001 条：拒绝，输入框保留，列表 / 计数 / 预览全停在上一成功快照
    expect(addPatternViaUI(c, '999999')).toBe(false)
    expect(notice(c)).toBe('INVALID_PATTERN')
    expect(shownOverTotal(c)).toEqual({ shown: 50_000, total: 50_000 })
    expect(enabledOverTotal(c)).toEqual({ enabled: 50_000, total: 50_000 })
    expect(workPreview(c)).toBe('zzz') // 数字短语对 'zzz' 零命中，预览为原文

    // 边界处启停兼容：停用第一行 → 49,999/50,000，该行“未统计”，预览不变
    click(rowCheck(rows(c)[0]))
    expect(notice(c)).toBeNull()
    expect(enabledOverTotal(c)).toEqual({ enabled: 49_999, total: 50_000 })
    expect(rowCount(rows(c)[0]).textContent).toBe('未统计')

    // 筛选 / 窗口化在满规模下仍按原始下标工作
    setFilter(c, '049999')
    expect(rows(c)).toHaveLength(1)
    click(rowCheck(rows(c)[0])) // 停用最后一条（原始下标 49,999）
    expect(enabledOverTotal(c)).toEqual({ enabled: 49_998, total: 50_000 })
    expect(rowCount(rows(c)[0]).textContent).toBe('未统计')
    setFilter(c, '')
    expect(shownOverTotal(c)).toEqual({ shown: 50_000, total: 50_000 })

    // 边界处删除一条后可以重新补回 50,000（补唯一 6 长新值）
    click(rowDelete(rows(c)[0]))
    expect(enabledOverTotal(c)).toEqual({ enabled: 49_998, total: 49_999 })
    expect(addPatternViaUI(c, '999999')).toBe(true)
    expect(enabledOverTotal(c)).toEqual({ enabled: 49_999, total: 50_000 })
    expect(notice(c)).toBeNull()
  })

  it('最小数量：只剩一条时删除被 INVALID_PATTERN 拒绝，列表/计数/预览/采纳稿不变', async () => {
    const c = await renderApp('abc abc', ['abc', 'xx'])
    click(rowDelete(rows(c)[1])) // 删 'xx' → 工作集只剩 'abc'
    expectRowsCoherent(c, [{ value: 'abc', enabled: true, count: 2 }])
    expect(workPreview(c)).toBe('### ###')

    // 先采纳这一“仅一条”的合法工作集
    click(buttonByText(c, '采纳为下载稿'))
    expect(adoptedPreview(c)).toBe('### ###')

    // 删除唯一条目：拒绝；行仍在、计数与预览不变、错误提示显示
    click(rowDelete(rows(c)[0]))
    expect(notice(c)).toBe('INVALID_PATTERN')
    expectRowsCoherent(c, [{ value: 'abc', enabled: true, count: 2 }])
    expect(workPreview(c)).toBe('### ###')
    expect(adoptedPreview(c)).toBe('### ###')

    // 启停仍兼容；被拒删除不影响随后的成功动作（成功清除错误提示）
    click(rowCheck(rows(c)[0]))
    expect(notice(c)).toBeNull()
    expectRowsCoherent(c, [{ value: 'abc', enabled: false, count: null }])
    expect(workPreview(c)).toBe('abc abc')
  })

  it('总长上界：改长/新增超 300,000 被拒；缩短后可再增长到恰好边界，采纳/下载成套', async () => {
    const c = await renderApp('z', uniquePatterns(3000, 100))
    expect(enabledOverTotal(c)).toEqual({ enabled: 3000, total: 3000 })

    // 把首条改成 101 长（值本身合法、唯一）：总长 300,001 → 拒绝，行值保留
    commitRow(c, 0, 'z'.repeat(101))
    expect(notice(c)).toBe('INVALID_PATTERN')
    expect(rowText(rows(c)[0]).value).toBe('z'.repeat(101)) // 草稿保留便于继续修改
    // 工作集未变：复选框仍勾选、计数来自上次成功快照（0 命中）、统计不变
    expect(rowCheck(rows(c)[0]).checked).toBe(true)
    expect(rowCount(rows(c)[0]).textContent).toBe('0')
    expect(enabledOverTotal(c)).toEqual({ enabled: 3000, total: 3000 })
    expect(workPreview(c)).toBe('z')

    // 边界处新增也被拒（新增框保留输入）
    expect(addPatternViaUI(c, 'w')).toBe(false)
    expect(notice(c)).toBe('INVALID_PATTERN')

    // 等长改写（100→100 唯一值）：总长不变，成功，错误清除
    commitRow(c, 0, 'y'.repeat(100))
    expect(notice(c)).toBeNull()
    expect(rowText(rows(c)[0]).value).toBe('y'.repeat(100))

    // 缩短到 99 → 299,999；再补 1 长恰好回到 300,000；继续新增才被拒
    commitRow(c, 0, 'y'.repeat(99))
    expect(addPatternViaUI(c, 'z')).toBe(true)
    expect(notice(c)).toBeNull()
    expect(enabledOverTotal(c)).toEqual({ enabled: 3001, total: 3001 })
    expect(addPatternViaUI(c, 'q')).toBe(false)
    expect(notice(c)).toBe('INVALID_PATTERN')
    expect(enabledOverTotal(c)).toEqual({ enabled: 3001, total: 3001 })

    // 边界处启停兼容
    click(rowCheck(rows(c)[0]))
    expect(enabledOverTotal(c)).toEqual({ enabled: 3000, total: 3001 })
    click(rowCheck(rows(c)[0]))

    // 采纳 + 下载：固化的正是当前可见工作预览（合法、可再载入的边界工作集）
    click(buttonByText(c, '采纳为下载稿'))
    const expected = workPreview(c)
    expect(adoptedPreview(c)).toBe(expected)
    const dl = stubDownload()
    click(buttonByText(c, '下载 redacted.txt'))
    dl.restore()
    expect(dl.downloaded()).toBe(true)
    expect(await dl.blobs[0].text()).toBe(expected)
  })

  it('边界处重算故障：成功增长保留、故障动作拒绝；恢复后采纳/下载仍为合法边界工作集', async () => {
    const c = await renderApp('zz', uniquePatterns(49_999, 6))
    // 先制造一次成功采纳（49,999 条的合法稿）
    click(buttonByText(c, '采纳为下载稿'))
    const oldDraft = adoptedPreview(c)

    // 增长到 50,000 的这次重算抛错：新增被 COUNT_FAILED 拒绝
    mockedMaskText.mockImplementationOnce(() => {
      throw new Error('boom at boundary')
    })
    expect(addPatternViaUI(c, String(49_999).padStart(6, '0'))).toBe(false)
    expect(notice(c)).toBe('COUNT_FAILED')
    // 四类快照停在上一成功状态：49,999 条、预览为旧稿、输入框保留候选值
    expect(enabledOverTotal(c)).toEqual({ enabled: 49_999, total: 49_999 })
    expect(workPreview(c)).toBe(oldDraft)
    expect(adoptedPreview(c)).toBe(oldDraft)
    const addInput = c
      .querySelector<HTMLElement>('.add-row')!
      .querySelector<HTMLInputElement>('input')!
    expect(addInput.value).toBe(String(49_999).padStart(6, '0'))

    // 恢复：同一新增成功到恰好 50,000；采纳更新，下载文本成套
    expect(addPatternViaUI(c, String(49_999).padStart(6, '0'))).toBe(true)
    expect(notice(c)).toBeNull()
    expect(enabledOverTotal(c)).toEqual({ enabled: 50_000, total: 50_000 })
    click(buttonByText(c, '采纳为下载稿'))
    expect(adoptedPreview(c)).toBe(workPreview(c))
    const dl = stubDownload()
    click(buttonByText(c, '下载 redacted.txt'))
    dl.restore()
    expect(dl.downloaded()).toBe(true)
    expect(await dl.blobs[0].text()).toBe(workPreview(c))
  })
})
