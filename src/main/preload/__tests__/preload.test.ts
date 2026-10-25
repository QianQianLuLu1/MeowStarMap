/**
 * @layer L2
 * @module src/main/preload
 * @coverage 装配完整性（5 个全局 + 30 个命名空间键）/ call 解包语义 / subscribe 退订 / 依赖白名单
 * @dependencies electron (contextBridge/ipcRenderer mock)
 *
 * preload 曾长期零单测（仅 e2e S3 冒烟覆盖），2026-08 命名空间化拆分重构时补齐：
 * 1. mock electron 后真实执行入口装配，断言对外契约不被拆分破坏
 * 2. call() 三分支（成功解包 / 失败抛 IpcError / 畸形响应兜底）
 * 3. 把「preload 禁止引入 heavy 模块、shared 仅 type-only」约束机械化为白名单扫描
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const { exposeMock, invokeMock, onMock, removeListenerMock, sendMock } = vi.hoisted(() => {
  // preload 的授信源自检在模块加载期读取 location.origin（见 ../origin-guard.ts），
  // 而 vitest 对本文件用的是 node 环境——没有 location 全局会被判为非授信文档 → 零暴露。
  // 必须抢在任何静态 import（下面的 import '../../preload'）之前打桩，模拟生产文档 origin。
  Object.defineProperty(globalThis, 'location', {
    value: { origin: 'app://renderer' },
    configurable: true,
    writable: true
  })
  return {
    exposeMock: vi.fn(),
    invokeMock: vi.fn(),
    onMock: vi.fn(),
    removeListenerMock: vi.fn(),
    sendMock: vi.fn()
  }
})

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: exposeMock },
  ipcRenderer: {
    invoke: invokeMock,
    on: onMock,
    removeListener: removeListenerMock,
    send: sendMock
  }
}))

// 入口在 import 阶段即完成装配与暴露（与真实 preload 运行方式一致），
// 因此暴露记录需在任何 mock 清理之前先捕获。
import { IpcError, call, subscribe } from '../ipc'
import '../../preload'

const exposedNames: string[] = exposeMock.mock.calls.map(([name]) => name as string)

function getExposed<T>(name: string): T {
  const rec = exposeMock.mock.calls.find(([n]) => n === name)
  if (!rec) throw new Error(`未捕获到全局暴露: ${name}`)
  return rec[1] as T
}

beforeEach(() => {
  invokeMock.mockReset()
  onMock.mockReset()
  removeListenerMock.mockReset()
  sendMock.mockReset()
})

describe('preload 装配完整性', () => {
  it('暴露 5 个全局对象（e2e S3 契约）', () => {
    expect(exposedNames.sort()).toEqual(
      ['IpcError', '__setPluginI18nT', 'electronAPI', 'pluggableElectronIpc', 'pluginAPI'].sort()
    )
  })

  it('nikkisync 命名空间方法清单（K8 整理队列接入后共 28 个）', () => {
    // 逐个方法名而不是只数键：命名空间内的方法就是渲染层拿到的对外契约，
    // 少一个方法 = 图库某项能力静默不可用，而键数断言看不出来
    const electronAPI = getExposed<{ nikkisync: Record<string, unknown> }>('electronAPI')
    expect(Object.keys(electronAPI.nikkisync).sort()).toEqual(
      [
        'getRuntimeStatus',
        'startScan',
        'getAssets',
        'getAssetDetail',
        'getResource',
        'getResourceRecords',
        'getChanges',
        'searchSuits',
        'searchClothing',
        'profileStats',
        'onLibraryChanged',
        'getServerStatus',
        'startServer',
        'stopServer',
        'getPairingCode',
        'getPairedDevices',
        'revokeDevice',
        // K2/K3/K6（历史缺口：这三个节点的 8 个方法当时未入清单，随 K8 一并补全）
        'getMetadataConsent',
        'setMetadataConsent',
        'resolveGameVersion',
        'getExtraDirectories',
        'inspectExtraDirectory',
        'addExtraDirectory',
        'removeExtraDirectory',
        'rescanExtraDirectories',
        // K8：整理队列（批量删除）
        'getOrganizerQueue',
        'decideOrganizerItem',
        'approveOrganizerItems'
      ].sort()
    )
  })

  it('阶段4 五个新方法各自命中对应通道名（一行转发最容易写错的就是通道名）', async () => {
    const electronAPI = getExposed<{
      nikkisync: Record<string, (...args: unknown[]) => Promise<unknown>>
    }>('electronAPI')
    invokeMock.mockResolvedValue({ success: true, data: { ok: 1 } })
    await electronAPI.nikkisync.getResourceRecords({ assetIds: ['a/1'], mode: 'path' })
    expect(invokeMock).toHaveBeenCalledWith('nikkisync:get-resource-records', {
      assetIds: ['a/1'],
      mode: 'path'
    })
    await electronAPI.nikkisync.getChanges({ after: 3 })
    expect(invokeMock).toHaveBeenCalledWith('nikkisync:get-changes', { after: 3 })
    await electronAPI.nikkisync.searchSuits({ query: '花' })
    expect(invokeMock).toHaveBeenCalledWith('nikkisync:search-suits', { query: '花' })
    await electronAPI.nikkisync.searchClothing({ query: '裙' })
    expect(invokeMock).toHaveBeenCalledWith('nikkisync:search-clothing', { query: '裙' })
    await electronAPI.nikkisync.profileStats()
    expect(invokeMock).toHaveBeenCalledWith('nikkisync:profile-stats')
  })

  it('K8 三个整理队列方法各自命中对应通道名（破坏性能力的转发面逐字锁定）', async () => {
    const electronAPI = getExposed<{
      nikkisync: Record<string, (...args: unknown[]) => Promise<unknown>>
    }>('electronAPI')
    invokeMock.mockResolvedValue({ success: true, data: { ok: 1 } })
    await electronAPI.nikkisync.getOrganizerQueue()
    expect(invokeMock).toHaveBeenCalledWith('nikkisync:get-organizer-queue')
    await electronAPI.nikkisync.decideOrganizerItem({
      id: 'del-1aaaaaaaaaaaaaaa',
      approve: true
    })
    expect(invokeMock).toHaveBeenCalledWith('nikkisync:decide-organizer-item', {
      id: 'del-1aaaaaaaaaaaaaaa',
      approve: true
    })
    await electronAPI.nikkisync.approveOrganizerItems({ ids: ['del-1aaaaaaaaaaaaaaa'] })
    expect(invokeMock).toHaveBeenCalledWith('nikkisync:approve-organizer-items', {
      ids: ['del-1aaaaaaaaaaaaaaa']
    })
  })

  it('electronAPI 包含全部 34 个键（reportReady + 33 个命名空间，阶段4 增 assetEdits）', () => {
    const electronAPI = getExposed<Record<string, unknown>>('electronAPI')
    expect(Object.keys(electronAPI).sort()).toEqual(
      [
        'reportReady',
        'scanner',
        'file',
        'editor',
        'watermark',
        'category',
        'mediaAction',
        'video',
        'dialog',
        'thumbnail',
        'media',
        'profile',
        'uiTheme',
        'shell',
        'settings',
        'export',
        'data',
        'backup',
        'share',
        'sync',
        'nikkisync',
        'assetEdits',
        'cache',
        'log',
        'crash',
        'app',
        'task',
        'import',
        'importRoot',
        'operationHistory',
        'decrypt',
        'plugin',
        'resonance',
        'favorites'
      ].sort()
    )
  })

  it('reportReady 通过 ipcRenderer.send 上报（通道字符串不变）', () => {
    const electronAPI = getExposed<{ reportReady: () => void }>('electronAPI')
    electronAPI.reportReady()
    expect(sendMock).toHaveBeenCalledWith('renderer:ready')
  })

  it('命名空间方法走 call 解包（file.delete 通道与参数透传）', async () => {
    invokeMock.mockResolvedValueOnce({ success: true, data: { success: true, processed: 1 } })
    const electronAPI = getExposed<{ file: { delete: (p: string[]) => Promise<unknown> } }>(
      'electronAPI'
    )
    const result = await electronAPI.file.delete(['/a.jpg'])
    expect(invokeMock).toHaveBeenCalledWith('file:delete', ['/a.jpg'])
    expect(result).toEqual({ success: true, processed: 1 })
  })

  it('pluggableElectronIpc 门面为只读 raw invoke（不走 call 解包）', async () => {
    invokeMock.mockResolvedValueOnce([])
    const facade = getExposed<{ getActive: () => Promise<unknown> }>('pluggableElectronIpc')
    await facade.getActive()
    expect(invokeMock).toHaveBeenCalledWith('pluggable:getActivePlugins')
  })

  it('pluginAPI 能力桥包含 media/db/fs/watermark/task/i18n 六个域', () => {
    const pluginAPI = getExposed<Record<string, unknown>>('pluginAPI')
    expect(Object.keys(pluginAPI).sort()).toEqual([
      'db',
      'fs',
      'i18n',
      'media',
      'task',
      'watermark'
    ])
  })
})

describe('call() 解包语义（IPC_CONTRACT 契约）', () => {
  it('成功响应解包返回业务数据', async () => {
    invokeMock.mockResolvedValueOnce({ success: true, data: { value: 42 } })
    await expect(call<{ value: number }>('ch:ok')).resolves.toEqual({ value: 42 })
  })

  it('失败响应还原为 IpcError（code/userMessage/details 透传）', async () => {
    invokeMock.mockResolvedValueOnce({
      success: false,
      error: {
        code: 'IPC_NOT_FOUND',
        message: 'tech msg',
        userMessage: 'user msg',
        details: { a: 1 }
      }
    })
    const err = await call('ch:fail').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(IpcError)
    const ipcErr = err as IpcError
    expect(ipcErr.code).toBe('IPC_NOT_FOUND')
    expect(ipcErr.message).toBe('tech msg')
    expect(ipcErr.userMessage).toBe('user msg')
    expect(ipcErr.details).toEqual({ a: 1 })
  })

  it('畸形响应抛 IPC_MALFORMED_RESPONSE 兜底错误', async () => {
    invokeMock.mockResolvedValueOnce({ foo: 'bar' })
    await expect(call('ch:malformed')).rejects.toMatchObject({
      code: 'IPC_MALFORMED_RESPONSE'
    })
    invokeMock.mockResolvedValueOnce(null)
    await expect(call('ch:null')).rejects.toMatchObject({ code: 'IPC_MALFORMED_RESPONSE' })
  })
})

describe('subscribe() 事件订阅', () => {
  it('剥离事件对象向回调透传载荷，退订调用 removeListener', () => {
    const callback = vi.fn()
    const unsubscribe = subscribe<{ n: number }>('ch:event', callback)

    expect(onMock).toHaveBeenCalledWith('ch:event', expect.any(Function))
    const handler = onMock.mock.calls[onMock.mock.calls.length - 1]![1] as (
      event: unknown,
      payload: { n: number }
    ) => void
    handler({ sender: 'evt' }, { n: 7 })
    expect(callback).toHaveBeenCalledWith({ n: 7 })

    unsubscribe()
    expect(removeListenerMock).toHaveBeenCalledWith('ch:event', handler)
  })
})

describe('IpcError 错误类', () => {
  it('是 Error 子类且字段完整', () => {
    const exposedIpcError =
      getExposed<
        new (
          code: string,
          message: string,
          details?: unknown,
          userMessage?: string
        ) => Error & { code: string; userMessage?: string; details?: unknown }
      >('IpcError')

    const err = new exposedIpcError('IPC_CONFLICT', 'conflict', { k: 'v' }, '冲突')
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('IPC_CONFLICT')
    expect(err.userMessage).toBe('冲突')
    expect(err.details).toEqual({ k: 'v' })
    expect(err.name).toBe('IpcError')
  })
})

describe('preload 依赖白名单守卫（零 heavy 依赖约束）', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const preloadRoot = resolve(here, '..') // src/main/preload
  const entryFile = resolve(preloadRoot, '../preload.ts') // src/main/preload.ts
  const preloadLoggerFile = resolve(preloadRoot, '../preload-logger.ts')

  function listSourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        return name === '__tests__' ? [] : listSourceFiles(full)
      }
      return name.endsWith('.ts') && !name.endsWith('.d.ts') ? [full] : []
    })
  }

  function resolveSource(fromFile: string, spec: string): string {
    const base = resolve(dirname(fromFile), spec)
    for (const cand of [base, `${base}.ts`, join(base, 'index.ts')]) {
      if (existsSync(cand) && statSync(cand).isFile()) return cand
    }
    return base
  }

  interface ImportRecord {
    file: string
    spec: string
    isTypeOnly: boolean
  }

  function collectImports(file: string): ImportRecord[] {
    const source = readFileSync(file, 'utf-8')
    const records: ImportRecord[] = []
    const pattern = /\b(?:import|export)\s+([\s\S]*?)from\s+['"]([^'"]+)['"]/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(source)) !== null) {
      records.push({
        file,
        spec: match[2],
        isTypeOnly: /^type\b/.test(match[1].trim())
      })
    }
    return records
  }

  it('入口与全部 preload 模块仅依赖 electron / preload 内部模块 / type-only 的 shared 类型', () => {
    const violations: string[] = []
    for (const record of [entryFile, ...listSourceFiles(preloadRoot)].flatMap(collectImports)) {
      const { file, spec, isTypeOnly } = record
      const label = `${relative(preloadRoot, file)} -> '${spec}'`
      if (spec === 'electron') continue
      if (!spec.startsWith('.')) {
        violations.push(
          `${label}: 禁止裸模块依赖（preload 运行时仅允许 electron，sandbox 环境无 node_modules）`
        )
        continue
      }
      const resolved = resolveSource(file, spec)
      const relToRoot = relative(preloadRoot, resolved)
      const insidePreload =
        relToRoot !== '' && !relToRoot.startsWith('..') && !isAbsolute(relToRoot)
      if (insidePreload) continue // ./ipc、./api/*、./plugin-bridge 等 preload 内部模块
      if (resolved === preloadLoggerFile) continue // 零依赖日志（见 preload-logger.ts 设计约束）
      if (resolved.includes(`${sep}shared${sep}`)) {
        if (!isTypeOnly) {
          violations.push(
            `${label}: shared 引入必须 type-only（运行时值依赖会被打进 preload bundle）`
          )
        }
        continue
      }
      violations.push(`${label}: 禁止的依赖（主进程 heavy 模块会破坏 preload 零依赖约束）`)
    }
    expect(violations).toEqual([])
  })
})

// ============ 文档源自检（纵深防御）：非授信文档零暴露 ============
// preload 对窗口加载的任何文档都会执行。若主框架被导航到 file:///…/evil.html 或本机
// 任意端口的 localhost 服务，未加门禁时会把完整 IPC 桥重建在那个页面上。
// 以下用例重估 preload 模块（改 location 桩 + resetModules），验证门禁确实跳过全部暴露。
// 必须放在文件末尾：vi.resetModules 之后的动态 import 会拿到新的模块实例，
// 而上面各用例持有的是首次加载时静态 import 的实例。
describe('文档源自检门禁', () => {
  const TRUSTED_LOCATION = { origin: 'app://renderer' }

  function setLocation(value: unknown): void {
    Object.defineProperty(globalThis, 'location', { value, configurable: true, writable: true })
  }

  async function reevaluatePreload(): Promise<void> {
    vi.resetModules()
    await import('../../preload')
  }

  it('授信 origin（app://renderer）下 5 个全局正常暴露（回归基线）', async () => {
    setLocation(TRUSTED_LOCATION)
    exposeMock.mockClear()
    await reevaluatePreload()

    expect(exposeMock.mock.calls.map(([name]) => name).sort()).toEqual(
      ['IpcError', '__setPluginI18nT', 'electronAPI', 'pluggableElectronIpc', 'pluginAPI'].sort()
    )
  })

  it('file:// 文档（本地 evil.html）下不暴露任何全局', async () => {
    setLocation({ origin: 'file://' })
    exposeMock.mockClear()
    await reevaluatePreload()

    expect(exposeMock).not.toHaveBeenCalled()
  })

  it('非 5173 端口的 localhost 服务下不暴露任何全局', async () => {
    setLocation({ origin: 'http://localhost:8080' })
    exposeMock.mockClear()
    await reevaluatePreload()

    expect(exposeMock).not.toHaveBeenCalled()
  })

  it('opaque origin（about:blank / null）下不暴露任何全局', async () => {
    setLocation({ origin: 'null' })
    exposeMock.mockClear()
    await reevaluatePreload()

    expect(exposeMock).not.toHaveBeenCalled()
  })

  it('无 location 全局（node/单测环境）下不暴露任何全局', async () => {
    delete (globalThis as unknown as Record<string, unknown>)['location']
    exposeMock.mockClear()
    await reevaluatePreload()

    expect(exposeMock).not.toHaveBeenCalled()
    // 还原授信桩，避免影响同文件后续用例
    setLocation(TRUSTED_LOCATION)
  })
})
