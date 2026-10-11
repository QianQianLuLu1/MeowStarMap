import { app } from 'electron'
import os from 'os'
import path from 'path'
import { logger } from '../utils/logger'
import { SyncMetadataRepository } from '../database/sync-metadata-repository'
import { SyncPairingRepository } from '../database/sync-pairing-repository'
import { SyncReadRepository } from '../database/sync-read-repository'
import { AuthService } from '../sync/auth-service'
import { PairingService } from '../sync/pairing-service'
import { SyncIdentityService, type SyncLogger } from '../sync/identity-service'
import { SyncServer, SYNC_SERVER_DEFAULT_PORT } from '../sync/server/sync-server'
import type {
  AssetChangeInput,
  PairingQrInfo,
  SyncApiServices,
  SyncEventSink,
  SyncServerHandle,
  SyncServerStatusInfo
} from '../sync/server/types'
import type { ChangeType, WsEvent } from '../../shared/sync/protocol'
import type { AppContext } from './app-context'

// 装配句柄类型下沉于 sync/server/types.ts（供 ipc/handler-context 引用），此处转出口
export type { PairingQrInfo, SyncServerHandle, SyncServerStatusInfo }

/**
 * NikkiSync 同步服务器装配点（阶段 4，sync-integration）。
 *
 * - 遵守 src/main/sync/AGENTS.md：sync/ 本体不 import electron，userData 路径、
 *   electron-log、单例生命周期全部由本装配层注入
 * - 组装链：TLS 身份（{userData}/sync）→ 三仓储（db/workerBridge/dbPath）→
 *   AuthService / PairingService → SyncApiServices → SyncServer（HTTPS + WS）
 * - 事件汇（SyncEventSink）：journal 永远写（服务器未运行也写，保证 /v1/changes
 *   完整）、失败仅告警不中断写路径；单条变更立即广播；批量变更合并广播最后一条
 *   （客户端凭最高 revision 走 /v1/changes 补齐整批，防移动端事件风暴）
 * - 端口：设置 sync.serverPort（默认 27124），EADDRINUSE 由 SyncServer +1 重试；
 *   自启开关：设置 sync.serverEnabled（默认 true）
 * - LAN 地址解析策略与 share-wifi-service.getLanIp 一致（默认路由优先 + 虚拟网卡
 *   过滤 + 127.0.0.1 兜底）；原方法为类私有，此处精简复制以避免改动 services 目录
 */

// 与 share-wifi-service 同款用法：默认路由探测对外局域网地址（CJS 依赖，无类型）
const networkAddress: (options?: { ipv6?: boolean }) => string = require('network-address')

const SETTING_ENABLED = 'sync.serverEnabled'
const SETTING_PORT = 'sync.serverPort'

const VIRTUAL_ADAPTER_PATTERN =
  /(vmware|vmnet|virtualbox|vbox|docker|hyper-v|vethernet|tailscale|zerotier|wireguard|wg-|vpn|tap-|tun-)/i
const PRIVATE_IPV4_PATTERN = /^(10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/

/** 组装同步服务器并按设置自启；失败不阻塞应用启动（状态经 IPC sync:getStatus 可见） */
export async function initSyncServer(ctx: AppContext): Promise<SyncServerHandle> {
  const db = ctx.dbManager.getDatabase()
  if (!db) throw new Error('sync server setup requires an initialized database')
  const workerBridge = ctx.dbManager.getWorkerBridge()
  const dbPath = ctx.dbManager.getDbPath()

  const syncLogger: SyncLogger = {
    info: (message) => logger.info(message),
    warn: (message) => logger.warn(message)
  }
  const identity = new SyncIdentityService({
    directory: path.join(app.getPath('userData'), 'sync'),
    logger: syncLogger
  })
  const tlsIdentity = identity.getOrCreateTlsIdentity()
  const metadata = new SyncMetadataRepository(db, workerBridge, dbPath)
  const sessions = new SyncPairingRepository(db, workerBridge, dbPath)
  const reads = new SyncReadRepository(db, workerBridge, dbPath)
  const auth = new AuthService({
    getDevice: (deviceId) => metadata.getPairedDevice(deviceId),
    touchDevice: (deviceId) => metadata.touchDevice(deviceId)
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

  const configuredPort = ctx.dbManager.getSetting(SETTING_PORT, SYNC_SERVER_DEFAULT_PORT)
  const server = new SyncServer(services, {
    host: '0.0.0.0',
    port:
      typeof configuredPort === 'number' && Number.isInteger(configuredPort) && configuredPort > 0
        ? configuredPort
        : SYNC_SERVER_DEFAULT_PORT,
    tls: { key: tlsIdentity.keyPem, cert: tlsIdentity.certPem },
    logger: syncLogger
  })

  const occurredAt = (): string => new Date().toISOString()
  const broadcastSafe = (event: WsEvent): void => {
    try {
      server.broadcastEvent(event)
    } catch (err) {
      logger.warn('[Sync] broadcast failed', err)
    }
  }

  const events: SyncEventSink = {
    recordAssetChange: async (eventType: ChangeType, assetId: string): Promise<void> => {
      try {
        const { revision } = await metadata.recordAssetChange({ eventType, assetId })
        broadcastSafe({ event: eventType, revision, assetId, occurredAt: occurredAt() })
      } catch (err) {
        logger.warn(`[Sync] failed to record asset change (${eventType} ${assetId})`, err)
      }
    },
    recordAssetChanges: async (changes: ReadonlyArray<AssetChangeInput>): Promise<number> => {
      if (changes.length === 0) return 0
      try {
        await metadata.recordAssetChanges(changes)
        // 合并广播：只发最后一条（revision 最高），客户端凭 revision 走 /v1/changes 补齐整批
        const last = changes[changes.length - 1]!
        broadcastSafe({
          event: last.eventType,
          revision: metadata.getCurrentRevision(),
          assetId: last.assetId,
          occurredAt: occurredAt()
        })
      } catch (err) {
        logger.warn('[Sync] failed to record asset change batch', err)
      }
      return changes.length
    },
    broadcastRescanStarted: async (): Promise<void> => {
      broadcastSafe({
        event: 'library.rescan.started',
        revision: metadata.getCurrentRevision(),
        occurredAt: occurredAt()
      })
    },
    broadcastRescanCompleted: async (changedAssets: number): Promise<void> => {
      broadcastSafe({
        event: 'library.rescan.completed',
        revision: metadata.getCurrentRevision(),
        occurredAt: occurredAt(),
        changedAssets
      })
    }
  }

  const start = async (): Promise<void> => {
    if (server.getStatus().running) return
    await server.start()
  }

  const handle: SyncServerHandle = {
    events,
    start,
    stop: () => server.stop(),
    getStatus: async (): Promise<SyncServerStatusInfo> => {
      const status = server.getStatus()
      let serverIdentity: { serverId: string; serverName: string } | null = null
      try {
        serverIdentity = await metadata.ensureServerIdentity()
      } catch {
        // 身份查询失败不阻塞状态展示
      }
      return {
        available: true,
        running: status.running,
        host: status.host,
        port: status.port,
        connections: status.connections,
        serverId: serverIdentity?.serverId ?? null,
        serverName: serverIdentity?.serverName ?? null,
        pairedDeviceCount: metadata.listPairedDevices().length,
        tlsFingerprintSha256: tlsIdentity.fingerprintSha256,
        lanHost: resolveLanHost()
      }
    },
    createPairingQr: async (): Promise<PairingQrInfo> => {
      const status = server.getStatus()
      if (!status.running) throw new Error('sync server is not running')
      const host = resolveLanHost()
      const offer = await pairing.buildPairingQrContent({ host, port: status.port })
      return {
        content: offer.content,
        expiresAt: offer.expiresAt,
        serverId: offer.serverId,
        host,
        port: status.port,
        tlsFingerprintSha256: tlsIdentity.fingerprintSha256
      }
    }
  }

  // 暴露给写路径 handler 与 IPC（写路径对 syncEvents 的调用永不依赖服务器状态）
  ctx.syncEvents = events
  ctx.syncServer = handle

  try {
    const enabled = ctx.dbManager.getSetting(SETTING_ENABLED, true)
    if (enabled) await start()
  } catch (err) {
    logger.error('[Sync] failed to auto-start the sync server', err)
  }
  return handle
}

/** 局域网地址（QR 配对用）：默认路由优先，校验落在真实网卡后采用；否则扫网卡取 IPv4 私有段 */
function resolveLanHost(): string {
  try {
    const byRoute = networkAddress()
    if (byRoute && byRoute !== '0.0.0.0' && byRoute !== '127.0.0.1' && isLanAddress(byRoute)) {
      return byRoute
    }
  } catch {
    // 默认路由探测失败，走网卡扫描
  }
  const interfaces = os.networkInterfaces()
  for (const [name, list] of Object.entries(interfaces)) {
    if (VIRTUAL_ADAPTER_PATTERN.test(name)) continue
    for (const item of list ?? []) {
      if (!item || item.internal || item.family !== 'IPv4') continue
      if (PRIVATE_IPV4_PATTERN.test(item.address)) return item.address
    }
  }
  return '127.0.0.1'
}

/** 默认路由结果二次校验：确为某张真实（非虚拟、非回环）网卡上的地址 */
function isLanAddress(addr: string): boolean {
  const target = addr.split('%')[0]!.toLowerCase()
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_ADAPTER_PATTERN.test(name)) continue
    for (const item of list ?? []) {
      if (item && !item.internal && item.address.toLowerCase() === target) return true
    }
  }
  return false
}
