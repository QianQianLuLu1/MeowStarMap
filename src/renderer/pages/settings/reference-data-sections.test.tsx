/**
 * @vitest-environment jsdom
 *
 * reference-data-sections.tsx 的域内回归（文件名与源文件同 base，使 npm run verify /
 * .husky/pre-commit 能自动把本文件绑到源文件）。
 *
 * 钉三件事：
 * ① 两个镜像键各自独立读写、互不串用（manifest 站点 ≠ 图片加速入口，语义不同）；
 * ② 保存失败时输入框回滚到**已持久化值**，而不是留在用户刚输错的串上——
 *    否则界面显示一个从未生效的地址，属静默失败；
 * ③ 空串是合法值（= 未配置，走官方/原始地址），不能被当成"没填"而跳过提交。
 *
 * 运行：npx vitest run src/renderer/pages/settings/reference-data-sections.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ReferenceDataMirrorSection } from './reference-data-sections'
import { GlobalToastContext } from './shared'

const IMAGE_KEY = 'referenceData.imageMirrorBaseUrl'
const MANIFEST_KEY = 'referenceData.manifestBaseUrl'
const AUTO_UPDATE_KEY = 'referenceData.autoUpdate'

const mockShowMessage = vi.fn()

let settingsGet: ReturnType<typeof vi.fn>
let settingsSet: ReturnType<typeof vi.fn>
let refreshMock: ReturnType<typeof vi.fn>
let store: Record<string, unknown>

function installElectronApi(persisted: Record<string, unknown> = {}) {
  store = { ...persisted }
  settingsGet = vi.fn((key: string, fallback: unknown) =>
    Promise.resolve(store[key] !== undefined ? store[key] : fallback)
  )
  settingsSet = vi.fn((key: string, value: unknown) => {
    store[key] = value
    return Promise.resolve({ saved: true })
  })
  refreshMock = vi.fn(() =>
    Promise.resolve({
      available: true,
      packages: [],
      lastCheckedAt: null,
      lastError: null,
      updating: false
    })
  )
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    settings: { get: settingsGet, set: settingsSet },
    referenceData: { refresh: refreshMock }
  }
}

function renderSection() {
  return render(
    <GlobalToastContext.Provider value={mockShowMessage}>
      <ReferenceDataMirrorSection />
    </GlobalToastContext.Provider>
  )
}

const imageInput = () => screen.getByLabelText('图片加速入口')
const manifestInput = () => screen.getByLabelText('参考数据镜像站点')
const imageSaveButton = () => screen.getByRole('button', { name: '保存 图片加速入口' })
const manifestSaveButton = () => screen.getByRole('button', { name: '保存 参考数据镜像站点' })

beforeEach(() => {
  installElectronApi()
  mockShowMessage.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ReferenceDataMirrorSection — 正常', () => {
  it('挂载后读出两个已存值并回填各自输入框', async () => {
    installElectronApi({
      [IMAGE_KEY]: 'https://image-mirror.example.test',
      [MANIFEST_KEY]: 'https://manifest-mirror.example.test'
    })
    renderSection()

    await waitFor(() => expect(imageInput()).toHaveValue('https://image-mirror.example.test'))
    expect(manifestInput()).toHaveValue('https://manifest-mirror.example.test')
    expect(settingsGet).toHaveBeenCalledWith(IMAGE_KEY, '')
    expect(settingsGet).toHaveBeenCalledWith(MANIFEST_KEY, '')
  })

  it('保存图片加速入口 → 只写图片键', async () => {
    renderSection()
    await waitFor(() => expect(imageInput()).toBeInTheDocument())

    fireEvent.change(imageInput(), { target: { value: 'https://cdn-mirror.example.test' } })
    fireEvent.click(imageSaveButton())

    await waitFor(() =>
      expect(settingsSet).toHaveBeenCalledWith(IMAGE_KEY, 'https://cdn-mirror.example.test')
    )
    expect(settingsSet).toHaveBeenCalledTimes(1)
    expect(mockShowMessage).toHaveBeenCalledWith('已保存')
  })

  it('保存参考数据镜像站点 → 只写 manifest 键（两键互不串用）', async () => {
    renderSection()
    await waitFor(() => expect(manifestInput()).toBeInTheDocument())

    fireEvent.change(manifestInput(), { target: { value: 'https://manifest.example.test' } })
    fireEvent.click(manifestSaveButton())

    await waitFor(() =>
      expect(settingsSet).toHaveBeenCalledWith(MANIFEST_KEY, 'https://manifest.example.test')
    )
    expect(settingsSet).toHaveBeenCalledTimes(1)
  })

  it('两个入口可同时改动、各自独立提交', async () => {
    renderSection()
    await waitFor(() => expect(imageInput()).toBeInTheDocument())

    fireEvent.change(imageInput(), { target: { value: 'https://a.example.test' } })
    fireEvent.change(manifestInput(), { target: { value: 'https://b.example.test' } })
    fireEvent.click(imageSaveButton())
    fireEvent.click(manifestSaveButton())

    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(2))
    expect(settingsSet).toHaveBeenNthCalledWith(1, IMAGE_KEY, 'https://a.example.test')
    expect(settingsSet).toHaveBeenNthCalledWith(2, MANIFEST_KEY, 'https://b.example.test')
  })
})

describe('ReferenceDataMirrorSection — 异常', () => {
  it('保存被主进程拒绝（SSRF/非法 URL）→ error toast 且输入框回滚到已持久化值', async () => {
    installElectronApi({ [IMAGE_KEY]: 'https://good.example.test' })
    settingsSet = vi.fn(() =>
      Promise.reject(
        Object.assign(new Error('dev detail'), {
          name: 'AppError',
          code: 'VALIDATION_ERROR',
          userMessage: 'referenceData.imageMirrorBaseUrl 必须是公网 http(s) 地址（留空走原始地址）'
        })
      )
    )
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      settings: { get: settingsGet, set: settingsSet }
    }
    renderSection()
    await waitFor(() => expect(imageInput()).toHaveValue('https://good.example.test'))

    fireEvent.change(imageInput(), { target: { value: 'http://127.0.0.1:9' } })
    fireEvent.click(imageSaveButton())

    await waitFor(() => expect(mockShowMessage).toHaveBeenCalledTimes(1))
    // 用户可读文案走 AppError 口径（userMessage），不是 "Error: …" 全串
    expect(mockShowMessage.mock.calls[0]![1]).toBe('error')
    expect(String(mockShowMessage.mock.calls[0]![0])).toContain('必须是公网 http(s) 地址')
    // 关键：回滚到已持久化值，界面不得显示一个从未生效的地址
    expect(imageInput()).toHaveValue('https://good.example.test')
  })

  it('window.electronAPI 缺失（预览版/桥未就绪）→ 不崩溃、不提交', async () => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
    renderSection()

    fireEvent.change(await screen.findByLabelText('图片加速入口'), {
      target: { value: 'https://a.example.test' }
    })
    fireEvent.click(imageSaveButton())
    await Promise.resolve()

    expect(settingsSet).not.toHaveBeenCalled()
    expect(mockShowMessage).not.toHaveBeenCalled()
  })
})

describe('ReferenceDataMirrorSection — 边界', () => {
  it('首尾空白被 trim 后提交（与主进程落库口径一致）', async () => {
    renderSection()
    await waitFor(() => expect(imageInput()).toBeInTheDocument())

    fireEvent.change(imageInput(), { target: { value: '  https://a.example.test  ' } })
    fireEvent.click(imageSaveButton())

    await waitFor(() =>
      expect(settingsSet).toHaveBeenCalledWith(IMAGE_KEY, 'https://a.example.test')
    )
  })

  it('清空后保存 → 提交空串（= 未配置，走原始/官方地址），不得跳过提交', async () => {
    installElectronApi({ [IMAGE_KEY]: 'https://a.example.test' })
    renderSection()
    await waitFor(() => expect(imageInput()).toHaveValue('https://a.example.test'))

    fireEvent.change(imageInput(), { target: { value: '' } })
    fireEvent.click(imageSaveButton())

    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith(IMAGE_KEY, ''))
    expect(mockShowMessage).toHaveBeenCalledWith('已保存')
  })

  it('仅空白串保存 → 提交空串', async () => {
    renderSection()
    await waitFor(() => expect(imageInput()).toBeInTheDocument())

    fireEvent.change(imageInput(), { target: { value: '   ' } })
    fireEvent.click(imageSaveButton())

    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith(IMAGE_KEY, ''))
  })

  it('设置缺省时输入框为空（get 回落空串），不渲染 undefined', async () => {
    renderSection()
    await waitFor(() => expect(imageInput()).toBeInTheDocument())

    expect(imageInput()).toHaveValue('')
    expect(manifestInput()).toHaveValue('')
  })

  it('输入内容未变化时点保存仍幂等提交同一值（不做脏检查跳过）', async () => {
    installElectronApi({ [IMAGE_KEY]: 'https://a.example.test' })
    renderSection()
    await waitFor(() => expect(imageInput()).toHaveValue('https://a.example.test'))

    fireEvent.click(imageSaveButton())
    fireEvent.click(imageSaveButton())

    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(2))
    expect(settingsSet).toHaveBeenNthCalledWith(2, IMAGE_KEY, 'https://a.example.test')
  })
})

// ============================================================
// 审查修复（2026-11-11）：autoUpdate 开关与手动刷新入口
// 总计划 T1.4「用户可配镜像与自动更新」+ 131 行「设置页手动刷新」属本轮交付，
// 设置键/主进程消费/preload 通道/12 语文案均已就位，唯 UI 缺失——以下用例先红后绿。
// ============================================================

const autoUpdateSwitch = () => screen.getByRole('switch', { name: '启动时自动检查参考数据更新' })
const refreshButton = () => screen.getByRole('button', { name: '检查更新' })

describe('ReferenceDataMirrorSection — autoUpdate 开关', () => {
  it('挂载读回已持久化值（false → 关；true → 开）', async () => {
    installElectronApi({ [AUTO_UPDATE_KEY]: false })
    renderSection()
    await waitFor(() => expect(autoUpdateSwitch()).toHaveAttribute('aria-checked', 'false'))
    expect(settingsGet).toHaveBeenCalledWith(AUTO_UPDATE_KEY, true)
  })

  it('切换开关 → 持久化布尔值并提示已保存', async () => {
    installElectronApi({ [AUTO_UPDATE_KEY]: true })
    renderSection()
    await waitFor(() => expect(autoUpdateSwitch()).toHaveAttribute('aria-checked', 'true'))

    fireEvent.click(autoUpdateSwitch())

    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith(AUTO_UPDATE_KEY, false))
    expect(autoUpdateSwitch()).toHaveAttribute('aria-checked', 'false')
    expect(mockShowMessage).toHaveBeenCalledWith('已保存')
  })

  it('保存失败 → 回滚到已持久化值并弹错误 toast', async () => {
    installElectronApi({ [AUTO_UPDATE_KEY]: true })
    settingsSet = vi.fn(() =>
      Promise.reject(
        Object.assign(new Error('dev detail'), {
          name: 'AppError',
          code: 'VALIDATION_ERROR',
          userMessage: '开关值必须是布尔'
        })
      )
    )
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      settings: { get: settingsGet, set: settingsSet },
      referenceData: { refresh: refreshMock }
    }
    renderSection()
    await waitFor(() => expect(autoUpdateSwitch()).toHaveAttribute('aria-checked', 'true'))

    fireEvent.click(autoUpdateSwitch())

    await waitFor(() => expect(mockShowMessage).toHaveBeenCalledTimes(1))
    expect(mockShowMessage.mock.calls[0]![1]).toBe('error')
    expect(autoUpdateSwitch()).toHaveAttribute('aria-checked', 'true')
  })

  it('脏值（非布尔）按默认开启显示，不静默写库', async () => {
    installElectronApi({ [AUTO_UPDATE_KEY]: 'false' })
    renderSection()
    await waitFor(() => expect(autoUpdateSwitch()).toHaveAttribute('aria-checked', 'true'))
    expect(settingsSet).not.toHaveBeenCalled()
  })
})

describe('ReferenceDataMirrorSection — 手动刷新入口', () => {
  it('点击刷新 → 调 referenceData.refresh，available=true 提示成功', async () => {
    renderSection()
    await waitFor(() => expect(refreshButton()).toBeInTheDocument())

    fireEvent.click(refreshButton())

    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mockShowMessage).toHaveBeenCalledWith('参考数据已更新'))
  })

  it('available=false（fail-soft 降级）→ 错误 toast 用通用文案，不铺 lastError 技术细节', async () => {
    refreshMock = vi.fn(() =>
      Promise.resolve({
        available: false,
        packages: [],
        lastCheckedAt: null,
        lastError: '[manifest] fetch failed: ECONNREFUSED 127.0.0.1:443',
        updating: false
      })
    )
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      settings: { get: settingsGet, set: settingsSet },
      referenceData: { refresh: refreshMock }
    }
    renderSection()
    await waitFor(() => expect(refreshButton()).toBeInTheDocument())

    fireEvent.click(refreshButton())

    await waitFor(() => expect(mockShowMessage).toHaveBeenCalledTimes(1))
    expect(mockShowMessage.mock.calls[0]![1]).toBe('error')
    expect(String(mockShowMessage.mock.calls[0]![0])).not.toContain('ECONNREFUSED')
  })

  it('refresh 抛错（桥异常兜底）→ 错误 toast，不崩溃', async () => {
    refreshMock = vi.fn(() => Promise.reject(new Error('bridge gone')))
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      settings: { get: settingsGet, set: settingsSet },
      referenceData: { refresh: refreshMock }
    }
    renderSection()
    await waitFor(() => expect(refreshButton()).toBeInTheDocument())

    fireEvent.click(refreshButton())

    await waitFor(() => expect(mockShowMessage).toHaveBeenCalledTimes(1))
    expect(mockShowMessage.mock.calls[0]![1]).toBe('error')
  })

  it('busy 期间连点 → 只发一次请求（防抖门）', async () => {
    let resolveRefresh: (v: unknown) => void = () => undefined
    refreshMock = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve
        })
    )
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      settings: { get: settingsGet, set: settingsSet },
      referenceData: { refresh: refreshMock }
    }
    renderSection()
    await waitFor(() => expect(refreshButton()).toBeInTheDocument())

    fireEvent.click(refreshButton())
    fireEvent.click(refreshButton())
    fireEvent.click(refreshButton())
    expect(refreshMock).toHaveBeenCalledTimes(1)

    resolveRefresh({
      available: true,
      packages: [],
      lastCheckedAt: null,
      lastError: null,
      updating: false
    })
    await waitFor(() => expect(mockShowMessage).toHaveBeenCalledWith('参考数据已更新'))
    // busy 解除后可再次刷新
    fireEvent.click(refreshButton())
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(2))
  })

  it('桥缺失（预览版）→ 点击不崩溃、不发请求', async () => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
    renderSection()

    fireEvent.click(await screen.findByRole('button', { name: '检查更新' }))
    await Promise.resolve()

    expect(refreshMock).not.toHaveBeenCalled()
    expect(mockShowMessage).not.toHaveBeenCalled()
  })
})
