/**
 * @layer L3
 * @module src/main/app/sync-server-setup
 * @coverage 同步服务装配常量（sync-integration 阶段5：默认关闭）
 *
 * initSyncServer 全链路（TLS 身份写盘/仓储/自启）由阶段4 手动验证 + sync/server 集成测试覆盖；
 * 此处仅锁定可导出的默认值常量——任务硬性要求「同步服务默认关闭，用户手动启用」。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/userdata') }
}))

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

import { SYNC_SERVER_ENABLED_DEFAULT } from '../sync-server-setup'

describe('sync-server-setup — 自启默认值（阶段5）', () => {
  it('SYNC_SERVER_ENABLED_DEFAULT 为 false（默认关闭，用户手动启用）', () => {
    expect(SYNC_SERVER_ENABLED_DEFAULT).toBe(false)
  })
})
