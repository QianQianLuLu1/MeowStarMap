import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execSync } from 'child_process'
import { isGamePlayPhotosScanExempt, scanDirectory } from '../worker-entry'
import {
  extractUidFromPath,
  extractAlbumTypeFromPath,
  extractMediaSourceFromPath,
  resolveNativeThumbnailPath
} from '../path-classifier'

// 1x1 透明 PNG（合法媒体文件），高频复用
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC',
  'base64'
)

let tmpRoot: string
let gppRoot: string

beforeAll(async () => {
  ;(process as { parentPort?: unknown }).parentPort = {
    on: () => undefined,
    postMessage: () => undefined
  }
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wxnn-compat-'))
  gppRoot = path.join(tmpRoot, 'X6Game', 'Saved', 'GamePlayPhotos')
  buildTree()
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

// 构造多 UID + 多相册子目录的 GamePlayPhotos 树（含 HQ/LQ 同名与原生缩略图复用场景）
function buildTree(): void {
  const uids = ['1234567890', '9876543210']
  for (const uid of uids) {
    // 高清原图 + 同名原生低清缩略图（复用场景）
    writePng(path.join(gppRoot, uid, 'NikkiPhotos_HighQuality', 'shot_a.png'))
    writePng(path.join(gppRoot, uid, 'NikkiPhotos_LowQuality', 'shot_a.png'))
    // 打卡/旅行手帐等自定义相册子目录（按原目录名分类）
    writePng(path.join(gppRoot, uid, 'TravelLog', 'trip.png'))
  }
}

function listAllFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else out.push(full)
    }
  }
  walk(dir)
  return out
}

describe('nikki_albums 等价对比（G4 characterization）', () => {
  it('扫描根被正确识别为 GamePlayPhotos 豁免子树', () => {
    expect(isGamePlayPhotosScanExempt(gppRoot)).toBe(true)
  })

  it('每张照片的 UID / 相册 / 来源分类与 path-classifier 纯函数完全一致', async () => {
    const { files } = await scanDirectory(gppRoot, false, true)
    expect(files.length).toBeGreaterThan(0)

    for (const f of files) {
      // 与 nikki_albums 等价规则（同一 path-classifier）逐字段对齐
      expect(f.account_uid).toBe(extractUidFromPath(f.file_path))
      expect(f.album_type).toBe(extractAlbumTypeFromPath(f.file_path))
      // GamePlayPhotos 一律归属游戏内官方相册来源
      expect(f.media_source).toBe(extractMediaSourceFromPath(f.file_path))
      expect(f.media_source).toBe('game')
    }
  })

  it('HQ 图片复用原生 LQ 缩略图，不生成新缩略图文件（spec 六③）', async () => {
    const before = listAllFiles(gppRoot).sort()
    const { files } = await scanDirectory(gppRoot, false, true)
    const after = listAllFiles(gppRoot).sort()
    // GamePlayPhotos 路径下不新增任何缩略图文件
    expect(after).toEqual(before)

    const hqFiles = files.filter((f) => f.file_path.includes('NikkiPhotos_HighQuality'))
    expect(hqFiles.length).toBeGreaterThan(0)
    for (const f of hqFiles) {
      // 缩略图直接指向原生低清同名文件，而非生成缓存
      expect(f.thumbnail).toBe(resolveNativeThumbnailPath(f.file_path))
    }
    // 自定义相册（无 HQ/LQ 映射）不应关联原生缩略图
    const travel = files.filter((f) => f.file_path.includes('TravelLog'))
    for (const f of travel) {
      expect(f.thumbnail).toBeUndefined()
    }
  })
})

describe('隐藏目录遍历豁免（spec 六④）', () => {
  it('隐藏属性的相册子目录仍被强制递归遍历', () => {
    const hiddenDir = path.join(gppRoot, '1234567890', 'NikkiPhotos_HighQuality', 'HiddenSub')
    writePng(path.join(hiddenDir, 'in_hidden.png'))
    let attribOk = false
    try {
      execSync(`attrib +h "${hiddenDir}"`, { stdio: 'ignore' })
      attribOk = true
    } catch {
      // 非 Windows / 无 attrib 时退化为普通目录断言（readdir 本就忽略隐藏属性）
    }
    return (async () => {
      const { files } = await scanDirectory(gppRoot, false, true)
      const hit = files.some((f) => f.file_path.endsWith('in_hidden.png'))
      // 无论是否成功设置隐藏位，目录都应被遍历（Windows readdir 忽略 HIDDEN 属性）
      expect(hit).toBe(true)
      if (attribOk) {
        execSync(`attrib -h "${hiddenDir}"`, { stdio: 'ignore' })
      }
    })()
  })
})
