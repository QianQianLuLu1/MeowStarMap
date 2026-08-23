/**
 * @layer L3
 * @module src/main/ipc/handlers/video
 * @coverage 视频域 IPC handler 注册与执行
 * @dependencies electron / VideoService / ThumbnailGenerator / livePhotoService / media-constants
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HandlerContext } from '../handler-context'

const { handleMock, fsStatMock, livePhotoExportMock } = vi.hoisted(() => {
  return {
    handleMock: vi.fn(),
    fsStatMock: vi.fn(),
    livePhotoExportMock: vi.fn()
  }
})

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: vi.fn() }
}))

vi.mock('fs', () => ({
  default: {
    promises: { stat: fsStatMock }
  }
}))

vi.mock('../../utils/media-constants', () => ({
  VIDEO_EXPORT_FORMATS: ['mp4', 'webm', 'mov'] as const
}))

vi.mock('../../services/livephoto-service', () => ({
  livePhotoService: { exportLivePhoto: livePhotoExportMock }
}))

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logFault: vi.fn(),
  getLogDirectory: vi.fn(() => '/mock/logs')
}))

vi.mock('../validator', async () => await import('../../../../tests/mocks/mock-validator'))

import { registerVideoHandlers } from './video'
import { assertFileReadPath, assertFileWritePath } from '../validator'

const assertFileReadPathMock = vi.mocked(assertFileReadPath)
const assertFileWritePathMock = vi.mocked(assertFileWritePath)

interface VideoServiceStub {
  getMetadata: ReturnType<typeof vi.fn>
  exportVideo: ReturnType<typeof vi.fn>
  captureFrame: ReturnType<typeof vi.fn>
  trimVideo: ReturnType<typeof vi.fn>
  changeSpeed: ReturnType<typeof vi.fn>
}

interface ThumbnailGenStub {
  generate: ReturnType<typeof vi.fn>
}

function makeCtx(videoService: VideoServiceStub, thumbnailGen: ThumbnailGenStub): HandlerContext {
  return {
    videoService,
    thumbnailGen,
    dbManager: { getSetting: vi.fn(), setSetting: vi.fn() },
    getMainWindow: () => null,
    notifyMediaUpdated: vi.fn(),
    invalidateMediaPathCache: vi.fn(),
    applyUITheme: vi.fn(),
    isThumbnailsGenerating: () => false,
    setThumbnailsGenerating: vi.fn()
  } as unknown as HandlerContext
}

function getHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  for (const call of handleMock.mock.calls) {
    if (call[0] === channel) return call[1]
  }
  throw new Error(`未找到 channel: ${channel}`)
}

describe('registerVideoHandlers', () => {
  let videoService: VideoServiceStub
  let thumbnailGen: ThumbnailGenStub

  beforeEach(() => {
    handleMock.mockClear()
    fsStatMock.mockReset()
    assertFileReadPathMock.mockReset()
    assertFileWritePathMock.mockReset()
    livePhotoExportMock.mockReset()
    videoService = {
      getMetadata: vi.fn(),
      exportVideo: vi.fn(),
      captureFrame: vi.fn(),
      trimVideo: vi.fn(),
      changeSpeed: vi.fn()
    }
    thumbnailGen = { generate: vi.fn() }
  })

  it('应注册 9 个 video channel', () => {
    registerVideoHandlers(makeCtx(videoService, thumbnailGen))
    const channels = handleMock.mock.calls.map((c) => c[0])
    expect(channels).toEqual([
      'video:thumbnail',
      'video:metadata',
      'video:export',
      'video:captureFrame',
      'video:trim',
      'video:changeSpeed',
      'video:exportLivePhoto',
      'video:edit',
      'video:editBatch'
    ])
  })

  it('video:thumbnail 调用 thumbnailGen.generate 并返回 thumbnail/hasThumbnail', async () => {
    thumbnailGen.generate.mockResolvedValue('/thumb/path')
    registerVideoHandlers(makeCtx(videoService, thumbnailGen))
    const result = (await getHandler('video:thumbnail')(['/video.mp4'])) as {
      success: true
      data: { thumbnail: string; hasThumbnail: boolean }
    }
    expect(assertFileReadPathMock).toHaveBeenCalledWith('/video.mp4')
    expect(thumbnailGen.generate).toHaveBeenCalledWith('/video.mp4')
    expect(result.data.thumbnail).toBe('/thumb/path')
    expect(result.data.hasThumbnail).toBe(true)
  })

  it('video:thumbnail 返回空时 hasThumbnail=false', async () => {
    thumbnailGen.generate.mockResolvedValue('')
    registerVideoHandlers(makeCtx(videoService, thumbnailGen))
    const result = (await getHandler('video:thumbnail')(['/v.mp4'])) as {
      success: true
      data: { hasThumbnail: boolean }
    }
    expect(result.data.hasThumbnail).toBe(false)
  })

  it('video:metadata 返回 size/duration/width/height/codec/frameRate', async () => {
    fsStatMock.mockResolvedValue({ size: 1024 })
    videoService.getMetadata.mockResolvedValue({
      duration: 5000,
      width: 1920,
      height: 1080,
      codec: 'h264',
      frameRate: 30
    })
    registerVideoHandlers(makeCtx(videoService, thumbnailGen))
    const result = (await getHandler('video:metadata')(['/v.mp4'])) as {
      success: true
      data: {
        path: string
        size: number
        duration: number
        width: number
        height: number
        codec: string
        frameRate: number
      }
    }
    expect(fsStatMock).toHaveBeenCalledWith('/v.mp4')
    expect(videoService.getMetadata).toHaveBeenCalledWith('/v.mp4')
    expect(result.data).toEqual({
      path: '/v.mp4',
      size: 1024,
      duration: 5000,
      width: 1920,
      height: 1080,
      codec: 'h264',
      frameRate: 30
    })
  })

  it('video:metadata 元数据字段缺失时回退为默认值', async () => {
    fsStatMock.mockResolvedValue({ size: 0 })
    videoService.getMetadata.mockResolvedValue({})
    registerVideoHandlers(makeCtx(videoService, thumbnailGen))
    const result = (await getHandler('video:metadata')(['/v.mp4'])) as {
      success: true
      data: { duration: number; width: number; codec: string }
    }
    expect(result.data.duration).toBe(0)
    expect(result.data.width).toBe(0)
    expect(result.data.codec).toBe('')
  })

  it('video:export 成功时返回 service 结果', async () => {
    videoService.exportVideo.mockResolvedValue({ exported: true, path: '/out.mp4' })
    registerVideoHandlers(makeCtx(videoService, thumbnailGen))
    const result = (await getHandler('video:export')(['/v.mp4', '/out', 'mp4'])) as {
      success: true
      data: { exported: boolean }
    }
    expect(assertFileReadPathMock).toHaveBeenCalledWith('/v.mp4')
    expect(assertFileWritePathMock).toHaveBeenCalledWith('/out')
    expect(videoService.exportVideo).toHaveBeenCalledWith('/v.mp4', '/out', 'mp4')
    expect(result.data.exported).toBe(true)
  })

  it('video:export 格式不在 VIDEO_EXPORT_FORMATS 时抛 validation', async () => {
    registerVideoHandlers(makeCtx(videoService, thumbnailGen))
    const result = (await getHandler('video:export')(['/v.mp4', '/out', 'avi'])) as {
      success: false
      error: { code: string; message: string }
    }
    expect(result.error.code).toBe('IPC_VALIDATION_ERROR')
    expect(result.error.message).toContain('avi')
    expect(videoService.exportVideo).not.toHaveBeenCalled()
  })

  it('video:captureFrame 不传 targetDir 时跳过 write 校验', async () => {
    videoService.captureFrame.mockResolvedValue({ framePath: '/frame.jpg' })
    registerVideoHandlers(makeCtx(videoService, thumbnailGen))
    const result = (await getHandler('video:captureFrame')(['/v.mp4', 1000, undefined])) as {
      success: true
      data: { framePath: string }
    }
    expect(assertFileReadPathMock).toHaveBeenCalledWith('/v.mp4')
    expect(assertFileWritePathMock).not.toHaveBeenCalled()
    expect(videoService.captureFrame).toHaveBeenCalledWith('/v.mp4', 1000, undefined)
    expect(result.data.framePath).toBe('/frame.jpg')
  })

  it('video:captureFrame 传 targetDir 时校验写路径', async () => {
    videoService.captureFrame.mockResolvedValue({ framePath: '/out/f.jpg' })
    registerVideoHandlers(makeCtx(videoService, thumbnailGen))
    await getHandler('video:captureFrame')(['/v.mp4', 1000, '/out'])
    expect(assertFileWritePathMock).toHaveBeenCalledWith('/out')
  })

  it('video:trim 成功时返回 service 结果', async () => {
    videoService.trimVideo.mockResolvedValue({ path: '/out/trimmed.mp4' })
    registerVideoHandlers(makeCtx(videoService, thumbnailGen))
    const result = (await getHandler('video:trim')(['/v.mp4', 1, 10, '/out'])) as {
      success: true
      data: { path: string }
    }
    expect(assertFileReadPathMock).toHaveBeenCalledWith('/v.mp4')
    expect(assertFileWritePathMock).toHaveBeenCalledWith('/out')
    expect(videoService.trimVideo).toHaveBeenCalledWith('/v.mp4', 1, 10, '/out')
    expect(result.data.path).toBe('/out/trimmed.mp4')
  })

  it('video:trim endTime <= startTime 时抛 validation', async () => {
    registerVideoHandlers(makeCtx(videoService, thumbnailGen))
    const result = (await getHandler('video:trim')(['/v.mp4', 10, 10, '/out'])) as {
      success: false
      error: { code: string; message: string }
    }
    expect(result.error.code).toBe('IPC_VALIDATION_ERROR')
    expect(result.error.message).toContain('结束时间必须大于开始时间')
    expect(videoService.trimVideo).not.toHaveBeenCalled()
  })

  it('video:trim endTime < startTime 时也抛 validation', async () => {
    registerVideoHandlers(makeCtx(videoService, thumbnailGen))
    const result = (await getHandler('video:trim')(['/v.mp4', 10, 5, '/out'])) as {
      success: false
      error: { code: string }
    }
    expect(result.error.code).toBe('IPC_VALIDATION_ERROR')
  })

  it('video:changeSpeed 成功时返回 service 结果', async () => {
    videoService.changeSpeed.mockResolvedValue({ path: '/out/v.mp4' })
    registerVideoHandlers(makeCtx(videoService, thumbnailGen))
    const result = (await getHandler('video:changeSpeed')(['/v.mp4', 2.0, '/out'])) as {
      success: true
      data: { path: string }
    }
    expect(assertFileReadPathMock).toHaveBeenCalledWith('/v.mp4')
    expect(assertFileWritePathMock).toHaveBeenCalledWith('/out')
    expect(videoService.changeSpeed).toHaveBeenCalledWith('/v.mp4', 2.0, '/out')
    expect(result.data.path).toBe('/out/v.mp4')
  })

  it('video:exportLivePhoto 成功时返回 service 结果', async () => {
    livePhotoExportMock.mockResolvedValue({ success: true, files: ['/img.jpg', '/vid.mp4'] })
    registerVideoHandlers(makeCtx(videoService, thumbnailGen))
    const result = (await getHandler('video:exportLivePhoto')(['/v.mp4', '/out'])) as {
      success: true
      data: { success: boolean }
    }
    expect(assertFileReadPathMock).toHaveBeenCalledWith('/v.mp4')
    expect(assertFileWritePathMock).toHaveBeenCalledWith('/out')
    expect(livePhotoExportMock).toHaveBeenCalledWith('/v.mp4', '/out')
    expect(result.data.success).toBe(true)
  })

  it('video:exportLivePhoto service 抛错时透传', async () => {
    livePhotoExportMock.mockRejectedValue(new Error('解码失败'))
    registerVideoHandlers(makeCtx(videoService, thumbnailGen))
    const result = (await getHandler('video:exportLivePhoto')(['/v.mp4', '/out'])) as {
      success: false
      error: { code: string; message: string }
    }
    expect(result.error.code).toBe('IPC_INTERNAL_ERROR')
    expect(result.error.message).toContain('解码失败')
  })
})
