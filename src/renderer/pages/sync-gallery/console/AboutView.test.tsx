// @vitest-environment jsdom
/**
 * T11：关于视图套件——版本卡（双版本 + 对齐提交 + 署名）/ 下载四渠道逐字外链 /
 * 检查更新走宿主通道 / 发送诊断诚实置灰 / 六仓库链。
 *
 * 运行：npx vitest run src/renderer/pages/sync-gallery/console/AboutView.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { AboutView } from './AboutView'
import {
  setupConsoleTest,
  renderView,
  mockShowMessage,
  appGetVersion,
  appCheckUpdate,
  logExportZip,
  shellOpenExternal
} from './sync-console-test-utils'
import {
  NIKKISYNC_ALIGNED_VERSION,
  NIKKISYNC_ALIGNED_COMMIT
} from '../../../../shared/nikkisync-version'
import {
  UPSTREAM_ANDROID_APK_URL,
  UPSTREAM_QUARK_URL,
  UPSTREAM_BAIDU_URL,
  UPSTREAM_GITHUB_RELEASES_URL,
  UPSTREAM_REPO_LINKS
} from './upstream-links'

function renderAbout() {
  return renderView(<AboutView />)
}

beforeEach(() => {
  setupConsoleTest()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('T11：版本卡', () => {
  it('宿主版本 + 上游对齐版本/提交 + 解码组件署名齐备', async () => {
    renderAbout()
    await waitFor(() => expect(appGetVersion).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('2.5.7-beta')).toBeInTheDocument()
    expect(screen.getByText(NIKKISYNC_ALIGNED_VERSION)).toBeInTheDocument()
    expect(screen.getByText(NIKKISYNC_ALIGNED_COMMIT)).toBeInTheDocument()
    expect(screen.getByText(/RanAxro \/ Nikki Albums/)).toBeInTheDocument()
  })

  it('app.getVersion 缺席 ⇒ 占位「—」', async () => {
    ;(window.electronAPI as unknown as { app: Record<string, unknown> }).app.getVersion = undefined
    renderAbout()
    expect(await screen.findByText('—')).toBeInTheDocument()
  })
})

describe('T11：下载与更新', () => {
  it('四渠道外链逐字上游（APK/夸克/百度/GitHub），经 shell.openExternal 打开', async () => {
    renderAbout()
    const channels: Array<[string, string]> = [
      ['CNB 测试版', UPSTREAM_ANDROID_APK_URL],
      ['夸克网盘', UPSTREAM_QUARK_URL],
      ['百度网盘', UPSTREAM_BAIDU_URL],
      ['GitHub Releases', UPSTREAM_GITHUB_RELEASES_URL]
    ]
    for (const [name, url] of channels) {
      fireEvent.click(await screen.findByRole('button', { name }))
      await waitFor(() => expect(shellOpenExternal).toHaveBeenCalledWith(url))
    }
    expect(shellOpenExternal).toHaveBeenCalledTimes(4)
  })

  it('「检查更新」= 宿主 app.checkUpdate 应用内更新通道（非上游 EXE 自替换）', async () => {
    renderAbout()
    fireEvent.click(screen.getByTestId('sync-about-check-update'))
    await waitFor(() => expect(appCheckUpdate).toHaveBeenCalledTimes(1))
    expect(mockShowMessage).toHaveBeenCalledWith('已发起更新检查', 'info')
    // 宿主语义说明在场
    expect(screen.getByText('使用宿主应用内更新通道检查新版本。')).toBeInTheDocument()
  })

  it('app.checkUpdate 缺席 ⇒ 诚实提示更新通道不可用', async () => {
    ;(window.electronAPI as unknown as { app: Record<string, unknown> }).app.checkUpdate = undefined
    renderAbout()
    fireEvent.click(screen.getByTestId('sync-about-check-update'))
    await waitFor(() => expect(mockShowMessage).toHaveBeenCalledWith('更新通道不可用', 'info'))
  })
})

describe('T11：诊断与反馈', () => {
  it('导出诊断走 log.exportZip，成功 Toast 带路径', async () => {
    renderAbout()
    fireEvent.click(screen.getByTestId('sync-about-export'))
    await waitFor(() => expect(logExportZip).toHaveBeenCalledTimes(1))
    expect(mockShowMessage).toHaveBeenCalledWith(
      '诊断包已导出：C:/diagnostics/nikkisync.zip',
      'success'
    )
  })

  it('「发送诊断」诚实置灰（support-submit 通道未装载，不伪造提交）', async () => {
    renderAbout()
    const support = await screen.findByRole('button', { name: '发送诊断' })
    expect(support).toBeDisabled()
    expect(screen.getByText(/需先在同步设置开启「匿名诊断提交」/)).toBeInTheDocument()
  })
})

describe('T11：项目仓库与来源', () => {
  it('五链逐字上游（含解码署名链），点击经 shell.openExternal 打开', async () => {
    renderAbout()
    const names = [
      '大喵相机助手 · NikkiSync',
      'RanAxro · Nikki Albums',
      '喵星图 · MeowStarMap',
      'NUAN5.PRO · 在线参数解析',
      '暖暖共鸣录 · gongeo.us'
    ]
    for (let i = 0; i < names.length; i += 1) {
      fireEvent.click(await screen.findByRole('button', { name: names[i] }))
      await waitFor(() =>
        expect(shellOpenExternal).toHaveBeenCalledWith(UPSTREAM_REPO_LINKS[i].url)
      )
    }
    expect(shellOpenExternal).toHaveBeenCalledTimes(5)
  })
})
