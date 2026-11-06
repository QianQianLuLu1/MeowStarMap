/**
 * @vitest-environment jsdom
 *
 * AboutInfoSection「检查更新」入口的错误分流与 API 缺席兜底。
 * 观测面：window.electronAPI.app.checkUpdate / shell.openExternal 与 GlobalToastContext 的 showMessage。
 * i18n mock 让 t() 原样返回 key，断言直接落在既有 i18n key 上（不硬编码中文、不新增 locale key）。
 *
 * 运行：npx vitest run src/renderer/pages/settings/about-sections.test.tsx
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { AboutInfoSection } from './about-sections'
import { GlobalToastContext } from './shared'

// t 返回 key：文案值由 locale 文件与 i18n:guard 保证，本套件只钉「用了哪个既有 key」
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } })
}))

const GITHUB_URL = 'https://github.com/QianQianLuLu1/MeowStarMap'
const FAIL_KEY = 'settings.about.updateSourceUnavailable'

const openExternalMock = vi.fn(async () => undefined)
const showMessageMock = vi.fn()
let checkUpdateMock: ReturnType<typeof vi.fn>

/** 覆盖 setup.ts 注入的 Proxy 占位；withCheckUpdate=false 复刻 API 缺席边界 */
function installApi(withCheckUpdate = true): void {
  checkUpdateMock = vi.fn(async () => ({ checking: true }))
  const app: Record<string, unknown> = { getVersion: vi.fn(async () => '2.5.7-beta') }
  if (withCheckUpdate) app.checkUpdate = checkUpdateMock
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    app,
    shell: { openExternal: openExternalMock }
  }
}

function renderSection(): void {
  render(
    <GlobalToastContext.Provider value={showMessageMock}>
      <AboutInfoSection />
    </GlobalToastContext.Provider>
  )
}

function clickCheckUpdate(): void {
  fireEvent.click(screen.getByText('settings.about.checkUpdate'))
}

function ipcError(code: string): Error {
  return Object.assign(new Error('boom'), { code })
}

beforeEach(() => {
  openExternalMock.mockClear()
  showMessageMock.mockClear()
  installApi()
})

describe('AboutInfoSection —— 检查更新的错误分流与 API 缺席兜底', () => {
  it('(正常) checkUpdate 成功 ⇒ 不跳官网、不弹提示', async () => {
    renderSection()
    clickCheckUpdate()

    await waitFor(() => expect(checkUpdateMock).toHaveBeenCalledTimes(1))
    expect(openExternalMock).not.toHaveBeenCalled()
    expect(showMessageMock).not.toHaveBeenCalled()
  })

  it('(分流回归锁) IPC_PRECONDITION_FAILED ⇒ 兜底打开官网，不弹错误提示', async () => {
    checkUpdateMock.mockRejectedValue(ipcError('IPC_PRECONDITION_FAILED'))
    renderSection()
    clickCheckUpdate()

    await waitFor(() => expect(openExternalMock).toHaveBeenCalledWith(GITHUB_URL))
    expect(showMessageMock).not.toHaveBeenCalled()
  })

  it('(缺陷) IPC_INTERNAL_ERROR ⇒ 不跳官网，给可见错误提示', async () => {
    checkUpdateMock.mockRejectedValue(ipcError('IPC_INTERNAL_ERROR'))
    renderSection()
    clickCheckUpdate()

    await waitFor(() => expect(showMessageMock).toHaveBeenCalledWith(FAIL_KEY, 'error'))
    expect(openExternalMock).not.toHaveBeenCalled()
  })

  it('(边界) checkUpdate API 缺席 ⇒ 给可见兜底，不得静默无反应', async () => {
    installApi(false)
    renderSection()
    clickCheckUpdate()

    await waitFor(() => expect(showMessageMock).toHaveBeenCalledWith(FAIL_KEY, 'error'))
    expect(openExternalMock).not.toHaveBeenCalled()
  })
})
