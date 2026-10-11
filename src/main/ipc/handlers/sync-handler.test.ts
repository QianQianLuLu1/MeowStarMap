/**
 * @layer L3
 * @module src/main/ipc/handlers/sync-handler
 * @coverage sync 域 IPC handler 注册与执行（sync-integration 阶段5：设备列表/撤销 + 既有 4 通道行为锁）
 * @dependencies electron / SyncServerHandle
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SyncEventSink, SyncServerHandle, SyncServerStatusInfo } from '../../sync/server/types'
import { createSchemasMock, makeCtx, getHandler } from './_test-helpers'

const { handleMock } = vi.hoisted(() => ({ handleMock: vi.fn() }))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: vi.fn() }
}))

// revokeDevice 走 wrapHandlerRaw + 内联 zod（scanner:start 同款，保证 zod 真实生效）
vi.mock('../validator', async () => ({
  ...(await import('../../../../tests/mocks/mock-validator')),
  schemas: createSchemasMock()
}))

import { registerSyncHandlers } from './sync-handler'

const STATUS: SyncServerStatusInfo = {
  available: true,
  running: true,
  host: '127.0.0.1',
  port: 27124,
  connections: 0,
  serverId: 'wxnn-0123456789abcdef',
  serverName: 'WXNN XiangCe',
  pairedDeviceCount: 1,
  tlsFingerprintSha256: 'aa'.repeat(32),
  lanHost: '192.168.1.10'
}

function makeSyncEvents(): SyncEventSink {
  return {
    recordAssetChange: vi.fn(async () => undefined),
    recordAssetChanges: vi.fn(async () => 0),
    broadcastRescanStarted: vi.fn(async () => undefined),
    broadcastRescanCompleted: vi.fn(async () => undefined)
  }
}

function makeSyncServer(overrides: Partial<SyncServerHandle> = {}): SyncServerHandle {
  return {
    events: makeSyncEvents(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    getStatus: vi.fn(async () => STATUS),
    createPairingQr: vi.fn(async () => ({
      content: 'NS1|wxnn-x|192.168.1.10|27124|tok|1893456000|' + 'ab'.repeat(32),
      expiresAt: '2026-10-11T12:05:00.000Z',
      serverId: 'wxnn-0123456789abcdef',
      host: '192.168.1.10',
      port: 27124,
      tlsFingerprintSha256: 'aa'.repeat(32)
    })),
    listDevices: vi.fn(async () => []),
    revokeDevice: vi.fn(async () => null),
    ...overrides
  } as SyncServerHandle
}

beforeEach(() => {
  handleMock.mockClear()
})

describe('registerSyncHandlers — 通道注册', () => {
  it('注册 6 个通道（含阶段5 设备列表/撤销）', () => {
    registerSyncHandlers(makeCtx({ syncServer: makeSyncServer() }))
    const channels = handleMock.mock.calls.map((c) => c[0])
    expect(channels).toEqual(
      expect.arrayContaining([
        'sync:getStatus',
        'sync:startServer',
        'sync:stopServer',
        'sync:createPairingQr',
        'sync:listDevices',
        'sync:revokeDevice'
      ])
    )
  })
})

describe('registerSyncHandlers — 设备列表/撤销（阶段5）', () => {
  it('sync:listDevices 返回活跃设备列表', async () => {
    const devices = [
      {
        deviceId: 'dev-1',
        deviceName: 'iPhone 15',
        platform: 'ios',
        appVersion: '1.0.0',
        pairedAt: '2026-10-11T00:00:00.000Z',
        lastSeenAt: null,
        lastAckRevision: 0
      }
    ]
    const syncServer = makeSyncServer({ listDevices: vi.fn(async () => devices) })
    registerSyncHandlers(makeCtx({ syncServer }))
    const result = (await getHandler(handleMock, 'sync:listDevices')()) as {
      success: true
      data: typeof devices
    }
    expect(result.success).toBe(true)
    expect(result.data).toEqual(devices)
    expect(syncServer.listDevices).toHaveBeenCalledTimes(1)
  })

  it('sync:listDevices 未组装 → preconditionFailed', async () => {
    registerSyncHandlers(makeCtx({}))
    const result = (await getHandler(handleMock, 'sync:listDevices')()) as {
      success: false
      error: { code: string }
    }
    expect(result.error.code).toBe('IPC_PRECONDITION_FAILED')
  })

  it('sync:revokeDevice 成功：调用 handle.revokeDevice 并返回刷新列表', async () => {
    const refreshed = [
      {
        deviceId: 'dev-2',
        deviceName: 'Pixel 8',
        platform: 'android',
        appVersion: null,
        pairedAt: '2026-10-10T00:00:00.000Z',
        lastSeenAt: '2026-10-11T01:00:00.000Z',
        lastAckRevision: 3
      }
    ]
    const syncServer = makeSyncServer({
      revokeDevice: vi.fn(async (deviceId: string) =>
        deviceId === 'dev-1'
          ? {
              deviceId: 'dev-1',
              deviceName: 'iPhone 15',
              platform: 'ios',
              appVersion: null,
              pairedAt: '2026-10-11T00:00:00.000Z',
              lastSeenAt: null,
              lastAckRevision: 0
            }
          : null
      ),
      listDevices: vi.fn(async () => refreshed)
    })
    registerSyncHandlers(makeCtx({ syncServer }))
    const result = (await getHandler(handleMock, 'sync:revokeDevice')(['dev-1'])) as {
      success: true
      data: typeof refreshed
    }
    expect(syncServer.revokeDevice).toHaveBeenCalledWith('dev-1')
    expect(result.data).toEqual(refreshed)
  })

  it('sync:revokeDevice 未知设备 → notFound', async () => {
    const syncServer = makeSyncServer({ revokeDevice: vi.fn(async () => null) })
    registerSyncHandlers(makeCtx({ syncServer }))
    const result = (await getHandler(handleMock, 'sync:revokeDevice')(['dev-ghost'])) as {
      success: false
      error: { code: string }
    }
    expect(result.error.code).toBe('IPC_NOT_FOUND')
  })

  it('sync:revokeDevice 参数非法（空串/超长/非字符串）→ validation', async () => {
    const syncServer = makeSyncServer()
    registerSyncHandlers(makeCtx({ syncServer }))
    for (const bad of ['', 'x'.repeat(129), 123]) {
      const result = (await getHandler(handleMock, 'sync:revokeDevice')([bad])) as {
        success: false
        error: { code: string }
      }
      expect(result.error.code).toBe('IPC_VALIDATION_ERROR')
    }
    expect(syncServer.revokeDevice).not.toHaveBeenCalled()
  })

  it('sync:revokeDevice 未组装 → preconditionFailed', async () => {
    registerSyncHandlers(makeCtx({}))
    const result = (await getHandler(handleMock, 'sync:revokeDevice')(['dev-1'])) as {
      success: false
      error: { code: string }
    }
    expect(result.error.code).toBe('IPC_PRECONDITION_FAILED')
  })
})

describe('registerSyncHandlers — 既有 4 通道行为锁（阶段4）', () => {
  it('sync:getStatus 未组装 → available:false（不抛）', async () => {
    registerSyncHandlers(makeCtx({}))
    const result = (await getHandler(handleMock, 'sync:getStatus')()) as {
      success: true
      data: { available: boolean }
    }
    expect(result.data.available).toBe(false)
  })

  it('sync:getStatus 组装后返回状态', async () => {
    registerSyncHandlers(makeCtx({ syncServer: makeSyncServer() }))
    const result = (await getHandler(handleMock, 'sync:getStatus')()) as {
      success: true
      data: SyncServerStatusInfo
    }
    expect(result.data).toEqual(STATUS)
  })

  it('sync:startServer / sync:stopServer 未组装 → preconditionFailed', async () => {
    registerSyncHandlers(makeCtx({}))
    for (const channel of ['sync:startServer', 'sync:stopServer']) {
      const result = (await getHandler(handleMock, channel)()) as {
        success: false
        error: { code: string }
      }
      expect(result.error.code).toBe('IPC_PRECONDITION_FAILED')
    }
  })

  it('sync:startServer 成功 → start 后返回状态；createPairingQr 透传', async () => {
    const syncServer = makeSyncServer()
    registerSyncHandlers(makeCtx({ syncServer }))
    const started = (await getHandler(handleMock, 'sync:startServer')()) as {
      success: true
      data: SyncServerStatusInfo
    }
    expect(syncServer.start).toHaveBeenCalledTimes(1)
    expect(started.data).toEqual(STATUS)
    const qr = (await getHandler(handleMock, 'sync:createPairingQr')()) as {
      success: true
      data: { content: string }
    }
    expect(qr.data.content.startsWith('NS1|')).toBe(true)
  })
})
