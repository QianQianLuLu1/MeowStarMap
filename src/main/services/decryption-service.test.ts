import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'

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
  setDecryptionWorkerBridge,
  decomposeClothId,
  parseClothDiyNetworkData,
  normalizeClothDiyIdMap
} from './decryption-service'
import { setClothDiyCacheRoot } from './cloth-diy-cache'

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
  // 阶段 3：缓存根注入每用例隔离的临时目录（electron mock 的缺省根跨用例共享，
  // 同码用例会互相污染，故全部用例统一走注入根）
  setClothDiyCacheRoot(path.join(tmpRoot, 'cloth-diy-cache'))
})

afterEach(() => {
  // 桥是 service 模块级状态，必须逐用例重置，避免跨用例泄漏
  setDecryptionWorkerBridge(null)
  disposeDecryptionService()
  setClothDiyCacheRoot(null)
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
// parseCameraParams 灯光/滤镜 None 判定（经 decodeFileParams 全链路）
// Bug：灯光/滤镜实际为"无"时，属性面板显示 "None" (50%) / "None" (100%)
// 根因：None 判定仅匹配精确字面量 'None'，带引号/空白/大小写变体漏过检查
// ============================================================

describe('decodeFileParams → parseCameraParams 灯光/滤镜 None 判定', () => {
  /**
   * 构造 31 元素参数数组：idx17/18=灯光 id/强度，idx29/30=滤镜 id/强度，其余填 0
   */
  function makeCameraArray(
    lightId: unknown,
    lightStrength: unknown,
    filterId: unknown,
    filterStrength: unknown
  ): string {
    const arr: unknown[] = Array.from({ length: 31 }, (_, i) => (i === 1 ? 1 : 0))
    arr[17] = lightId
    arr[18] = lightStrength
    arr[29] = filterId
    arr[30] = filterStrength
    return JSON.stringify(arr)
  }

  /** 全链路驱动：mock koffi（step1 JSON + step3 参数文本）后执行 decodeFileParams */
  async function decodeWithStep3(step3Text: string) {
    setupAbiVersion()
    const f = path.join(tmpRoot, 'a.jpg')
    fs.writeFileSync(f, Buffer.alloc(10))

    const step1Json = JSON.stringify({
      social_photo: { photo_info: {}, time: { day: 1, hour: 10, min: 30, sec: 0 } },
      CameraParams: 'YmFzZTY0UGFyYW1z'
    })
    const step1Bytes = Buffer.from(step1Json, 'utf-8')
    const step3Bytes = Buffer.from(step3Text, 'utf-8')

    decodeFn.mockImplementation((_ptr: unknown, _type: string, len: number) => {
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

    return decodeFileParams(f, 'NikkiPhotos', 'default')
  }

  it('灯光/滤镜 id 为带引号的 "None" 时按"无"处理（light/filter 为 undefined）', async () => {
    const r = await decodeWithStep3(makeCameraArray('"None"', 0.5, '"None"', 1))
    expect(r.hasParams).toBe(true)
    expect(r.camera?.light).toBeUndefined()
    expect(r.camera?.filter).toBeUndefined()
  })

  it('None 变体（含空白/大小写）时 light/filter 为 undefined', async () => {
    const r = await decodeWithStep3(makeCameraArray(' NONE ', 0.5, 'None', 1))
    expect(r.hasParams).toBe(true)
    expect(r.camera?.light).toBeUndefined()
    expect(r.camera?.filter).toBeUndefined()
  })

  it('逗号分隔分支中带引号的 "None" 同样按"无"处理', async () => {
    // 31 段逗号文本：idx17/18=灯光，idx29/30=滤镜，其余填 0（idx1=1 人像模式）
    const parts: string[] = Array.from({ length: 31 }, (_, i) => (i === 1 ? '1' : '0'))
    parts[17] = '"None"'
    parts[18] = '0.5'
    parts[29] = '"None"'
    parts[30] = '1'
    const r = await decodeWithStep3(parts.join(','))
    expect(r.hasParams).toBe(true)
    expect(r.camera?.light).toBeUndefined()
    expect(r.camera?.filter).toBeUndefined()
  })

  it('非 None 的真实 id 剥离包裹引号并保留强度', async () => {
    const r = await decodeWithStep3(makeCameraArray('"VibeLight_001"', 0.8, '"Fresh_001"', 0.6))
    expect(r.hasParams).toBe(true)
    expect(r.camera?.light).toEqual({ id: 'VibeLight_001', strength: 0.8 })
    expect(r.camera?.filter).toEqual({ id: 'Fresh_001', strength: 0.6 })
  })

  it('精确字面量 None 的既有行为不回退（light/filter 为 undefined）', async () => {
    const r = await decodeWithStep3(makeCameraArray('None', 0.5, 'None', 1))
    expect(r.hasParams).toBe(true)
    expect(r.camera?.light).toBeUndefined()
    expect(r.camera?.filter).toBeUndefined()
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
    expect(r.structured).toBeUndefined() // networkData 缺省时 structured 同进退（阶段 1 语义）
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

  it('structured：桥返回含 patternData 样本 → 解析为 14 件服饰，networkData 保留原文', async () => {
    setupAbiVersion()
    setupClothDiyLocal()
    installBridge(async () => ({ ok: true, status: 0, networkData: SAMPLE_ID_MAP }))

    const r = await decodeClothDiyShareCode('code')
    expect(r.success).toBe(true)
    expect(r.networkData).toBe(SAMPLE_ID_MAP) // raw 兜底保留
    expect(r.structured?.clothes).toHaveLength(14)
    expect(r.structured?.clothes[0]?.id).toBe(1020840033)
  })

  it('structured：桥返回信封不符 JSON → structured 为 null 且 networkData 保留', async () => {
    setupAbiVersion()
    setupClothDiyLocal()
    installBridge(async () => ({ ok: true, status: 0, networkData: '{"color":"red"}' }))

    const r = await decodeClothDiyShareCode('code')
    expect(r.success).toBe(true)
    expect(r.networkData).toBe('{"color":"red"}')
    expect(r.structured).toBeNull()
  })

  // ---- 阶段 3：网络结果本地磁盘缓存 ----

  /** 缓存文件路径（sha256(trim(code)).txt；basename 白名单校验后再拼接） */
  function clothCacheFile(code: string): string {
    const name = `${crypto.createHash('sha256').update(code.trim(), 'utf8').digest('hex')}.txt`
    if (!/^[0-9a-f]{64}\.txt$/.test(name)) throw new Error(`unsafe cache file name: ${name}`)
    return path.join(tmpRoot, 'cloth-diy-cache', name)
  }

  const SAMPLE_CACHED =
    '{"Content":{"Content":{"PoseId":7,"wearingClothes":[1020840033,1020100001]}}}'

  it('阶段 3 缓存：首次未命中→走网络→写盘（文件内容 = networkData）', async () => {
    setupAbiVersion()
    setupClothDiyLocal()
    const decodeNetwork = installBridge(async () => ({
      ok: true,
      status: 0,
      networkData: SAMPLE_CACHED
    }))

    const r = await decodeClothDiyShareCode('cache_code')
    expect(r.success).toBe(true)
    expect(r.networkData).toBe(SAMPLE_CACHED)
    expect(decodeNetwork).toHaveBeenCalledTimes(1)
    expect(fs.readFileSync(clothCacheFile('cache_code'), 'utf8')).toBe(SAMPLE_CACHED)
  })

  it('阶段 3 缓存：同一码二次调用命中缓存，不再触发 decodeNetwork', async () => {
    setupAbiVersion()
    setupClothDiyLocal()
    const decodeNetwork = installBridge(async () => ({
      ok: true,
      status: 0,
      networkData: SAMPLE_CACHED
    }))

    await decodeClothDiyShareCode('hit_code')
    const second = await decodeClothDiyShareCode('hit_code')
    expect(decodeNetwork).toHaveBeenCalledTimes(1) // 第二次命中缓存，桥不再被触发
    expect(second.networkData).toBe(SAMPLE_CACHED)
    expect(second.structured?.poseId).toBe(7)
    expect(second.structured?.clothes).toHaveLength(2)
    expect(second.error).toBeUndefined()
  })

  it('阶段 3 缓存：删除缓存文件后再次调用重新走网络', async () => {
    setupAbiVersion()
    setupClothDiyLocal()
    const decodeNetwork = installBridge(async () => ({
      ok: true,
      status: 0,
      networkData: SAMPLE_CACHED
    }))

    await decodeClothDiyShareCode('gone_code')
    expect(fs.existsSync(clothCacheFile('gone_code'))).toBe(true) // 首次已落盘（实现前即红）
    expect(decodeNetwork).toHaveBeenCalledTimes(1)
    fs.rmSync(clothCacheFile('gone_code'))
    await decodeClothDiyShareCode('gone_code')
    expect(decodeNetwork).toHaveBeenCalledTimes(2)
    expect(fs.existsSync(clothCacheFile('gone_code'))).toBe(true) // 重走网络后重新落盘
  })

  it('阶段 3 缓存：网络失败不写缓存，随后成功才写入', async () => {
    setupAbiVersion()
    setupClothDiyLocal()
    let ok = false
    const decodeNetwork = installBridge(async () =>
      ok ? { ok: true, status: 0, networkData: SAMPLE_CACHED } : { ok: true, status: 10 }
    )

    const r1 = await decodeClothDiyShareCode('retry_code')
    expect(r1.error).toContain('NetworkError')
    expect(fs.existsSync(clothCacheFile('retry_code'))).toBe(false) // 失败不写缓存
    ok = true
    const r2 = await decodeClothDiyShareCode('retry_code')
    expect(r2.error).toBeUndefined()
    expect(fs.readFileSync(clothCacheFile('retry_code'), 'utf8')).toBe(SAMPLE_CACHED) // 成功才写
    expect(decodeNetwork).toHaveBeenCalledTimes(2)
  })

  it('阶段 3 缓存：命中时即使桥未注入也返回 networkData（离线复用）', async () => {
    setupAbiVersion()
    setupClothDiyLocal()
    fs.mkdirSync(path.join(tmpRoot, 'cloth-diy-cache'), { recursive: true })
    fs.writeFileSync(clothCacheFile('offline_code'), SAMPLE_CACHED, 'utf8')

    // 不注入桥（afterEach 已确保初始为 null）
    const r = await decodeClothDiyShareCode('offline_code')
    expect(r.success).toBe(true)
    expect(r.networkData).toBe(SAMPLE_CACHED)
    expect(r.structured?.clothes).toHaveLength(2)
    expect(r.error).toBeUndefined()
  })

  it('阶段 3 缓存：写盘失败不阻塞主流程，恢复根后可正常缓存', async () => {
    setupAbiVersion()
    setupClothDiyLocal()
    const notADir = path.join(tmpRoot, 'plain-file.txt')
    fs.writeFileSync(notADir, 'x', 'utf8')
    setClothDiyCacheRoot(notADir) // 根指向普通文件，mkdir 必失败
    const decodeNetwork = installBridge(async () => ({
      ok: true,
      status: 0,
      networkData: SAMPLE_CACHED
    }))

    const r1 = await decodeClothDiyShareCode('wfail_code')
    expect(r1.success).toBe(true) // 写盘失败不影响解码结果
    expect(r1.networkData).toBe(SAMPLE_CACHED)

    setClothDiyCacheRoot(path.join(tmpRoot, 'cloth-diy-cache')) // 恢复隔离根
    const r2 = await decodeClothDiyShareCode('wfail_code')
    expect(r2.success).toBe(true)
    expect(r2.networkData).toBe(SAMPLE_CACHED)
    expect(decodeNetwork).toHaveBeenCalledTimes(2) // 写失败未留下缓存 → 重走网络
    expect(fs.readFileSync(clothCacheFile('wfail_code'), 'utf8')).toBe(SAMPLE_CACHED)
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

// ============================================================
// parseDressingParams 服饰 ID 拆解表征（经 decodeFileParams 全链路）
// 护住 decomposeClothId 抽函数重构：照片参数路径的拆解结果必须逐字段不变
// ============================================================

describe('parseDressingParams 服饰 ID 拆解表征（经 decodeFileParams）', () => {
  /** mock 全链路：step1 JSON 携带 nikki_clothes，step3 为 31 元素相机参数数组 */
  async function decodeWithClothes(nikkiClothes: number[]) {
    setupAbiVersion()
    const f = path.join(tmpRoot, 'a.jpg')
    fs.writeFileSync(f, Buffer.alloc(10))

    const step1Json = JSON.stringify({
      social_photo: { photo_info: { nikki_clothes: nikkiClothes } },
      CameraParams: 'YmFzZTY0UGFyYW1z'
    })
    const step1Bytes = Buffer.from(step1Json, 'utf-8')
    const step3Bytes = Buffer.from(
      JSON.stringify(Array.from({ length: 31 }, (_, i) => (i === 1 ? 1 : 0))),
      'utf-8'
    )

    decodeFn.mockImplementation((_ptr: unknown, _type: string, len: number) => {
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

    return decodeFileParams(f, 'NikkiPhotos', 'default')
  }

  it('dressing.clothes 拆解字段逐字段一致（契约 §5 示例 1020100001）', async () => {
    const r = await decodeWithClothes([1020100001, 1023100090])
    expect(r.hasParams).toBe(true)
    expect(r.dressing?.clothes).toEqual([
      { id: 1020100001, clothType: 10, clothTypeName: null, state: 0, species: 102 },
      { id: 1023100090, clothType: 10, clothTypeName: null, state: 3, species: 102 }
    ])
  })
})

// ============================================================
// decomposeClothId：服饰 ID 拆解共享纯函数（十进制位段，契约 §5）
// ============================================================

describe('decomposeClothId（服饰 ID 拆解纯函数，契约 §5）', () => {
  it('契约 §5 示例：1020100001 → species 102 / state 0 / clothType 10 / outfitFeature 1', () => {
    expect(decomposeClothId(1020100001)).toEqual({
      outfitFeature: 1,
      clothType: 10,
      state: 0,
      species: 102
    })
  })

  it('末段满额进位边界：1023999999 → outfitFeature 9999 / clothType 99 / state 3 / species 102', () => {
    expect(decomposeClothId(1023999999)).toEqual({
      outfitFeature: 9999,
      clothType: 99,
      state: 3,
      species: 102
    })
  })

  it('实采样本 3 首件：1020840033 → species 102 / state 0 / clothType 84 / outfitFeature 33', () => {
    expect(decomposeClothId(1020840033)).toEqual({
      outfitFeature: 33,
      clothType: 84,
      state: 0,
      species: 102
    })
  })
})

// ============================================================
// parseClothDiyNetworkData：搭配码 networkData 结构化解析（阶段 1，契约 §3/§4）
// fixture 逐字取自契约 §3.6 实采样本原文（脱敏后，2026-10-31 DLL 实抓）
// ============================================================

/** 契约 §3.6 样本 1 原文：最简形态（无 DIY、无 patternData，wearingDIYInfos 为空对象三态） */
const SAMPLE_MINIMAL =
  '{"Content":{"Content":{"wearingDIYInfos":{},"wearingClothes":[1023100090,1023710101,1023730101,1022600062,1023860042,1023750101,1023500101,1020840183,1023900101]}}}'

/** 契约 §3.6 样本 2 原文：Hair + General 混合 DIY（ColorGridID1:-1 哨兵值、TargetColor1 缺省） */
const SAMPLE_DIY_MIX =
  '{"Content":{"Content":{"wearingDIYInfos":[{"TargetGroupID":1,"CoreData":{"B":0.18116399645805,"ColorGridID":17,"R":0.064802996814251,"A":1,"G":0.078186996281147},"FeatureTag":1,"TargetClothID":1020600181},{"TargetGroupID":2,"CoreData":{"B":0.18116399645805,"ColorGridID":17,"R":0.064802996814251,"A":1,"G":0.078186996281147},"FeatureTag":1,"TargetClothID":1020600181},{"TargetGroupID":1,"CoreData":{"B":0.18116399645805,"ColorGridID":17,"R":0.064802996814251,"A":1,"G":0.078186996281147},"FeatureTag":3,"TargetClothID":1020600181},{"TargetGroupID":1,"CoreData":{"B":0.31991198658943,"ColorGridID":129,"R":0.30816900730133,"A":1,"G":0.30431100726128},"FeatureTag":1,"TargetClothID":1022500178},{"TargetGroupID":2,"CoreData":{"B":0.38350799679756,"ColorGridID":41,"R":0.2870579957962,"A":1,"G":0.40419900417328},"FeatureTag":1,"TargetClothID":1022500178},{"TargetGroupID":2,"CoreData":{"B":0.11162699759007,"ColorGridID":142,"R":0.15736000239849,"A":1,"G":0.11625999957323},"FeatureTag":3,"TargetClothID":1022500178},{"TargetGroupID":1,"CoreData":{"TargetColor0":{"R":0.29613798856735,"B":0.086499996483326,"A":1,"G":0.15896099805832},"ColorGridID0":3,"RoughnessOffset":-0.03,"ColorGridID1":-1,"HairColorMode":1},"FeatureTag":6,"TargetClothID":1020100165}],"wearingClothes":[1020100165,1020710055,1021410007,1023730178,1020600181,1023960165,1020850126,1020300180,1022500178,1020810033,1020820223,1021840004,1021200003]}}}'

/** 契约 §3.6 样本 3 原文：含 IdMap 自定义语法 patternData（标准 JSON.parse 必失败） */
const SAMPLE_ID_MAP =
  '{"Content":{"Content":{"patternData":[:1020600092:0,1021830003:0,1029300004:0,1020730037:0,1020710121:0,1021500022:0,1021820003:0,1021200004:0,1020100090:0,1021410026:0,1020850062:0,1021750003:0,1020810033:0,1020840033:0],"wearingClothes":[1020840033,1020100090,1020710121,1021410026,1020730037,1020600092,1029300004,1020850062,1021500022,1021200004,1020810033,1021820003,1021830003,1021750003],"wearingDIYInfos":[{"TargetGroupID":1,"CoreData":{"TargetColor0":{"R":0.89626902341843,"B":0.28662699460983,"A":1,"G":0.32294499874115},"ColorGridID0":55,"RoughnessOffset":0,"ColorGridID1":-1,"HairColorMode":1},"FeatureTag":6,"TargetClothID":1020100090}]}}}'

describe('parseClothDiyNetworkData（networkData 结构化解析主函数，契约 §3/§4）', () => {
  // ---- 正常 ----
  it('样本 1（最简形态）：9 件服饰、首件拆解正确、poseId 省略', () => {
    const s = parseClothDiyNetworkData(SAMPLE_MINIMAL)
    expect(s).not.toBeNull()
    expect(s!.poseId).toBeUndefined()
    expect(s!.clothes).toHaveLength(9)
    expect(s!.clothes[0]).toEqual({
      id: 1023100090,
      clothType: 10,
      state: 3,
      species: 102,
      outfitFeature: 90
    })
  })

  it('样本 3（含 patternData IdMap）：预归一化后解析出 14 件（契约 §7.4.1 点名必测 fixture）', () => {
    const s = parseClothDiyNetworkData(SAMPLE_ID_MAP)
    expect(s).not.toBeNull()
    expect(s!.clothes).toHaveLength(14)
    expect(s!.clothes[0]?.id).toBe(1020840033)
  })

  it('样本 2（DIY 混合）：wearingDIYInfos 不干扰投影，13 件', () => {
    const s = parseClothDiyNetworkData(SAMPLE_DIY_MIX)
    expect(s).not.toBeNull()
    expect(s!.clothes).toHaveLength(13)
    expect(s!.clothes[0]?.id).toBe(1020100165)
  })

  it('PoseId 为正整数时保留', () => {
    const s = parseClothDiyNetworkData(
      '{"Content":{"Content":{"PoseId":123,"wearingClothes":[1020100001]}}}'
    )
    expect(s!.poseId).toBe(123)
  })

  // ---- 异常 ----
  it('畸形 JSON 不抛错，返回 null', () => {
    expect(parseClothDiyNetworkData('not json{{')).toBeNull()
  })

  it('缺双层 Content 信封返回 null', () => {
    expect(parseClothDiyNetworkData('{"foo":1}')).toBeNull()
    expect(parseClothDiyNetworkData('{"Content":{}}')).toBeNull()
  })

  it('wearingClothes 缺失或非数组返回 null（上游必需字段）', () => {
    expect(parseClothDiyNetworkData('{"Content":{"Content":{}}}')).toBeNull()
    expect(
      parseClothDiyNetworkData('{"Content":{"Content":{"wearingClothes":"1020100001"}}}')
    ).toBeNull()
  })

  // ---- 边界 ----
  it('wearingClothes 空数组 → clothes:[]（合法空搭配）', () => {
    const s = parseClothDiyNetworkData('{"Content":{"Content":{"wearingClothes":[]}}}')
    expect(s).toEqual({ clothes: [] })
  })

  it('PoseId 为 0/负数/非整数/字符串/null 时一律省略，其余字段照常', () => {
    for (const pose of ['0', '-5', '1.5', '"123"', 'null']) {
      const raw = `{"Content":{"Content":{"PoseId":${pose},"wearingClothes":[1020100001]}}}`
      const s = parseClothDiyNetworkData(raw)
      expect(s!.poseId).toBeUndefined()
      expect(s!.clothes).toHaveLength(1)
    }
  })

  it('clothes 含 ID=0/负数脏数据时逐条跳过，保持原顺序', () => {
    const s = parseClothDiyNetworkData(
      '{"Content":{"Content":{"wearingClothes":[0,1020100001,-1,1023100090]}}}'
    )
    expect(s!.clothes).toEqual([
      { id: 1020100001, clothType: 10, state: 0, species: 102, outfitFeature: 1 },
      { id: 1023100090, clothType: 10, state: 3, species: 102, outfitFeature: 90 }
    ])
  })

  it('nsHiddenData 空表 IdMap（[:]）容忍，正常解析', () => {
    const s = parseClothDiyNetworkData(
      '{"Content":{"Content":{"nsHiddenData":[:],"wearingClothes":[1020100001]}}}'
    )
    expect(s!.clothes).toHaveLength(1)
  })
})

describe('normalizeClothDiyIdMap（IdMap 预归一化，契约 §3.2 BNF）', () => {
  it('条目改写为 JSON 对象形态', () => {
    expect(normalizeClothDiyIdMap('{"patternData":[:1020600092:0,1021830003:0]}')).toBe(
      '{"patternData":{"1020600092":0,"1021830003":0}}'
    )
  })

  it('空表 [:] → {}', () => {
    expect(normalizeClothDiyIdMap('[:]')).toBe('{}')
  })

  it('负数键值与冒号两侧空白', () => {
    expect(normalizeClothDiyIdMap('[:-5 : -1,7:2]')).toBe('{"-5":-1,"7":2}')
  })

  it('不符合 BNF（尾逗号/非数字键值）原样保留，交由后续 JSON.parse 降级', () => {
    expect(normalizeClothDiyIdMap('[:1:0,]')).toBe('[:1:0,]')
    expect(normalizeClothDiyIdMap('[:a:b]')).toBe('[:a:b]')
  })

  it('无 IdMap 语法时原样返回', () => {
    expect(normalizeClothDiyIdMap('{"a":1}')).toBe('{"a":1}')
  })
})
