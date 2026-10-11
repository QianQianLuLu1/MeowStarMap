import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import Database from 'better-sqlite3'
import sharp from 'sharp'
import type DatabaseType from 'better-sqlite3'
import {
  SYNC_METADATA_DDL_STATEMENTS,
  SyncMetadataRepository
} from '../../src/main/database/sync-metadata-repository'
import {
  SYNC_PAIRING_DDL_STATEMENTS,
  SyncPairingRepository
} from '../../src/main/database/sync-pairing-repository'
import { SyncReadRepository } from '../../src/main/database/sync-read-repository'
import { AuthService } from '../../src/main/sync/auth-service'
import { PairingService } from '../../src/main/sync/pairing-service'
import { SyncIdentityService } from '../../src/main/sync/identity-service'
import { SyncServer } from '../../src/main/sync/server/sync-server'
import type { SyncApiServices, SyncEventSink } from '../../src/main/sync/server/types'
import type { WsEvent } from '../../src/shared/sync/protocol'
import { parseArgs } from './launch-args'

/**
 * E2E 联调启动器（阶段 6，docs/sync-integration/06-e2e-plan.md §3.1）。
 *
 * 以 sync-server-setup.ts 同款装配链在进程内启动真实同步服务端：
 * 真实 SQLite（临时目录，schema 列面 = sync 读取面，语义同 connection.ts 迁移）+
 * 真实 TLS 身份 + AuthService/PairingService + SyncReadRepository + SyncServer。
 * 与装配层的唯一差异：无 Electron（userData 目录、设置开关由 CLI 参数替代）。
 *
 * - fixture：sharp 生成 JPEG 照片（含缩略图）/同名 motion 对/视频/已删除项，
 *   motion 链接走真实 rebuildMotionLinks（同名约定），journal 走真实事件汇
 * - stdout 输出一行 `WXNN_E2E_INFO {json}`：端口/身份/指纹/配对 URI/控制端口
 * - 控制端口（仅 127.0.0.1）：注入新资产（journal+WS 广播）、创建新鲜/过期
 *   配对会话、广播 rescan 事件——供跨仓库驱动测试（NikkiSync 侧）与 S13 使用
 * - 运行方式：`ELECTRON_RUN_AS_NODE=1 electron --import tsx launch-server.ts`
 *   （原生 better-sqlite3 为 Electron ABI，plain Node 不可加载，已实测）
 *
 * 用法：
 *   --host 0.0.0.0        监听地址（默认 127.0.0.1）
 *   --port 27124          监听端口（默认 0 = 系统分配；须为 0–65535 整数）
 *   --pair-host 10.0.2.2  配对 URI 中的 host（默认 = host，0.0.0.0 时取首个私有 IPv4）
 *   --data-dir <dir>      数据目录（默认临时目录；自建临时目录在退出时尽力删除）
 *   --qr                  额外输出终端二维码（供真机扫码配对）
 *   --serve               长驻运行（默认行为，兼容文档历史写法的 no-op 标志）
 *
 * 退出清理：SIGINT/SIGTERM 优雅退出会停服并删除自建临时目录（--data-dir 指定的目录
 * 交给调用方管理、不删）；Windows 下 taskkill /F 等强杀不会触发任何清理，WAL 与
 * 临时目录会残留（测试工具风险自洽）。
 */

// ============================================================================
// media_files 建表（仅 sync 读取面所需列；列名/语义与 connection.ts 迁移一致，
// 非同步面的列省略。启动器自管插入，不走应用迁移）
// ============================================================================

const MEDIA_FILES_DDL = `
  CREATE TABLE IF NOT EXISTS media_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL UNIQUE,
    file_name TEXT NOT NULL,
    file_type TEXT NOT NULL,
    file_ext TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    duration REAL,
    created_at TEXT NOT NULL,
    modified_at TEXT NOT NULL,
    source_path TEXT NOT NULL DEFAULT '',
    thumbnail TEXT,
    indexed_at TEXT NOT NULL,
    account_uid TEXT NOT NULL DEFAULT '',
    is_deleted INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,
    is_missing INTEGER NOT NULL DEFAULT 0,
    is_corrupted INTEGER NOT NULL DEFAULT 0,
    editor_metadata TEXT,
    is_duplicate INTEGER NOT NULL DEFAULT 0,
    sha256 TEXT
  )
`

const SQL_MEDIA_INSERT = `
  INSERT INTO media_files
    (file_path, file_name, file_type, file_ext, file_size, width, height, duration,
     created_at, modified_at, thumbnail, indexed_at, account_uid, is_deleted, deleted_at,
     editor_metadata, sha256)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`

function nowIso(): string {
  return new Date().toISOString()
}

function log(message: string): void {
  process.stdout.write(`[sync-e2e] ${message}\n`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const ownsDataDir = args.dataDir === null
  const dataDir = args.dataDir ?? mkdtempSync(path.join(tmpdir(), 'wxnn-sync-e2e-'))
  mkdirSync(dataDir, { recursive: true })
  const db: DatabaseType.Database = new Database(path.join(dataDir, 'wxnn-sync-e2e.db'))
  db.pragma('journal_mode = WAL')
  // 退出清理（exit 处理器按注册顺序执行）：先关 DB——启动失败路径不会走 shutdown 的
  // 显式 close，而 Windows 下打开的 SQLite 文件无法被删除；自建临时目录再尽力删除
  // （--data-dir 指定的目录交由调用方管理、不删）。Windows 强杀（taskkill /F）不触发
  // exit 事件，属文件头注记的已知局限
  process.on('exit', () => {
    try {
      db.close()
    } catch {
      // 优雅退出路径已显式关闭
    }
  })
  if (ownsDataDir) {
    process.on('exit', () => {
      try {
        rmSync(dataDir, { recursive: true, force: true })
      } catch {
        // 退出阶段的尽力清理，失败不再上报
      }
    })
  }

  // ============ 真实 SQLite + sync 全表 schema ============
  const ddlStatements = [
    MEDIA_FILES_DDL,
    ...SYNC_METADATA_DDL_STATEMENTS,
    ...SYNC_PAIRING_DDL_STATEMENTS
  ]
  for (const statement of ddlStatements) {
    db.prepare(statement).run()
  }

  // ============ 装配链（同 sync-server-setup.ts，去 Electron 化） ============
  const identity = new SyncIdentityService({
    directory: path.join(dataDir, 'sync'),
    logger: { info: log, warn: (m) => log(`WARN ${m}`) }
  })
  const tlsIdentity = identity.getOrCreateTlsIdentity()
  const metadata = new SyncMetadataRepository(db, null, dataDir)
  const sessions = new SyncPairingRepository(db, null, dataDir)
  const reads = new SyncReadRepository(db, null, dataDir)
  const auth = new AuthService({
    getDevice: (deviceId) => metadata.getPairedDevice(deviceId),
    touchDevice: (deviceId) => void metadata.touchDevice(deviceId)
  })
  const pairing = new PairingService({ sessions, devices: metadata, identity })

  const services: SyncApiServices = {
    getServerInfo: () => reads.getServerInfo(),
    getServerIdentity: () => metadata.ensureServerIdentity(),
    getCurrentRevision: () => metadata.getCurrentRevision(),
    listAssets: (query) => reads.listAssets(query),
    getAssetDetail: (assetId) => reads.getAssetDetail(assetId),
    getResourceLocation: (assetId, resourceId) => reads.getResourceLocation(assetId, resourceId),
    getChanges: (after, limit) => reads.getChanges(after, limit),
    verifyRequest: (input) => auth.verifyRequest(input),
    redeemToken: (request) => pairing.redeemToken(request)
  }

  const server = new SyncServer(services, {
    host: args.host,
    port: args.port,
    tls: { key: tlsIdentity.keyPem, cert: tlsIdentity.certPem },
    logger: { info: log, warn: (m) => log(`WARN ${m}`) }
  })

  const broadcastSafe = (event: WsEvent): void => {
    try {
      server.broadcastEvent(event)
    } catch (error) {
      log(`broadcast failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const events: SyncEventSink = {
    recordAssetChange: async (eventType, assetId) => {
      const { revision } = await metadata.recordAssetChange({ eventType, assetId })
      broadcastSafe({ event: eventType, revision, assetId, occurredAt: nowIso() })
    },
    recordAssetChanges: async (changes) => {
      if (changes.length === 0) return 0
      await metadata.recordAssetChanges(changes)
      const last = changes[changes.length - 1]!
      broadcastSafe({
        event: last.eventType,
        revision: metadata.getCurrentRevision(),
        assetId: last.assetId,
        occurredAt: nowIso()
      })
      return changes.length
    },
    broadcastRescanStarted: async () => {
      broadcastSafe({
        event: 'library.rescan.started',
        revision: metadata.getCurrentRevision(),
        occurredAt: nowIso()
      })
    },
    broadcastRescanCompleted: async (changedAssets) => {
      broadcastSafe({
        event: 'library.rescan.completed',
        revision: metadata.getCurrentRevision(),
        occurredAt: nowIso(),
        changedAssets
      })
    }
  }

  // ============ fixture 注入（真实仓储 + 真实事件汇） ============
  const mediaDir = path.resolve(dataDir, 'photos')
  mkdirSync(mediaDir, { recursive: true })

  /** fixture 文件名白名单 + 媒体目录边界校验（纵深防御；文件名均为本脚本生成的常量） */
  const MEDIA_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
  function resolveMediaPath(fileName: string): string {
    if (!MEDIA_FILENAME_PATTERN.test(fileName)) {
      throw new Error(`invalid fixture media file name: ${fileName}`)
    }
    const resolved = path.resolve(mediaDir, fileName)
    if (resolved !== mediaDir && !resolved.startsWith(mediaDir + path.sep)) {
      throw new Error(`fixture media path escapes media dir: ${fileName}`)
    }
    return resolved
  }

  async function makeJpeg(width: number, height: number, color: string): Promise<Buffer> {
    return sharp({ create: { width, height, channels: 3, background: color } })
      .jpeg()
      .toBuffer()
  }

  interface InsertOptions {
    fileName: string
    bytes: Buffer
    fileType?: 'image' | 'video'
    width?: number
    height?: number
    duration?: number | null
    thumbnailBytes?: Buffer
    deleted?: boolean
    modifiedAt: string
    editorMetadata?: Record<string, unknown>
  }

  const insertMediaStmt = db.prepare(SQL_MEDIA_INSERT)
  const journalInputs: Array<{
    eventType: 'asset.created' | 'asset.updated' | 'asset.deleted'
    assetId: string
  }> = []
  let seq = 0

  function insertMedia(options: InsertOptions): number {
    seq++
    const resolvedPath = resolveMediaPath(options.fileName)
    writeFileSync(resolvedPath, options.bytes)
    const ext = options.fileName.slice(options.fileName.lastIndexOf('.') + 1).toLowerCase()
    let thumbnailPath: string | null = null
    if (options.thumbnailBytes) {
      thumbnailPath = resolveMediaPath(`thumb_${seq}.jpg`)
      writeFileSync(thumbnailPath, options.thumbnailBytes)
    }
    const info = insertMediaStmt.run(
      resolvedPath,
      options.fileName,
      options.fileType ?? 'image',
      ext,
      options.bytes.length,
      options.width ?? null,
      options.height ?? null,
      options.duration ?? null,
      options.modifiedAt,
      options.modifiedAt,
      thumbnailPath,
      options.modifiedAt,
      '10001',
      options.deleted ? 1 : 0,
      options.deleted ? options.modifiedAt : null,
      options.editorMetadata ? JSON.stringify(options.editorMetadata) : null,
      null
    )
    const id = Number(info.lastInsertRowid)
    journalInputs.push({ eventType: 'asset.created', assetId: String(id) })
    return id
  }

  const baseTime = Date.parse('2026-10-01T00:00:00.000Z')

  // 6 张照片（时间递增 → keyset 分页有多页可走）
  for (let i = 1; i <= 6; i++) {
    const bytes = await makeJpeg(
      64 + i,
      64,
      ['#ff0000', '#00aa00', '#0000ff', '#ffaa00', '#aa00ff', '#00aaaa'][i - 1] ?? '#888888'
    )
    const modifiedAt = new Date(baseTime + i * 60_000).toISOString()
    insertMedia({
      fileName: `photo_${i}.jpg`,
      bytes,
      width: 64 + i,
      height: 64,
      modifiedAt,
      // 第 2、4 张带编辑元数据（hasMetadata=true + 详情 metadata）；
      // raw 顶层注入上游样式的 nativeParam* 键，验证隐私剥离契约（S6 红灯→绿灯）
      editorMetadata:
        i % 2 === 0
          ? {
              nativeParamToken: 'token-visible',
              nativeParamPayload: 'e2e-private',
              nativeParamNuan5Md5: '0123456789abcdef0123456789abcdef',
              filter: { name: '暖阳' }
            }
          : undefined,
      // 第 3 张带派生缩略图（thumbnailResourceId + previewResourceId=thumbnail）
      thumbnailBytes: i === 3 ? await makeJpeg(16, 16, '#eeeeee') : undefined
    })
  }

  // motion 对（同名约定：motion_photo.jpg + motion_photo.mp4 → rebuildMotionLinks 建链）
  const motionStill = await makeJpeg(96, 96, '#123456')
  insertMedia({
    fileName: 'motion_photo.jpg',
    bytes: motionStill,
    width: 96,
    height: 96,
    modifiedAt: new Date(baseTime + 7 * 60_000).toISOString()
  })
  const motionVideo = Buffer.alloc(4096, 0x5a)
  insertMedia({
    fileName: 'motion_photo.mp4',
    bytes: motionVideo,
    fileType: 'video',
    width: 96,
    height: 96,
    duration: 2.5,
    modifiedAt: new Date(baseTime + 7 * 60_000).toISOString()
  })

  // 普通视频
  const videoBytes = Buffer.alloc(8192, 0xa5)
  insertMedia({
    fileName: 'clip.mp4',
    bytes: videoBytes,
    fileType: 'video',
    width: 320,
    height: 240,
    duration: 12.5,
    modifiedAt: new Date(baseTime + 8 * 60_000).toISOString()
  })

  // 已删除照片（仅 includeDeleted=true 可见）
  const deletedBytes = await makeJpeg(32, 32, '#333333')
  insertMedia({
    fileName: 'deleted.jpg',
    bytes: deletedBytes,
    width: 32,
    height: 32,
    deleted: true,
    modifiedAt: new Date(baseTime + 9 * 60_000).toISOString()
  })

  const paired = await metadata.rebuildMotionLinks()
  await events.recordAssetChanges(journalInputs)
  log(`fixtures injected: ${journalInputs.length} assets, motion links paired=${paired.paired}`)

  // ============ 启动 HTTPS 同步服务 ============
  const address = await server.start()

  // ============ 控制端口（仅 127.0.0.1，供测试进程触发变更/会话） ============
  const control = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const reply = (status: number, body: unknown): void => {
      const data = Buffer.from(JSON.stringify(body), 'utf8')
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(data)
    }
    void handleControl(req, url).then(
      (body) => reply(200, body),
      (error: unknown) =>
        reply(500, { error: error instanceof Error ? error.message : String(error) })
    )
  })

  async function handleControl(req: IncomingMessage, url: URL): Promise<unknown> {
    if (req.method === 'GET' && url.pathname === '/status') {
      const status = server.getStatus()
      return {
        running: status.running,
        connections: status.connections,
        libraryRevision: metadata.getCurrentRevision(),
        pairedDevices: metadata.listActivePairedDevices().length
      }
    }
    if (req.method === 'GET' && url.pathname === '/tls-cert') {
      // 供测试驱动取证书 PEM（驱动校验指纹后才钉扎为唯一 CA；仅 loopback 控制端口可达）
      return { certPem: tlsIdentity.certPem }
    }
    if (req.method === 'POST' && url.pathname === '/assets') {
      // 注入新照片资产：落盘 → 入库 → 单条事件（journal + WS 广播）
      const bytes = await makeJpeg(80, 80, '#0a7ebe')
      const id = insertMedia({
        fileName: `injected_${Date.now()}.jpg`,
        bytes,
        width: 80,
        height: 80,
        modifiedAt: nowIso()
      })
      await events.recordAssetChange('asset.created', String(id))
      return { assetId: String(id), libraryRevision: metadata.getCurrentRevision() }
    }
    if (req.method === 'POST' && url.pathname === '/pairing-session') {
      let ttlMs = 5 * 60_000
      try {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
          ttlMs?: number
        }
        if (typeof body.ttlMs === 'number' && Number.isFinite(body.ttlMs)) ttlMs = body.ttlMs
      } catch {
        // 无 body 或非法 JSON：使用默认 TTL
      }
      return pairing.createPairingToken({ ttlMs })
    }
    if (req.method === 'POST' && url.pathname === '/broadcast-rescan') {
      await events.broadcastRescanStarted()
      await events.broadcastRescanCompleted(0)
      return { ok: true, libraryRevision: metadata.getCurrentRevision() }
    }
    throw new Error('unknown control route')
  }

  const controlPort = await new Promise<number>((resolve, reject) => {
    control.once('error', reject)
    control.listen(0, '127.0.0.1', () => {
      const addr = control.address()
      resolve(typeof addr === 'object' && addr ? addr.port : 0)
    })
  })

  // ============ 配对邀约（NS1 紧凑 URI + Android 完整 URI） ============
  const pairHost =
    args.pairHost ?? (args.host === '0.0.0.0' ? (firstPrivateIpv4() ?? '127.0.0.1') : args.host)
  const offer = await pairing.buildPairingQrContent({ host: pairHost, port: address.port })
  const tlsFingerprint = tlsIdentity.fingerprintSha256
  const verboseUri =
    `nikki-sync://pair?serverId=${encodeURIComponent(offer.serverId)}` +
    `&host=${encodeURIComponent(pairHost)}&port=${address.port}` +
    `&token=${encodeURIComponent(offer.token)}&protocol=1` +
    `&expiresAt=${encodeURIComponent(offer.expiresAt)}` +
    `&tls=${tlsFingerprint}`
  const serverIdentity = await metadata.ensureServerIdentity()

  const info = {
    pid: process.pid,
    dataDir,
    host: address.host,
    port: address.port,
    controlPort,
    serverId: serverIdentity.serverId,
    serverName: serverIdentity.serverName,
    tlsFingerprintSha256: tlsFingerprint,
    libraryRevision: metadata.getCurrentRevision(),
    pairingUri: offer.content,
    pairUriVerbose: verboseUri,
    pairingToken: offer.token,
    pairingExpiresAt: offer.expiresAt
  }
  process.stdout.write(`WXNN_E2E_INFO ${JSON.stringify(info)}\n`)

  if (args.qr) {
    try {
      const qrcode = (await import('qrcode')).default
      process.stdout.write(
        `${await qrcode.toString(offer.content, { type: 'terminal', small: true })}\n`
      )
    } catch (error) {
      log(`qrcode render failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  log(`sync server at ${address.host}:${address.port}, control at 127.0.0.1:${controlPort}`)
  log(`pair with: ${offer.content}`)

  // ============ 常驻 + 优雅退出（退出仅靠 SIGINT/SIGTERM；后台运行时 stdin
  // 常为 /dev/null 立即 EOF，故不监听 stdin end，避免刚启动即自停） ============
  const shutdown = async (): Promise<void> => {
    log('shutting down')
    try {
      control.close()
      await server.stop()
      db.close()
    } catch (error) {
      log(`shutdown error: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      // 无论停服是否出错都必须退出，否则 SIGINT 回调悬挂为 unhandled rejection
      process.exit(0)
    }
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
  setInterval(() => undefined, 1 << 30)
}

/** 首个私有段 IPv4（0.0.0.0 绑定时的默认配对 host；与 sync-server-setup 同口径的精简版） */
function firstPrivateIpv4(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list ?? []) {
      if (
        item &&
        !item.internal &&
        item.family === 'IPv4' &&
        /^(10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(item.address)
      ) {
        return item.address
      }
    }
  }
  return null
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `[sync-e2e] launch failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  )
  process.exit(1)
})
