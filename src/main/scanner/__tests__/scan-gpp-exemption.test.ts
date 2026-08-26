import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// 1x1 透明 PNG（约 67 字节，远小于 5KB 过滤阈值），用于构造合法媒体文件
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC'
const PNG_1X1 = Buffer.from(PNG_1X1_BASE64, 'base64')

// scanDirectory 末尾 emitProgress 需要 parentPort，导入前安装桩（与 worker-entry.test.ts 同源）
let mod: typeof import('../worker-entry')
let tmpRoot: string

beforeAll(async () => {
  ;(process as { parentPort?: unknown }).parentPort = {
    on: () => undefined,
    postMessage: () => undefined
  }
  mod = await import('../worker-entry')
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wxnn-gpp-exempt-'))
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

function buildTree(root: string): string {
  // 构造一个 GamePlayPhotos 风格的目录树（仅在 root 已含 X6Game\Saved\GamePlayPhotos 时命中豁免）
  const hq = path.join(root, '1234567890', 'NikkiPhotos_HighQuality')
  const cache = path.join(hq, 'Cache')
  const lq = path.join(root, '1234567890', 'NikkiPhotos_LowQuality')
  writePng(path.join(hq, 'small.png')) // < 5KB → 若应用小图过滤会被跳过
  writePng(path.join(cache, 'inside_cache.png')) // 缓存子目录 → 若应用缓存跳过会被跳过
  writePng(path.join(lq, 'normal_lq.png'))
  return root
}

describe('isGamePlayPhotosScanExempt（G3 豁免判定纯函数）', () => {
  it('GamePlayPhotos 根/子路径返回 true', () => {
    expect(mod.isGamePlayPhotosScanExempt('C:\\x\\X6Game\\Saved\\GamePlayPhotos')).toBe(true)
    expect(
      mod.isGamePlayPhotosScanExempt(
        'C:\\x\\X6Game\\Saved\\GamePlayPhotos\\1234567890\\NikkiPhotos_HighQuality\\a.png'
      )
    ).toBe(true)
  })

  it('非 GamePlayPhotos 路径返回 false（ScreenShot / 同名用户目录）', () => {
    expect(mod.isGamePlayPhotosScanExempt('C:\\x\\X6Game\\ScreenShot')).toBe(false)
    // 评审收紧：必须命中完整 \X6Game\Saved\GamePlayPhotos\，防同名用户目录误豁免
    expect(mod.isGamePlayPhotosScanExempt('C:\\backup\\GamePlayPhotos')).toBe(false)
    expect(mod.isGamePlayPhotosScanExempt('')).toBe(false)
  })
})

describe('scanDirectory 在 GamePlayPhotos 下强制遍历豁免（G3 集成）', () => {
  it('GamePlayPhotos 树：缓存子目录与小图均被收录（不过滤）', async () => {
    const gppRoot = path.join(tmpRoot, 'X6Game', 'Saved', 'GamePlayPhotos')
    buildTree(gppRoot)
    // db 未连接时 saveBatchToDatabase 直接返回 0，不影响 files 收集
    const { files } = await mod.scanDirectory(gppRoot, false, true)
    const paths = files.map((f) => f.file_path)
    expect(paths.some((p) => p.endsWith('small.png'))).toBe(true)
    expect(paths.some((p) => p.endsWith(path.join('Cache', 'inside_cache.png')))).toBe(true)
  })

  it('非 GamePlayPhotos 树（对照组）：缓存子目录与小图被跳过', async () => {
    const otherRoot = path.join(tmpRoot, 'NotGame', 'Photos')
    buildTree(otherRoot)
    const { files } = await mod.scanDirectory(otherRoot, false, true)
    const paths = files.map((f) => f.file_path)
    expect(paths.some((p) => p.endsWith('small.png'))).toBe(false)
    expect(paths.some((p) => p.endsWith(path.join('Cache', 'inside_cache.png')))).toBe(false)
  })
})
