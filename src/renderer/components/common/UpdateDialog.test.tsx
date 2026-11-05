/**
 * @vitest-environment jsdom
 * @layer L3
 * @module src.renderer.components.common.UpdateDialog
 * @coverage 检查更新弹窗改造契约：error / not-available 模态标题"更新"、双按钮"关闭"+"确定"、确定跳官网、not-available 移出 toast
 * @dependencies fs（源码结构检查）
 * @remarks 沿用 GalleryPage.test.tsx 的源码结构性断言模式。UpdateDialog 依赖 i18n / IPC，
 *   不直接 render，改用源码字符串断言。做否定断言前必须剔除注释行，否则会误命中本文件
 *   注释中引用的缺陷写法（如"更新出错""重试"）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { UpdateDialog } from './UpdateDialog'
import type { UpdatePayload } from '../../../shared/types/electron-api'

// i18n mock：t 原样返回 key，让断言直接落在键名上（文案值本身由 locale 文件与 npm run i18n:guard 保证）
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

const dialogSrc = fs.readFileSync(
  path.resolve(process.cwd(), 'src', 'renderer', 'components', 'common', 'UpdateDialog.tsx'),
  'utf-8'
)

// 剔除 // 行注释与 /* */ 块注释，避免否定断言误命中注释中引用的缺陷写法
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const code = stripComments(dialogSrc)

describe('UpdateDialog 检查更新弹窗改造（error / not-available）', () => {
  it('error 模态标题使用 updateTitle（"更新"），不再硬编码"更新出错"', () => {
    expect(code).toContain("t('settings.about.updateTitle')")
    expect(code).not.toContain('更新出错')
  })

  it('error 模态正文使用 updateNetworkBusy 文案', () => {
    expect(code).toContain("t('settings.about.updateNetworkBusy')")
  })

  it('error 模态按钮为"关闭"(common.close) + "确定"(common.ok)，不再含"重试"', () => {
    expect(code).toContain("t('common.close')")
    expect(code).toContain("t('common.ok')")
    expect(code).not.toContain('重试')
  })

  it('isModalStage 已纳入 not-available', () => {
    expect(code).toMatch(/s === 'not-available'/)
  })

  it('onUpdate 回调不再为 not-available 弹 toast（避免重复提示）', () => {
    // not-available 进入模态，不应再走轻量 toast 分支
    expect(code).not.toContain("p.stage === 'not-available'")
  })

  it('not-available 模态正文使用 updateNoNewVersion 文案', () => {
    expect(code).toContain("t('settings.about.updateNoNewVersion')")
  })

  it('"确定"按钮调用 handleOpenOfficial，且该函数打开官网（openExternal + GITHUB_URL），不再重试 checkUpdate', () => {
    expect(code).toContain('handleOpenOfficial')
    expect(code).toContain('GITHUB_URL')
    expect(code).toContain('openExternal')
    // 不应存在重试逻辑（旧 handleRetry / 再次 checkUpdate）
    expect(code).not.toContain('handleRetry')
    expect(code).not.toMatch(/app\?\.checkUpdate\(\)/)
  })

  it('模块级 GITHUB_URL 常量指向目标官网', () => {
    expect(dialogSrc).toContain("const GITHUB_URL = 'https://github.com/QianQianLuLu1/MeowStarMap'")
  })

  it('error 分支按 errorKind 分流：源码同时具备 source 专属文案与 network 原文案', () => {
    expect(code).toContain("t('settings.about.updateSourceUnavailable')")
    expect(code).toContain('errorKind')
  })

  it('i18n key 在 zh-CN / en 中均已声明', () => {
    const zh = fs.readFileSync(
      path.resolve(process.cwd(), 'src', 'renderer', 'i18n', 'locales', 'zh-CN.json'),
      'utf-8'
    )
    const en = fs.readFileSync(
      path.resolve(process.cwd(), 'src', 'renderer', 'i18n', 'locales', 'en.json'),
      'utf-8'
    )
    for (const key of [
      'updateTitle',
      'updateNetworkBusy',
      'updateNoNewVersion',
      'updateSourceUnavailable'
    ]) {
      expect(zh).toContain(`"${key}"`)
      expect(en).toContain(`"${key}"`)
    }
  })
})

/**
 * render 型用例：error 分支的文案必须随 errorKind 分流。
 * 修复前 error 分支恒渲染 updateNetworkBusy ⇒ 下面「source」用例为红；
 * 标「回归锁」的用例修复前后都应为绿（守住原提示、跳转行为与下载弹窗不被破坏）。
 */
type FakeElectronAPI = {
  app: {
    onUpdate: (cb: (payload: UpdatePayload) => void) => () => void
    downloadUpdate: () => Promise<unknown>
    installUpdate: () => Promise<unknown>
  }
  shell: { openExternal: (url: string) => Promise<unknown> }
}

const OFFICIAL_URL = 'https://github.com/QianQianLuLu1/MeowStarMap'

let updateListener: ((payload: UpdatePayload) => void) | null = null
const openExternalMock = vi.fn(async () => undefined)

function installFakeApi(): void {
  updateListener = null
  ;(window as unknown as { electronAPI: FakeElectronAPI }).electronAPI = {
    app: {
      onUpdate: (cb) => {
        updateListener = cb
        return () => {
          updateListener = null
        }
      },
      downloadUpdate: vi.fn(async () => undefined),
      installUpdate: vi.fn(async () => undefined)
    },
    shell: { openExternal: openExternalMock }
  }
}

/** 主进程推一条 app:update（组件的状态唯一入口） */
function pushUpdate(payload: UpdatePayload): void {
  act(() => {
    updateListener?.(payload)
  })
}

describe('UpdateDialog error 分支按 errorKind 分流（render 型）', () => {
  beforeEach(() => {
    openExternalMock.mockClear()
    installFakeApi()
  })

  afterEach(() => {
    cleanup()
  })

  it('errorKind=source 显示「未获取到可用的更新信息」，不得再出现网络繁忙文案', () => {
    render(<UpdateDialog />)
    pushUpdate({ stage: 'error', errorKind: 'source', errorMessage: 'Cannot find latest.yml' })

    expect(screen.queryByText('settings.about.updateSourceUnavailable')).toBeInTheDocument()
    expect(screen.queryByText('settings.about.updateNetworkBusy')).not.toBeInTheDocument()
  })

  it('errorKind=network 仍显示「当前网络繁忙」（回归锁：原异常提示不得被破坏）', () => {
    render(<UpdateDialog />)
    pushUpdate({ stage: 'error', errorKind: 'network', errorMessage: 'connect ECONNREFUSED' })

    expect(screen.queryByText('settings.about.updateNetworkBusy')).toBeInTheDocument()
    expect(screen.queryByText('settings.about.updateSourceUnavailable')).not.toBeInTheDocument()
  })

  it('旧事件不带 errorKind 时仍按网络繁忙处理（回归锁：向后兼容）', () => {
    render(<UpdateDialog />)
    pushUpdate({ stage: 'error', errorMessage: 'legacy payload without kind' })

    expect(screen.queryByText('settings.about.updateNetworkBusy')).toBeInTheDocument()
  })

  it('source 分支的「确定」依旧跳官网（回归锁：跳转行为不变）', () => {
    render(<UpdateDialog />)
    pushUpdate({ stage: 'error', errorKind: 'source' })
    fireEvent.click(screen.getByText('common.ok'))

    expect(openExternalMock).toHaveBeenCalledWith(OFFICIAL_URL)
  })

  it('network 分支的「确定」依旧跳官网（回归锁）', () => {
    render(<UpdateDialog />)
    pushUpdate({ stage: 'error', errorKind: 'network' })
    fireEvent.click(screen.getByText('common.ok'))

    expect(openExternalMock).toHaveBeenCalledWith(OFFICIAL_URL)
  })

  it('available 阶段仍是「发现新版本」+ 版本号 + 下载按钮（回归锁：下载弹窗不受影响）', () => {
    render(<UpdateDialog />)
    pushUpdate({ stage: 'available', version: '9.9.9', releaseNotes: '修复检查更新' })

    // h2 把键名与版本号拼在同一节点（"updateDialog.foundNewVersion v9.9.9"），故用正则而非精确串
    expect(screen.queryByText(/updateDialog\.foundNewVersion/)).toBeInTheDocument()
    expect(screen.queryByText(/9\.9\.9/)).toBeInTheDocument()
    expect(screen.queryByText('updateDialog.downloadNow')).toBeInTheDocument()
    expect(screen.queryByText('修复检查更新')).toBeInTheDocument()
  })

  it('not-available 阶段仍是「当前已是最新版本」（回归锁）', () => {
    render(<UpdateDialog />)
    pushUpdate({ stage: 'not-available', version: '2.5.7-beta' })

    expect(screen.queryByText('settings.about.updateNoNewVersion')).toBeInTheDocument()
    fireEvent.click(screen.getByText('common.ok'))
    expect(openExternalMock).toHaveBeenCalledWith(OFFICIAL_URL)
  })
})
