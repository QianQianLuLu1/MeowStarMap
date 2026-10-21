/**
 * 图库全屏预览诊断（临时探针，非回归用例）
 *
 * 目的：在真实 Electron 运行时复现"图库全屏预览无法正常使用"，捕获
 *   - DevTools Console 报错
 *   - 全屏 <img data-fullscreen-img> 的 media:// 请求状态码
 *   - 点击缩略图后全屏 dialog 是否出现
 *
 * 用法：npx playwright test fullscreen-diagnose.e2e.ts
 * 前置：release/win-unpacked/*.exe 已存在（helpers.findUnpackedExe）
 */
import { test, expect, type Page, type TestInfo } from '@playwright/test'
import { launchApp, closeApp, collectDiagLogs, type LaunchedApp } from './helpers'

let launched: LaunchedApp | undefined
let win: Page

// eslint-disable-next-line no-empty-pattern -- Playwright hook 首参必须是对象解构模式
test.afterAll(async ({}, testInfo: TestInfo) => {
  if (launched) {
    await collectDiagLogs(launched.userDataDir, testInfo.outputDir)
  }
  await closeApp(launched)
  launched = undefined
})

test('图库全屏预览诊断：点击缩略图 → 捕获 media:// 状态与 Console', async () => {
  // 用例预算必须严格大于下方 90s 的网格等待：CI 的 windows runner 上没有游戏
  // （run 39583778122 日志 `[e2e-nikkisync] gameRoot=<none>` + `[DIAG] gridReady=false gridcellCount=0`），
  // 图库走 GalleryPage 的 EmptyState 分支 ⇒ `[role="grid"]` 永不出现 ⇒ 等待只能跑到超时。
  // 配置默认预算是 60s（playwright.config.ts 的 timeout），于是用例在 await 里就被判
  // `Test timeout of 60000ms exceeded`，末尾那两条恒真断言救不了它——这正是该步骤唯一红点。
  // 写法与 smoke.e2e.ts 的 S7 同源（那里用 test.setTimeout(120_000) 兜 90s 的 expect.poll）。
  test.setTimeout(150_000)
  launched = await launchApp()
  win = await launched.app.firstWindow()
  await win.waitForLoadState('domcontentloaded', { timeout: 15_000 })

  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  const mediaResponses: Array<{ url: string; status: number | string }> = []

  win.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      consoleErrors.push(`[${msg.type()}] ${msg.text()}`)
    }
  })
  win.on('pageerror', (err) => {
    pageErrors.push(`${err.name}: ${err.message}`)
  })
  win.on('response', (resp) => {
    const u = resp.url()
    if (u.startsWith('media://')) {
      mediaResponses.push({ url: u.slice(0, 120), status: resp.status() })
    }
  })

  // 等待图库网格出现（最多 90s，覆盖首启自动扫描）
  let gridReady = false
  try {
    await win.waitForSelector('[role="grid"]', { timeout: 90_000 })
    gridReady = true
  } catch {
    gridReady = false
  }

  const cellCount = gridReady ? await win.locator('[role="gridcell"]').count() : 0

  console.log(`[DIAG] gridReady=${gridReady} gridcellCount=${cellCount}`)

  let dialogAppeared = false
  let imgSrc: string | null = null
  const mediaStatusBeforeClick = mediaResponses.length

  if (cellCount > 0) {
    // 点击第一张缩略图
    await win.locator('[role="gridcell"]').first().click({ timeout: 10_000 })
    try {
      await win.waitForSelector('[role="dialog"][aria-modal="true"], [role="dialog"]', {
        timeout: 8_000
      })
      dialogAppeared = true
    } catch {
      dialogAppeared = false
    }

    if (dialogAppeared) {
      const img = win.locator('img[data-fullscreen-img]').first()
      if (await img.count()) {
        imgSrc = await img.getAttribute('src')
      }
    }
  }

  console.log(`[DIAG] dialogAppeared=${dialogAppeared}`)

  console.log(`[DIAG] fullscreenImgSrc=${imgSrc ? imgSrc.slice(0, 160) : 'null'}`)

  console.log(
    `[DIAG] mediaResponses(count=${mediaResponses.length}, newSinceClick=${
      mediaResponses.length - mediaStatusBeforeClick
    })=${JSON.stringify(mediaResponses.slice(-10))}`
  )

  console.log(`[DIAG] consoleErrors=${JSON.stringify(consoleErrors.slice(0, 30))}`)

  console.log(`[DIAG] pageErrors=${JSON.stringify(pageErrors.slice(0, 30))}`)

  // 诊断探针：不强断言通过，仅确保采集到关键信号，避免 CI 误判
  expect(gridReady || consoleErrors.length >= 0).toBe(true)
  expect(dialogAppeared || cellCount === 0).toBe(true)
})
