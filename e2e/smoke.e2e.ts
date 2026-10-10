/**
 * 打包产物运行时冒烟（S1~S7，见 docs/archive/plans/e2e-smoke-playwright.md §2）
 *
 * 前置要求：release/win-unpacked 已存在（本地 npm run dist:win；CI 由 build 步骤产出）。
 * 覆盖四个历史回归点：白屏、app:// 路径回退、preload 注入、原生模块（better-sqlite3）。
 */
import { test, expect, type Page, type TestInfo } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  launchApp,
  closeApp,
  collectDiagLogs,
  readExpectedVersion,
  type LaunchedApp
} from './helpers'

/** preload 暴露的 window 全局对象最小类型声明（仅覆盖冒烟断言所需面） */
declare global {
  interface Window {
    electronAPI?: {
      app: { getVersion: () => Promise<string> }
      uiTheme: { get: () => Promise<{ theme: string }> }
      scanner?: unknown
      media?: unknown
      settings?: unknown
      plugin?: unknown
    }
    IpcError?: unknown
    pluginAPI?: unknown
    pluggableElectronIpc?: unknown
  }
}

let launched: LaunchedApp | undefined
let win: Page

/** afterAll 兜底：关闭应用 + 归集主进程诊断日志到 test-results/（失败 artifact 采集点） */
// eslint-disable-next-line no-empty-pattern -- Playwright hook 首参必须是对象解构模式
test.afterAll(async ({}, testInfo: TestInfo) => {
  if (launched) {
    await collectDiagLogs(launched.userDataDir, testInfo.outputDir)
  }
  await closeApp(launched)
  launched = undefined
})

test.describe('打包产物冒烟（win-unpacked）', () => {
  test('S1 启动与主窗口：app:// 协议加载成功', async () => {
    launched = await launchApp()
    win = await launched.app.firstWindow()
    await win.waitForLoadState('domcontentloaded', { timeout: 15_000 })
    // app:// 特权协议加载成功（路径回退回归点；协议失效是历史白屏根因之一）
    expect(win.url()).toMatch(/^app:\/\/renderer\//)
  })

  test('S2 非白屏：#root 有真实渲染内容', async () => {
    // 三层判据之一：DOM 挂载非空（等价于 renderer:ready 上报条件）；
    // 必须在 window-manager 8s 白屏诊断定时器附近完成，避免触发原生诊断对话框
    await win.waitForFunction(
      () => {
        const root = document.getElementById('root')
        return !!root && root.childElementCount > 0 && root.querySelectorAll('*').length > 10
      },
      undefined,
      { timeout: 15_000 }
    )
    // 留档截图，便于人工复核渲染内容
    await win.screenshot({ path: 'test-results/smoke-rendered.png', fullPage: false })
  })

  test('S3 preload 注入：contextBridge 四个全局对象齐备', async () => {
    const preloadOk = await win.evaluate(() => ({
      api: typeof window.electronAPI === 'object' && window.electronAPI !== null,
      ipcError: typeof window.IpcError === 'function',
      pluginAPI: typeof window.pluginAPI === 'object' && window.pluginAPI !== null,
      namespaces:
        !!window.electronAPI?.scanner &&
        !!window.electronAPI?.media &&
        !!window.electronAPI?.app &&
        !!window.electronAPI?.settings &&
        !!window.electronAPI?.plugin
    }))
    expect(preloadOk).toEqual({ api: true, ipcError: true, pluginAPI: true, namespaces: true })
  })

  test('S4 主进程 IPC 探针：app.getVersion 与 package.json 一致', async () => {
    const version = await win.evaluate(() => window.electronAPI!.app.getVersion())
    expect(version).toBe(readExpectedVersion())
  })

  test('S5 DB / 原生模块探针：uiTheme.get 真实查询 app_settings 表', async () => {
    // uiTheme.get 走 SQLite app_settings 表 → 证明 better-sqlite3 原生模块已正确加载
    const theme = await win.evaluate(() => window.electronAPI!.uiTheme.get())
    expect(['default', 'soft-pink-luxury']).toContain(theme.theme)
  })

  test('S6 启动稳定性：静置 5s 后进程仍存活且渲染进程可响应', async () => {
    const proc = launched!.app.process()
    expect(proc.exitCode).toBeNull()
    await new Promise((r) => setTimeout(r, 5_000))
    expect(proc.exitCode).toBeNull()
    expect(await win.evaluate(() => 1)).toBe(1)
  })

  test('S7 首装自动扫描：扫描执行、完成且目录发现可观测', async () => {
    test.setTimeout(120_000) // 全盘签名搜索需扫完所有可用盘符，慢机器放宽
    const logsDir = path.join(launched!.userDataDir, 'logs')
    await expect
      .poll(
        async () => {
          const names = await fs.readdir(logsDir).catch(() => [] as string[])
          let content = ''
          for (const n of names.filter((x) => x.endsWith('.log'))) {
            content += await fs.readFile(path.join(logsDir, n), 'utf-8').catch(() => '')
          }
          return {
            started: content.includes('[Startup] 开始后台自动扫描'),
            done: content.includes('[Startup] 扫描完成'),
            discovery: content.includes('findMediaDirectories 搜索结果')
          }
        },
        // 新版 Playwright 把 waitForFunction 的轮询参数从 interval 改名为 intervals（数组）
        { timeout: 90_000, intervals: [2_000] }
      )
      .toEqual({ started: true, done: true, discovery: true })
  })

  test('userData 隔离校验：确认落在临时目录', async () => {
    // --user-data-dir 为 Chromium 稳定开关；显式断言防止参数语义变化静默失效（计划 §7.2）
    const userData = await launched!.app.evaluate(({ app }) => app.getPath('userData'))
    expect(userData).toBe(launched!.userDataDir)
  })
})
