/**
 * @layer L1
 * @module src/main/media-worker/worker-protocol
 * @coverage 类型契约校验（编译时 + 运行时结构断言）
 * @dependencies none
 * @remarks 类型导出模块，验证三类任务（缩略图/pHash/重复标记）消息字段完整性
 */
import { describe, it, expect } from 'vitest'
import type { ThumbnailQuality, MediaWorkerCommand, MediaWorkerEvent } from './worker-protocol'

describe('ThumbnailQuality 类型契约', () => {
  it('支持 low', () => {
    const q: ThumbnailQuality = 'low'
    expect(q).toBe('low')
  })

  it('支持 standard', () => {
    const q: ThumbnailQuality = 'standard'
    expect(q).toBe('standard')
  })

  it('支持 high', () => {
    const q: ThumbnailQuality = 'high'
    expect(q).toBe('high')
  })
})

describe('MediaWorkerCommand 类型契约', () => {
  it('THUMBNAIL_BATCH_START 包含 dbPath/cacheDir/thumbnailQuality', () => {
    const cmd: MediaWorkerCommand = {
      type: 'THUMBNAIL_BATCH_START',
      payload: { dbPath: '/db', cacheDir: '/cache', thumbnailQuality: 'standard' }
    }
    expect(cmd.type).toBe('THUMBNAIL_BATCH_START')
    expect(cmd.payload.cacheDir).toBe('/cache')
    expect(cmd.payload.thumbnailQuality).toBe('standard')
  })

  it('PHASH_BATCH_START 包含 dbPath', () => {
    const cmd: MediaWorkerCommand = {
      type: 'PHASH_BATCH_START',
      payload: { dbPath: '/db' }
    }
    expect(cmd.type).toBe('PHASH_BATCH_START')
    expect(cmd.payload.dbPath).toBe('/db')
  })

  it('DUPLICATE_MARK_START 包含 dbPath', () => {
    const cmd: MediaWorkerCommand = {
      type: 'DUPLICATE_MARK_START',
      payload: { dbPath: '/db' }
    }
    expect(cmd.type).toBe('DUPLICATE_MARK_START')
  })

  it('THUMBNAIL_STOP 无 payload', () => {
    const cmd: MediaWorkerCommand = { type: 'THUMBNAIL_STOP' }
    expect(cmd.type).toBe('THUMBNAIL_STOP')
  })

  it('PHASH_STOP 无 payload', () => {
    const cmd: MediaWorkerCommand = { type: 'PHASH_STOP' }
    expect(cmd.type).toBe('PHASH_STOP')
  })

  it('DUPLICATE_STOP 无 payload', () => {
    const cmd: MediaWorkerCommand = { type: 'DUPLICATE_STOP' }
    expect(cmd.type).toBe('DUPLICATE_STOP')
  })

  it('MEDIA_WORKER_DISPOSE 无 payload', () => {
    const cmd: MediaWorkerCommand = { type: 'MEDIA_WORKER_DISPOSE' }
    expect(cmd.type).toBe('MEDIA_WORKER_DISPOSE')
  })

  it('THUMBNAIL_BATCH_START thumbnailQuality 支持 low', () => {
    const cmd: MediaWorkerCommand = {
      type: 'THUMBNAIL_BATCH_START',
      payload: { dbPath: '/db', cacheDir: '/cache', thumbnailQuality: 'low' }
    }
    expect(cmd.payload.thumbnailQuality).toBe('low')
  })

  it('THUMBNAIL_BATCH_START thumbnailQuality 支持 high', () => {
    const cmd: MediaWorkerCommand = {
      type: 'THUMBNAIL_BATCH_START',
      payload: { dbPath: '/db', cacheDir: '/cache', thumbnailQuality: 'high' }
    }
    expect(cmd.payload.thumbnailQuality).toBe('high')
  })
})

describe('MediaWorkerEvent 类型契约', () => {
  it('WORKER_READY 无 payload', () => {
    const ev: MediaWorkerEvent = { type: 'WORKER_READY' }
    expect(ev.type).toBe('WORKER_READY')
  })

  it('THUMBNAIL_PROGRESS 包含 processed/total/currentFile', () => {
    const ev: MediaWorkerEvent = {
      type: 'THUMBNAIL_PROGRESS',
      payload: { processed: 5, total: 10, currentFile: '/p/foo.jpg' }
    }
    expect(ev.type).toBe('THUMBNAIL_PROGRESS')
    expect(ev.payload.processed).toBe(5)
    expect(ev.payload.total).toBe(10)
  })

  it('THUMBNAIL_COMPLETE 包含 success/message/processed/total', () => {
    const ev: MediaWorkerEvent = {
      type: 'THUMBNAIL_COMPLETE',
      payload: { success: true, message: 'ok', processed: 10, total: 10 }
    }
    expect(ev.payload.success).toBe(true)
    expect(ev.payload.processed).toBe(10)
  })

  it('THUMBNAIL_COMPLETE 失败场景', () => {
    const ev: MediaWorkerEvent = {
      type: 'THUMBNAIL_COMPLETE',
      payload: { success: false, message: 'failed', processed: 0, total: 0 }
    }
    expect(ev.payload.success).toBe(false)
  })

  it('PHASH_PROGRESS 包含 processed/total/currentFile', () => {
    const ev: MediaWorkerEvent = {
      type: 'PHASH_PROGRESS',
      payload: { processed: 3, total: 8, currentFile: '/p/bar.jpg' }
    }
    expect(ev.payload.processed).toBe(3)
  })

  it('PHASH_COMPLETE 包含基础字段', () => {
    const ev: MediaWorkerEvent = {
      type: 'PHASH_COMPLETE',
      payload: { success: true, message: 'ok', processed: 8, total: 8 }
    }
    expect(ev.payload.success).toBe(true)
  })

  it('PHASH_COMPLETE 支持 duplicatesResult 可选字段', () => {
    const ev: MediaWorkerEvent = {
      type: 'PHASH_COMPLETE',
      payload: {
        success: true,
        message: 'ok',
        processed: 8,
        total: 8,
        duplicatesResult: { markedDuplicates: 2, totalGroups: 1 }
      }
    }
    expect(ev.payload.duplicatesResult?.markedDuplicates).toBe(2)
    expect(ev.payload.duplicatesResult?.totalGroups).toBe(1)
  })

  it('DUPLICATE_PROGRESS 包含 compared/totalPairs', () => {
    const ev: MediaWorkerEvent = {
      type: 'DUPLICATE_PROGRESS',
      payload: { compared: 100, totalPairs: 1000 }
    }
    expect(ev.payload.compared).toBe(100)
    expect(ev.payload.totalPairs).toBe(1000)
  })

  it('DUPLICATE_COMPLETE 包含 success/markedDuplicates/totalGroups', () => {
    const ev: MediaWorkerEvent = {
      type: 'DUPLICATE_COMPLETE',
      payload: { success: true, message: 'ok', markedDuplicates: 5, totalGroups: 2 }
    }
    expect(ev.payload.markedDuplicates).toBe(5)
    expect(ev.payload.totalGroups).toBe(2)
  })

  it('DUPLICATE_COMPLETE 失败场景', () => {
    const ev: MediaWorkerEvent = {
      type: 'DUPLICATE_COMPLETE',
      payload: { success: false, message: 'failed', markedDuplicates: 0, totalGroups: 0 }
    }
    expect(ev.payload.success).toBe(false)
  })

  it('MEDIA_WORKER_LOG 包含 level/message', () => {
    const ev: MediaWorkerEvent = {
      type: 'MEDIA_WORKER_LOG',
      payload: { level: 'warn', message: 'careful' }
    }
    expect(ev.payload.level).toBe('warn')
  })

  it('MEDIA_WORKER_LOG 支持 args 可选字段', () => {
    const ev: MediaWorkerEvent = {
      type: 'MEDIA_WORKER_LOG',
      payload: { level: 'error', message: 'boom', args: ['ctx'] }
    }
    expect(ev.payload.args).toEqual(['ctx'])
  })

  it('WORKER_ERROR 包含 message/stack', () => {
    const ev: MediaWorkerEvent = {
      type: 'WORKER_ERROR',
      payload: { message: 'crashed', stack: 'trace' }
    }
    expect(ev.payload.message).toBe('crashed')
  })

  it('WORKER_ERROR stack 字段可选', () => {
    const ev: MediaWorkerEvent = {
      type: 'WORKER_ERROR',
      payload: { message: 'crashed' }
    }
    expect(ev.payload.stack).toBeUndefined()
  })
})
