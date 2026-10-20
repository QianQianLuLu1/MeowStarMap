/**
 * CI 复现用例：Windows 形态游戏根喂进通道编排时，不得被误记成 E002。
 *
 * 为什么单独成文件：`__tests__/scan-channels.test.ts` 用 `fs.mkdtempSync(os.tmpdir())` 建**真**
 * 目录，路径形态恒等于宿主，因此它在 Windows 与 CI 上都自洽——也就永远测不到
 * 「库里的 Windows 串 + CI 的 posix 绑定」这一对组合。本文件把 fs 全量 mock，
 * 只喂 Windows 字面量，配合 `vitest.ci-linux.config.ts` 即可在开发机复现 CI 红灯。
 *
 * 锁步关系（改动任一侧都要同时看另一侧）：
 * - `gameplayphotos-root.ts` 的候选串按数据方言拼接 ⇒ Windows 根拼出反斜杠串；
 * - `scan-channels.ts:114` 的前缀比较必须用同方言的 `sepOf(root)`，
 *   用宿主 `path.sep`（CI 上是 '/'）就永远匹配不到 ⇒ 每个 Windows 根都记 E002。
 *
 * 判别力（不是恒真断言）：
 * - 把 `scan-channels.ts` 的 `sepOf(root)` 换回 `path.sep` ⇒ 装置下本文件红（missing 非空）；
 * - 把 `gameplayphotos-root.ts` 的 `joinUnder` 换回宿主 `path.join` ⇒ 装置下 officialAlbum 空、
 *   secondary 出现混合分隔符 ⇒ 本文件与 resolve-gameplayphotos.test.ts 双双红。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fsp from 'fs/promises'
import { resolveScanChannels } from '../scan-channels'

const mockAccess = vi.mocked(fsp.access)
const mockReaddir = vi.mocked(fsp.readdir)

vi.mock('fs/promises', () => ({
  default: {
    access: vi.fn(),
    readFile: vi.fn(),
    readdir: vi.fn()
  }
}))

// gameplayphotos-root 经 utils/logger 间接触 electron（app.getPath），单测里必须 stub
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getName: () => 'test', getAppPath: () => '/tmp' }
}))

/**
 * CI 复现装置（常驻）：宿主 `path` 钉成 posix。理由与 resolve-gameplayphotos.test.ts 相同——
 * 本文件只喂 Windows 字面量且 fs 全量 mock，钉 posix 后开发机也能抓住
 * 「把 sepOf/joinUnder 撤成宿主 path.sep / path.join」这类回归（本机宿主即 win32，不钉就永远看不见）。
 * 工厂内必须动态 import：`vi.mock` 会被提升到文件顶部，引用顶层 import 绑定会撞 TDZ。
 */
vi.mock('path', async (importOriginal) => {
  const { posixHost } = await import('../../../../tests/mocks/posix-host-path')
  return posixHost(importOriginal as () => Promise<unknown>)
})
vi.mock('node:path', async (importOriginal) => {
  const { posixHost } = await import('../../../../tests/mocks/posix-host-path')
  return posixHost(importOriginal as () => Promise<unknown>)
})

const WIN_ROOT = 'C:\\Games\\InfinityNikki Launcher\\InfinityNikki'
const WIN_GPP = `${WIN_ROOT}\\X6Game\\Saved\\GamePlayPhotos`

/** 只有已登记的 Windows 形态路径 access 才成功（其余按 ENOENT 失败） */
function existsOnly(paths: readonly string[]): void {
  mockAccess.mockImplementation((p: unknown) =>
    typeof p === 'string' && paths.includes(p)
      ? Promise.resolve()
      : Promise.reject(new Error('ENOENT'))
  )
}

describe('resolveScanChannels —— Windows 形态游戏根（CI 复现）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAccess.mockReset()
    mockReaddir.mockReset()
    mockReaddir.mockResolvedValue([] as never)
  })

  it('正常：解析出官方相册目录，且 missing 不记 E002', async () => {
    existsOnly([WIN_GPP, `${WIN_ROOT}\\X6Game\\ScreenShot`])
    const res = await resolveScanChannels([WIN_ROOT])
    expect(res.officialAlbum).toEqual([WIN_GPP])
    expect(res.missing).toEqual([])
  })

  it('正常：次级通道拼接结果不得出现混合分隔符', async () => {
    existsOnly([WIN_GPP, `${WIN_ROOT}\\X6Game\\Video`])
    const res = await resolveScanChannels([WIN_ROOT])
    expect(res.secondary).toEqual([`${WIN_ROOT}\\X6Game\\Video`])
    for (const p of res.secondary) {
      expect(p.includes('/') && p.includes('\\')).toBe(false)
    }
  })

  it('异常：根下确实没有 GamePlayPhotos 时仍记 E002（修复不得把失败变静默）', async () => {
    existsOnly([])
    const res = await resolveScanChannels([WIN_ROOT])
    expect(res.officialAlbum).toEqual([])
    expect(res.missing).toHaveLength(1)
    expect(res.missing[0].code).toBe('E002')
    expect(res.missing[0].root).toBe(WIN_ROOT)
  })

  it('边界：手动直选 GamePlayPhotos 目录（相等分支）也不得记 E002', async () => {
    existsOnly([WIN_GPP])
    mockReaddir.mockResolvedValue([
      { name: 'NikkiPhotos_HighQuality', isDirectory: () => true }
    ] as never)
    const res = await resolveScanChannels([WIN_GPP])
    expect(res.officialAlbum).toEqual([WIN_GPP])
    expect(res.missing).toEqual([])
  })
})
