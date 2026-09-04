/**
 * GamePlayPhotos 变体路径与隐藏目录强制豁免（需求一 / 需求二.2）。
 *
 * 覆盖：
 * - 变体路径 [游戏根]\X6Game\GamePlayPhotos（无 Saved 段）同样命中遍历豁免；
 * - 官方相册目录指纹判定（手动直选 / 副本目录）；
 * - scanDirectory 对变体与手动直选目录均强制遍历（缓存子目录与小图不过滤）；
 * - 用户自建同名目录不得被误豁免。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// 1x1 透明 PNG（约 67 字节，远小于 5KB 过滤阈值）
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC'
const PNG_1X1 = Buffer.from(PNG_1X1_BASE64, 'base64')

let mod: typeof import('../worker-entry')
let rootMod: typeof import('../gameplayphotos-root')
let channels: typeof import('../scan-channels')
let tmpRoot: string

beforeAll(async () => {
  // scanDirectory 末尾 emitProgress 需要 parentPort，导入前安装桩
  ;(process as { parentPort?: unknown }).parentPort = {
    on: () => undefined,
    postMessage: () => undefined
  }
  mod = await import('../worker-entry')
  rootMod = await import('../gameplayphotos-root')
  channels = await import('../scan-channels')
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wxnn-gpp-variant-'))
})

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  delete (process as { parentPort?: unknown }).parentPort
})

function writePng(p: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, PNG_1X1)
}

function buildTree(root: string): void {
  const hq = path.join(root, '1234567890', 'NikkiPhotos_HighQuality')
  const lq = path.join(root, '1234567890', 'NikkiPhotos_LowQuality')
  writePng(path.join(hq, 'small.png')) // < 5KB → 应用小图过滤时被跳过
  writePng(path.join(hq, 'Cache', 'inside_cache.png')) // 缓存子目录
  writePng(path.join(lq, 'normal_lq.png'))
}

describe('GamePlayPhotos 变体路径豁免', () => {
  it('X6Game\\GamePlayPhotos（无 Saved 段）命中豁免', () => {
    expect(mod.isGamePlayPhotosScanExempt('C:\\x\\X6Game\\GamePlayPhotos')).toBe(true)
    expect(mod.isGamePlayPhotosScanExempt('C:\\x\\X6Game\\GamePlayPhotos\\1234567890\\a.png')).toBe(
      true
    )
  })
})

describe('resolveGamePlayPhotosDir 变体兜底（需求二.2）', () => {
  it('Saved 变体存在时优先返回 Saved 变体', async () => {
    const root = path.join(tmpRoot, 'case-saved')
    fs.mkdirSync(path.join(root, 'X6Game', 'Saved', 'GamePlayPhotos'), { recursive: true })
    fs.mkdirSync(path.join(root, 'X6Game', 'GamePlayPhotos'), { recursive: true })
    await expect(rootMod.resolveGamePlayPhotosDir(root)).resolves.toBe(
      path.join(root, 'X6Game', 'Saved', 'GamePlayPhotos')
    )
  })

  it('Saved 变体缺失时降级返回 X6Game\\GamePlayPhotos', async () => {
    const root = path.join(tmpRoot, 'case-fallback')
    fs.mkdirSync(path.join(root, 'X6Game', 'GamePlayPhotos'), { recursive: true })
    await expect(rootMod.resolveGamePlayPhotosDir(root)).resolves.toBe(
      path.join(root, 'X6Game', 'GamePlayPhotos')
    )
  })

  it('两者均不存在时返回 null', async () => {
    const root = path.join(tmpRoot, 'case-none')
    fs.mkdirSync(path.join(root, 'X6Game'), { recursive: true })
    await expect(rootMod.resolveGamePlayPhotosDir(root)).resolves.toBeNull()
  })
})

describe('isOfficialAlbumDir 官方相册目录指纹判定', () => {
  it('目录名为 GamePlayPhotos 且含纯数字 UID 子目录 → true', async () => {
    const dir = path.join(tmpRoot, 'fp-uid', 'GamePlayPhotos')
    fs.mkdirSync(path.join(dir, '1234567890'), { recursive: true })
    await expect(rootMod.isOfficialAlbumDir(dir)).resolves.toBe(true)
  })

  it('目录名为 GamePlayPhotos 且含 NikkiPhotos_HighQuality → true（直接选中 UID 目录场景）', async () => {
    const dir = path.join(tmpRoot, 'fp-hq', 'GamePlayPhotos')
    fs.mkdirSync(path.join(dir, 'NikkiPhotos_HighQuality'), { recursive: true })
    await expect(rootMod.isOfficialAlbumDir(dir)).resolves.toBe(true)
  })

  it('目录名非 GamePlayPhotos 但含 NikkiPhotos_HighQuality → false（防误豁免普通目录）', async () => {
    const dir = path.join(tmpRoot, 'fp-notalbum', 'InfinityNikki')
    fs.mkdirSync(path.join(dir, 'NikkiPhotos_HighQuality'), { recursive: true })
    await expect(rootMod.isOfficialAlbumDir(dir)).resolves.toBe(false)
  })

  it('用户自建同名空目录 → false（防误豁免）', async () => {
    const dir = path.join(tmpRoot, 'fp-empty', 'GamePlayPhotos')
    fs.mkdirSync(dir, { recursive: true })
    await expect(rootMod.isOfficialAlbumDir(dir)).resolves.toBe(false)
  })

  it('目录不存在 → false', async () => {
    await expect(rootMod.isOfficialAlbumDir(path.join(tmpRoot, 'not-exist'))).resolves.toBe(false)
  })
})

describe('scanDirectory 强制遍历豁免（需求一 / 需求二.2 端到端）', () => {
  it('变体路径 X6Game\\GamePlayPhotos：缓存子目录与小图均被收录', async () => {
    const gppRoot = path.join(tmpRoot, 'e2e-variant', 'X6Game', 'GamePlayPhotos')
    buildTree(gppRoot)
    const { files } = await mod.scanDirectory(gppRoot, false, true)
    const paths = files.map((f) => f.file_path)
    expect(paths.some((p) => p.endsWith('small.png'))).toBe(true)
    expect(paths.some((p) => p.endsWith(path.join('Cache', 'inside_cache.png')))).toBe(true)
  })

  it('手动直选的副本目录（保留 GamePlayPhotos 原名，父级为中文路径）同样豁免', async () => {
    const copyRoot = path.join(tmpRoot, 'e2e-manual-copy', '我的相册备份', 'GamePlayPhotos')
    buildTree(copyRoot)
    const { files } = await mod.scanDirectory(copyRoot, false, true)
    const paths = files.map((f) => f.file_path)
    expect(paths.some((p) => p.endsWith('small.png'))).toBe(true)
    expect(paths.some((p) => p.endsWith(path.join('Cache', 'inside_cache.png')))).toBe(true)
  })

  it('隐藏 + 系统属性目录无需开启「显示隐藏文件」即可扫描', async () => {
    const gppRoot = path.join(tmpRoot, 'e2e-hidden', 'X6Game', 'Saved', 'GamePlayPhotos')
    buildTree(gppRoot)
    // 设置隐藏 + 系统属性（Windows）；设置失败时用例退化为「普通目录同样可扫」，仍具回归价值
    try {
      const { execFileSync } = await import('child_process')
      execFileSync('attrib', ['+h', '+s', gppRoot], { windowsHide: true })
      execFileSync('attrib', ['+h', '+s', path.join(gppRoot, '1234567890')], { windowsHide: true })
    } catch {
      /* 非 Windows 或无 attrib：退化为普通目录扫描校验 */
    }
    try {
      const { files } = await mod.scanDirectory(gppRoot, false, true)
      expect(files.length).toBeGreaterThan(0)
      const paths = files.map((f) => f.file_path)
      expect(paths.some((p) => p.includes('NikkiPhotos_HighQuality'))).toBe(true)
    } finally {
      // 还原属性，避免临时目录无法清理
      try {
        const { execFileSync } = await import('child_process')
        execFileSync('attrib', ['-h', '-s', path.join(gppRoot, '1234567890')], {
          windowsHide: true
        })
        execFileSync('attrib', ['-h', '-s', gppRoot], { windowsHide: true })
      } catch {
        /* ignore */
      }
    }
  })

  it('对照组：非官方相册目录仍应用缓存跳过与小图过滤', async () => {
    const otherRoot = path.join(tmpRoot, 'e2e-control', 'NotGame', 'Photos')
    buildTree(otherRoot)
    const { files } = await mod.scanDirectory(otherRoot, false, true)
    const paths = files.map((f) => f.file_path)
    expect(paths.some((p) => p.endsWith('small.png'))).toBe(false)
    expect(paths.some((p) => p.endsWith(path.join('Cache', 'inside_cache.png')))).toBe(false)
  })
})

describe('resolveScanChannels 双通道编排（需求二.3 / 用户确认恢复 ScreenShot）', () => {
  it('官方相册通道取 Saved 变体；次级通道收录 ScreenShot 与 Video', async () => {
    const root = path.join(tmpRoot, 'ch-full')
    fs.mkdirSync(path.join(root, 'X6Game', 'Saved', 'GamePlayPhotos'), { recursive: true })
    fs.mkdirSync(path.join(root, 'X6Game', 'ScreenShot'), { recursive: true })
    fs.mkdirSync(path.join(root, 'X6Game', 'Video'), { recursive: true })

    const res = await channels.resolveScanChannels([root])
    expect(res.officialAlbum).toEqual([path.join(root, 'X6Game', 'Saved', 'GamePlayPhotos')])
    expect(res.secondary).toEqual([
      path.join(root, 'X6Game', 'ScreenShot'),
      path.join(root, 'X6Game', 'Video')
    ])
    expect(res.missing).toEqual([])
  })

  it('Saved 变体缺失 → 官方相册通道降级到 X6Game\\GamePlayPhotos', async () => {
    const root = path.join(tmpRoot, 'ch-variant')
    fs.mkdirSync(path.join(root, 'X6Game', 'GamePlayPhotos'), { recursive: true })

    const res = await channels.resolveScanChannels([root])
    expect(res.officialAlbum).toEqual([path.join(root, 'X6Game', 'GamePlayPhotos')])
    expect(res.missing).toEqual([])
  })

  it('根目录无 GamePlayPhotos → missing 记录 E002 与实际子目录列表', async () => {
    const root = path.join(tmpRoot, 'ch-missing')
    fs.mkdirSync(path.join(root, 'X6Game'), { recursive: true })

    const res = await channels.resolveScanChannels([root])
    expect(res.officialAlbum).toEqual([])
    expect(res.missing).toHaveLength(1)
    expect(res.missing[0].code).toBe('E002')
    expect(res.missing[0].root).toBe(root)
    expect(res.missing[0].children).toContain('X6Game')
  })

  it('入参非数组 → 返回空通道集，不抛异常', async () => {
    await expect(channels.resolveScanChannels(undefined as unknown as string[])).resolves.toEqual({
      officialAlbum: [],
      secondary: [],
      missing: []
    })
  })
})
