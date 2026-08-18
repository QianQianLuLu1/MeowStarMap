import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import fsp from 'fs/promises'
import koffi from 'koffi'
import { app } from 'electron'

/**
 * 集成测试：图片参数解密服务端到端链路
 *
 * 范围：覆盖「读取文件 → 大小校验 → 创建密钥 → DLL 解密 → 释放资源」完整链路。
 *
 * 设计说明：
 *   - decryption-service 依赖 koffi 原生 FFI 调用 nuan5_decryption.dll
 *   - 测试通过 mock koffi 模块观察控制流，不依赖真实 DLL
 *   - 模块顶层执行 koffi.struct() / koffi.pointer()，mock 必须提供稳定类型描述符
 *   - getBoundFunctions 缓存函数绑定，用 vi.resetModules 确保每次测试拿到新鲜实例
 *   - findDllPath 依赖 process.resourcesPath，测试前必须设置
 *   - 关键：源码 import fsp from 'fs/promises'，必须单独 mock 此模块
 *     仅 mock 'fs' 无法拦截 fsp.stat / fsp.readFile
 *
 * 边界场景：
 *   1. 文件超过 10MB 上限（P0-A3 安全保护）
 *   2. 文件读取失败（ENOENT / EACCES / UID 缺失）
 *   3. 并发调用 decodeFileParams（mutex 串行化，避免 C 内存 use-after-free）
 */

// ============================================================
// Mock 声明（hoisted）
// ============================================================

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/test-userdata'),
    getVersion: vi.fn(() => '2.5.0'),
    getAppPath: vi.fn(() => '/tmp/test-app'),
    isPackaged: false
  }
}))

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    statSync: vi.fn(),
    appendFileSync: vi.fn(),
    promises: {
      stat: vi.fn(),
      readFile: vi.fn(),
      appendFile: vi.fn().mockResolvedValue(undefined),
      readdir: vi.fn().mockResolvedValue([]),
      unlink: vi.fn().mockResolvedValue(undefined)
    }
  }
}))

// 关键：源码使用 `import fsp from 'fs/promises'`，必须单独 mock
// fsp.stat / fsp.readFile 是异步 fs API 的真实入口
vi.mock('fs/promises', () => ({
  default: {
    stat: vi.fn(),
    readFile: vi.fn(),
    appendFile: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    unlink: vi.fn().mockResolvedValue(undefined)
  }
}))

// koffi mock：提供稳定的类型描述符 + 可控的 load/decode 行为
vi.mock('koffi', () => {
  const structCache: Record<string, object> = {}
  const pointerCache: Record<string, object> = {}

  const koffiMock = {
    struct: vi.fn((name: string, _def?: unknown) => {
      if (!structCache[name]) structCache[name] = { _koffi: 'struct', name }
      return structCache[name]
    }),
    pointer: vi.fn((inner: unknown) => {
      const key = String(inner)
      if (!pointerCache[key]) pointerCache[key] = { _koffi: 'pointer', inner }
      return pointerCache[key]
    }),
    load: vi.fn(),
    decode: vi.fn()
  }
  return { default: koffiMock }
})

// ============================================================
// 动态 import：配合 vi.resetModules 实现模块级状态隔离
// ============================================================
type DecryptionService = typeof import('./decryption-service')
let svc: DecryptionService

const originalResourcesPath = (process as { resourcesPath?: string }).resourcesPath

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()

  // findDllPath 依赖 process.resourcesPath，必须设置
  Object.defineProperty(process, 'resourcesPath', {
    value: 'C:\\test-resources',
    configurable: true
  })

  // 重置基础 mock
  vi.mocked(fs.existsSync).mockReturnValue(true)
  vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as never)
  vi.mocked(fs.appendFileSync).mockImplementation(() => undefined as never)
  vi.mocked(fsp.appendFile).mockResolvedValue(undefined as never)

  svc = await import('./decryption-service')
})

afterEach(() => {
  // 恢复 process.resourcesPath
  if (originalResourcesPath === undefined) {
    delete (process as { resourcesPath?: string }).resourcesPath
  } else {
    Object.defineProperty(process, 'resourcesPath', {
      value: originalResourcesPath,
      configurable: true
    })
  }
  vi.useRealTimers()
})

// ============================================================
// Helpers：构造 mock DLL 函数返回值
// ============================================================

/** 31 元素的相机参数 JSON 数组（parseCameraParams 要求长度 >= 31） */
const STEP3_CAMERA_ARRAY = JSON.stringify(Array.from({ length: 31 }, (_, i) => i))

/** step1 解密后的 JSON 文本，包含 CameraParams 字段 */
const STEP1_JSON = JSON.stringify({
  social_photo: {
    photo_info: {},
    time: { day: 1, hour: 10, min: 30, sec: 0 }
  },
  CameraParams: 'YmFzZTY0UGFyYW1z'
})

/**
 * 构造 mock lib，setupMockLib 后 koffi.load 返回该 lib
 * 所有 func 绑定返回可控结果
 */
function setupMockLib(
  overrides: {
    mediaDecodeFileBytesUnchecked?: ReturnType<typeof vi.fn>
    mediaDecrypt?: ReturnType<typeof vi.fn>
    mediaKeyFromStr?: ReturnType<typeof vi.fn>
    mediaKeyCameraParam?: ReturnType<typeof vi.fn>
    freeMediaKey?: ReturnType<typeof vi.fn>
    freeCBytes?: ReturnType<typeof vi.fn>
    abiVersion?: number
  } = {}
): void {
  const step1Bytes = Buffer.from(STEP1_JSON, 'utf-8')
  const step3Bytes = Buffer.from(STEP3_CAMERA_ARRAY, 'utf-8')

  const defaultAbiVersion = overrides.abiVersion ?? 1

  // koffi.decode：根据 len 返回对应字节数组
  // step1 较长（约 130 字节），step3 较短（约 90 字节）
  vi.mocked(koffi.decode).mockImplementation((_ptr, _type, len) => {
    if (len === step3Bytes.length) {
      return Array.from(step3Bytes) as never
    }
    return Array.from(step1Bytes.subarray(0, Math.min(len, step1Bytes.length))) as never
  })

  const lib = {
    func: vi.fn((name: string) => {
      if (name === 'abi_version') {
        return (() => defaultAbiVersion) as never
      }
      if (name === 'media_decode_file_bytes_unchecked') {
        return (
          overrides.mediaDecodeFileBytesUnchecked ??
          (vi.fn(() => ({
            status: 0,
            bytes: { data: { _ptr: 'step1' }, len: step1Bytes.length, cap: step1Bytes.length }
          })) as never)
        )
      }
      if (name === 'media_decrypt') {
        return (
          overrides.mediaDecrypt ??
          (vi.fn(() => ({
            status: 0,
            bytes: { data: { _ptr: 'step3' }, len: step3Bytes.length, cap: step3Bytes.length }
          })) as never)
        )
      }
      if (name === 'media_key_from_str') {
        return overrides.mediaKeyFromStr ?? (vi.fn(() => ({ _key: 'uid' })) as never)
      }
      if (name === 'media_key_camera_param') {
        return overrides.mediaKeyCameraParam ?? (vi.fn(() => ({ _key: 'camera' })) as never)
      }
      if (name === 'free_media_key') {
        return overrides.freeMediaKey ?? (vi.fn(() => undefined) as never)
      }
      if (name === 'free_c_bytes') {
        return overrides.freeCBytes ?? (vi.fn(() => undefined) as never)
      }
      return vi.fn(() => undefined) as never
    }),
    unload: vi.fn()
  }

  vi.mocked(koffi.load).mockReturnValue(lib as never)
}

/** 设置 fsp.stat + fsp.readFile 返回正常的小文件 */
function setupValidFile(fileContent: Buffer = Buffer.alloc(100)): void {
  vi.mocked(fsp.stat).mockResolvedValue({ size: fileContent.length } as never)
  vi.mocked(fsp.readFile).mockResolvedValue(fileContent as never)
}

// ============================================================
// 集成测试用例
// ============================================================

describe('集成：图片参数解密端到端链路', () => {
  // ============================================================
  // 正常流程
  // ============================================================
  describe('正常流程：读取文件 → 解密 → 返回相机参数', () => {
    it('合法文件 + UID → 解密成功，返回 hasParams=true + camera 数据', async () => {
      setupMockLib()
      setupValidFile()

      const result = await svc.decodeFileParams(
        'C:\\photo.nikkiphoto',
        'NikkiPhotos_HighQuality',
        '123456'
      )

      expect(result.hasParams).toBe(true)
      expect(result.camera).toBeDefined()
      // parseCameraParams：arr[14] = focalLength, arr[1] = portraitMode
      expect(result.camera?.focalLength).toBe(14)
      expect(result.camera?.portraitMode).toBe(true)
    })

    it('step1 status≠0 → 释放 bytes 并返回对应错误', async () => {
      const freeCBytesSpy = vi.fn()
      setupMockLib({
        mediaDecodeFileBytesUnchecked: vi.fn(() => ({
          status: 1,
          bytes: { data: null, len: 0, cap: 0 }
        })) as never,
        freeCBytes: freeCBytesSpy as never
      })
      setupValidFile()

      const result = await svc.decodeFileParams(
        'C:\\photo.nikkiphoto',
        'NikkiPhotos_HighQuality',
        '123456'
      )

      expect(result.hasParams).toBe(false)
      expect(result.error).toContain('NullPointer')
      // P0-A3：step1 status≠0 时也调用 freeCBytes 释放
      expect(freeCBytesSpy).toHaveBeenCalled()
    })
  })

  // ============================================================
  // 边界 1：文件超过 10MB 上限
  // ============================================================
  describe('边界 1：文件大小上限保护（10MB）', () => {
    it('11MB 文件 → 返回错误，不读取文件内容，不调用解密函数', async () => {
      const decodeSpy = vi.fn(() => ({
        status: 0,
        bytes: { data: { _ptr: 'step1' }, len: 100, cap: 100 }
      }))
      setupMockLib({
        mediaDecodeFileBytesUnchecked: decodeSpy as never
      })
      const ELEVEN_MB = 11 * 1024 * 1024
      vi.mocked(fsp.stat).mockResolvedValue({ size: ELEVEN_MB } as never)

      const result = await svc.decodeFileParams('C:\\big.jpg', 'NikkiPhotos_HighQuality', '123456')

      expect(result.hasParams).toBe(false)
      expect(result.error).toContain('文件过大')
      expect(result.error).toContain(String(ELEVEN_MB))
      // 不读取文件内容
      expect(fsp.readFile).not.toHaveBeenCalled()
      // 不调用实际解密函数
      expect(decodeSpy).not.toHaveBeenCalled()
    })

    it('刚好 10MB 文件 → 通过大小校验，继续后续流程', async () => {
      setupMockLib()
      const TEN_MB = 10 * 1024 * 1024
      vi.mocked(fsp.stat).mockResolvedValue({ size: TEN_MB } as never)
      vi.mocked(fsp.readFile).mockResolvedValue(Buffer.alloc(TEN_MB) as never)

      const result = await svc.decodeFileParams(
        'C:\\exactly10mb.jpg',
        'NikkiPhotos_HighQuality',
        '123456'
      )

      // 通过大小校验，成功走到解密流程
      expect(result.hasParams).toBe(true)
      expect(fsp.readFile).toHaveBeenCalled()
    })
  })

  // ============================================================
  // 边界 2：文件读取失败 / UID 缺失
  // ============================================================
  describe('边界 2：文件读取失败与 UID 缺失', () => {
    it('stat 抛 ENOENT → 返回"无法读取文件"', async () => {
      setupMockLib()
      vi.mocked(fsp.stat).mockRejectedValue(new Error('ENOENT') as never)

      const result = await svc.decodeFileParams(
        'C:\\missing.nikkiphoto',
        'NikkiPhotos_HighQuality',
        '123456'
      )

      expect(result.hasParams).toBe(false)
      expect(result.error).toBe('无法读取文件')
      // stat 失败 → 不应继续读文件
      expect(fsp.readFile).not.toHaveBeenCalled()
    })

    it('readFile 抛 EACCES → 返回"无法读取文件"', async () => {
      setupMockLib()
      vi.mocked(fsp.stat).mockResolvedValue({ size: 100 } as never)
      vi.mocked(fsp.readFile).mockRejectedValue(new Error('EACCES') as never)

      const result = await svc.decodeFileParams(
        'C:\\locked.nikkiphoto',
        'NikkiPhotos_HighQuality',
        '123456'
      )

      expect(result.hasParams).toBe(false)
      expect(result.error).toBe('无法读取文件')
    })

    it('UID 为 undefined → 降级使用 cameraParam 密钥继续解密', async () => {
      setupMockLib()
      setupValidFile()

      const result = await svc.decodeFileParams(
        'C:\\photo.nikkiphoto',
        'NikkiPhotos_HighQuality',
        undefined
      )

      // UID 不可用时降级用 cameraParam 密钥，不再返回 uidMissing
      expect(result.hasParams).toBe(true)
    })

    it('UID 为 "default" → 降级使用 cameraParam 密钥继续解密', async () => {
      setupMockLib()
      setupValidFile()

      const result = await svc.decodeFileParams(
        'C:\\photo.nikkiphoto',
        'NikkiPhotos_HighQuality',
        'default'
      )

      // UID 为 default 时降级用 cameraParam 密钥，不再返回 uidMissing
      expect(result.hasParams).toBe(true)
    })
  })

  // ============================================================
  // 边界 3：并发调用 mutex 串行化
  // ============================================================
  describe('边界 3：并发调用 mutex 串行化', () => {
    it('3 次并发调用 → task 串行执行，任一时刻只有一个在运行', async () => {
      setupMockLib()
      // 用 fsp.stat 的异步执行观察并发度
      // decodeFileParams 的 task 内部 await fsp.stat，是异步让出点
      let activeCount = 0
      let maxActive = 0
      vi.mocked(fsp.stat).mockImplementation(async () => {
        activeCount++
        maxActive = Math.max(maxActive, activeCount)
        // 让出一个 microtask，允许其他 task 插入（如果 mutex 失效）
        await Promise.resolve()
        activeCount--
        return { size: 100 } as never
      })
      vi.mocked(fsp.readFile).mockResolvedValue(Buffer.alloc(100) as never)

      const results = await Promise.all([
        svc.decodeFileParams('C:\\a.nikkiphoto', 'album', 'uid1'),
        svc.decodeFileParams('C:\\b.nikkiphoto', 'album', 'uid2'),
        svc.decodeFileParams('C:\\c.nikkiphoto', 'album', 'uid3')
      ])

      expect(results).toHaveLength(3)
      // mutex 串行化：任一时刻只有一个 task 在执行 stat
      expect(maxActive).toBe(1)
    })

    it('mutex 不因单次调用失败而阻塞后续调用', async () => {
      let callCount = 0
      setupMockLib({
        mediaKeyFromStr: vi.fn(() => {
          callCount++
          if (callCount === 1) {
            throw new Error('DLL key creation crash')
          }
          return { _key: 'uid' }
        }) as never
      })
      setupValidFile()

      // 第一次调用失败（mediaKeyFromStr 抛错）
      const r1 = await svc.decodeFileParams('C:\\a.nikkiphoto', 'album', 'uid1')
      expect(r1.hasParams).toBe(false)

      // 第二次调用应正常执行（mutex 未被第一次的失败阻塞）
      const r2 = await svc.decodeFileParams('C:\\b.nikkiphoto', 'album', 'uid2')
      expect(r2.hasParams).toBe(true)
    })
  })

  // ============================================================
  // 资源释放
  // ============================================================
  describe('资源释放：密钥与 DLL 字节缓冲区', () => {
    it('解密成功后释放 uidKey + camKey + 两次 CBytes', async () => {
      const freeMediaKeySpy = vi.fn()
      const freeCBytesSpy = vi.fn()
      setupMockLib({
        freeMediaKey: freeMediaKeySpy as never,
        freeCBytes: freeCBytesSpy as never
      })
      setupValidFile()

      await svc.decodeFileParams('C:\\photo.nikkiphoto', 'album', '123456')

      // 释放两个 key（uidKey + camKey）
      expect(freeMediaKeySpy).toHaveBeenCalledTimes(2)
      // 释放两次 CBytes（step1 + step3）
      expect(freeCBytesSpy).toHaveBeenCalledTimes(2)
    })

    it('disposeDecryptionService → 卸载 DLL', async () => {
      const unloadSpy = vi.fn()
      // 简化：直接 mock koffi.load 返回带 unload spy 的 lib
      vi.mocked(koffi.load).mockReturnValue({
        func: vi.fn((name: string) => {
          if (name === 'abi_version') return (() => 1) as never
          return vi.fn(() => undefined) as never
        }),
        unload: unloadSpy
      } as never)
      setupValidFile()

      // 触发 DLL 加载
      await svc.decodeFileParams('C:\\photo.nikkiphoto', 'album', '123456')
      expect(koffi.load).toHaveBeenCalled()

      // 卸载
      svc.disposeDecryptionService()
      expect(unloadSpy).toHaveBeenCalled()
    })
  })
})
