import { _electron as electron, type ElectronApplication } from '@playwright/test'
import fsSync from 'node:fs'
import { glob } from 'tinyglobby'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { detectTscOverwrittenDist } from './dist-guard'

/** 工程根目录（e2e/ 的上一级；项目 type=module，用 import.meta.url 定位而非 __dirname） */
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 定位 win-unpacked 产物 exe。
 * exe 名跟随 productName（"喵星图"，含中文），禁止硬编码文件名；
 * 统一用 glob 结果的绝对路径传给 executablePath，避免 PowerShell/编码拼接问题。
 */
export async function findUnpackedExe(): Promise<string> {
  const [exe] = await glob(['release/win-unpacked/*.exe'], { absolute: true, cwd: ROOT_DIR })
  if (!exe) {
    throw new Error('未找到 release/win-unpacked/*.exe，请先执行 npm run dist:win 产出打包产物')
  }
  return exe
}

/**
 * 版本期望值运行时读取 package.json，不硬编码（避免版本号演进后断言失效）。
 */
export function readExpectedVersion(): string {
  const require_ = createRequire(import.meta.url)
  const pkg = require_(path.join(ROOT_DIR, 'package.json')) as { version: string }
  return pkg.version
}

export interface LaunchedApp {
  app: ElectronApplication
  /** 本次冒烟独占的临时 userData 目录（全新用户 → 覆盖首启建库/迁移路径） */
  userDataDir: string
}

export interface LaunchOptions {
  /**
   * 复用指定 userData 目录（默认每次新建 .cache/e2e-smoke-<ts>）。
   * 用途：同一份库做「二次启动」测量——只有复用目录才能看出跨会话是否重复生成。
   */
  userDataDir?: string
}

/**
 * 用产物自带 Electron 启动应用（Playwright 官方 _electron.launch，无需下载浏览器二进制）。
 * --user-data-dir 指向临时目录：隔离 CI 残留/本机数据，并验证首启建库迁移路径。
 */
export async function launchApp(options: LaunchOptions = {}): Promise<LaunchedApp> {
  const exe = await findUnpackedExe()
  // userData 放工程内 .cache/：兼容受限沙箱（仅允许写工作区）；CI 上同样可用
  const userDataDir =
    options.userDataDir ?? path.join(ROOT_DIR, '.cache', `e2e-smoke-${Date.now()}`)
  // 排障线索：打印解析到的 exe 与 userData（中文路径风险项，见计划 §7.2）
  process.stdout.write(`[e2e] executable: ${exe}\n`)
  process.stdout.write(`[e2e] userData:   ${userDataDir}\n`)

  const app = await electron.launch({
    executablePath: exe,
    // 必须用 --user-data-dir=<path> 等号形式：Electron 的 app.getPath('userData')
    // 只解析等号形式的 switch 值，空格分隔形式（--user-data-dir <path>）会被忽略，
    // 导致 userData 落回默认 Roaming、隔离失效（含空格路径仍正确保留）。
    args: [`--user-data-dir=${userDataDir}`],
    env: { ...process.env, NODE_ENV: 'production' },
    timeout: 30_000
  })
  return { app, userDataDir }
}

/**
 * 失败现场采集：把临时 userData 下的主进程日志拷入 Playwright 结果目录，
 * 随失败 artifact 一并上传（计划 §4.1 / §5）。
 * 采集范围覆盖三类现场：
 * 1. userDataDir/logs/*.log|*.jsonl（electron-log 正常落盘）
 * 2. userDataDir/diag.log、startup-errors.log（启动早期诊断日志，whenReady 后落盘）
 * 3. %APPDATA%/meow-star-map/diag.log（whenReady 前 diagLog 的 APPDATA fallback，
 *    INDEX loaded 等早期行落在那里；仅保留最近 5 分钟行，避免混入历史运行）
 */
export async function collectDiagLogs(userDataDir: string, destDir: string): Promise<void> {
  await fs.mkdir(destDir, { recursive: true })

  // 1) 主进程日志目录 logs/*.log|*.jsonl（正常路径）
  const logDir = path.join(userDataDir, 'logs')
  let entries: Dirent[] = []
  try {
    entries = await fs.readdir(logDir, { withFileTypes: true })
  } catch {
    // logs 目录不存在（可能启动即崩），继续采集其他现场
  }
  await Promise.all(
    entries
      .filter((e) => e.isFile() && (e.name.endsWith('.log') || e.name.endsWith('.jsonl')))
      .map(async (e) => {
        try {
          await fs.copyFile(path.join(logDir, e.name), path.join(destDir, e.name))
        } catch {
          // 单个日志拷贝失败（如被进程占用）不阻塞采集其余文件
        }
      })
  )

  // 2) 启动早期诊断日志（本次运行间隔内）
  const candidates: Array<[string, string]> = [
    [path.join(userDataDir, 'diag.log'), 'diag.log'],
    [path.join(userDataDir, 'startup-errors.log'), 'startup-errors.log'],
    [path.join(process.env.APPDATA ?? '', 'meow-star-map', 'diag.log'), 'appdata-diag.log']
  ]
  await Promise.all(
    candidates.map(async ([src, name]) => {
      try {
        const content = await fs.readFile(src, 'utf-8')
        if (!content.trim()) return
        // APPDATA 全局日志可能含历史运行行，仅保留最近 5 分钟内时间戳行避免串档；
        // 非时间戳行（异常堆栈续行）随前置行一并保留
        const cutoff = Date.now() - 5 * 60_000
        const kept = content
          .split('\n')
          .filter((line) => {
            const m = line.match(/^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\]/)
            if (!m) return true
            return Date.parse(m[1]) >= cutoff
          })
          .join('\n')
        if (kept.trim()) await fs.writeFile(path.join(destDir, name), kept)
      } catch {
        // 文件不存在或读取失败 → 跳过该采集点
      }
    })
  )
}

/**
 * 用仓内 Electron 直接加载**未打包**但已 `npm run build` 的产物（dist/main + dist/renderer）。
 *
 * 为什么需要：`launchApp` 依赖 `release/win-unpacked/*.exe`（需 `npm run dist:win`），
 * 而部分开发机/CI 环境无法拉取 Electron 发行包完成打包。本函数跳过 asar 打包环节，
 * 仍走真实应用会话（`app://` 协议 + preload + 完整 before-quit 退出链），
 * 差异只在 `app.isPackaged=false`（装载缝因此走开发态 specifier，不取 asar.unpacked）。
 *
 * NODE_ENV 固定为 production：window-manager 据此走 `app://renderer/index.html` 而非 vite dev server。
 */
export async function launchBuiltApp(
  args: string[] = [],
  extraEnv: Record<string, string> = {},
  options: LaunchOptions = {}
): Promise<LaunchedApp> {
  const exe = path.join(ROOT_DIR, 'node_modules', 'electron', 'dist', 'electron.exe')
  if (!fsSync.existsSync(exe)) {
    throw new Error(`未找到 Electron 可执行文件：${exe}（请先 npm install）`)
  }
  if (!fsSync.existsSync(path.join(ROOT_DIR, 'dist', 'main', 'main', 'app', 'index.js'))) {
    throw new Error('未找到 dist/main/main/app/index.js，请先执行 npm run build')
  }
  // 产物形态守卫：dist/main 若被 tsc -b 覆写成 per-file CJS，这里直接给出原因，
  // 不要让「preload 桥整体缺失」伪装成被测代码的缺陷（判据与背景见 e2e/dist-guard.ts）
  const preloadPath = path.join(ROOT_DIR, 'dist', 'main', 'main', 'preload.js')
  const preloadHead = fsSync.existsSync(preloadPath)
    ? fsSync.readFileSync(preloadPath, 'utf-8')
    : ''
  const guard = detectTscOverwrittenDist(
    preloadHead,
    fsSync.existsSync(path.join(path.dirname(preloadPath), 'preload.d.ts'))
  )
  if (guard) {
    throw new Error(guard)
  }
  const userDataDir =
    options.userDataDir ?? path.join(ROOT_DIR, '.cache', `e2e-built-${Date.now()}`)
  process.stdout.write(`[e2e] executable (unpackaged): ${exe}\n`)
  process.stdout.write(`[e2e] userData:                ${userDataDir}\n`)

  const app = await electron.launch({
    executablePath: exe,
    // 第一个非 switch 参数即应用路径（仓根 package.json 的 main 指向 dist/main/main/app/index.js）
    args: [ROOT_DIR, `--user-data-dir=${userDataDir}`, ...args],
    env: { ...process.env, NODE_ENV: 'production', ...extraEnv },
    timeout: 60_000
  })
  return { app, userDataDir }
}

/**
 * 关闭兜底（计划 §5）：close 失败（如 8s 白屏诊断原生对话框阻塞）时 kill 进程，
 * 防止 CI 挂起；tempDir 清理失败容忍（Windows 文件锁）。
 */
export async function closeApp(
  launched: LaunchedApp | undefined,
  options: { keepUserData?: boolean } = {}
): Promise<void> {
  if (!launched) return
  try {
    await launched.app.close()
  } catch {
    try {
      launched.app.process().kill()
    } catch {
      // 进程已退出
    }
  }
  // keepUserData：二次启动测量需要保留同一份库与 Chromium 磁盘缓存，交由调用方清理
  if (options.keepUserData) return
  try {
    await fs.rm(launched.userDataDir, { recursive: true, force: true })
  } catch {
    // 临时目录清理失败不影响测试结果
  }
}
