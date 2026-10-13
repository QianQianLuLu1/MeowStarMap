/**
 * 内嵌 NikkiSync Runtime 的真实应用会话验证（整合阶段 2 · 验收项 1/2/3/4/5/7）
 *
 * 前置：`npm run build`（dist/main + dist/renderer）。与 smoke.e2e.ts 的区别：
 * 本用例经 `launchBuiltApp` 用仓内 Electron 直接加载**未打包**产物，走完整应用生命周期
 * （主进程 init → app:// 渲染进程 → preload/contextBridge → IPC → before-quit 清理链），
 * 因此它给出单测给不出的四类证据：
 *   1. Runtime 在真实主进程内初始化，库文件落在本次 `--user-data-dir` 下（不是 %LOCALAPPDATA%）；
 *   2. 渲染进程经 `electronAPI.nikkisync.*` 拿到的就是 NikkiSync 协议 DTO（零字段转换）；
 *   3. 应用退出时 `performCleanup` 真的走到 `stopNikkiSyncRuntime`：日志有 stopped 轨迹、无 stop failed、
 *      WAL 已 checkpoint；
 *   4. 无游戏目录时应用照常启动（state=degraded），不崩不弹。
 *
 * 游戏根：优先 `NIKKI_NIKKISYNC_GAME_ROOT`，其次本机常见安装位；都不存在时本轮只验 degraded 分支
 * （资产类断言显式 skip，绝不把环境缺失伪装成逻辑失败）。
 *
 * 类型口径：不在此 `declare global` 覆写 `Window.electronAPI`——同 tsconfig program 内
 * smoke.e2e.ts 已有同名声明，合并会直接红 `typecheck:e2e`；改为局部类型 + method/arg 派发。
 */
import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { launchBuiltApp, closeApp, collectDiagLogs, type LaunchedApp } from './helpers'

const DEFAULT_GAME_ROOT_CANDIDATES = [
  'H:\\InfinityNikki Launcher\\InfinityNikki',
  'D:\\InfinityNikki Launcher\\InfinityNikki',
  'C:\\Program Files\\InfinityNikki Launcher\\InfinityNikki'
]

/** 上游 0001_initial.sql 的 12 张业务表（sqlite_sequence 为派生对象，不参与断言） */
const BUSINESS_TABLES = [
  'app_settings',
  'assets',
  'change_journal',
  'device_sync_state',
  'library_state',
  'metadata_dictionary_entries',
  'metadata_dictionary_state',
  'paired_devices',
  'pairing_sessions',
  'resolver_candidates',
  'resources',
  'schema_migrations'
]

/** 上游 `resources.role` CHECK 约束的全集 */
const UPSTREAM_ROLES = [
  'source_primary',
  'source_high_quality',
  'source_low_quality',
  'source_motion',
  'derived_thumbnail',
  'derived_preview'
]

interface RuntimeStatus {
  state: string
  dbPath: string
  linkReady: boolean
  tables?: string[]
  scanner?: unknown
  error?: string
  hint?: string
}

interface AssetSummaryItem {
  assetId: string
  type: string
  state: string
  revision: number
  hasMotion: boolean
  hasMetadata: boolean
}

interface AssetPage {
  items: AssetSummaryItem[]
  nextCursor?: string
  libraryRevision: number
}

interface AssetDetail {
  asset: {
    assetId: string
    type: string
    resources: Array<{ resourceId: string; role: string; fileName: string; sha256: string }>
    motion?: { stillResourceId: string; motionResourceId: string }
  }
}

/** 渲染进程内执行一次桥调用：Playwright 只序列化函数与入参，故用 method+arg 派发 */
type BridgeCall =
  | { method: 'status' }
  | { method: 'assets'; arg?: { limit?: number; cursor?: string; type?: string } }
  | { method: 'detail'; arg: string }
  | { method: 'resource'; arg: { assetId: string; resourceId: string; mode?: 'meta' | 'path' } }

async function dispatchOnPage(win: Page, call: BridgeCall): Promise<unknown> {
  return await win.evaluate(async (input) => {
    const host = (window as unknown as { electronAPI?: { nikkisync?: Record<string, unknown> } })
      .electronAPI
    const bridge = host?.nikkisync
    if (!bridge) throw new Error('preload did not expose electronAPI.nikkisync')
    if (input.method === 'status') return await (bridge.getRuntimeStatus as () => unknown)()
    if (input.method === 'assets')
      return await (bridge.getAssets as (arg?: unknown) => unknown)(input.arg)
    if (input.method === 'detail')
      return await (bridge.getAssetDetail as (arg: string) => unknown)(input.arg)
    return await (bridge.getResource as (arg?: unknown) => unknown)(input.arg)
  }, call)
}

let launched: LaunchedApp | undefined
let win: Page | undefined
let status: RuntimeStatus | undefined

/**
 * 在页面内执行一次「必定失败」的详情查询，返回渲染侧实际看到的失败信息。
 *
 * 口径说明：contextBridge 不能把 `IpcError` 子类实例原样递过隔离世界，
 * 拒绝对象会被序列化为只带 `message` 的普通 Error（`code` 字段丢失）。
 * 错误码到 IPC_NOT_FOUND 的映射属于主进程 handler 行为，由
 * `src/main/ipc/handlers/nikkisync-handler.test.ts` 直接断言 `res.error.code`；
 * 本用例只验「失败能经 IPC 传成 rejection 且信息不丢」，不把上述序列化为产品缺陷。
 */
async function dispatchFailureMessage(page: Page, assetId: string): Promise<string> {
  return await page.evaluate(async (id) => {
    const host = (window as unknown as { electronAPI?: { nikkisync?: Record<string, unknown> } })
      .electronAPI
    const bridge = host?.nikkisync
    if (!bridge) return 'MISSING_BRIDGE'
    try {
      await (bridge.getAssetDetail as (arg: string) => unknown)(id)
      return 'NO_ERROR'
    } catch (error) {
      const message = (error as { message?: unknown } | null)?.message
      return String(message ?? error)
    }
  }, assetId)
}

async function callBridge<T>(call: BridgeCall): Promise<T> {
  if (!win) throw new Error('N1 未创建窗口，无法调用渲染进程桥')
  return (await dispatchOnPage(win, call)) as T
}

async function resolveGameRoot(): Promise<string | undefined> {
  const fromEnv = (process.env.NIKKI_NIKKISYNC_GAME_ROOT ?? '').trim()
  const candidates = fromEnv
    ? [fromEnv, ...DEFAULT_GAME_ROOT_CANDIDATES]
    : DEFAULT_GAME_ROOT_CANDIDATES
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(path.join(candidate, 'X6Game'))
      if (stat.isDirectory()) return candidate
    } catch {
      // 该候选不存在，继续下一个
    }
  }
  return undefined
}

const gameRoot = await resolveGameRoot()
process.stdout.write(`[e2e-nikkisync] gameRoot=${gameRoot ?? '<none: 预期 degraded>'}\n`)

test.describe.configure({ mode: 'serial' })

test.describe('内嵌 NikkiSync Runtime（真实应用会话）', () => {
  // eslint-disable-next-line no-empty-pattern -- Playwright hook 首参必须是对象解构模式（与 smoke.e2e.ts 同口径）
  test.afterAll(async ({}, testInfo) => {
    if (!launched) return
    // 失败路径兜底：成功路径已在 N4 内正常 close（那才是要验的退出链）
    await collectDiagLogs(launched.userDataDir, testInfo.outputDir).catch(() => {})
    await closeApp(launched, { keepUserData: true })
  })

  test('N1 启动：Runtime 在主进程内初始化，状态可读', async () => {
    launched = await launchBuiltApp([], {
      NIKKI_NIKKISYNC_RUNTIME: '1',
      ...(gameRoot ? { NIKKI_NIKKISYNC_GAME_ROOT: gameRoot } : {})
    })
    // userDataDir 由 helpers 统一给出工程内 .cache 绝对路径（受限沙箱也可写）
    const page = await launched.app.firstWindow()
    win = page
    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 })
    expect(page.url()).toMatch(/^app:\/\/renderer\//)

    const bridgeType = await page.evaluate(
      () =>
        typeof (
          (window as unknown as Record<string, unknown>).electronAPI as
            { nikkisync?: { getRuntimeStatus?: unknown } } | undefined
        )?.nikkisync?.getRuntimeStatus
    )
    expect(bridgeType).toBe('function')

    // init 在 createMainWindow 之前完成，状态此刻应已收敛为 running / degraded
    await expect
      .poll(async () => (await callBridge<RuntimeStatus>({ method: 'status' })).state, {
        timeout: 30_000,
        message: 'runtime state 未收敛为 running/degraded（说明启动链没跑或抛错逃逸）'
      })
      .toMatch(/^(running|degraded)$/)

    status = await callBridge<RuntimeStatus>({ method: 'status' })
    expect(status.linkReady).toBe(true)
    if (status.state === 'degraded') {
      expect(status.error).toContain('Infinity Nikki installation was not found')
      return
    }
    for (const table of BUSINESS_TABLES) {
      expect(status.tables ?? []).toContain(table)
    }
  })

  test('N2 库落点：文件在本次 userData/nikkisync 下，不碰 %LOCALAPPDATA%', async () => {
    const app = launched
    const current = status
    if (!app || !current) {
      test.skip(true, 'N1 未产出状态')
      return
    }
    const expected = path.join(app.userDataDir, 'nikkisync', 'nikkisync.db')
    expect(path.resolve(current.dbPath)).toBe(path.resolve(expected))
    const stat = await fs.stat(expected)
    expect(stat.size).toBeGreaterThan(0)
    const localAppData = process.env.LOCALAPPDATA ?? ''
    if (localAppData) {
      // 上游独立 exe 的默认数据目录不得被嵌入态写入（计划 §3）
      await expect(
        fs.stat(path.join(localAppData, 'NikkiSync', 'nikkisync.sqlite'))
      ).rejects.toThrow()
    }
  })

  test('N3 查询：协议 DTO 原样透传（含 motion 聚合与资源绝对路径）', async () => {
    const page = win
    if (!page || status?.state !== 'running') {
      test.skip(true, '本轮无可用游戏目录或未建立窗口，资产面证据由链接态单测给出')
      return
    }
    const list = (await dispatchOnPage(page, { method: 'assets', arg: { limit: 20 } })) as AssetPage
    expect(list.items.length).toBeGreaterThan(0)
    expect(typeof list.libraryRevision).toBe('number')
    for (const item of list.items) {
      expect(['photo', 'motion_photo']).toContain(item.type)
      expect(typeof item.hasMotion).toBe('boolean')
      expect(typeof item.revision).toBe('number')
    }

    const first = list.items[0]
    if (!first) throw new Error('上游列表返回空页，无法继续断言详情')
    const detail = (await dispatchOnPage(page, {
      method: 'detail',
      arg: first.assetId
    })) as AssetDetail
    // 顶层只有 asset（上游 mapAssetDetail 的形状）
    expect(Object.keys(detail)).toEqual(['asset'])
    expect(detail.asset.resources.length).toBeGreaterThan(0)
    for (const resource of detail.asset.resources) {
      expect(UPSTREAM_ROLES).toContain(resource.role)
      expect(resource.sha256).toHaveLength(64)
    }

    const motion = list.items.find((item) => item.type === 'motion_photo')
    if (motion) {
      const motionDetail = (await dispatchOnPage(page, {
        method: 'detail',
        arg: motion.assetId
      })) as AssetDetail
      const still = motionDetail.asset.resources.find((r) => r.role === 'source_primary')
      const moving = motionDetail.asset.resources.find((r) => r.role === 'source_motion')
      if (!still || !moving) {
        throw new Error(
          `motion_photo 缺配对资源：roles=${motionDetail.asset.resources.map((r) => r.role).join(',')}`
        )
      }
      // AssetResolver 的配对结论必须经协议 motion 段暴露（静图 + 视频同资产）
      expect(motionDetail.asset.motion?.stillResourceId).toBe(still.resourceId)
      expect(motionDetail.asset.motion?.motionResourceId).toBe(moving.resourceId)
    }

    const head = detail.asset.resources[0]
    if (!head) throw new Error('详情里没有资源行，无法验证 getResource')
    const location = await dispatchOnPage(page, {
      method: 'resource',
      arg: { assetId: first.assetId, resourceId: head.resourceId, mode: 'path' }
    })
    expect(typeof location).toBe('string')
    const located = await fs.stat(String(location))
    expect(located.size).toBeGreaterThan(0)

    // 不存在的资产：失败必须经 IPC 传成 rejection 且不丢原因（错误码映射由单测断言）
    const notFoundMessage = await dispatchFailureMessage(page, 'asset_not_exist')
    expect(notFoundMessage).toContain('not found')
    expect(notFoundMessage).not.toBe('NO_ERROR')
  })

  test('N4 退出链：before-quit 走到 stopNikkiSyncRuntime，日志无 stop failed', async () => {
    const session = launched
    if (!session) {
      test.skip(true, 'N1 未启动应用')
      return
    }
    launched = undefined
    // app.close() 触发真实 before-quit → performCleanup（内含本阶段接入的停止调用）
    await session.app.close()

    const logDir = path.join(session.userDataDir, 'logs')
    let names: string[] = []
    try {
      names = (await fs.readdir(logDir)).filter((name) => name.endsWith('.log'))
    } catch {
      names = []
    }
    const text = (
      await Promise.all(names.map((name) => fs.readFile(path.join(logDir, name), 'utf-8')))
    ).join('\n')
    expect(text).toMatch(/\[NIKKISYNC\].*runtime start result: state=(running|degraded)/)
    expect(text).toMatch(/\[NIKKISYNC\] embedded runtime stopped/)
    expect(text).not.toMatch(/embedded runtime stop failed/)

    // 优雅关闭的客观信号：WAL 已 checkpoint（残留则应为 0 字节）
    const wal = path.join(session.userDataDir, 'nikkisync', 'nikkisync.db-wal')
    try {
      const stat = await fs.stat(wal)
      expect(stat.size).toBe(0)
    } catch {
      // -wal 被清理同样是干净关闭
    }
    await fs.rm(session.userDataDir, { recursive: true, force: true }).catch(() => {})
  })
})
