/**
 * 打包产物运行时冒烟（S1~S7；用例清单见 docs/manual-smoke-checklist.md，
 * 原方案文档已归档至 docs/archive/plans/e2e-smoke-playwright.md §2，不入仓、git 历史可查）
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
      app: {
        getVersion: () => Promise<string>
        /** GPU 状态只读探针（app:gpu-status，2026-10-24 硬件加速优化新增） */
        getGpuStatus?: () => Promise<unknown>
      }
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

// launched/win 是模块作用域的跨用例共享态（S1 建、S2~S8 复用），而 Playwright 在某条用例
// 失败后会回收 worker 并重新求值模块 ⇒ 剩余用例读到 undefined，一条真失败伪装成六条。
// serial 让本 describe 失败即中止剩余用例（同族写法见 e2e/nikkisync-runtime.e2e.ts:305）。
test.describe.configure({ mode: 'serial' })

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

  test('S8 GPU 状态探针：app:gpu-status 结构齐备且硬件加速默认开启', async () => {
    const raw = await win.evaluate(() => window.electronAPI?.app?.getGpuStatus?.())
    // 结构断言（字段契约见 docs/IPC_CONTRACT.md §12）
    expect(raw).toBeTruthy()
    const s = raw as {
      hardwareAcceleration: { enabled: boolean; reason: string }
      fallback: unknown
      discretePreference: unknown
      featureStatus: unknown
      gpus: unknown
      activeGpu: unknown
      electronVersion: string
      platform: string
    }
    expect(typeof s.hardwareAcceleration?.enabled).toBe('boolean')
    expect(typeof s.hardwareAcceleration?.reason).toBe('string')
    expect(s.fallback).toBeTruthy()
    expect(s.discretePreference).toBeTruthy()
    // 全新临时 userData 无回退标记 → 硬件加速必须默认开启。该断言与机器有无独显无关：
    // CI 无 GPU 环境下 Electron 默认也不禁用（SwiftShader 仅体现在 featureStatus 取值上）
    expect(s.hardwareAcceleration.enabled).toBe(true)
    // 只观测不断言具体值：CI SwiftShader 与独显机的取值本来就不同，输出供人工复核
    expect(['object', 'null']).toContain(typeof s.featureStatus)
    expect(['object', 'null']).toContain(typeof s.gpus)
    expect(['string', 'null']).toContain(typeof s.activeGpu)
    process.stdout.write(`[gpu] reason=${s.hardwareAcceleration.reason}\n`)
    process.stdout.write(`[gpu] activeGpu=${JSON.stringify(s.activeGpu)}\n`)
    process.stdout.write(
      `[gpu] featureStatus=${JSON.stringify(s.featureStatus)} gpus=${JSON.stringify(s.gpus)}\n`
    )
  })
})
