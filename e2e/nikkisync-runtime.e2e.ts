/**
 * 内嵌 NikkiSync Runtime 的真实应用会话验证（整合阶段 2 · 验收项 1/2/3/4/5/7；
 * 阶段 3 追加 N3b 同步服务的跨进程证据）
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
 *   5. （阶段 3）`nikkisync:start-server` 让**上游 LocalSyncServer** 在真实主进程里监听 28080，
 *      e2e 进程用库内自签证书作 CA 做真校验取到 `/v1/server` 200 与未鉴权 401，配对串的指纹
 *      与 TLS 身份一致；`stop-server` 后端口拒绝连接，`before-quit` 后仍保持释放。
 *
 * 游戏根：优先 `NIKKI_NIKKISYNC_GAME_ROOT`，其次本机常见安装位；都不存在时本轮只验 degraded 分支
 * （资产类断言显式 skip，绝不把环境缺失伪装成逻辑失败）。
 *
 * 类型口径：不在此 `declare global` 覆写 `Window.electronAPI`——同 tsconfig program 内
 * smoke.e2e.ts 已有同名声明，合并会直接红 `typecheck:e2e`；改为局部类型 + method/arg 派发。
 */
import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import https from 'node:https'
import net from 'node:net'
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
  /** 上游 `scanner.getStatus()` 展平：status / installation? / lastScan? */
  scannerStatus?: string
  installation?: unknown
  lastScan?: unknown
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
  | { method: 'serverStatus' }
  | { method: 'startServer' }
  | { method: 'stopServer' }
  | { method: 'pairingCode' }

/** 阶段 3 的服务面返回值（与 `NikkiSyncServerStatusInfo` 同形，此处只做本地窄化） */
interface ServerStatus {
  available: boolean
  running: boolean
  host: string
  port: number
  secure?: boolean
  serverId?: string
  mdnsEnabled: boolean
  tlsFingerprintSha256?: string
  serverCertificatePem?: string
  lanHost?: string
  error?: string
}

interface PairingCode {
  content: string
  expiresAt: string
  serverId: string
  host: string
  port: number
  tlsFingerprintSha256: string
}

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
    if (input.method === 'serverStatus') return await (bridge.getServerStatus as () => unknown)()
    if (input.method === 'startServer') return await (bridge.startServer as () => unknown)()
    if (input.method === 'stopServer') return await (bridge.stopServer as () => unknown)()
    if (input.method === 'pairingCode') return await (bridge.getPairingCode as () => unknown)()
    return await (bridge.getResource as (arg?: unknown) => unknown)(input.arg)
  }, call)
}

let launched: LaunchedApp | undefined
let win: Page | undefined
let status: RuntimeStatus | undefined
/** N3b 实际监听过的端口；N4 用它验证退出链真的把端口释放了（未启过服务则 undefined）。 */
let syncPort: number | undefined

/** 读取本次会话的主进程日志（electron-log 落在 `{userData}/logs/*.log`）。 */
async function readMainLogTail(session: LaunchedApp | undefined): Promise<string> {
  if (!session) return ''
  const logDir = path.join(session.userDataDir, 'logs')
  let names: string[] = []
  try {
    names = (await fs.readdir(logDir)).filter((name) => name.endsWith('.log'))
  } catch {
    return ''
  }
  return (
    await Promise.all(names.map((name) => fs.readFile(path.join(logDir, name), 'utf-8')))
  ).join('\n')
}

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

/** 端口在本机是否可占（e2e 用默认 28080，被占则如实 skip，不谎报“通过”）。 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve(true))
    })
  })
}

/**
 * 从**外部进程**用上游自签证书作 CA 发一次真校验的 HTTPS 请求
 * （等价手机侧 pin 指纹后的行为；不关验证，因此这条证据是真的）。
 */
function httpsFromTest(port: number, ca: string, requestPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: '127.0.0.1', port, path: requestPath, servername: 'nikkisync.local', ca },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

/** 连接是否已被拒绝（停止服务的客观判据）。 */
function connectionRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', () => resolve(true))
  })
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

  test('N3b 同步服务：真实主进程内启上游 LocalSyncServer，外部进程用证书做真校验并停得干净', async () => {
    if (!status) {
      test.skip(true, 'N1 未取到 runtime 状态')
      return
    }
    if (!status.linkReady) {
      test.skip(true, '未建链：同步服务面不可用（受支持的默认态）')
      return
    }
    // 上游对 EADDRINUSE 不重试（本阶段刻意不代其发明兜底）⇒ 端口被占只能如实 skip
    const free = await isPortFree(28080)
    test.skip(!free, '默认端口 28080 已被其它进程占用，无法在本机复现该判据')

    const started = await callBridge<ServerStatus>({ method: 'startServer' })
    expect(started.available).toBe(true)
    expect(started.running).toBe(true)
    expect(started.secure).toBe(true)
    expect(started.port).toBe(28080)
    expect(started.tlsFingerprintSha256).toHaveLength(64)
    expect(started.serverCertificatePem).toContain('BEGIN CERTIFICATE')
    syncPort = started.port

    // 未鉴权请求必须被上游拒于 401（跨进程证据，不是同进程白盒调用）
    const unauthorized = await httpsFromTest(
      started.port,
      String(started.serverCertificatePem),
      '/v1/assets'
    )
    expect(unauthorized).toBe(401)
    // 免鉴权发现端点
    const serverInfo = await httpsFromTest(
      started.port,
      String(started.serverCertificatePem),
      '/v1/server'
    )
    expect(serverInfo).toBe(200)

    const code = await callBridge<PairingCode>({ method: 'pairingCode' })
    const segments = code.content.split('|')
    expect(segments).toHaveLength(7)
    expect(segments[0]).toBe('NS1')
    expect(segments[1]).toBe(started.serverId)
    expect(Number(segments[3])).toBe(started.port)
    // 二维码 pin 的指纹必须与库内 TLS 身份一致（否则手机侧 pinning 无从谈起）
    expect(code.tlsFingerprintSha256).toBe(started.tlsFingerprintSha256)
    expect(Date.parse(code.expiresAt)).toBeGreaterThan(Date.now())

    // 状态卡数据源（UI 每 2s 轮询的同一条通道）
    const again = await callBridge<ServerStatus>({ method: 'serverStatus' })
    expect(again.running).toBe(true)

    const stopped = await callBridge<ServerStatus>({ method: 'stopServer' })
    expect(stopped.running).toBe(false)
    expect(await connectionRefused(started.port)).toBe(true)
    // 注：不在此断主进程日志——electron-log 是异步落盘，运行中可能还没写；
    // 服务停止链的日志判据放在 N4（app.close() 之后，日志已 flush）。
  })

  test('N3c 设置页真实渲染：开关起服务、二维码 SVG 与设备列表在真实窗口里出图', async () => {
    const session = launched
    if (!session || !win) {
      test.skip(true, 'N1 未启动应用')
      return
    }
    if (!(await isPortFree(28080))) {
      test.skip(true, '默认端口 28080 已被占用（上游不重试，本阶段不代其发明兜底）')
      return
    }
    const page = win
    // 文案判据依赖语言：固定为 zh-CN 后重载（localStorage 只影响本次临时 userData）
    await page.evaluate(() => {
      localStorage.setItem('app-language', 'zh-CN')
      // 阶段3：设置页左导航的落点由 localStorage 决定，直接开到「同步服务」节
      localStorage.setItem('settings-active-section', 'sync-service')
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByTitle('设置').first().click()

    // 节标题与开关都来自真实 i18n 文本（不是测试内构造的 DOM）
    const toggle = page.getByRole('switch', { name: '启用同步服务' }).first()
    await toggle.waitFor({ timeout: 20_000 })
    await toggle.click()
    await expect
      .poll(
        async () =>
          page
            .getByText('运行中')
            .first()
            .isVisible()
            .catch(() => false),
        {
          timeout: 20_000,
          message: '开关点下后状态卡未出现「运行中」（服务没起或状态通道不通）'
        }
      )
      .toBe(true)

    // 设备列表：尚未配对 ⇒ 空态文案（不是报错态）。放在开弹窗之前，避免模态层影响可见性判定
    await expect(page.getByText('暂无已配对设备').first()).toBeVisible()

    // 二维码：真实窗口里由 qrcode 生成的 SVG 必须出图，且下方地址段与运行端口一致
    await page.getByRole('button', { name: '配对新设备' }).first().click()
    const surface = page.locator('.sync-qr-surface').first()
    await expect(surface.locator('svg')).toHaveCount(1, { timeout: 20_000 })
    const svgMarkup = await surface.innerHTML()
    expect(svgMarkup).toContain('<svg')
    // 一张真二维码的 SVG 远大于占位空壳：以此排除“渲染了但内容是空”的假绿
    expect(svgMarkup.length).toBeGreaterThan(2000)
    await expect(page.getByText(/:28080/).first()).toBeVisible({ timeout: 10_000 })
    // 有效期倒计时存在（上游默认 5 分钟）
    await expect(page.getByText('有效期').first()).toBeVisible()
    // 留一张真实窗口的视觉证据（二维码出图与否，看图比断言更直观）
    await page.screenshot({ path: path.join('test-results', 'nikkisync-pairing-qr.png') })
    await page.keyboard.press('Escape')

    // 故意让服务保持运行到 N4：退出链必须把它关掉并释放端口（N4 里断言）
    syncPort = 28080
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

    const text = await readMainLogTail(session)
    expect(text).toMatch(/\[NIKKISYNC\].*runtime start result: state=(running|degraded)/)
    expect(text).toMatch(/\[NIKKISYNC\] embedded runtime stopped/)
    expect(text).not.toMatch(/embedded runtime stop failed/)
    // 阶段 3：退出链必须先停 LAN 服务再关库；N3b 启过服务就要看到端口释放
    expect(text).not.toMatch(/server\.stop failed/)
    if (syncPort !== undefined) {
      expect(await connectionRefused(syncPort)).toBe(true)
    }

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
