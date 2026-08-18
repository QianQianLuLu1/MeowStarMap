/**
 * @layer L1
 * @module src/main/utils/disk
 * @coverage assertDiskSpace
 * @dependencies mock: fs/promises statfs
 * @remarks mock statfs 后的纯逻辑测试
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// 控制 statfs 返回值与行为
let statfsResult: { bavail: number; bsize: number } | null | Error = {
  bavail: 1000,
  bsize: 4096
}

vi.mock('fs/promises', () => ({
  default: {
    statfs: vi.fn(async (dir: string) => {
      if (statfsResult instanceof Error) throw statfsResult
      if (statfsResult === null) throw new Error('ENOENT: no such file or directory')
      return statfsResult
    })
  }
}))

import { assertDiskSpace } from './disk'
import fsp from 'fs/promises'

describe('disk - assertDiskSpace', () => {
  beforeEach(() => {
    statfsResult = { bavail: 1000, bsize: 4096 } // 4MB 可用
    vi.mocked(fsp.statfs).mockClear()
  })

  it('可用空间充足时不抛错', async () => {
    statfsResult = { bavail: 1000, bsize: 4096 } // 4MB
    await expect(assertDiskSpace('/fake/dir', 1024)).resolves.toBeUndefined()
  })

  it('可用空间等于需求时不抛错（边界）', async () => {
    statfsResult = { bavail: 1000, bsize: 4096 } // 4096000 bytes
    await expect(assertDiskSpace('/fake/dir', 4096000)).resolves.toBeUndefined()
  })

  it('可用空间不足时抛错（消息含需要与剩余 MB）', async () => {
    statfsResult = { bavail: 1000, bsize: 4096 } // 1000*4096 = 3.9MB
    await expect(assertDiskSpace('/fake/dir', 5 * 1024 * 1024)).rejects.toThrow(
      /磁盘空间不足，需要 5\.0 MB，仅剩 3\.9 MB/
    )
  })

  it('available = 0 时任何需求都抛错', async () => {
    statfsResult = { bavail: 0, bsize: 4096 }
    await expect(assertDiskSpace('/fake/dir', 1)).rejects.toThrow(/磁盘空间不足/)
  })

  it('requiredBytes = 0 时不抛错', async () => {
    statfsResult = { bavail: 0, bsize: 4096 }
    await expect(assertDiskSpace('/fake/dir', 0)).resolves.toBeUndefined()
  })

  it('statfs 抛 ENOENT 时静默跳过（不阻断主流程）', async () => {
    statfsResult = null
    await expect(assertDiskSpace('/nonexistent/dir', 1024)).resolves.toBeUndefined()
  })

  it('statfs 抛其他错误时静默跳过（除非是磁盘空间不足错误）', async () => {
    statfsResult = new Error('EPERM: operation not permitted')
    await expect(assertDiskSpace('/fake/dir', 1024)).resolves.toBeUndefined()
  })

  it('抛出的"磁盘空间不足"错误不会被静默处理', async () => {
    // 即使 statfs 抛错，错误消息包含"磁盘空间不足"时仍向上抛
    statfsResult = new Error('磁盘空间不足，需要 100 MB，仅剩 50 MB')
    await expect(assertDiskSpace('/fake/dir', 1024)).rejects.toThrow(/磁盘空间不足/)
  })

  it('调用 fsp.statfs 时传入目录路径', async () => {
    await assertDiskSpace('/specific/dir', 1024)
    expect(fsp.statfs).toHaveBeenCalledWith('/specific/dir')
  })

  it('大数值空间计算正确', async () => {
    // 1GB available, 500MB required
    statfsResult = { bavail: 1024 * 1024, bsize: 1024 } // 1GB
    await expect(assertDiskSpace('/fake/dir', 500 * 1024 * 1024)).resolves.toBeUndefined()
  })

  it('bsize = 1 时按 bavail 字节计算', async () => {
    statfsResult = { bavail: 100, bsize: 1 } // 100 bytes
    await expect(assertDiskSpace('/fake/dir', 101)).rejects.toThrow(/磁盘空间不足/)
    await expect(assertDiskSpace('/fake/dir', 100)).resolves.toBeUndefined()
  })

  it('超大需求触发磁盘空间不足', async () => {
    statfsResult = { bavail: 1000, bsize: 4096 } // 4MB
    await expect(assertDiskSpace('/fake/dir', Number.MAX_SAFE_INTEGER)).rejects.toThrow(
      /磁盘空间不足/
    )
  })
})
