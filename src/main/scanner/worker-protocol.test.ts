/**
 * @layer L1
 * @module src/main/scanner/worker-protocol
 * @coverage 类型契约校验（编译时 + 运行时结构断言）
 * @dependencies none
 * @remarks 类型导出模块，验证各类型字段完整性
 */
import { describe, it, expect } from 'vitest'
import type {
  ScanOptions,
  ScanProgress,
  MediaFile,
  WorkerCommand,
  WorkerEvent
} from './worker-protocol'

describe('ScanOptions 类型契约', () => {
  it('支持空对象（所有字段可选）', () => {
    const opts: ScanOptions = {}
    expect(opts).toEqual({})
  })

  it('支持完整字段赋值', () => {
    const opts: ScanOptions = {
      path: '/game',
      incremental: true,
      fullScan: false,
      customKnownPaths: ['/path1', '/path2']
    }
    expect(opts.path).toBe('/game')
    expect(opts.incremental).toBe(true)
    expect(opts.fullScan).toBe(false)
    expect(opts.customKnownPaths).toHaveLength(2)
  })

  it('fullScan 与 incremental 可同时存在（虽然语义冲突，但类型允许）', () => {
    const opts: ScanOptions = { fullScan: true, incremental: true }
    expect(opts.fullScan).toBe(true)
  })
})

describe('ScanProgress 类型契约', () => {
  it('包含全部必需字段', () => {
    const p: ScanProgress = {
      scanned: 0,
      found: 0,
      currentPath: '',
      status: 'idle'
    }
    expect(p.scanned).toBe(0)
    expect(p.found).toBe(0)
    expect(p.currentPath).toBe('')
    expect(p.status).toBe('idle')
  })

  it('status 支持 running 状态', () => {
    const p: ScanProgress = { scanned: 1, found: 1, currentPath: '/x', status: 'running' }
    expect(p.status).toBe('running')
  })

  it('status 支持 completed 状态', () => {
    const p: ScanProgress = { scanned: 1, found: 1, currentPath: '', status: 'completed' }
    expect(p.status).toBe('completed')
  })

  it('status 支持 failed 状态', () => {
    const p: ScanProgress = { scanned: 1, found: 0, currentPath: '', status: 'failed' }
    expect(p.status).toBe('failed')
  })

  it('scanned/found 允许为 0', () => {
    const p: ScanProgress = { scanned: 0, found: 0, currentPath: '', status: 'idle' }
    expect(p.scanned + p.found).toBe(0)
  })
})

describe('MediaFile 类型契约', () => {
  it('image 类型包含全部必需字段', () => {
    const f: MediaFile = {
      file_path: '/p/photo.jpg',
      file_name: 'photo.jpg',
      file_type: 'image',
      file_ext: '.jpg',
      file_size: 1024,
      width: 1920,
      height: 1080,
      created_at: '2024-01-01T00:00:00Z',
      modified_at: '2024-01-01T00:00:00Z',
      source_path: '/src',
      indexed_at: '2024-01-01T00:00:00Z',
      scene_category: 'screenshot',
      scene_time: 'day',
      outfit: '星之海',
      account_uid: '12345678',
      album_type: '高质量照片',
      media_source: 'game'
    }
    expect(f.file_type).toBe('image')
    expect(f.scene_category).toBe('screenshot')
    expect(f.media_source).toBe('game')
  })

  it('video 类型支持可选 width/height/duration', () => {
    const f: MediaFile = {
      file_path: '/p/clip.mp4',
      file_name: 'clip.mp4',
      file_type: 'video',
      file_ext: '.mp4',
      file_size: 10240,
      created_at: '2024-01-01T00:00:00Z',
      modified_at: '2024-01-01T00:00:00Z',
      source_path: '/src',
      indexed_at: '2024-01-01T00:00:00Z',
      scene_category: 'other',
      scene_time: 'unknown',
      outfit: '',
      account_uid: 'default',
      album_type: '其他',
      media_source: 'launcher'
    }
    expect(f.width).toBeUndefined()
    expect(f.height).toBeUndefined()
    expect(f.duration).toBeUndefined()
    expect(f.media_source).toBe('launcher')
  })

  it('media_source 支持 cloud', () => {
    const f: MediaFile = {
      file_path: '/p/cloud.jpg',
      file_name: 'cloud.jpg',
      file_type: 'image',
      file_ext: '.jpg',
      file_size: 100,
      created_at: '',
      modified_at: '',
      source_path: '',
      indexed_at: '',
      scene_category: 'other',
      account_uid: 'default',
      album_type: '云照片',
      media_source: 'cloud'
    }
    expect(f.media_source).toBe('cloud')
  })

  it('scene_time/outfit 字段可选', () => {
    const f: MediaFile = {
      file_path: '/p',
      file_name: 'n',
      file_type: 'image',
      file_ext: '.jpg',
      file_size: 0,
      created_at: '',
      modified_at: '',
      source_path: '',
      indexed_at: '',
      scene_category: 'other',
      account_uid: 'default',
      album_type: '其他',
      media_source: 'game'
    }
    expect(f.scene_time).toBeUndefined()
    expect(f.outfit).toBeUndefined()
  })
})

describe('WorkerCommand 类型契约', () => {
  it('SCAN_START 包含 dbPath 与 options', () => {
    const cmd: WorkerCommand = {
      type: 'SCAN_START',
      payload: { dbPath: '/db', options: { incremental: true } }
    }
    expect(cmd.type).toBe('SCAN_START')
    expect(cmd.payload.dbPath).toBe('/db')
  })

  it('SCAN_START options 支持空对象', () => {
    const cmd: WorkerCommand = {
      type: 'SCAN_START',
      payload: { dbPath: '/db', options: {} }
    }
    expect(cmd.payload.options).toEqual({})
  })

  it('SCAN_STOP 无 payload', () => {
    const cmd: WorkerCommand = { type: 'SCAN_STOP' }
    expect(cmd.type).toBe('SCAN_STOP')
  })

  it('SCAN_DISPOSE 无 payload', () => {
    const cmd: WorkerCommand = { type: 'SCAN_DISPOSE' }
    expect(cmd.type).toBe('SCAN_DISPOSE')
  })
})

describe('WorkerEvent 类型契约', () => {
  it('SCAN_PROGRESS 包含 ScanProgress', () => {
    const ev: WorkerEvent = {
      type: 'SCAN_PROGRESS',
      payload: { scanned: 0, found: 0, currentPath: '', status: 'idle' }
    }
    expect(ev.type).toBe('SCAN_PROGRESS')
    expect(ev.payload.status).toBe('idle')
  })

  it('SCAN_COMPLETE 包含 success/message', () => {
    const ev: WorkerEvent = {
      type: 'SCAN_COMPLETE',
      payload: { success: true, message: 'ok' }
    }
    expect(ev.payload.success).toBe(true)
    expect(ev.payload.message).toBe('ok')
  })

  it('SCAN_COMPLETE 支持 filesFound 可选字段', () => {
    const ev: WorkerEvent = {
      type: 'SCAN_COMPLETE',
      payload: { success: true, message: 'ok', filesFound: 42 }
    }
    expect(ev.payload.filesFound).toBe(42)
  })

  it('SCAN_COMPLETE 失败场景', () => {
    const ev: WorkerEvent = {
      type: 'SCAN_COMPLETE',
      payload: { success: false, message: 'failed' }
    }
    expect(ev.payload.success).toBe(false)
  })

  it('SCAN_LOG 包含 level/message', () => {
    const ev: WorkerEvent = {
      type: 'SCAN_LOG',
      payload: { level: 'warn', message: 'careful' }
    }
    expect(ev.payload.level).toBe('warn')
  })

  it('SCAN_LOG 支持 args 可选字段', () => {
    const ev: WorkerEvent = {
      type: 'SCAN_LOG',
      payload: { level: 'error', message: 'boom', args: ['ctx1', 42] }
    }
    expect(ev.payload.args).toEqual(['ctx1', 42])
  })

  it('WORKER_READY 无 payload', () => {
    const ev: WorkerEvent = { type: 'WORKER_READY' }
    expect(ev.type).toBe('WORKER_READY')
  })

  it('WORKER_ERROR 包含 message/stack', () => {
    const ev: WorkerEvent = {
      type: 'WORKER_ERROR',
      payload: { message: 'boom', stack: 'trace' }
    }
    expect(ev.payload.message).toBe('boom')
    expect(ev.payload.stack).toBe('trace')
  })

  it('WORKER_ERROR stack 字段可选', () => {
    const ev: WorkerEvent = {
      type: 'WORKER_ERROR',
      payload: { message: 'boom' }
    }
    expect(ev.payload.stack).toBeUndefined()
  })
})
