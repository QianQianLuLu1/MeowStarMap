/**
 * 诊断测试：复现并定位「扫描发现 0 个媒体文件」的根因（Bug C）。
 *
 * 不修改任何业务代码，仅用 fixtures 驱动真实扫描链路：
 *   findMediaDirectories（发现目录） → scanDirectory（递归 + 过滤 + 入库判断）
 *
 * 不依赖 better-sqlite3（原生模块与当前 Node 存在 ABI 不匹配），scanDirectory 在 db 未打开时
 * 仍会填充 files 数组（仅跳过持久化），足以验证「给定正确目录时能发现文件」这一核心机制。
 *
 * 运行：npx vitest run src/main/scanner/__tests__/scan-diagnose.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fsp } from 'fs'
import os from 'os'
import path from 'path'
import { findMediaDirectories, scanDirectory } from '../../scanner/worker-entry'

let fixtureRoot: string
const cleanup: string[] = []

function makeBytes(size: number): Buffer {
  const buf = Buffer.alloc(size, 0xab)
  buf[0] = 0xff
  buf[1] = 0xd8
  return buf
}

async function writeFile(p: string, content: Buffer | string) {
  await fsp.mkdir(path.dirname(p), { recursive: true })
  await fsp.writeFile(p, content)
}

beforeAll(async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'nikki-scan-diag-'))
  cleanup.push(base)
  // 真实游戏相册布局：NikkiPhotos_HighQuality 子目录下含正常图片、中文相册、<5KB 小图
  fixtureRoot = path.join(base, 'InfinityNikki')
  await writeFile(
    path.join(fixtureRoot, 'NikkiPhotos_HighQuality', 'photo1.jpg'),
    makeBytes(64 * 1024)
  )
  await writeFile(
    path.join(fixtureRoot, 'NikkiPhotos_HighQuality', 'photo2.png'),
    makeBytes(48 * 1024)
  )
  await writeFile(
    path.join(fixtureRoot, 'NikkiPhotos_HighQuality', '中文相册', 'photo3.jpg'),
    makeBytes(32 * 1024)
  )
  // <5KB 小图（applyFilters=true 时会被过滤）
  await writeFile(
    path.join(fixtureRoot, 'NikkiPhotos_HighQuality', 'tiny.jpg'),
    makeBytes(2 * 1024)
  )
  // 非媒体文件，应被忽略
  await writeFile(path.join(fixtureRoot, 'NikkiPhotos_HighQuality', 'readme.txt'), 'not media')
})

afterAll(async () => {
  for (const dir of cleanup) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe('Bug C 诊断：扫描发现 0 文件根因', () => {
  it('findMediaDirectories：数组形式自定义路径应原样返回该目录', async () => {
    const dirs = await findMediaDirectories([fixtureRoot])
    expect(dirs).toContain(fixtureRoot)
    expect(dirs.length).toBeGreaterThanOrEqual(1)
  })

  it('scanDirectory（applyFilters=true）：应发现 3 张正常图片，<5KB 被过滤', async () => {
    const { files } = await scanDirectory(fixtureRoot, false, true)
    // photo1/photo2/中文photo3 命中；tiny.jpg(<5KB) 被过滤；txt 被忽略
    expect(files.length, 'applyFilters=true 应发现 3 张图片').toBe(3)
    const names = files.map((f) => f.file_name).sort()
    expect(names).toEqual(['photo1.jpg', 'photo2.png', 'photo3.jpg'])
  })

  it('scanDirectory（applyFilters=false）：<5KB 小图也应被计入', async () => {
    const { files } = await scanDirectory(fixtureRoot, false, false)
    // 不过滤：photo1/photo2/中文photo3/tiny = 4
    expect(files.length, 'applyFilters=false 应发现 4 张图片').toBe(4)
  })
})
