import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

/**
 * @layer L2
 * @module src/main/services/decryption-service
 * @coverage 文件解密 + 相机参数加密 + ClothDiy 分享码 + HomeBuild 分享码 + dispose
 *           + FIX(组17-1) 网络解码子进程桥降级语义 + mutex 不被网络解码阻塞回归
 * @dependencies koffi, electron, fs/promises, logger
 * @remarks 完全 mock koffi FFI；网络解码经 setDecryptionWorkerBridge 注入假桥，
 *          不再直接 mock cloth_diy/home_build_decode_network FFI
 */

// ============================================================
// Mock 声明（hoisted）
// ============================================================

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => path.join(os.tmpdir(), 'wxnn-decrypt-test-userdata', name)),
    getAppPath: vi.fn(() => path.join(os.tmpdir(), 'wxnn-decrypt-test-app'))
  }
}))

vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}))

// koffi mock：struct/pointer/decode/load 全部提供 stub
// 暴露 mockFns 让测试用例动态控制各 FFI 函数返回值
const mockFns: Record<string, ReturnType<typeof vi.fn>> = {}

// 用 vi.hoisted 提升 decodeFn 以便 import 后通过 koffi.decode 访问
const { decodeFn } = vi.hoisted(() => ({
  decodeFn: vi.fn((_ptr: unknown, _type: string, _len: number) => [])
}))

vi.mock('koffi', () => {
  const structFn = vi.fn((name: string, _def: unknown) => ({ _structName: name }))
  const pointerFn = vi.fn((type: string) => ({ _pointerTo: type }))
  const loadFn = vi.fn((_dllPath: string) => ({
    func: vi.fn((fnName: string, _retType: unknown, _argTypes: unknown) => {
      // 为每个 FFI 函数创建独立的 mock
      if (!mockFns[fnName]) {
        mockFns[fnName] = vi.fn()
      }
      return mockFns[fnName]
    }),
    unload: vi.fn()
  }))
  return {
    default: {
      struct: structFn,
      pointer: pointerFn,
      load: loadFn,
      decode: decodeFn
    }
  }
})

// ============================================================
// Import after mock
// ============================================================
import {
  decodeFileParams,
  encodeCameraParams,
  decodeClothDiyShareCode,
  decodeHomeBuildShareCode,
  disposeDecryptionService,
  setDecryptionWorkerBridge
} from './decryption-service'

// ============================================================
// Helpers
// ============================================================

let tmpRoot: string

beforeEach(() => {
  vi.clearAllMocks()
  // 重置 mockFns
  for (const k of Object.keys(mockFns)) {
    delete mockFns[k]
  }
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wxnn-decrypt-'))
  // 准备 DLL 路径占位（findDllPath 会找 candidates，确保至少一个存在）
  const resourcesPath = path.join(tmpRoot, 'resources')
  fs.mkdirSync(resourcesPath, { recursive: true })
  fs.writeFileSync(path.join(resourcesPath, 'nuan5_decryption.dll'), Buffer.alloc(0))
  process.resourcesPath = resourcesPath
})

afterEach(() => {
  // 桥是 service 模块级状态，必须逐用例重置，避免跨用例泄漏
  setDecryptionWorkerBridge(null)
  disposeDecryptionService()
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

/** 配置 abi_version mock：返回 EXPECTED_ABI_VERSION=1 */
function setupAbiVersion(): void {
  // abi_version 是 lib.func('abi_version', ...)() 调用，需要 mockFns['abi_version']() 返回 1
  if (!mockFns['abi_version']) mockFns['abi_version'] = vi.fn()
  mockFns['abi_version'].mockReturnValue(1)
}

/** 配置 CBytes 解码：koffi.decode 返回字节数组 */
function setupKoffiDecode(bytes: number[]): void {
  decodeFn.mockReturnValue(bytes)
}

/**
 * FIX(组17-1)：注入假网络解码桥。
 * 网络解码已下沉到 utilityProcess，service 经 setDecryptionWorkerBridge 拿到桥实例；
 * 测试只 mock 桥的 decodeNetwork 返回值（NetworkDecodeResult 形状）。
 * @returns decodeNetwork 的 vi.fn（可断言调用参数）
 */
function installBridge(
  impl: (kind: 'clothDiy' | 'homeBuild', codeStr: string) => Promise<unknown>
): ReturnType<typeof vi.fn> {
  const decodeNetwork = vi.fn(impl)
  setDecryptionWorkerBridge({ decodeNetwork } as never)
  return decodeNetwork
}

// ============================================================
// decodeFileParams
// ============================================================

describe('decodeFileParams', () => {
  it('文件不存在时返回 hasParams:false + "无法读取文件"', async () => {
    setupAbiVersion()
    const r = await decodeFileParams(path.join(tmpRoot, 'not_exist.jpg'), 'NikkiPhotos', 'uid_123')
    expect(r.hasParams).toBe(false)
    expect(r.error).toBe('无法读取文件')
  })

  it('文件超过 10MB 上限时返回 hasParams:false + 文件过大提示', async () => {
    setupAbiVersion()
    const bigFile = path.join(tmpRoot, 'big.jpg')
    fs.writeFileSync(bigFile, Buffer.alloc(0))
    // mock stat 返回超大文件
    const statSpy = vi.spyOn(fs.promises, 'stat').mockResolvedValueOnce({
      size: 11 * 1024 * 1024
    } as never)
    const r = await decodeFileParams(bigFile, 'NikkiPhotos', 'uid_123')
    expect(r.hasParams).toBe(false)
    expect(r.error).toContain('文件过大')
    statSpy.mockRestore()
  })

  it('uid 为 default 且路径无 UID 时降级使用 cameraParam 密钥解密', async () => {
    setupAbiVersion()
    const f = path.join(tmpRoot, 'a.jpg')
    fs.writeFileSync(f, Buffer.alloc(10))
    // cameraParam 返回有效密钥，Step 1 返回 FindNoStartFlag（照片无自定义数据）
    mockFns['media_key_camera_param'] = vi.fn().mockReturnValue({})
    mockFns['media_decode_file_bytes_unchecked'] = vi.fn().mockReturnValue({
      status: 4, // FindNoStartFlag
      bytes: { data: null, len: 0, cap: 0 }
    })
    mockFns['free_c_bytes'] = vi.fn()
    const r = await decodeFileParams(f, 'NikkiPhotos', 'default')
    expect(r.hasParams).toBe(false)
    // 不再返回 uidMissing，而是由 DLL 返回具体状态码
    expect(r.error).not.toContain('未识别到角色 UID')
    expect(r.error).toContain('FindNoStartFlag')
  })

  // ---- 多 UID 遍历尝试（candidateUids） ----

  it('candidateUids 非空且第一个 UID 正确 → 解密成功，不尝试后续 UID', async () => {
    setupAbiVersion()
    const f = path.join(tmpRoot, 'a.jpg')
    fs.writeFileSync(f, Buffer.alloc(10))

    const step1Json = JSON.stringify({
      social_photo: { photo_info: {}, time: { day: 1, hour: 10, min: 30, sec: 0 } },
      CameraParams: 'YmFzZTY0UGFyYW1z'
    })
    const step3Arr = JSON.stringify(Array.from({ length: 31 }, (_, i) => i))
    const step1Bytes = Buffer.from(step1Json, 'utf-8')
    const step3Bytes = Buffer.from(step3Arr, 'utf-8')

    decodeFn.mockImplementation((_ptr, _type, len) => {
      if (len === step3Bytes.length) return Array.from(step3Bytes)
      return Array.from(step1Bytes.subarray(0, Math.min(len, step1Bytes.length)))
    })

    mockFns['media_key_from_str'] = vi.fn().mockReturnValue({ _key: 'uid' })
    mockFns['media_key_camera_param'] = vi.fn().mockReturnValue({ _key: 'camera' })
    mockFns['media_decode_file_bytes_unchecked'] = vi.fn().mockReturnValue({
      status: 0,
      bytes: { data: {}, len: step1Bytes.length, cap: step1Bytes.length + 16 }
    })
    mockFns['media_decrypt'] = vi.fn().mockReturnValue({
      status: 0,
      bytes: { data: {}, len: step3Bytes.length, cap: step3Bytes.length + 16 }
    })
    mockFns['free_c_bytes'] = vi.fn()
    mockFns['free_media_key'] = vi.fn()

    const r = await decodeFileParams(f, 'NikkiPhotos', 'default', ['correct_uid', 'other_uid'])
    expect(r.hasParams).toBe(true)
    // 第一个 UID 成功就返回，不尝试第二个
    expect(mockFns['media_key_from_str']).toHaveBeenCalledTimes(1)
    expect(mockFns['media_key_from_str']).toHaveBeenCalledWith('correct_uid')
  })

  it('candidateUids 非空且全部失败 → 降级 cameraParam', async () => {
    setupAbiVersion()
    const f = path.join(tmpRoot, 'a.jpg')
    fs.writeFileSync(f, Buffer.alloc(10))

    mockFns['media_key_from_str'] = vi.fn().mockReturnValue({ _key: 'uid' })
    mockFns['media_key_camera_param'] = vi.fn().mockReturnValue({ _key: 'camera' })
    mockFns['media_decode_file_bytes_unchecked'] = vi.fn().mockReturnValue({
      status: 5, // FindNoEndFlag
      bytes: { data: null, len: 0, cap: 0 }
    })
    mockFns['free_c_bytes'] = vi.fn()
    mockFns['free_media_key'] = vi.fn()

    const r = await decodeFileParams(f, 'NikkiPhotos', 'default', ['uid1', 'uid2'])
    expect(r.hasParams).toBe(false)
    // 2 次候选 UID + 1 次 cameraParam 降级 = 3 次
    expect(mockFns['media_decode_file_bytes_unchecked']).toHaveBeenCalledTimes(3)
    // 方案四：降级 3 触发且 FindNoEndFlag 时，返回 uidRequired 提示而非原始 FindNoEndFlag
    expect(r.error).toContain('未能获取有效的游戏 UID')
  })

  it('candidateUids 为空数组 → 直接降级 cameraParam，跳过遍历', async () => {
    setupAbiVersion()
    const f = path.join(tmpRoot, 'a.jpg')
    fs.writeFileSync(f, Buffer.alloc(10))

    mockFns['media_key_from_str'] = vi.fn().mockReturnValue({ _key: 'uid' })
    mockFns['media_key_camera_param'] = vi.fn().mockReturnValue({ _key: 'camera' })
    mockFns['media_decode_file_bytes_unchecked'] = vi.fn().mockReturnValue({
      status: 4, // FindNoStartFlag
      bytes: { data: null, len: 0, cap: 0 }
    })
    mockFns['free_c_bytes'] = vi.fn()
    mockFns['free_media_key'] = vi.fn()

    const r = await decodeFileParams(f, 'NikkiPhotos', 'default', [])
    expect(r.hasParams).toBe(false)
    // 空数组跳过遍历，直接 cameraParam 降级，只调用 1 次
    expect(mockFns['media_decode_file_bytes_unchecked']).toHaveBeenCalledTimes(1)
    expect(mockFns['media_key_from_str']).not.toHaveBeenCalled()
    expect(r.error).toContain('FindNoStartFlag')
  })

  it('多 UID 遍历释放所有 tryKey（无内存泄漏）', async () => {
    setupAbiVersion()
    const f = path.join(tmpRoot, 'a.jpg')
    fs.writeFileSync(f, Buffer.alloc(10))

    mockFns['media_key_from_str'] = vi.fn().mockReturnValue({ _key: 'uid' })
    mockFns['media_key_camera_param'] = vi.fn().mockReturnValue({ _key: 'camera' })
    mockFns['media_decode_file_bytes_unchecked'] = vi.fn().mockReturnValue({
      status: 5,
      bytes: { data: null, len: 0, cap: 0 }
    })
    mockFns['free_c_bytes'] = vi.fn()
    mockFns['free_media_key'] = vi.fn()

    await decodeFileParams(f, 'NikkiPhotos', 'default', ['uid1', 'uid2', 'uid3'])
    // 3 个候选 UID 各释放 1 次 tryKey + 1 次 camKey = 4 次
    expect(mockFns['free_media_key']).toHaveBeenCalledTimes(4)
  })

  it('Camera 密钥创建失败时返回 hasParams:false', async () => {
    setupAbiVersion()
    const f = path.join(tmpRoot, 'a.jpg')
    fs.writeFileSync(f, Buffer.alloc(10))
    mockFns['media_key_from_str'] = vi.fn().mockReturnValue({})
    mockFns['media_key_camera_param'] = vi.fn().mockReturnValue(null)
    const r = await decodeFileParams(f, 'NikkiPhotos', 'uid_123')
    expect(r.hasParams).toBe(false)
    expect(r.error).toContain('Camera 密钥创建失败')
  })

  it('Step 1 status≠0 时返回 hasParams:false + 对应错误信息', async () => {
    setupAbiVersion()
    const f = path.join(tmpRoot, 'a.jpg')
    fs.writeFileSync(f, Buffer.alloc(10))
    mockFns['media_key_from_str'] = vi.fn().mockReturnValue({})
    mockFns['media_key_camera_param'] = vi.fn().mockReturnValue({})
    mockFns['media_decode_file_bytes_unchecked'] = vi.fn().mockReturnValue({
      status: 4, // FindNoStartFlag
      bytes: { data: null, len: 0, cap: 0 }
    })
    mockFns['free_c_bytes'] = vi.fn()
    const r = await decodeFileParams(f, 'NikkiPhotos', 'uid_123')
    expect(r.hasParams).toBe(false)
    expect(r.error).toContain('FindNoStartFlag')
  })

  it('Step 1 输出 JSON 不含 CameraParams 字段时返回未找到提示', async () => {
    setupAbiVersion()
    const f = path.join(tmpRoot, 'a.jpg')
    fs.writeFileSync(f, Buffer.alloc(10))
    mockFns['media_key_from_str'] = vi.fn().mockReturnValue({})
    mockFns['media_key_camera_param'] = vi.fn().mockReturnValue({})
    // Step 1 返回有效 JSON 但无 CameraParams 字段
    const fakeJson = JSON.stringify({ other_field: 'value' })
    setupKoffiDecode(Array.from(Buffer.from(fakeJson)))
    mockFns['media_decode_file_bytes_unchecked'] = vi.fn().mockReturnValue({
      status: 0,
      bytes: { data: {}, len: fakeJson.length, cap: fakeJson.length + 16 }
    })
    mockFns['free_c_bytes'] = vi.fn()
    const r = await decodeFileParams(f, 'NikkiPhotos', 'uid_123')
    expect(r.hasParams).toBe(false)
    expect(r.error).toContain('未找到 CameraParams')
  })

  it('不含 CameraParams 字段时返回 notContained:true 空态语义，error 保留诊断信息', async () => {
    setupAbiVersion()
    const f = path.join(tmpRoot, 'no-camera-params.jpg')
    fs.writeFileSync(f, Buffer.alloc(10))
    mockFns['media_key_from_str'] = vi.fn().mockReturnValue({})
    mockFns['media_key_camera_param'] = vi.fn().mockReturnValue({})
    // Step 1 返回有效 JSON 但无 CameraParams 字段（文件本身不含该参数）
    const fakeJson = JSON.stringify({ social_photo: { photo_info: {} } })
    setupKoffiDecode(Array.from(Buffer.from(fakeJson)))
    mockFns['media_decode_file_bytes_unchecked'] = vi.fn().mockReturnValue({
      status: 0,
      bytes: { data: {}, len: fakeJson.length, cap: fakeJson.length + 16 }
    })
    mockFns['free_c_bytes'] = vi.fn()
    const r = await decodeFileParams(f, 'NikkiPhotos', 'uid_123')
    // 空态语义：渲染层据此展示“不包含该参数”，与白名单拒绝等真实错误区分
    expect(r.hasParams).toBe(false)
    expect(r.notContained).toBe(true)
    // error 字段保留（供日志/诊断），仍为“未找到 CameraParams”文案
    expect(r.error).toContain('未找到 CameraParams')
  })
})

// ============================================================
// encodeCameraParams
// ============================================================

describe('encodeCameraParams', () => {
  it('加密成功（status=0）返回 success:true + data', async () => {
    setupAbiVersion()
    const fakeBytes = [1, 2, 3, 4]
    setupKoffiDecode(fakeBytes)
    mockFns['media_encode_camera_params_bytes'] = vi.fn().mockReturnValue({
      status: 0,
      bytes: { data: {}, len: fakeBytes.length, cap: fakeBytes.length + 16 }
    })
    mockFns['free_c_bytes'] = vi.fn()
    const r = await encodeCameraParams('{"foo":"bar"}')
    expect(r.success).toBe(true)
    expect(r.data).toBeInstanceOf(Buffer)
    expect(Array.from(r.data!)).toEqual(fakeBytes)
  })

  it('加密失败（status≠0）返回 success:false + 错误信息', async () => {
    setupAbiVersion()
    mockFns['media_encode_camera_params_bytes'] = vi.fn().mockReturnValue({
      status: 2, // DataLenIsNotAMultipleOf16
      bytes: { data: null, len: 0, cap: 0 }
    })
    mockFns['free_c_bytes'] = vi.fn()
    const r = await encodeCameraParams('invalid')
    expect(r.success).toBe(false)
    expect(r.error).toContain('DataLenIsNotAMultipleOf16')
  })

  it('FFI 调用抛异常时返回 success:false + 错误信息', async () => {
    setupAbiVersion()
    mockFns['media_encode_camera_params_bytes'] = vi.fn().mockImplementation(() => {
      throw new Error('segfault')
    })
    const r = await encodeCameraParams('{}')
    expect(r.success).toBe(false)
    expect(r.error).toContain('segfault')
  })
})

// ============================================================
// decodeClothDiyShareCode
// ============================================================

describe('decodeClothDiyShareCode', () => {
  /** clothDiy 本地提取（mutex 内）公共 mock：有效分享码 + timestamp=1 + uid 提取失败 */
  function setupClothDiyLocal(): void {
    mockFns['cloth_diy_share_code_from_code_str'] = vi.fn().mockReturnValue({})
    mockFns['cloth_diy_share_code_timestamp'] = vi.fn().mockReturnValue(1)
    mockFns['cloth_diy_share_code_uid_bytes'] = vi.fn().mockReturnValue({
      status: 1,
      bytes: { data: null, len: 0, cap: 0 }
    })
    mockFns['free_c_bytes'] = vi.fn()
    mockFns['free_cloth_diy_share_code'] = vi.fn()
  }

  it('分享码无效（shareCode=null）返回 success:false', async () => {
    setupAbiVersion()
    mockFns['cloth_diy_share_code_from_code_str'] = vi.fn().mockReturnValue(null)
    const r = await decodeClothDiyShareCode('invalid_code')
    expect(r.success).toBe(false)
    expect(r.error).toContain('无效的染色分享码')
  })

  it('成功提取 timestamp + uidBytes + networkData', async () => {
    setupAbiVersion()
    mockFns['cloth_diy_share_code_from_code_str'] = vi.fn().mockReturnValue({})
    mockFns['cloth_diy_share_code_timestamp'] = vi.fn().mockReturnValue(1700000000)
    mockFns['cloth_diy_share_code_uid_bytes'] = vi.fn().mockReturnValue({
      status: 0,
      bytes: { data: {}, len: 3, cap: 16 }
    })
    decodeFn.mockReturnValueOnce([1, 2, 3]) // 进程内只剩 uidBytes 一次 CBytes 解码
    mockFns['free_c_bytes'] = vi.fn()
    mockFns['free_cloth_diy_share_code'] = vi.fn()
    const fakeNet = '{"color":"red"}'
    const decodeNetwork = installBridge(async () => ({ ok: true, status: 0, networkData: fakeNet }))

    const r = await decodeClothDiyShareCode('valid_code')
    expect(r.success).toBe(true)
    expect(r.timestamp).toBe(1700000000)
    expect(Array.from(r.uidBytes!)).toEqual([1, 2, 3])
    expect(r.networkData).toBe(fakeNet)
    expect(decodeNetwork).toHaveBeenCalledWith('clothDiy', 'valid_code')
  })

  it('timestamp 为 0 时返回 undefined，网络 status≠0 时 error 带状态名', async () => {
    setupAbiVersion()
    mockFns['cloth_diy_share_code_from_code_str'] = vi.fn().mockReturnValue({})
    mockFns['cloth_diy_share_code_timestamp'] = vi.fn().mockReturnValue(0)
    mockFns['cloth_diy_share_code_uid_bytes'] = vi.fn().mockReturnValue({
      status: 1,
      bytes: { data: null, len: 0, cap: 0 }
    })
    mockFns['free_c_bytes'] = vi.fn()
    mockFns['free_cloth_diy_share_code'] = vi.fn()
    installBridge(async () => ({ ok: true, status: 10 })) // NetworkError

    const r = await decodeClothDiyShareCode('code')
    expect(r.success).toBe(true)
    expect(r.timestamp).toBeUndefined()
    expect(r.error).toContain('NetworkError')
  })

  it('异常时返回 success:false + 错误信息', async () => {
    setupAbiVersion()
    mockFns['cloth_diy_share_code_from_code_str'] = vi.fn().mockImplementation(() => {
      throw new Error('ffi crash')
    })
    const r = await decodeClothDiyShareCode('code')
    expect(r.success).toBe(false)
    expect(r.error).toContain('ffi crash')
  })

  it('FIX(组17-1) 桥未注入：本地字段照常返回 + 网络解码降级提示', async () => {
    setupAbiVersion()
    setupClothDiyLocal()
    // 不注入桥（afterEach 已确保初始为 null）

    const r = await decodeClothDiyShareCode('code')
    expect(r.success).toBe(true)
    expect(r.timestamp).toBe(1)
    expect(r.networkData).toBeUndefined()
    expect(r.error).toContain('网络解码不可用')
  })

  it('FIX(组17-1) 桥失败语义：timeout→超时文案，crashed/not-ready→不可用文案', async () => {
    setupAbiVersion()
    setupClothDiyLocal()

    installBridge(async () => ({ ok: false, reason: 'timeout' }))
    expect((await decodeClothDiyShareCode('c1')).error).toContain('网络解码超时')

    installBridge(async () => ({ ok: false, reason: 'worker-crashed' }))
    expect((await decodeClothDiyShareCode('c2')).error).toContain('网络解码不可用')

    installBridge(async () => ({ ok: false, reason: 'not-ready' }))
    expect((await decodeClothDiyShareCode('c3')).error).toContain('网络解码不可用')
  })
})

// ============================================================
// decodeHomeBuildShareCode
// ============================================================

describe('decodeHomeBuildShareCode', () => {
  it('分享码无效（shareCode=null）返回 success:false', async () => {
    setupAbiVersion()
    mockFns['home_build_share_code_from_code_str'] = vi.fn().mockReturnValue(null)
    const r = await decodeHomeBuildShareCode('invalid_code')
    expect(r.success).toBe(false)
    expect(r.error).toContain('无效的家园建造分享码')
  })

  it('成功提取 server + networkData', async () => {
    setupAbiVersion()
    mockFns['home_build_share_code_from_code_str'] = vi.fn().mockReturnValue({})
    mockFns['home_build_share_code_server'] = vi.fn().mockReturnValue(2)
    mockFns['free_home_build_share_code'] = vi.fn()
    const fakeNet = '{"home":"data"}'
    const decodeNetwork = installBridge(async () => ({ ok: true, status: 0, networkData: fakeNet }))

    const r = await decodeHomeBuildShareCode('valid_code')
    expect(r.success).toBe(true)
    expect(r.server).toBe(2)
    expect(r.networkData).toBe(fakeNet)
    expect(decodeNetwork).toHaveBeenCalledWith('homeBuild', 'valid_code')
  })

  it('server 为 0 时返回 undefined，网络失败时优雅降级', async () => {
    setupAbiVersion()
    mockFns['home_build_share_code_from_code_str'] = vi.fn().mockReturnValue({})
    mockFns['home_build_share_code_server'] = vi.fn().mockReturnValue(0)
    mockFns['free_home_build_share_code'] = vi.fn()
    installBridge(async () => ({ ok: true, status: 1 })) // NullPointer

    const r = await decodeHomeBuildShareCode('code')
    expect(r.success).toBe(true)
    expect(r.server).toBeUndefined()
    expect(r.error).toContain('NullPointer')
  })

  it('异常时返回 success:false + 错误信息', async () => {
    setupAbiVersion()
    mockFns['home_build_share_code_from_code_str'] = vi.fn().mockImplementation(() => {
      throw new Error('ffi fail')
    })
    const r = await decodeHomeBuildShareCode('code')
    expect(r.success).toBe(false)
    expect(r.error).toContain('ffi fail')
  })
})

// ============================================================
// disposeDecryptionService
// ============================================================

describe('disposeDecryptionService', () => {
  it('lib 未加载时调用不抛错', () => {
    expect(() => disposeDecryptionService()).not.toThrow()
  })

  it('lib 已加载时调用 unload', async () => {
    setupAbiVersion()
    // 触发 lib 加载
    mockFns['media_encode_camera_params_bytes'] = vi.fn().mockReturnValue({
      status: 0,
      bytes: { data: null, len: 0, cap: 0 }
    })
    mockFns['free_c_bytes'] = vi.fn()
    await encodeCameraParams('{}')
    // 现在 lib 已加载
    disposeDecryptionService()
    // 再次调用不抛错（幂等）
    expect(() => disposeDecryptionService()).not.toThrow()
  })
})

// ============================================================
// withMutex 串行化验证
// ============================================================

describe('withMutex 串行化', () => {
  it('并发调用被串行化（不互相干扰）', async () => {
    setupAbiVersion()
    const order: string[] = []
    mockFns['media_encode_camera_params_bytes'] = vi.fn().mockImplementation(() => {
      order.push('start')
      // 模拟异步延迟（虽然 FFI 是同步的，但 mutex 链式 promise 仍串行）
      return {
        status: 0,
        bytes: { data: null, len: 0, cap: 0 }
      }
    })
    mockFns['free_c_bytes'] = vi.fn()
    // 并发发起 3 个调用
    await Promise.all([encodeCameraParams('a'), encodeCameraParams('b'), encodeCameraParams('c')])
    expect(order).toHaveLength(3)
  })

  it('FIX(组17-1) 网络解码挂起时不阻塞 mutex：encodeCameraParams 立即完成', async () => {
    setupAbiVersion()
    mockFns['cloth_diy_share_code_from_code_str'] = vi.fn().mockReturnValue({})
    mockFns['cloth_diy_share_code_timestamp'] = vi.fn().mockReturnValue(1)
    mockFns['cloth_diy_share_code_uid_bytes'] = vi.fn().mockReturnValue({
      status: 1,
      bytes: { data: null, len: 0, cap: 0 }
    })
    mockFns['free_c_bytes'] = vi.fn()
    mockFns['free_cloth_diy_share_code'] = vi.fn()
    mockFns['media_encode_camera_params_bytes'] = vi.fn().mockReturnValue({
      status: 0,
      bytes: { data: null, len: 0, cap: 0 }
    })

    // 桥挂起直到手动放行——修复前网络 FFI 在 mutex 内执行，会拖垮所有解密调用
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    installBridge(() => gate.then(() => ({ ok: false, reason: 'worker-crashed' })))

    const pending = decodeClothDiyShareCode('net_code') // 本地提取完成后停在桥上
    const enc = await encodeCameraParams('{}') // 必须不被网络挂起阻塞
    expect(enc.success).toBe(true)

    release()
    const r = await pending
    expect(r.success).toBe(true)
    expect(r.timestamp).toBe(1) // 本地字段早已提取完成
    expect(r.error).toContain('网络解码不可用') // 桥失败降级，本地字段不受影响
  })
})
