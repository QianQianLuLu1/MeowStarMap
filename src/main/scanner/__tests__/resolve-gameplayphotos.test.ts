/**
 * 子任务3：resolveGamePlayPhotosScanRoots 单位测试。
 * 验证「游戏根目录 → [根]/X6Game/Saved/GamePlayPhotos 唯一扫描根」的拼接语义，
 * 对齐 nikki_albums（installPath 访问其下 GamePlayPhotos，不递归整盘）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fsp from 'fs/promises'
import { resolveGamePlayPhotosScanRoots, GAMEPLAYPHOTOS_RELATIVE } from '../gameplayphotos-root'

const mockAccess = vi.mocked(fsp.access)

vi.mock('fs/promises', () => ({
  default: {
    access: vi.fn(),
    readFile: vi.fn(),
    readdir: vi.fn()
  }
}))

const GPP_SUFFIX = 'X6Game\\Saved\\GamePlayPhotos'

// 缺失根目录时 resolveGamePlayPhotosScanRoots 会记录 logger.warn，
// 触发 initLogger → app.getPath('userData')；本文件未依赖生产 electron，需 mock 以避免崩溃。
vi.mock('electron', () => ({
  app: { getPath: () => process.cwd() }
}))

describe('resolveGamePlayPhotosScanRoots', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAccess.mockReset()
  })

  it('将游戏根拼接为唯一扫描根 X6Game\\Saved\\GamePlayPhotos', async () => {
    mockAccess.mockImplementation((p: unknown) =>
      String(p).endsWith(GPP_SUFFIX) ? Promise.resolve() : Promise.reject(new Error('ENOENT'))
    )
    const result = await resolveGamePlayPhotosScanRoots([
      'C:\\Games\\InfinityNikki Launcher\\InfinityNikki'
    ])
    expect(result).toEqual([
      'C:\\Games\\InfinityNikki Launcher\\InfinityNikki\\X6Game\\Saved\\GamePlayPhotos'
    ])
  })

  it('缺失 GamePlayPhotos 的根被跳过（返回空）', async () => {
    mockAccess.mockImplementation(() => Promise.reject(new Error('ENOENT')))
    const result = await resolveGamePlayPhotosScanRoots(['C:\\Games\\InfinityNikki'])
    expect(result).toEqual([])
  })

  it('所有返回目录均含 X6Game\\Saved\\GamePlayPhotos', async () => {
    mockAccess.mockImplementation((p: unknown) =>
      String(p).endsWith(GPP_SUFFIX) ? Promise.resolve() : Promise.reject(new Error('ENOENT'))
    )
    const roots = ['D:\\a', 'E:\\b\\InfinityNikki', 'F:\\c\\X']
    const result = await resolveGamePlayPhotosScanRoots(roots)
    expect(result).toHaveLength(3)
    for (const r of result) expect(r).toContain(GPP_SUFFIX)
  })

  it('忽略空串与非字符串项', async () => {
    mockAccess.mockImplementation(() => Promise.resolve())
    const result = await resolveGamePlayPhotosScanRoots([
      '',
      null as unknown as string,
      'C:\\Games\\X'
    ])
    expect(result).toEqual(['C:\\Games\\X\\' + GPP_SUFFIX])
  })

  it('GAMEPLAYPHOTOS_RELATIVE 常量路径正确', () => {
    expect(GAMEPLAYPHOTOS_RELATIVE).toBe('X6Game\\Saved\\GamePlayPhotos')
  })

  it('GamePlayPhotos 缺失时通过 logger 输出警告', async () => {
    const logger = vi.fn()
    mockAccess.mockImplementation(() => Promise.reject(new Error('ENOENT')))
    await resolveGamePlayPhotosScanRoots(['C:\\Games\\InfinityNikki'], logger)
    expect(logger).toHaveBeenCalledWith('warn', expect.stringContaining('InfinityNikki'))
  })
})
