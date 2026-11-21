// N6 补口：nikkisync-mock 演示态（URL ?demo=sync）的 TDD 契约。
// 与 nikkisync-mock.test.ts（空态契约，node 环境无 location）互补：本文件
// stub 出带 ?demo=sync 的 location 后 resetModules 重新求值模块图，验证演示态
// 返回形状与真实契约（shared/types/electron-api.ts）同形。形状漂移即红。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type NsShape = Record<string, (...args: unknown[]) => unknown>

/** 在 stub 好的 location 下重建干净 window 并重新装配 mock（模块级 demoSync 随导入时求值） */
async function loadDemoMock(): Promise<NsShape> {
  vi.resetModules()
  const { installPreviewMock } = await import('./install')
  const freshWindow: Record<string, unknown> = {}
  vi.stubGlobal('window', freshWindow)
  Object.defineProperty(freshWindow, 'electronAPI', {
    value: undefined,
    configurable: true,
    writable: true
  })
  installPreviewMock()
  const electronAPI = (freshWindow as { electronAPI: Record<string, NsShape> }).electronAPI
  if (!electronAPI?.nikkisync) throw new Error('nikkisync 命名空间未挂载')
  return electronAPI.nikkisync
}

beforeEach(() => {
  vi.stubGlobal('location', new URL('https://preview.local/?demo=sync'))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('nikkisync-mock 演示态（URL ?demo=sync）', () => {
  it('正常：demo 参数激活演示态（getServerStatus 返回 available:true 而非空态）', async () => {
    const ns = await loadDemoMock()
    const status = (await ns.getServerStatus()) as Record<string, unknown>
    expect(status.available).toBe(true)
  })

  it('正常：previewSyncAccount 按 assetId 返回单个契约对象（非数组——页面读 preview?.sourcePath）', async () => {
    const ns = await loadDemoMock()
    const preview = (await ns.previewSyncAccount({ assetId: 'demo-asset-s1' })) as Record<
      string,
      unknown
    >
    expect(preview).toEqual({
      resourceId: 'demo-asset-s1',
      mimeType: 'image/jpeg',
      sourcePath: 'mock://thumb-1.jpg'
    })
  })

  it('边界：previewSyncAccount 对未知 assetId 返回空对象（不抛、不越权返回他人样例）', async () => {
    const ns = await loadDemoMock()
    const preview = (await ns.previewSyncAccount({ assetId: 'no-such-asset' })) as Record<
      string,
      unknown
    >
    expect(preview).toEqual({})
  })

  it('正常：getPairingCode 返回契约全字段（NikkiSyncPairingCodeInfo 六键，倒计时现算）', async () => {
    const ns = await loadDemoMock()
    const code = (await ns.getPairingCode()) as Record<string, unknown>
    for (const key of [
      'content',
      'expiresAt',
      'serverId',
      'host',
      'port',
      'tlsFingerprintSha256'
    ]) {
      expect(code, `缺契约字段 ${key}`).toHaveProperty(key)
    }
    expect(new Date(code.expiresAt as string).getTime()).toBeGreaterThan(Date.now())
  })

  it('边界：demo=sync 以外的值不激活演示态（仍走空态契约）', async () => {
    vi.stubGlobal('location', new URL('https://preview.local/?demo=other'))
    const ns = await loadDemoMock()
    const status = (await ns.getServerStatus()) as Record<string, unknown>
    expect(status.available).toBe(false)
    expect(await ns.getPairingCode()).toEqual({})
  })
})
