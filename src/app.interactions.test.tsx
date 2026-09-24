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

import { maskText, type MaskResult } from './core/masker'
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
