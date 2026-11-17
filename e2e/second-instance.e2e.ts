/**
 * 第二实例不污染启动证据 + ack 静默让位（X1~X3；F2/F3/B 验收，2026-11-15）
 *
 * 场景：实例 1 正常运行后，用户再次双击快捷方式拉起实例 2（同一 exe、同一 userData
 * → 单实例锁冲突）。
 * 修复前：实例 2 在锁检查之前就执行 markBootAttempt（共享 gpu-fallback.json 的
 *        consecutiveFailures +1，阈值 2 即把下次真实启动打进软件渲染兼容模式）与
 *        initExitForensics（覆写/删除运行实例的 heartbeat.json，污染 GPU 自愈证据链）。
 * 修复后（F2/F3）：锁失败实例不做任何启动打点，证据文件零污染。
 * 修复后（B）：健康赢家的 second-instance 监听写 ack 存活标记，输家 6s 重试耗尽后
 *        检测到新鲜 ack 即 app.quit 静默退出——不再弹「已有实例运行」（窗口已聚焦
 *        却又弹报错 = 用户感知异常）。
 *
 * 前置要求：release/win-unpacked 已存在（本地 npm run dist:win；CI 由 build 步骤产出）。
 *
 * 断言口径说明：原生"已有实例运行"对话框与三选项交互路径由
 * src/main/app/__tests__/single-instance.test.ts 单测覆盖（用例 3~7 + B1~B11，含
 * ack 缺失/陈旧/损坏时仍弹框的僵尸场景）；本文件以「证据文件字节级不变 + 输家静默
 * 退出 + 实例 1 存活」作为自动代理判据。diag.log 落在 Documents\喵星图\Diagnostics
 * （机器级共享目录，跨运行累积），在 e2e 内断言其内容会读到历史运行行，故不作为判据。
 */
import { test, expect, type TestInfo } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { launchApp, closeApp, collectDiagLogs, type LaunchedApp } from './helpers'

test.describe.configure({ mode: 'serial' })

let primary: LaunchedApp | undefined
let secondary: LaunchedApp | undefined

/**
 * 以进程树为单位强杀（Windows）。
 * Playwright 在 win32 以 shell:true 包装启动（coreBundle.js：`shell = true`），
 * app.process() 返回的是 cmd.exe 包装进程——直接 kill() 杀不掉真实应用进程树，
 * 与应用自身"清理并重启"的 taskkill /F /T 口径对齐。
 */
function killProcessTree(pid: number): void {
  try {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true })
  } catch {
    // 进程已退出 / 已被清理
  }
}

/**
 * 实例 1 心跳 pid（X1 阶段捕获）。
 * 不用 Playwright 的 app.process().pid 做同一性判据：打包版 Electron 在 Windows 上
 * 主进程与 Playwright 句柄进程的对应关系属测试基建细节，心跳文件自身记录的 pid
 * 才是 exit-forensics 的真实口径；pid 连续性（X1→X3 同一 pid 存活）即可证明
 * 心跳始终由实例 1 维护、未被实例 2 覆写。
 */
let primaryHeartbeatPid = 0

/** 打包态取证根 = exe 同目录 Diagnostics（forensics-dir.ts install 分支）；证据断言与 userData 无关 */
function forensicsDirOf(app: LaunchedApp): string {
  return path.join(path.dirname(app.exePath), 'Diagnostics')
}

/** 大于锁重试窗口（6×1s）+ 余量：输家应在此窗口内检测到新鲜 ack 并静默退出 */
const RETRY_WINDOW_MARGIN_MS = 9_000

/**
 * 判定实例 2 是否已退出。不能直接轮询 app.process().exitCode：进程退出后
 * Playwright 的 process() 自身会抛 TypeError（连接已关闭）——该抛错即"已退出"
 * 的证据，与 exitCode 非 null 同义。
 */
function isSecondaryGone(): boolean {
  try {
    return secondary!.app.process().exitCode !== null
  } catch {
    // process() 在应用退出后不可用（Playwright 内部状态已回收）
    return true
  }
}

/** 进程存在性探测（与 exit-forensics.defaultIsProcessAlive 同口径） */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/** 读取 JSON 文件；不存在/损坏返回 null（与 exit-forensics 的 fail-open 口径一致） */
async function readJsonOrNull(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

// eslint-disable-next-line no-empty-pattern -- Playwright hook 首参必须是对象解构模式
test.afterAll(async ({}, testInfo: TestInfo) => {
  // 实例 2 若因异常未按预期静默退出（仍挂在对话框/进程残留），按进程树强杀兜底；
  // process() 在进程退出后会抛 TypeError（连接已关闭），同样视为无需清理
  if (secondary) {
    try {
      if (secondary.app.process().exitCode === null) {
        killProcessTree(secondary.app.process().pid!)
      }
    } catch {
      // 连接已随进程退出关闭——无残留可清理（X3 的 PowerShell 扫描另行兜底断言）
    }
  }
  if (primary) {
    await collectDiagLogs(primary.userDataDir, testInfo.outputDir, primary.exePath)
  }
  await closeApp(primary)
  primary = undefined
  secondary = undefined
})

test.describe('第二实例不污染启动证据（单实例锁 × GPU 证据链）', () => {
  test('X1 实例 1 启动成功：boot-ok.marker 就位、失败计数已由首绘成功清零', async () => {
    primary = await launchApp()
    const win = await primary.app.firstWindow()
    await win.waitForLoadState('domcontentloaded', { timeout: 15_000 })

    // boot-ok.marker：Application.initialize 完成的落盘标记（index.ts 写入）
    const markerPath = path.join(forensicsDirOf(primary), 'boot-ok.marker')
    await expect
      .poll(
        async () => {
          try {
            return await fs.readFile(markerPath, 'utf8')
          } catch {
            return ''
          }
        },
        { timeout: 30_000 }
      )
      .toBe('ok')

    // 等 markBootSuccess（did-finish-load + 8s settle）把 consecutiveFailures 清零，
    // 否则 X2 的字节级对比会被这次正常写盘干扰（markBootAttempt 1 → markBootSuccess 0）
    const gpuPath = path.join(forensicsDirOf(primary), 'gpu-fallback.json')
    await expect
      .poll(
        async () => {
          const gpu = await readJsonOrNull(gpuPath)
          return gpu?.consecutiveFailures
        },
        { timeout: 30_000 }
      )
      .toBe(0)

    // 捕获实例 1 的心跳 pid 并确认其存活（X2/X3 的同一性判据）
    const hb = await readJsonOrNull(path.join(forensicsDirOf(primary), 'heartbeat.json'))
    expect(hb, '赢家实例的 heartbeat.json 必须存在').not.toBeNull()
    primaryHeartbeatPid = hb!.pid as number
    expect(isPidAlive(primaryHeartbeatPid), '心跳 pid 应指向存活进程').toBe(true)
  })

  test('X2 实例 2 整个生命周期内：gpu-fallback.json 字节级不变、heartbeat.json 仍归实例 1', async () => {
    const userData = primary!.userDataDir
    const forensics = forensicsDirOf(primary!)
    const gpuPath = path.join(forensics, 'gpu-fallback.json')
    const hbPath = path.join(forensics, 'heartbeat.json')

    // 前置：实例 1（赢家）的心跳仍在维护
    const gpuBefore = await fs.readFile(gpuPath, 'utf8')
    const hbBefore = await readJsonOrNull(hbPath)
    expect(hbBefore, '赢家实例的 heartbeat.json 必须存在').not.toBeNull()
    expect(hbBefore?.pid).toBe(primaryHeartbeatPid)

    // 拉起第二实例（同 exe、同 userData → requestSingleInstanceLock 冲突）
    secondary = await launchApp({ userDataDir: userData })
    // B 修复：健康赢家响应 second-instance 写 ack → 输家 6s 重试耗尽后检测到新鲜
    // ack 即 app.quit 静默让位，不再停留于"已有实例运行"对话框
    await expect.poll(isSecondaryGone, { timeout: RETRY_WINDOW_MARGIN_MS }).toBe(true)

    // 核心断言 1：gpu-fallback.json 字节级不变——
    // 修复前实例 2 的 markBootAttempt 会把 consecutiveFailures 从 0 抬到 1
    const gpuAfter = await fs.readFile(gpuPath, 'utf8').catch(() => null)
    expect(gpuAfter).toBe(gpuBefore)

    // 核心断言 2：heartbeat.json 仍由实例 1 维护——
    // 修复前实例 2 的 initExitForensics 会覆写 bootId/pid，退出时整份删除
    const hbAfter = await readJsonOrNull(hbPath)
    expect(hbAfter, 'heartbeat.json 不得被实例 2 删除').not.toBeNull()
    expect(hbAfter?.bootId).toBe(hbBefore?.bootId)
    expect(hbAfter?.pid).toBe(primaryHeartbeatPid)
  })

  test('X3 实例 2 静默让位退出后：无残留进程，实例 1 仍存活可响应，心跳继续由实例 1 维护', async () => {
    // 实例 2 应无残留进程。过滤口径：slug + remote-debugging-port（Playwright 双实例
    // 都带）之后，必须同时排除实例 1 的主进程 pid 与其直系子进程——实例 1 的
    // renderer 等子进程同样带 slug + remote-debugging-port=0（实测取证：
    // --type=renderer --user-data-dir=<共享 slug> --remote-debugging-port=0），
    // 只按主 pid 排除会把实例 1 的 renderer 误判成实例 2 残留。实例 2 的任何
    // 遗留进程（主进程或子进程）父链都不含实例 1 主 pid，必然被留下。
    const slug = path.basename(secondary!.userDataDir)
    const psScript =
      `Get-CimInstance Win32_Process -Filter "Name='喵星图.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*${slug}*' -and ` +
      `$_.CommandLine -like '*remote-debugging-port*' -and ` +
      `$_.ProcessId -ne ${primaryHeartbeatPid} -and ` +
      `$_.ParentProcessId -ne ${primaryHeartbeatPid} } | ` +
      `ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`
    const queryLingering = (): string[] => {
      const out = execFileSync(
        'powershell',
        ['-NoProfile', '-EncodedCommand', Buffer.from(psScript, 'utf16le').toString('base64')],
        { encoding: 'utf8', timeout: 15_000, windowsHide: true }
      )
      return out
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    }
    // 轮询判定 + 失败取证：toEqual([]) 失败时打印的即 pid|命令行 全文
    await expect.poll(() => queryLingering(), { timeout: 15_000 }).toEqual([])

    // 实例 1 不受实例 2 生命周期影响：进程存活 + 渲染进程可响应
    const primaryProc = primary!.app.process()
    expect(primaryProc.exitCode).toBeNull()
    const win = await primary!.app.firstWindow()
    expect(await win.evaluate(() => 1)).toBe(1)

    // 心跳仍指向实例 1 且其 pid 存活（实例 2 至死未碰证据文件）
    const hb = await readJsonOrNull(path.join(forensicsDirOf(primary!), 'heartbeat.json'))
    expect(hb?.pid).toBe(primaryHeartbeatPid)
    expect(isPidAlive(primaryHeartbeatPid), '实例 1 心跳 pid 应仍存活').toBe(true)
  })
})
