/**
 * 全链路诊断错误码（需求五.1）：E001–E005 的埋点契约。
 *
 * 断言口径：每个失败场景必须在 scanLogStore 中留下**带 code** 的条目，
 * 且 detail 含需求指定的必需字段；成功场景不得产生错误码（避免误报）。
 *
 * 运行：npx vitest run src/main/scanner/__tests__/scan-error-codes.test.ts
 */
import { describe, it, expect, beforeEach, afterAll, beforeAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { scanLogStore, __resetScanLogStore } from '../scan-log-store'
import type { ScanErrorCode, ScanLogKind, ScanLogLevel } from '../scan-log-store'

// scanDirectory / discoverUidsFromGameDirs / resolveScanChannels 均需真实 fs，不 mock
let rootMod: typeof import('../gameplayphotos-root')
let uidMod: typeof import('../uid-discovery')

let tmpRoot: string
const created: string[] = []

/**
 * 安装 parentPort 桩，模拟主进程 ScannerWorkerBridge 的 SCAN_LOG 转发：
 * worker 侧 sendScanLogEntry 走 parentPort.postMessage，由主进程落 scanLogStore。
 * 缺此桩时结构化日志被丢弃，无法断言错误码。
 */
beforeAll(() => {
  ;(process as { parentPort?: unknown }).parentPort = {
    on: () => undefined,
    postMessage: (msg: { type?: string; payload?: Record<string, unknown> }) => {
      if (msg?.type !== 'SCAN_LOG' || !msg.payload) return
      scanLogStore.append({
        stage: String(msg.payload.stage ?? 'Scanner'),
        level: (msg.payload.level as ScanLogLevel) ?? 'info',
        kind: (msg.payload.kind as ScanLogKind) ?? 'other',
        message: String(msg.payload.message ?? ''),
        detail: msg.payload.detail,
        ...(msg.payload.code ? { code: msg.payload.code as ScanErrorCode } : {})
      })
    }
  }
})

beforeEach(async () => {
  __resetScanLogStore()
  scanLogStore.startRun()
  if (!rootMod) {
    rootMod = await import('../gameplayphotos-root')
    uidMod = await import('../uid-discovery')
  }
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wxnn-errcode-'))
  created.push(tmpRoot)
})

afterAll(() => {
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  delete (process as { parentPort?: unknown }).parentPort
  __resetScanLogStore()
})

/** 取本次轨迹中首个指定错误码的条目 */
function entryOf(code: ScanErrorCode) {
  return scanLogStore.getEntries().find((e) => e.code === code)
}

function mkDir(...parts: string[]): string {
  const p = path.join(tmpRoot, ...parts)
  fs.mkdirSync(p, { recursive: true })
  return p
}

describe('E001 未找到任何游戏安装目录', () => {
  it('游戏根集合为空 → 产出 E001，detail 含 gameRoots 与 probeTrail', async () => {
    const channels = await import('../scan-channels')
    const res = await channels.resolveScanChannels([])

    expect(res.officialAlbum).toEqual([])
    expect(res.secondary).toEqual([])
    const entry = entryOf('E001')
    expect(entry).toBeDefined()
    expect(entry?.level).toBe('error')
    const detail = entry?.detail as { gameRoots: string[]; probeTrail: unknown[] }
    expect(detail.gameRoots).toEqual([])
    expect(Array.isArray(detail.probeTrail)).toBe(true)
  })

  it('有游戏根但两条通道均为空 → 同样产出 E001', async () => {
    const root = mkDir('e001-root-empty')
    const channels = await import('../scan-channels')
    await channels.resolveScanChannels([root])

    const entry = entryOf('E001')
    expect(entry).toBeDefined()
    expect(entry?.kind).toBe('path-missing')
  })
})

describe('E002 找到游戏根目录，但目标子目录不存在', () => {
  it('根目录无 GamePlayPhotos → 产出 E002，detail 含根目录与实际子目录列表', async () => {
    const root = mkDir('e002-root')
    mkDir('e002-root', 'X6Game')
    fs.writeFileSync(path.join(root, 'X6Game', 'somefile.txt'), 'x')

    const channels = await import('../scan-channels')
    const res = await channels.resolveScanChannels([root])

    expect(res.missing).toHaveLength(1)
    expect(res.missing[0].code).toBe('E002')
    const entry = entryOf('E002')
    expect(entry).toBeDefined()
    const detail = entry?.detail as { root: string; children: string[] }
    expect(detail.root).toBe(root)
    expect(detail.children).toContain('X6Game')
  })
})

describe('E003 目录访问被拒绝（权限不足）', () => {
  it('GamePlayPhotos 访问返回 EACCES → 产出 E003，detail 含路径/错误码/错误栈', async () => {
    const root = mkDir('e003-root')
    const gpp = mkDir('e003-root', 'X6Game', 'Saved', 'GamePlayPhotos')

    // 用 access 抛 EACCES 模拟权限不足：直接调用解析函数并注入拒绝
    const err = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const origAccess = fs.promises.access
    ;(fs.promises as { access: typeof origAccess }).access = (async () => {
      throw err
    }) as typeof origAccess
    // 显式注入 no-op logger，避免默认 logger 触发 electron app.getPath（本文件未 mock electron）
    const noopLogger = () => undefined
    try {
      await rootMod.resolveGamePlayPhotosScanRoots([gpp, root], noopLogger)
    } finally {
      ;(fs.promises as { access: typeof origAccess }).access = origAccess
    }

    const entry = entryOf('E003')
    expect(entry).toBeDefined()
    expect(entry?.kind).toBe('permission')
    const detail = entry?.detail as { path: string; errorCode: string; stack: string }
    expect(detail.errorCode).toBe('EACCES')
    expect(detail.path).toContain('GamePlayPhotos')
    expect(typeof detail.stack).toBe('string')
  })
})

describe('E004 未找到 UID 文件夹', () => {
  it('GamePlayPhotos 下无纯数字子目录 → 产出 E004，detail 含目录下全部条目名', async () => {
    const gpp = mkDir('e004', 'GamePlayPhotos')
    fs.mkdirSync(path.join(gpp, 'NikkiPhotos_HighQuality'), { recursive: true })
    fs.writeFileSync(path.join(gpp, 'readme.txt'), 'x')

    const uids = uidMod.discoverUidsFromGameDirs([gpp])
    expect(uids).toEqual([])

    const entry = entryOf('E004')
    expect(entry).toBeDefined()
    const detail = entry?.detail as { path: string; entries: string[]; readable: boolean }
    expect(detail.path).toBe(gpp)
    expect(detail.entries).toContain('NikkiPhotos_HighQuality')
    expect(detail.entries).toContain('readme.txt')
    expect(detail.readable).toBe(true)
  })

  it('发现 UID 时不产出 E004', () => {
    const gpp = mkDir('e004-ok', 'GamePlayPhotos')
    fs.mkdirSync(path.join(gpp, '1234567890', 'NikkiPhotos_HighQuality'), { recursive: true })

    expect(uidMod.discoverUidsFromGameDirs([gpp])).toEqual(['1234567890'])
    expect(entryOf('E004')).toBeUndefined()
  })
})

describe('E005 图片/元数据读取失败', () => {
  it('stat 抛 EPERM → 产出 E005，detail 含失败路径与错误类型', async () => {
    const worker = await import('../worker-entry')
    const dir = mkDir('e005')
    fs.writeFileSync(path.join(dir, 'a.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))

    const statSpy = vi
      .spyOn(fs.promises, 'stat')
      .mockRejectedValueOnce(Object.assign(new Error('EPERM'), { code: 'EPERM' }))
    try {
      await worker.scanDirectory(dir, false, false)
    } finally {
      statSpy.mockRestore()
    }

    const entry = entryOf('E005')
    expect(entry).toBeDefined()
    const detail = entry?.detail as { path: string; errorType: string }
    expect(detail.errorType).toBe('EPERM')
    expect(detail.path).toContain('a.jpg')
  })
})

describe('成功路径不产生错误码（防误报）', () => {
  it('正常解析出官方相册目录时不产出 E001/E002', async () => {
    const root = mkDir('ok-root')
    mkDir('ok-root', 'X6Game', 'Saved', 'GamePlayPhotos', '1234567890')

    const channels = await import('../scan-channels')
    const res = await channels.resolveScanChannels([root])

    expect(res.officialAlbum).toHaveLength(1)
    expect(entryOf('E001')).toBeUndefined()
    expect(entryOf('E002')).toBeUndefined()
  })
})

describe('toExportText 导出文本含错误码列', () => {
  it('带 code 的条目在导出文本中出现错误码', async () => {
    const root = mkDir('export-root')
    mkDir('export-root', 'X6Game')
    const channels = await import('../scan-channels')
    await channels.resolveScanChannels([root])

    const store = await import('../scan-log-store')
    const text = store.toExportText()
    expect(text).toContain('E002')
    expect(text).toContain('export-root')
  })
})
