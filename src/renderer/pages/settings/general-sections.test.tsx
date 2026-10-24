/**
 * @vitest-environment jsdom
 *
 * general-sections.tsx 的域内回归（文件名与源文件同 base，使 npm run verify /
 * .husky/pre-commit 能自动把本文件绑到 general-sections.tsx；此前该源文件无匹配套件）。
 *
 * 钉「批量操作阈值」滑动的提交时机。原实现是裸 `<input type="range">` + 只在 `onMouseUp`
 * 提交，于是**键盘方向键调出来的值永远不会落库**——用户看见数字变了、刷新就回到旧值。
 * 换用设计系统的 SliderControl 后 `onKeyUp` 也走 onCommit，该缺陷顺带修好。
 *
 * 运行：npx vitest run src/renderer/pages/settings/general-sections.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { GeneralFileOpsSection, GeneralStartupSection } from './general-sections'
import { GlobalToastContext } from './shared'

const mockShowMessage = vi.fn()

let settingsGet: ReturnType<typeof vi.fn>
let settingsSet: ReturnType<typeof vi.fn>
let store: Record<string, unknown>

function installElectronApi(persisted: Record<string, unknown> = {}) {
  store = { ...persisted }
  settingsGet = vi.fn((key: string, fallback: unknown) =>
    Promise.resolve(store[key] !== undefined ? store[key] : fallback)
  )
  settingsSet = vi.fn((key: string, value: unknown) => {
    store[key] = value
    return Promise.resolve()
  })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    settings: { get: settingsGet, set: settingsSet }
  }
}

const getSlider = () => screen.getByRole('slider')

beforeEach(() => {
  installElectronApi()
  mockShowMessage.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GeneralFileOpsSection — 批量操作阈值', () => {
  it('(正常) 拖动后 pointerUp 提交当前值', async () => {
    installElectronApi({ 'fileOps.batchThreshold': 10 })
    render(
      <GlobalToastContext.Provider value={mockShowMessage}>
        <GeneralFileOpsSection />
      </GlobalToastContext.Provider>
    )
    await waitFor(() => expect(getSlider()).toBeInTheDocument())

    fireEvent.change(getSlider(), { target: { value: '25' } })
    fireEvent.pointerUp(getSlider())

    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith('fileOps.batchThreshold', 25))
  })

  it('(缺陷回归) 键盘方向键调整后也必须落库——原裸 range 只在 mouseUp 提交，键盘值被静默丢弃', async () => {
    installElectronApi({ 'fileOps.batchThreshold': 10 })
    render(
      <GlobalToastContext.Provider value={mockShowMessage}>
        <GeneralFileOpsSection />
      </GlobalToastContext.Provider>
    )
    await waitFor(() => expect(getSlider()).toBeInTheDocument())

    fireEvent.change(getSlider(), { target: { value: '42' } })
    fireEvent.keyUp(getSlider())

    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith('fileOps.batchThreshold', 42))
  })

  it('(边界) 双击数值不得把阈值重置为最小值 3', async () => {
    // SliderControl 的双击复位优先取 defaultValue，缺省会退到 min=3，
    // 误双击就会静默改掉用户阈值。这里传 defaultValue={当前值}，双击就退化成
    // 「重设同一个值」：既不改状态也不落库。
    // 诚实标注：本用例在换控件前是红的（裸 range 没有任何双击提交路径，waitFor 超时），
    // 但它红的原因是「断言写错了对象」——裸 range 上本就没有双击语义。
    // 因此它的定位是**新代码的边界守卫**（锁住 defaultValue 真的被传了），
    // 真正的红灯是上面 pointerUp / keyUp 两条。
    installElectronApi({ 'fileOps.batchThreshold': 30 })
    render(
      <GlobalToastContext.Provider value={mockShowMessage}>
        <GeneralFileOpsSection />
      </GlobalToastContext.Provider>
    )
    await waitFor(() => expect(getSlider()).toBeInTheDocument())

    fireEvent.doubleClick(getSlider())

    expect(settingsSet).not.toHaveBeenCalledWith('fileOps.batchThreshold', 3)
    // 值必须仍是 30——这条才是 defaultValue 真的传下去的证据
    expect(screen.getByText('30')).toBeInTheDocument()
  })

  it('(边界) 关闭「批量操作阈值」开关后滑动条不再挂载', async () => {
    installElectronApi({ 'fileOps.batchThresholdEnabled': false })
    render(
      <GlobalToastContext.Provider value={mockShowMessage}>
        <GeneralFileOpsSection />
      </GlobalToastContext.Provider>
    )
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: '批量操作阈值' })).toBeInTheDocument()
    )
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
  })
})

describe('GeneralStartupSection — 独显优先开关', () => {
  it('(正常) 读取 auto 偏好 → 关闭态；点击后提交 high-performance', async () => {
    installElectronApi({ 'gpu.discretePreference': 'auto' })
    render(
      <GlobalToastContext.Provider value={mockShowMessage}>
        <GeneralStartupSection />
      </GlobalToastContext.Provider>
    )
    const sw = await screen.findByRole('switch', { name: '优先使用独立显卡' })
    expect(sw).not.toBeChecked()
    fireEvent.click(sw)
    await waitFor(() =>
      expect(settingsSet).toHaveBeenCalledWith('gpu.discretePreference', 'high-performance')
    )
  })

  it('(边界) 无持久化值时默认开启（high-performance，点击切回 auto）', async () => {
    installElectronApi({})
    render(
      <GlobalToastContext.Provider value={mockShowMessage}>
        <GeneralStartupSection />
      </GlobalToastContext.Provider>
    )
    const sw = await screen.findByRole('switch', { name: '优先使用独立显卡' })
    expect(sw).toBeChecked()
    fireEvent.click(sw)
    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith('gpu.discretePreference', 'auto'))
  })
})
