// @core-change: 新增本地照片解码原始文本导出供同步本地解析器复用，并为文件系统错误携带原始 cause 供日志排查
/**
 * 游戏内图片参数解密服务
 * 严格按 nuan5_decryption_ffi.h 头文件调用 DLL
 *
 * P0-A3 加固：
 * 1. 函数绑定改为模块加载时一次性完成并缓存
 * 2. 引入 EXPECTED_ABI_VERSION 启动时校验
 * 3. 文件读取改 fsp.readFile 异步 + 10MB 上限
 * 4. service 模块内加 async mutex 串行化，避免并发操作 C 内存 use-after-free
 * 5. Step 1 status≠0 时也 freeCBytes 释放
 *
 * 解密流程（针对 NikkiPhotos 等游戏内照片）：
 * 1. media_decode_file_bytes_unchecked(flag=0xFFD9, key=UID) → JSON 文本
 * 2. 从 JSON 中提取 SocialPhoto.CameraParams（Base64 字符串）
 * 3. media_decrypt(Base64, key=Camera) → 相机参数 JSON 数组
 * 4. parseCameraParams 解析数组为结构化数据
 */
import koffi from 'koffi'
import fsp from 'fs/promises'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { logger } from '../utils/logger'
import { t } from '../i18n'
import { FileSystemError, InternalError, ValidationError } from '../../shared/errors/app-error'
import { findDllPath } from '../decryption-worker/dll-path'
import { readClothDiyCache, writeClothDiyCache } from './cloth-diy-cache'
import type { DecryptionWorkerBridge } from '../decryption-worker/bridge'
import type { NetworkDecodeKind, NetworkDecodeResult } from '../decryption-worker/worker-protocol'
import {
  type DecryptionResult,
  type CameraParams,
  type CameraParamsVersion,
  type RichCameraParams,
  type PhotographyInfo,
  type MultiPlayerInfo,
  type NikkiParams,
  type DressingParams,
  type InteractionParams,
  type ObjectParams,
  type SocialPhotoJSON,
  type EditPhotoState,
  type LocationInfo,
  type TaskInfo,
  type ClothParams,
  type ClothIdParts,
  type ClothDiyStructuredCloth,
  type ClothDiyStructuredOutfit,
  type EurekaParams,
  type MomoActionParams,
  type MomoHiddenState,
  type NikkiPoseInfo
} from '../types/decryption'

// ============================================================
// 常量
// ============================================================

// P0-A3：预期 ABI 版本，启动时校验，不匹配则抛错避免运行时崩溃
const EXPECTED_ABI_VERSION = 1

// P0-A3：文件大小上限 10MB，避免读取异常大文件阻塞主进程
const MAX_FILE_SIZE = 10 * 1024 * 1024

// ============================================================
// C 类型定义（与头文件一一对应）
// ============================================================

const CBytes = koffi.struct('CBytes', {
  data: koffi.pointer('uint8_t'),
  len: 'size_t',
  cap: 'size_t'
})

const MediaDecryptionResult = koffi.struct('MediaDecryptionResult', {
  status: 'uint32_t',
  bytes: CBytes
})

// Group 2: 加密结果（与解密结果布局相同）
const MediaEncryptionResult = koffi.struct('MediaEncryptionResult', {
  status: 'uint32_t',
  bytes: CBytes
})

// Group 3/4: 分享码解密结果（与 MediaDecryptionResult 布局相同）
const ClothDiyDecryptionResult = koffi.struct('ClothDiyDecryptionResult', {
  status: 'uint32_t',
  bytes: CBytes
})

const HomeBuildDecryptionResult = koffi.struct('HomeBuildDecryptionResult', {
  status: 'uint32_t',
  bytes: CBytes
})

const MediaKeyPtr = koffi.pointer('void')
// 分享码是不透明指针类型（C 中为 typedef struct ClothDiyShareCode ClothDiyShareCode）
const ClothDiyShareCodePtr = koffi.pointer('void')
const HomeBuildShareCodePtr = koffi.pointer('void')

const STATUS_MESSAGES: Record<number, string> = {
  0: 'Success',
  1: 'NullPointer',
  2: 'DataLenIsNotAMultipleOf16',
  3: 'DecodingBase64Failed',
  4: 'FindNoStartFlag',
  5: 'FindNoEndFlag',
  6: 'Io',
  7: 'IllegalUTF8',
  8: 'InvalidClothDiyShareCode',
  9: 'NotNumberString',
  10: 'NetworkError',
  11: 'InvalidHomeBuildShareCode',
  12: 'DeserializationFailed'
}

// ============================================================
// DLL 加载 + 函数绑定缓存
// ============================================================

let lib: koffi.IKoffiLib | null = null

// P0-A3：函数绑定缓存，模块加载时一次性完成
interface BoundFunctions {
  // Group 1: Media 解密（已实装）
  mediaDecrypt: koffi.KoffiFunction
  mediaDecodeFileBytesUnchecked: koffi.KoffiFunction
  mediaKeyCameraParam: koffi.KoffiFunction
  mediaKeyFromStr: koffi.KoffiFunction
  freeMediaKey: koffi.KoffiFunction
  freeCBytes: koffi.KoffiFunction
  // Group 2: Media 加密
  mediaEncodeCameraParamsBytes: koffi.KoffiFunction
  // Group 3: ClothDiy 分享码
  clothDiyShareCodeFromCodeStr: koffi.KoffiFunction
  clothDiyShareCodeTimestamp: koffi.KoffiFunction
  clothDiyShareCodeUidBytes: koffi.KoffiFunction
  clothDiyDecodeNetwork: koffi.KoffiFunction
  freeClothDiyShareCode: koffi.KoffiFunction
  // Group 4: HomeBuild 分享码
  homeBuildShareCodeFromCodeStr: koffi.KoffiFunction
  homeBuildShareCodeServer: koffi.KoffiFunction
  homeBuildDecodeNetwork: koffi.KoffiFunction
  freeHomeBuildShareCode: koffi.KoffiFunction
}

let boundFns: BoundFunctions | null = null

function getLib(): koffi.IKoffiLib {
  if (lib) return lib
  const dllPath = findDllPath()
  logger.info('[decryption] Loading DLL:', dllPath)
  lib = koffi.load(dllPath)

  // P0-A3：ABI 版本校验，不匹配则抛错避免后续调用产生不可预期的原生崩溃
  const ver = (lib.func('abi_version', 'uint32_t', []) as koffi.KoffiFunction)() as number
  logger.info('[decryption] ABI version:', ver, 'expected:', EXPECTED_ABI_VERSION)
  if (ver !== EXPECTED_ABI_VERSION) {
    // 卸载已加载的库，避免后续误调用
    try {
      lib.unload()
    } catch {
      /* ignore */
    }
    lib = null
    // DLL 与应用版本不配套属环境级部署问题，归 InternalError（兜底/第三方库错误）；
    // 显式 userMessage 携带具体 ABI 提示，避免 InternalError 默认兜底文案掩盖可行动信息
    const abiMismatchMsg = t('main.decryption.error.abiMismatch', {
      actual: ver,
      expected: EXPECTED_ABI_VERSION
    })
    throw new InternalError(abiMismatchMsg, undefined, { userMessage: abiMismatchMsg })
  }

  return lib
}

/**
 * P0-A3：一次性绑定所有 DLL 函数并缓存
 * 避免每次 decodeFileParams 调用都重新 libInstance.func() 绑定
 */
function getBoundFunctions(): BoundFunctions {
  if (boundFns) return boundFns
  const libInstance = getLib()
  boundFns = {
    // Group 1: Media 解密
    mediaDecrypt: libInstance.func('media_decrypt', MediaDecryptionResult, [
      koffi.pointer('uint8_t'),
      'size_t',
      MediaKeyPtr
    ]) as koffi.KoffiFunction,
    mediaDecodeFileBytesUnchecked: libInstance.func(
      'media_decode_file_bytes_unchecked',
      MediaDecryptionResult,
      [koffi.pointer('uint8_t'), 'size_t', koffi.pointer('uint8_t'), 'size_t', MediaKeyPtr]
    ) as koffi.KoffiFunction,
    mediaKeyCameraParam: libInstance.func(
      'media_key_camera_param',
      MediaKeyPtr,
      []
    ) as koffi.KoffiFunction,
    mediaKeyFromStr: libInstance.func('media_key_from_str', MediaKeyPtr, [
      'string'
    ]) as koffi.KoffiFunction,
    freeMediaKey: libInstance.func('free_media_key', 'void', [MediaKeyPtr]) as koffi.KoffiFunction,
    freeCBytes: libInstance.func('free_c_bytes', 'void', [CBytes]) as koffi.KoffiFunction,
    // Group 2: Media 加密 — media_encode_camera_params_bytes(bytes, len) -> MediaEncryptionResult
    mediaEncodeCameraParamsBytes: libInstance.func(
      'media_encode_camera_params_bytes',
      MediaEncryptionResult,
      [koffi.pointer('uint8_t'), 'size_t']
    ) as koffi.KoffiFunction,
    // Group 3: ClothDiy 分享码
    clothDiyShareCodeFromCodeStr: libInstance.func(
      'cloth_diy_share_code_from_code_str',
      ClothDiyShareCodePtr,
      ['string']
    ) as koffi.KoffiFunction,
    clothDiyShareCodeTimestamp: libInstance.func('cloth_diy_share_code_timestamp', 'int64_t', [
      ClothDiyShareCodePtr
    ]) as koffi.KoffiFunction,
    clothDiyShareCodeUidBytes: libInstance.func(
      'cloth_diy_share_code_uid_bytes',
      ClothDiyDecryptionResult,
      [ClothDiyShareCodePtr]
    ) as koffi.KoffiFunction,
    clothDiyDecodeNetwork: libInstance.func('cloth_diy_decode_network', ClothDiyDecryptionResult, [
      ClothDiyShareCodePtr
    ]) as koffi.KoffiFunction,
    freeClothDiyShareCode: libInstance.func('free_cloth_diy_share_code', 'void', [
      ClothDiyShareCodePtr
    ]) as koffi.KoffiFunction,
    // Group 4: HomeBuild 分享码
    homeBuildShareCodeFromCodeStr: libInstance.func(
      'home_build_share_code_from_code_str',
      HomeBuildShareCodePtr,
      ['string']
    ) as koffi.KoffiFunction,
    homeBuildShareCodeServer: libInstance.func('home_build_share_code_server', 'int64_t', [
      HomeBuildShareCodePtr
    ]) as koffi.KoffiFunction,
    homeBuildDecodeNetwork: libInstance.func(
      'home_build_decode_network',
      HomeBuildDecryptionResult,
      [HomeBuildShareCodePtr]
    ) as koffi.KoffiFunction,
    freeHomeBuildShareCode: libInstance.func('free_home_build_share_code', 'void', [
      HomeBuildShareCodePtr
    ]) as koffi.KoffiFunction
  }
  return boundFns
}

// ============================================================
// P0-A3：async mutex 串行化所有 DLL 调用
// 避免 concurrent 操作 C 内存导致 use-after-free
// ============================================================

let mutexChain: Promise<unknown> = Promise.resolve()

async function withMutex<T>(task: () => T | Promise<T>): Promise<T> {
  // 将新任务链接到 mutex 链末尾，确保串行执行
  const next = mutexChain.then(() => task())
  // 更新 mutexChain，但忽略当前任务的错误（避免一次失败阻塞后续所有调用）
  mutexChain = next.catch(() => {})
  return next
}

// ============================================================
// FIX(组17-1)：网络解码子进程桥
// cloth_diy/home_build 的网络解码 FFI 是同步网络 I/O，原先在 mutex 内执行，
// 网络慢时冻结主进程并拖垮照片参数解密。现下沉到 utilityProcess（见
// src/main/decryption-worker/），由 Application 构造时注入。
// ============================================================

let workerBridge: DecryptionWorkerBridge | null = null

export function setDecryptionWorkerBridge(bridge: DecryptionWorkerBridge | null): void {
  workerBridge = bridge
}

/**
 * 经子进程解码网络数据（在 mutex 之外调用——网络耗时不得阻塞本地 C 内存调用链）。
 * 永不抛错：超时/崩溃/未注入一律转优雅错误，与 DLL 返回 status≠0 的既有降级行为一致
 * （success:true + error，本地字段照常返回）。
 */
async function decodeNetworkGraceful(
  kind: NetworkDecodeKind,
  codeStr: string
): Promise<{ networkData?: string; error?: string }> {
  if (!workerBridge) {
    return { error: t('main.decryption.error.networkUnavailable') }
  }
  let result: NetworkDecodeResult
  try {
    result = await workerBridge.decodeNetwork(kind, codeStr)
  } catch (err) {
    logger.error(`[${kind}] 网络解码桥异常:`, err)
    return { error: t('main.decryption.error.networkUnavailable') }
  }
  if (!result.ok) {
    if (result.reason === 'timeout') {
      logger.warn(`[${kind}] 网络解码超时（8s），已降级返回本地字段`)
      return { error: t('main.decryption.error.networkTimeout') }
    }
    logger.warn(`[${kind}] 网络解码失败（worker ${result.reason}），已降级返回本地字段`)
    return { error: t('main.decryption.error.networkUnavailable') }
  }
  if (result.status !== 0) {
    logger.warn(`[${kind}] 网络解码 status:`, result.status, result.errorMessage ?? '')
    return {
      error: STATUS_MESSAGES[result.status] || t('main.decryption.error.networkDecodeFailed')
    }
  }
  return { networkData: result.networkData }
}

// ============================================================
// 参数解析（参考 nikki_albums converter.rs，非头文件内容）
// ============================================================

/**
 * 归一化相机参数中的字符串 id：去首尾空白、剥离包裹引号。
 * 真实解密数据中"无"的表示可能是带引号/含空白的 'None' 变体（属性面板曾显示 "None" (50%)），
 * 统一归一化后做 None 判定，非 None 的真实 id 也同步剥引号以保证 i18n 映射命中。
 */
function normalizeParamId(v: unknown): string {
  return String(v ?? '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .trim()
}

/** 灯光/滤镜 id 是否表示"无"（大小写不敏感） */
function isNoneParam(v: unknown): boolean {
  return normalizeParamId(v).toLowerCase() === 'none'
}

// ============================================================
// 相机参数版本分流（对齐上游 nuan5_structs/camera_params.rs 的 untagged V1/V2/V3）
// 版本判定依据是结构本身（元素个数 + flag + 元素类型一致性），不是数组第 0 位的
// version 字段；三版本长度互斥：31 / 32或40 / 44，无法匹配 → unknown 降级
// ============================================================

/** 数值 token 提取：有限数 → 原值；其余 → null（禁止把空值/字符串静默折叠为 0）。
 * JSON 形态仅认真正的 number（带引号数字串按字符串处理，对齐上游 untagged 的类型区分）；
 * CSV 形态数字段天然为字符串，需转换判定 */
function numericParamToken(v: unknown, csvForm: boolean): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (csvForm && typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** 数值 token → 整数判定（上游 i64/u8 语义：momo_pose、pose_id、标志位等必须为整数） */
function integerParamToken(v: unknown, csvForm: boolean): number | null {
  const n = numericParamToken(v, csvForm)
  return n !== null && Number.isInteger(n) ? n : null
}

/** V3 Enable 占位判定：[32-39]/[43] 须为字符串型 token（JSON 形态任意字符串；
 * CSV 形态非数字段），数值即结构不符（上游对数值读 String 会失败 → 整体降级） */
function isEnablePlaceholder(v: unknown, csvForm: boolean): boolean {
  if (typeof v !== 'string') return false
  return !csvForm || numericParamToken(v, true) === null
}

/** 上游值换算（parser/momo_camera_params_parser.rs）：网格单位 → 厘米/角度 */
const MOMO_AXIS_SCALE = 400
const MOMO_ROTATE_SCALE = 180

/** V2/V3 Disable 分支 [32-39]：大喵动作与调整参数；任一位非数值 → null（结构不符） */
function parseMomoDisableFields(
  arr: unknown[],
  csvForm: boolean,
  poseTime: number | null
): MomoActionParams | null {
  const poseId = integerParamToken(arr[32], csvForm)
  const horizontal = numericParamToken(arr[33], csvForm)
  const distance = numericParamToken(arr[34], csvForm)
  const height = numericParamToken(arr[35], csvForm)
  const rotateMomo = numericParamToken(arr[36], csvForm)
  const groundSnap = integerParamToken(arr[37], csvForm)
  const floating = integerParamToken(arr[38], csvForm)
  const withNikki = integerParamToken(arr[39], csvForm)
  if (
    poseId === null ||
    horizontal === null ||
    distance === null ||
    height === null ||
    rotateMomo === null ||
    groundSnap === null ||
    floating === null ||
    withNikki === null
  ) {
    return null
  }
  return {
    poseId,
    poseTime,
    horizontal: horizontal * MOMO_AXIS_SCALE,
    distance: distance * MOMO_AXIS_SCALE,
    height: height * MOMO_AXIS_SCALE,
    rotateMomo: rotateMomo * MOMO_ROTATE_SCALE,
    autoGroundSnap: groundSnap === 1,
    floatingEffect: floating === 1,
    poseWithNikki: withNikki === 1
  }
}

/** V3 [40-42] 暖暖动作：pose_id 与 in_idle 均为整数才有动作信息（否则 null = 无值）；
 * playing_percent 数值 → 值，字符串/空占位 → null（对齐上游 untagged Num/String 语义） */
function parseNikkiPoseFields(arr: unknown[], csvForm: boolean): NikkiPoseInfo | null {
  const poseId = integerParamToken(arr[40], csvForm)
  const inIdle = integerParamToken(arr[42], csvForm)
  if (poseId === null || inIdle === null) return null
  return {
    poseId,
    playingPercent: numericParamToken(arr[41], csvForm),
    inIdle: inIdle === 1
  }
}

/** 版本分流结果：tail 字段仅在匹配到已知版本结构时给出 */
interface CameraParamsTail {
  version: Exclude<CameraParamsVersion, 'unknown'>
  momoAction?: MomoActionParams | null
  nikkiPoseInfo?: NikkiPoseInfo | null
}

/**
 * 按版本分流解析数组尾部（对齐上游 untagged V1→V2→V3 完整消费语义）。
 * 长度互斥 + flag + 元素类型一致性共同决定版本；flag≠1 一律按 Enable
 * （上游 match _ => Enable）。无法匹配 → null（调用方降级 unknown）。
 */
function matchCameraParamsTail(arr: unknown[], csvForm: boolean): CameraParamsTail | null {
  const len = arr.length
  if (len === 31) return { version: 'v1' }

  if (len === 32 || len === 40) {
    const flag = integerParamToken(arr[31], csvForm)
    if (flag === null) return null
    if (flag === 1) {
      // Disable：大喵可见，40 位才完整（32 位为截断 → 结构不符）
      if (len !== 40) return null
      const momo = parseMomoDisableFields(arr, csvForm, null)
      return momo ? { version: 'v2', momoAction: momo } : null
    }
    // Enable：大喵隐藏，仅 32 位完整（40 位但 flag≠1 为内部不一致 → 降级）
    if (len !== 32) return null
    return { version: 'v2', momoAction: null }
  }

  if (len === 44) {
    const flag = integerParamToken(arr[31], csvForm)
    if (flag === null) return null
    const nikkiPoseInfo = parseNikkiPoseFields(arr, csvForm)
    if (flag === 1) {
      // Disable：[32-39] 与 [43] 均为数值
      const poseTime = numericParamToken(arr[43], csvForm)
      if (poseTime === null) return null
      const momo = parseMomoDisableFields(arr, csvForm, poseTime)
      if (!momo) return null
      return { version: 'v3', momoAction: momo, nikkiPoseInfo }
    }
    // Enable：[32-39] 与 [43] 均为字符串型空占位
    for (let i = 32; i <= 39; i++) {
      if (!isEnablePlaceholder(arr[i], csvForm)) return null
    }
    if (!isEnablePlaceholder(arr[43], csvForm)) return null
    return { version: 'v3', momoAction: null, nikkiPoseInfo }
  }

  return null
}

function parseCameraParams(text: string): CameraParams | undefined {
  if (!text) return undefined

  let arr: unknown[]
  let csvForm = false
  text = text.trim()

  try {
    if (text.startsWith('{')) {
      const obj = JSON.parse(text) as Record<string, unknown>
      const camera = obj.camera
      if (!Array.isArray(camera) || camera.length < 31) return undefined
      arr = camera
    } else if (text.startsWith('[') && text.endsWith(']')) {
      arr = JSON.parse(text) as unknown[]
      if (arr.length < 31) return undefined
    } else {
      arr = text.split(',').map((v) => v.trim())
      if (arr.length < 31) return undefined
      csvForm = true
    }
  } catch {
    // 以 { 或 [ 开头但非法 JSON：与长度不足同样按"无法识别"降级（undefined → hasParams:false），不向上抛错
    return undefined
  }

  // base 字段（[0-30]，V1/V2/V3 共享同一位序）——保持既有取值语义不变
  const camera: CameraParams = {
    focalLength: Number(arr[14]) || 0,
    apertureSection: Number(arr[15]) || 0,
    brightness: Number(arr[22]) || 0,
    exposure: Number(arr[23]) || 0,
    contrast: Number(arr[24]) || 0,
    saturation: Number(arr[25]) || 0,
    vibrance: Number(arr[26]) || 0,
    highlights: Number(arr[27]) || 0,
    shadows: Number(arr[28]) || 0,
    vignetteIntensity: Number(arr[19]) || 0,
    bloomIntensity: Number(arr[20]) || 0,
    bloomThreshold: Number(arr[21]) || 0,
    portraitMode: Number(arr[1]) === 1,
    filter:
      arr[29] && !isNoneParam(arr[29])
        ? { id: normalizeParamId(arr[29]), strength: Number(arr[30]) || 0 }
        : undefined,
    light:
      arr[17] && !isNoneParam(arr[17])
        ? { id: normalizeParamId(arr[17]), strength: Number(arr[18]) || 0 }
        : undefined,
    cameraVersion: 'unknown',
    rawParams: text
  }

  // 版本分流：tail 字段仅在匹配到已知版本结构时给出，否则保持 unknown 降级（保留 base + rawParams）
  const tail = matchCameraParamsTail(arr, csvForm)
  if (tail) {
    camera.cameraVersion = tail.version
    camera.momoAction = tail.momoAction
    camera.nikkiPoseInfo = tail.nikkiPoseInfo
  }
  return camera
}

// ============================================================
// P0-T3: 完整 SocialPhoto 解析函数
// JSON 字段名待 P0-T1 实际运行确认，当前使用多键名兜底
// ============================================================

/** 从 JSON 对象中按多种命名约定查找值（PascalCase/camelCase/snake_case） */
function pick(obj: Record<string, unknown> | null | undefined, ...keys: string[]): unknown {
  if (!obj) return undefined
  for (const k of keys) {
    if (obj[k] !== undefined) return obj[k]
  }
  return undefined
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : typeof v === 'string' ? Number(v) || 0 : 0
}

/** 三态数值提取：有限数字 → 原值；非空数字字符串 → 数值；缺失/null/空串/非数字串 → null。
 * 用于上游 OptionValue 语义字段（空串 "" 表示"存在但无值"）与可缺省枚举容器，
 * 真实零值（如 WindIntensity=0 无风）必须保留，禁止用 num() 折叠 */
function numOrNull(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function bool(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v === 1
  return false
}

/** Step 1.5: 将 step1Text JSON.parse 为 SocialPhotoJSON */
function parseSocialPhoto(step1Text: string): SocialPhotoJSON | null {
  try {
    const obj = JSON.parse(step1Text) as Record<string, unknown>
    return obj
  } catch {
    logger.warn('[decryption] JSON.parse failed for step1Text')
    return null
  }
}

/** 从 SocialPhotoJSON 中获取 social_photo 对象 */
function getSocialPhoto(json: SocialPhotoJSON): Record<string, unknown> | null {
  const sp = pick(json, 'social_photo', 'socialPhoto', 'SocialPhoto')
  return typeof sp === 'object' && sp !== null ? (sp as Record<string, unknown>) : null
}

/** 从 social_photo 中获取 photo_info 对象 */
function getPhotoInfo(socialPhoto: Record<string, unknown>): Record<string, unknown> | null {
  const pi = pick(socialPhoto, 'photo_info', 'photoInfo', 'PhotoInfo')
  return typeof pi === 'object' && pi !== null ? (pi as Record<string, unknown>) : null
}

/**
 * 地点标识：上游 SocialPhoto.TrackInfo.WorldID（v3.012 起新照片才有，旧照片整键缺失）。
 * 三态语义：仅正安全整数可定位；空串/非数字/0/负数/小数一律 null，绝不折叠成 0。
 */
function extractWorldId(socialPhoto: Record<string, unknown> | null): number | null {
  if (!socialPhoto) return null
  const raw = pick(socialPhoto, 'TrackInfo', 'track_info', 'trackInfo')
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const track = raw as Record<string, unknown>
  const value = numOrNull(pick(track, 'WorldID', 'world_id', 'worldId'))
  if (value === null || !Number.isSafeInteger(value) || value <= 0) return null
  return value
}

/** Step 5a: 解析拍摄信息 */
function parsePhotographyInfo(json: SocialPhotoJSON): PhotographyInfo {
  const socialPhoto = getSocialPhoto(json)
  const photoInfo = socialPhoto ? getPhotoInfo(socialPhoto) : null

  // 编辑状态
  const editHandler = pick(json, 'edit_photo_handler', 'editPhotoHandler', 'EditPhotoHandler')
  const editObj =
    typeof editHandler === 'object' && editHandler !== null
      ? (editHandler as Record<string, unknown>)
      : null
  const edit: EditPhotoState = {
    enabled: !!editObj,
    hasSticker: editObj ? bool(pick(editObj, 'has_sticker', 'hasSticker', 'HasSticker')) : false,
    hasText: editObj ? bool(pick(editObj, 'has_text', 'hasText', 'HasText')) : false
  }

  // 日期和时间
  const timeObj = socialPhoto ? pick(socialPhoto, 'time', 'Time') : undefined
  const timeRecord =
    typeof timeObj === 'object' && timeObj !== null ? (timeObj as Record<string, unknown>) : null
  const day = timeRecord ? num(pick(timeRecord, 'day', 'Day')) : 0
  const date = timeRecord ? { day } : null
  const time = timeRecord
    ? {
        hour: num(pick(timeRecord, 'hour', 'Hour')),
        minute: num(pick(timeRecord, 'min', 'minute', 'Min', 'Minute')),
        second: num(pick(timeRecord, 'sec', 'second', 'Sec', 'Second'))
      }
    : null

  // 地点（原始坐标 + 可选世界标识）
  let location: LocationInfo | null = null
  if (photoInfo) {
    const x = num(pick(photoInfo, 'nikki_loc_x', 'nikkiLocX', 'NikkiLocX'))
    const y = num(pick(photoInfo, 'nikki_loc_y', 'nikkiLocY', 'NikkiLocY'))
    const z = num(pick(photoInfo, 'nikki_loc_z', 'nikkiLocZ', 'NikkiLocZ'))
    location = { pos: { x, y, z }, name: null }
    // 旧照片不写该键，保证既有 DTO 逐字段不变（回归锁）
    const worldId = extractWorldId(socialPhoto)
    if (worldId !== null) location.worldId = worldId
  }

  // 天气
  const weather = socialPhoto
    ? num(pick(socialPhoto, 'weather_type', 'weatherType', 'WeatherType')) || null
    : null

  // 拍照模式 / 风向 / 风力（顶层 NormalPhotoInfo 容器；旧照片整键缺失 → null。
  // 容器内字段上游为必填 i8，此处仍按三态兜底；0 是真实枚举值如"无风"，必须保留）
  const normalPhotoRaw = pick(json, 'normal_photo_info', 'normalPhotoInfo', 'NormalPhotoInfo')
  const normalPhoto =
    typeof normalPhotoRaw === 'object' && normalPhotoRaw !== null && !Array.isArray(normalPhotoRaw)
      ? (normalPhotoRaw as Record<string, unknown>)
      : null
  const photoMode = normalPhoto
    ? numOrNull(pick(normalPhoto, 'photo_mode', 'photoMode', 'PhotoMode'))
    : null
  const windIntensity = normalPhoto
    ? numOrNull(pick(normalPhoto, 'wind_intensity', 'windIntensity', 'WindIntensity'))
    : null
  const windDirection = normalPhoto
    ? numOrNull(pick(normalPhoto, 'wind_direction', 'windDirection', 'WindDirection'))
    : null

  // 照片墙
  const photoWallPlugin = pick(json, 'photo_wall_plugin', 'photoWallPlugin', 'PhotoWallPlugin')
  const pwObj =
    typeof photoWallPlugin === 'object' && photoWallPlugin !== null
      ? (photoWallPlugin as Record<string, unknown>)
      : null
  let photoWall: number[] = []
  if (pwObj) {
    const ids = pick(pwObj, 'photo_id', 'photoId', 'PhotoId')
    if (Array.isArray(ids)) {
      photoWall = ids.map((v) => num(v))
    }
  }

  // 拍摄任务
  const tasks: TaskInfo[] = []
  const puzzlePlugin = pick(json, 'puzzle_game_plugin', 'puzzleGamePlugin', 'PuzzleGamePlugin')
  const puzzleObj =
    typeof puzzlePlugin === 'object' && puzzlePlugin !== null
      ? (puzzlePlugin as Record<string, unknown>)
      : null
  if (puzzleObj) {
    const tag = num(pick(puzzleObj, 'tag', 'Tag'))
    if (tag !== -1 && tag !== 0) tasks.push({ type: 'puzzle', tag })
  }
  const riskPhoto = pick(json, 'risk_photo', 'riskPhoto', 'RiskPhoto')
  if (riskPhoto && typeof riskPhoto === 'object') {
    tasks.push({ type: 'risk', tag: 0 })
  }
  const interactivePhoto = pick(json, 'interactive_photo', 'interactivePhoto', 'InteractivePhoto')
  if (interactivePhoto && typeof interactivePhoto === 'object') {
    tasks.push({ type: 'interactive', tag: 0 })
  }

  return {
    edit,
    date,
    time,
    location,
    weather,
    photoMode,
    windIntensity,
    windDirection,
    photoWall,
    tasks
  }
}

/** Step 5g: 解析双人合照（联机）信息：顶层 MultiPlayerHandler 容器（旧照片/单人照缺失 → null）。
 * 对齐上游 converter 仅保留 roleId/poseId/posePlayingPercent；
 * PoseID/PosePlayingPercent 为上游 OptionValue：空串 "" 表示存在但无值 → null */
function parseMultiPlayerInfo(json: SocialPhotoJSON): MultiPlayerInfo | null {
  const raw = pick(json, 'multi_player_handler', 'multiPlayerHandler', 'MultiPlayerHandler')
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const handler = raw as Record<string, unknown>
  return {
    // RoleID 上游为必填 i64，仍按三态兜底（非法数据不拖垮 pose 解析）
    roleId: numOrNull(pick(handler, 'role_id', 'roleId', 'RoleID')),
    poseId: numOrNull(pick(handler, 'pose_id', 'poseId', 'PoseID')),
    posePlayingPercent: numOrNull(
      pick(handler, 'pose_playing_percent', 'posePlayingPercent', 'PosePlayingPercent')
    )
  }
}

/** Step 5b: 解析暖暖信息 */
function parseNikkiParams(json: SocialPhotoJSON): NikkiParams {
  const socialPhoto = getSocialPhoto(json)
  const photoInfo = socialPhoto ? getPhotoInfo(socialPhoto) : null

  const giantStateRaw = socialPhoto
    ? pick(socialPhoto, 'giant_state', 'giantState', 'GiantState')
    : undefined
  const giantState =
    giantStateRaw !== undefined && giantStateRaw !== null ? bool(giantStateRaw) : false

  const hidden = photoInfo
    ? bool(pick(photoInfo, 'nikki_hidden', 'nikkiHidden', 'NikkiHidden'))
    : false

  let loc: NikkiParams['loc'] = null
  let rot: NikkiParams['rot'] = null
  let scale: NikkiParams['scale'] = null

  if (photoInfo) {
    loc = {
      x: num(pick(photoInfo, 'nikki_loc_x', 'nikkiLocX')),
      y: num(pick(photoInfo, 'nikki_loc_y', 'nikkiLocY')),
      z: num(pick(photoInfo, 'nikki_loc_z', 'nikkiLocZ'))
    }
    rot = {
      yaw: num(pick(photoInfo, 'nikki_rot_yaw', 'nikkiRotYaw')),
      pitch: num(pick(photoInfo, 'nikki_rot_pitch', 'nikkiRotPitch')),
      roll: num(pick(photoInfo, 'nikki_rot_roll', 'nikkiRotRoll'))
    }
    scale = {
      x: num(pick(photoInfo, 'nikki_scale_x', 'nikkiScaleX')),
      y: num(pick(photoInfo, 'nikki_scale_y', 'nikkiScaleY')),
      z: num(pick(photoInfo, 'nikki_scale_z', 'nikkiScaleZ'))
    }
  }

  return { giantState, hidden, loc, rot, scale }
}

/**
 * 服饰 ID 拆解共享纯函数（十进制位段，非位掩码；对齐上游 cloth_parser.rs，公式冻结于
 * docs/plans/cloth-outfit-data-contract.md §5）：
 * ID（10 位十进制）= species(3位) + state(1位) + clothType(2位) + outfitFeature(4位)
 * 照片参数解码（parseDressingParams）与搭配码 structured 解析共用，禁止另造副本。
 */
export function decomposeClothId(rawId: number): ClothIdParts {
  return {
    outfitFeature: rawId % 10000,
    clothType: Math.floor(rawId / 10000) % 100,
    state: Math.floor(rawId / 1000000) % 10,
    species: Math.floor(rawId / 10000000) % 1000
  }
}

/** Step 5c: 解析搭配信息（服装 + 祝福闪光）
 *  ID 拆解规则来自 nikki_albums 上游 cloth_parser.rs / eureka_parser.rs
 */
function parseDressingParams(json: SocialPhotoJSON): DressingParams {
  const socialPhoto = getSocialPhoto(json)
  const photoInfo = socialPhoto ? getPhotoInfo(socialPhoto) : null

  // 服装列表（nikki_clothes 是数字数组，cloth_type 从 ID 拆解）
  // ID 结构: species × 10^7 + state × 10^6 + cloth_type × 10^4 + outfit_feature
  const clothes: ClothParams[] = []
  if (photoInfo) {
    const rawClothes = pick(photoInfo, 'nikki_clothes', 'nikkiClothes', 'NikkiClothes')
    if (Array.isArray(rawClothes)) {
      for (const item of rawClothes) {
        const rawId =
          typeof item === 'number'
            ? item
            : typeof item === 'object' && item !== null
              ? num(pick(item as Record<string, unknown>, 'id', 'Id', 'ID'))
              : 0
        if (rawId === 0) continue

        // 从 ID 拆解（对齐上游 cloth_parser.rs，共享纯函数 decomposeClothId）
        const { outfitFeature, clothType, state, species } = decomposeClothId(rawId)

        // clothTypeName: 优先从 JSON 对象读取，否则为 null
        let clothTypeName: string | null = null
        if (typeof item === 'object' && item !== null) {
          const c = item as Record<string, unknown>
          const name = pick(c, 'cloth_type_name', 'clothTypeName', 'ClothTypeName', 'name', 'Name')
          if (typeof name === 'string') clothTypeName = name
        }

        clothes.push({ id: rawId, clothType, clothTypeName, state, species })
        logger.debug('[decryption] Cloth parsed:', {
          id: rawId,
          clothType,
          state,
          species,
          outfitFeature
        })
      }
    }
  }

  // 祝福闪光（magicball_color_ids 是数字数组，color/level 从 ID 拆解）
  // ID 结构: outfit × 10^3 + attachment_point × 10^2 + level × 10 + color
  const eureka: EurekaParams[] = []
  if (photoInfo) {
    const rawEureka = pick(
      photoInfo,
      'magicball_color_ids',
      'magicballColorIds',
      'MagicballColorIds'
    )
    if (Array.isArray(rawEureka)) {
      for (const item of rawEureka) {
        const rawId =
          typeof item === 'number'
            ? item
            : typeof item === 'object' && item !== null
              ? num(pick(item as Record<string, unknown>, 'id', 'Id', 'ID'))
              : 0
        if (rawId === 0) continue

        // 从 ID 拆解（对齐上游 eureka_parser.rs）
        const color = rawId % 10
        const level = Math.floor(rawId / 10) % 10
        const attachmentPoint = Math.floor(rawId / 100) % 10
        const outfit = Math.floor(rawId / 1000)

        eureka.push({ id: rawId, level, color, attachmentPoint, outfit })
        logger.debug('[decryption] Eureka parsed:', {
          id: rawId,
          color,
          level,
          attachmentPoint,
          outfit
        })
      }
    }
  }

  return { clothes, eureka }
}

/** Step 5d: 解析交互物信息 */
function parseInteractionParams(json: SocialPhotoJSON): InteractionParams {
  const socialPhoto = getSocialPhoto(json)

  function parseObject(raw: unknown): ObjectParams | null {
    if (!raw || typeof raw !== 'object') return null
    const obj = raw as Record<string, unknown>
    return {
      id:
        typeof obj['id'] === 'string'
          ? obj['id']
          : num(pick(obj, 'id', 'Id', 'ID', 'config_id', 'configId', 'cfg_id', 'cfgId')),
      loc: {
        x: num(pick(obj, 'loc_x', 'locX', 'LocX')),
        y: num(pick(obj, 'loc_y', 'locY', 'LocY')),
        z: num(pick(obj, 'loc_z', 'locZ', 'LocZ'))
      },
      rot: {
        yaw: num(pick(obj, 'rot_yaw', 'rotYaw', 'RotYaw')),
        pitch: num(pick(obj, 'rot_pitch', 'rotPitch', 'RotPitch')),
        roll: num(pick(obj, 'rot_roll', 'rotRoll', 'RotRoll'))
      },
      scale: {
        x: num(pick(obj, 'scale_x', 'scaleX', 'ScaleX')),
        y: num(pick(obj, 'scale_y', 'scaleY', 'ScaleY')),
        z: num(pick(obj, 'scale_z', 'scaleZ', 'ScaleZ'))
      }
    }
  }

  // 坐骑
  const mountRaw = socialPhoto
    ? pick(socialPhoto, 'mount_info', 'mountInfo', 'MountInfo')
    : undefined
  let mount: ObjectParams | null = null
  if (mountRaw && typeof mountRaw === 'object') {
    const mountObj = mountRaw as Record<string, unknown>
    // mount_info 可能是 OptionMap 包装，尝试取内部值
    const inner = pick(mountObj, 'some', 'Some', 'value', 'Value') || mountObj
    mount = parseObject(inner)
  }

  // 载具
  const carrierRaw = socialPhoto
    ? pick(socialPhoto, 'carrier_info', 'carrierInfo', 'CarrierInfo')
    : undefined
  const carrier = parseObject(carrierRaw)

  // 交互物列表
  const interactions: ObjectParams[] = []
  const interactionsRaw = socialPhoto
    ? pick(socialPhoto, 'interactions', 'Interactions')
    : undefined
  if (Array.isArray(interactionsRaw)) {
    for (const item of interactionsRaw) {
      const obj = parseObject(item)
      if (obj) interactions.push(obj)
    }
  }

  return { mount, carrier, interactions }
}

/** Step 6: 合并 CameraParams 数组数据 + photo_info 数据为 RichCameraParams */
function mergeRichCameraParams(camera: CameraParams, json: SocialPhotoJSON): RichCameraParams {
  const socialPhoto = getSocialPhoto(json)
  const photoInfo = socialPhoto ? getPhotoInfo(socialPhoto) : null

  // 缩放计算 + 相机位置
  let zoom = 0
  let cameraLoc: RichCameraParams['cameraLoc'] = null
  if (photoInfo) {
    const nikkiX = num(pick(photoInfo, 'nikki_loc_x', 'nikkiLocX'))
    const nikkiY = num(pick(photoInfo, 'nikki_loc_y', 'nikkiLocY'))
    const nikkiZ = num(pick(photoInfo, 'nikki_loc_z', 'nikkiLocZ'))
    const camX = num(pick(photoInfo, 'camera_actor_loc_x', 'cameraActorLocX'))
    const camY = num(pick(photoInfo, 'camera_actor_loc_y', 'cameraActorLocY'))
    const camZ = num(pick(photoInfo, 'camera_actor_loc_z', 'cameraActorLocZ'))
    cameraLoc = { x: camX, y: camY, z: camZ }
    const distance = Math.sqrt((nikkiX - camX) ** 2 + (nikkiY - camY) ** 2 + (nikkiZ - camZ) ** 2)
    zoom = -0.0035 * distance + 6.45
  }

  // 镜头旋转（roll + yaw + pitch）
  const rotation = photoInfo
    ? num(pick(photoInfo, 'camera_actor_rot_roll', 'cameraActorRotRoll'))
    : 0
  const cameraYaw = photoInfo
    ? num(pick(photoInfo, 'camera_actor_rot_yaw', 'cameraActorRotYaw'))
    : 0
  const cameraPitch = photoInfo
    ? num(pick(photoInfo, 'camera_actor_rot_pitch', 'cameraActorRotPitch'))
    : 0

  // 动作场景
  const pose = photoInfo ? num(pick(photoInfo, 'pose_id', 'poseId', 'PoseId')) : 0
  if (pose !== 0) {
    logger.debug(
      '[decryption] pose_id:',
      pose,
      t('main.decryption.log.mapHint', { map: 'POSE_ID_MAP' })
    )
  }

  // 定格（从 photo_info.framed_moment 读取，非 0 表示有定格）
  const framedMoment = photoInfo
    ? num(pick(photoInfo, 'framed_moment', 'framedMoment', 'FramedMoment'))
    : 0
  if (framedMoment !== 0) {
    logger.debug(
      '[decryption] framed_moment:',
      framedMoment,
      t('main.decryption.log.mapHint', { map: 'FRAMED_MOMENT_MAP' })
    )
  }

  // portrait_mode 优先从 portrait_mode_handler 读取
  const portraitHandler = pick(
    json,
    'portrait_mode_handler',
    'portraitModeHandler',
    'PortraitModeHandler'
  )
  if (portraitHandler && typeof portraitHandler === 'object') {
    const pm = pick(
      portraitHandler as Record<string, unknown>,
      'portrait_mode',
      'portraitMode',
      'PortraitMode'
    )
    if (pm !== undefined) {
      camera.portraitMode = bool(pm)
    }
  }

  // 大喵隐藏状态（CameraParams V2 才有，当前简化处理）
  // 如果 JSON 中 da_miao_info 存在且非空，则大喵可见
  const daMiaoRaw = socialPhoto
    ? pick(socialPhoto, 'da_miao_info', 'daMiaoInfo', 'DaMiaoInfo')
    : undefined
  let momoHidden: MomoHiddenState | null = null
  if (daMiaoRaw !== undefined) {
    if (
      daMiaoRaw === null ||
      (typeof daMiaoRaw === 'object' && Object.keys(daMiaoRaw as object).length === 0)
    ) {
      momoHidden = 'enabled'
    } else {
      momoHidden = 'disabled'
    }
  }

  return {
    ...camera,
    zoom,
    rotation,
    cameraYaw,
    cameraPitch,
    cameraLoc,
    pose,
    framedMoment,
    momoHidden
  }
}

// ============================================================
// ClothDiy networkData 结构化解析（阶段 1）
// 线上形态冻结于 docs/plans/cloth-outfit-data-contract.md §3/§4：双层 Content 包裹 JSON，
// 但 patternData/nsHiddenData 为 IdMap 自定义语法（"[:k:v,...]"），直接 JSON.parse 对含该
// 字段的样本必失败，须先按契约 §3.2 路线 1 预归一化。
// ============================================================

/** 信封层校验：双层 Content 包裹 + 必需/可选字段形态；strip 模式容忍未知字段（DIY 等） */
const clothDiyNetworkEnvelopeSchema = z.object({
  Content: z.object({
    Content: z.object({
      PoseId: z.unknown().optional(),
      wearingClothes: z.array(z.unknown()).optional()
    })
  })
})

/** IdMap 条目 BNF（契约 §3.2）：key=裸整数，value=裸数字（允许负数/小数） */
const ID_MAP_ENTRY_RE = /^(-?\d+)\s*:\s*(-?\d+(?:\.\d+)?)$/

/** IdMap 体 → JSON 对象体（"k:v,k:v" 改写为 '"k":v,"k":v'）；不符合 BNF 返回 null */
function idMapBodyToJson(body: string): string | null {
  if (body.trim() === '') return '' // 空表 "[:]"（唯一合法空形式）
  const parts: string[] = []
  for (const entry of body.split(',')) {
    const m = entry.trim().match(ID_MAP_ENTRY_RE)
    if (!m) return null // 含尾逗号/非数字键值 → 非 IdMap，整体放弃改写
    parts.push('"' + m[1] + '":' + m[2])
  }
  return parts.join(',')
}

/**
 * 将 networkData 中的 IdMap 自定义语法改写为标准 JSON 对象文本（契约 §3.2 预归一化路线）：
 * "[:1020600092:0,1021830003:0]" 改写为 '{"1020600092":0,"1021830003":0}'，空表 "[:]" 改写为 '{}'
 * 逐条目按 BNF 校验，不匹配的 "[:...]" 原样保留，交由后续 JSON.parse 自然失败降级。
 */
export function normalizeClothDiyIdMap(text: string): string {
  if (!text.includes('[:')) return text
  let out = ''
  let i = 0
  while (i < text.length) {
    const start = text.indexOf('[:', i)
    if (start === -1) {
      out += text.slice(i)
      break
    }
    const end = text.indexOf(']', start + 2)
    if (end === -1) {
      // 无配对右括号：非 IdMap，原样保留并继续扫描
      out += text.slice(i, start + 2)
      i = start + 2
      continue
    }
    const body = text.slice(start + 2, end)
    const jsonBody = idMapBodyToJson(body)
    if (jsonBody === null) {
      // 不符合 BNF：不是 IdMap，原样保留
      out += text.slice(i, end + 1)
      i = end + 1
      continue
    }
    out += text.slice(i, start) + '{' + jsonBody + '}'
    i = end + 1
  }
  return out
}

/**
 * 结构化解析 networkData → { poseId?, clothes }（阶段 1 投影，契约 §3/§4）。
 * 永不抛错：任何失败分支降级返回 null（raw 字符串由调用方保留兜底）。
 * @param networkData DLL 联网拉回的原始 UTF-8 文本
 */
export function parseClothDiyNetworkData(networkData: string): ClothDiyStructuredOutfit | null {
  // 预归一化（扫描器设计上不抛错，此处兜底防御：异常时按原文解析）
  let jsonText: string
  try {
    jsonText = normalizeClothDiyIdMap(networkData)
  } catch {
    jsonText = networkData
  }

  let raw: unknown
  try {
    raw = JSON.parse(jsonText)
  } catch {
    logger.warn(`[clothDiy] networkData 结构化解析失败（JSON 解析），降级为 structured:null`)
    return null
  }

  const parsed = clothDiyNetworkEnvelopeSchema.safeParse(raw)
  if (!parsed.success) {
    logger.warn(`[clothDiy] networkData 结构化解析失败（信封校验），降级为 structured:null`)
    return null
  }
  const inner = parsed.data.Content.Content

  // wearingClothes 必需（契约 §3.1）：缺失视为载荷畸形
  if (!inner.wearingClothes) {
    logger.warn(`[clothDiy] networkData 缺少 wearingClothes，降级为 structured:null`)
    return null
  }

  // 服饰投影：脏数据（非数字/非有限数/≤0）逐条跳过，保持原顺序
  const clothes: ClothDiyStructuredCloth[] = []
  for (const item of inner.wearingClothes) {
    if (typeof item !== 'number' || !Number.isFinite(item) || item <= 0) continue
    clothes.push({ id: item, ...decomposeClothId(item) })
  }

  // PoseId 仅保留正整数（0/负数/非整数/字符串一律省略）
  const poseRaw = inner.PoseId
  const poseId =
    typeof poseRaw === 'number' && Number.isInteger(poseRaw) && poseRaw > 0 ? poseRaw : undefined

  const structured: ClothDiyStructuredOutfit =
    poseId === undefined ? { clothes } : { poseId, clothes }
  logger.debug('[clothDiy] networkData structured:', { poseId, clothesCount: clothes.length })
  return structured
}

// ============================================================
// 辅助：从 CBytes 读取 Buffer
// ============================================================

function readCBytes(bytes: { data: koffi.PointerObject; len: number; cap: number }): Buffer {
  if (!bytes.data || bytes.len === 0) return Buffer.alloc(0)
  const raw = koffi.decode(bytes.data, 'uint8_t', bytes.len) as number[]
  return Buffer.from(raw)
}

// ============================================================
// 核心解密逻辑（使用缓存的函数绑定）
// ============================================================

/**
 * 本地照片解析适配器要的是两段**原始文本**（上游 parseLocalPhotoMetadata 的输入），
 * 而不是本服务已归一化的 DecryptionResult。用一个可选捕获对象在既有解码链里原样带出，
 * 避免复制整条 koffi 调用链（复用优先、零重复实现）。
 */
interface LocalPhotoRawTextsCapture {
  cameraText?: string
  photoText?: string
}

function decodeCameraParamsFromFile(
  fns: BoundFunctions,
  fileData: Buffer,
  uidKey: koffi.PointerObject,
  camKey: koffi.PointerObject,
  capture?: LocalPhotoRawTextsCapture
): DecryptionResult {
  // Step 1: 用 UID key + FFD9 flag 解密文件
  const flag = Buffer.from([0xff, 0xd9])
  const r1 = fns.mediaDecodeFileBytesUnchecked(
    flag,
    flag.length,
    fileData,
    fileData.length,
    uidKey
  ) as { status: number; bytes: { data: koffi.PointerObject; len: number; cap: number } }

  logger.info('[decryption] Step 1 status:', r1.status, STATUS_MESSAGES[r1.status] || 'Unknown')

  // P0-A3：Step 1 status≠0 时也要释放 r1.bytes（原实现漏掉此处的 freeCBytes）
  // 注意：status≠0 时 bytes.data 可能为 null，freeCBytes 需自行处理空指针
  if (r1.status !== 0) {
    try {
      fns.freeCBytes(r1.bytes)
    } catch {
      /* ignore */
    }
    const statusMsg =
      STATUS_MESSAGES[r1.status] || t('main.decryption.error.step1Failed', { status: r1.status })
    // FindNoEndFlag 通常意味着密钥不匹配（UID 错误或照片需要 UID 加密但使用了 cameraParam）
    const hint = r1.status === 5 ? t('main.decryption.error.findNoEndFlagHint') : ''
    return {
      hasParams: false,
      error: hint ? `${statusMsg} (${hint})` : statusMsg
    }
  }

  const step1Buf = readCBytes(r1.bytes)
  try {
    fns.freeCBytes(r1.bytes)
  } catch {
    /* ignore */
  }

  const step1Text = step1Buf.toString('utf-8')
  if (capture) capture.photoText = step1Text
  logger.info(
    '[decryption] Step 1 text length:',
    step1Text.length,
    'prefix:',
    step1Text.slice(0, 120)
  )
  // P0-T1: 完整 JSON 日志（debug 级别，避免生产环境泄露 UID 等敏感信息）
  logger.debug('[decryption] Step 1 full JSON:', step1Text)

  // Step 2: 从 JSON 中提取 CameraParams 的 Base64 值
  // 注意：JSON 中可能包含转义的 \/，需要还原为 /
  const match = step1Text.match(/"CameraParams":"([^"]+)"/)
  if (!match) {
    logger.warn(t('main.decryption.log.noCameraParams'))
    // 文件本身不含 CameraParams：notContained 标记供渲染层展示“不包含该参数”空态，
    // 与白名单拒绝等真实错误区分；error 保留供日志/候选 UID 遍历诊断使用
    return {
      hasParams: false,
      error: t('main.decryption.error.cameraParamsNotFound'),
      notContained: true
    }
  }

  const cameraParamsB64 = match[1].replace(/\\\//g, '/')
  logger.info('[decryption] Step 2 CameraParams Base64 length:', cameraParamsB64.length)

  // Step 3: 用 Camera key 解密 CameraParams Base64
  const b64Buf = Buffer.from(cameraParamsB64, 'utf-8')
  const r2 = fns.mediaDecrypt(b64Buf, b64Buf.length, camKey) as {
    status: number
    bytes: { data: koffi.PointerObject; len: number; cap: number }
  }

  logger.info('[decryption] Step 3 status:', r2.status, STATUS_MESSAGES[r2.status] || 'Unknown')

  if (r2.status !== 0) {
    try {
      fns.freeCBytes(r2.bytes)
    } catch {
      /* ignore */
    }
    return {
      hasParams: false,
      error:
        STATUS_MESSAGES[r2.status] || t('main.decryption.error.step3Failed', { status: r2.status })
    }
  }

  const step3Buf = readCBytes(r2.bytes)
  try {
    fns.freeCBytes(r2.bytes)
  } catch {
    /* ignore */
  }

  const step3Text = step3Buf.toString('utf-8').trim()
  if (capture) capture.cameraText = step3Text
  logger.info(
    '[decryption] Step 3 text length:',
    step3Text.length,
    'content:',
    step3Text.slice(0, 200)
  )

  // Step 4: 解析相机参数
  const camera = parseCameraParams(step3Text)
  if (!camera) {
    return { hasParams: false, error: t('main.decryption.error.cameraParamsInvalid') }
  }

  // Step 1.5 + Step 5-6: 完整 JSON 解析（各解析器独立 try-catch，单失败不影响其他）
  const socialPhoto = parseSocialPhoto(step1Text)
  if (!socialPhoto) {
    // JSON 解析失败时 fallback 到仅返回 CameraParams
    logger.warn('[decryption] SocialPhoto JSON parse failed, returning camera-only result')
    return { hasParams: true, camera: camera as RichCameraParams }
  }

  let richCamera: RichCameraParams
  try {
    richCamera = mergeRichCameraParams(camera, socialPhoto)
  } catch (err) {
    logger.error('[decryption] mergeRichCameraParams failed, using base camera:', err)
    richCamera = camera as RichCameraParams
  }

  let photography: PhotographyInfo | undefined
  try {
    photography = parsePhotographyInfo(socialPhoto)
  } catch (err) {
    logger.error('[decryption] parsePhotographyInfo failed:', err)
  }

  let nikki: NikkiParams | undefined
  try {
    nikki = parseNikkiParams(socialPhoto)
  } catch (err) {
    logger.error('[decryption] parseNikkiParams failed:', err)
  }

  let dressing: DressingParams | undefined
  try {
    dressing = parseDressingParams(socialPhoto)
  } catch (err) {
    logger.error('[decryption] parseDressingParams failed:', err)
  }

  let interactions: InteractionParams | undefined
  try {
    interactions = parseInteractionParams(socialPhoto)
  } catch (err) {
    logger.error('[decryption] parseInteractionParams failed:', err)
  }

  let multiPlayer: MultiPlayerInfo | null | undefined
  try {
    multiPlayer = parseMultiPlayerInfo(socialPhoto)
  } catch (err) {
    logger.error('[decryption] parseMultiPlayerInfo failed:', err)
  }

  logger.info('[decryption] Full parse result:', {
    hasPhotography: !!photography,
    hasNikki: !!nikki,
    hasDressing: !!dressing,
    clothesCount: dressing?.clothes.length ?? 0,
    hasInteractions: !!interactions,
    hasMultiPlayer: multiPlayer != null
  })

  return {
    hasParams: true,
    camera: richCamera,
    photography,
    nikki,
    dressing,
    interactions,
    multiPlayer
  }
}

// ============================================================
// 对外接口（P0-A3：改为 async + mutex 串行化）
// ============================================================

export async function decodeFileParams(
  filePath: string,
  albumType: string,
  uid?: string,
  candidateUids?: string[]
): Promise<DecryptionResult> {
  // P0-A3：mutex 串行化所有 DLL 调用，避免并发操作 C 内存 use-after-free
  return withMutex(async () => {
    try {
      const fns = getBoundFunctions()

      logger.info('[decryption] filePath:', filePath, 'albumType:', albumType, 'uid:', uid)

      // P0-A3：改用 fsp.readFile 异步读取，避免阻塞主进程事件循环
      // 同时校验文件大小上限，避免读取异常大文件
      let fileData: Buffer
      try {
        const stat = await fsp.stat(filePath)
        if (stat.size > MAX_FILE_SIZE) {
          return {
            hasParams: false,
            error: t('main.decryption.error.fileTooLarge', {
              size: stat.size,
              limit: MAX_FILE_SIZE
            })
          }
        }
        fileData = await fsp.readFile(filePath)
        logger.info('[decryption] File size:', fileData.length)
      } catch {
        return { hasParams: false, error: t('main.decryption.error.fileUnreadable') }
      }

      // 创建两个密钥：UID key 和 Camera key
      let uidKey: koffi.PointerObject | null = null
      let camKey: koffi.PointerObject | null = null

      // 降级：uid='default' 或未提供时，尝试从文件路径重新提取
      let effectiveUid = uid
      if (!effectiveUid || effectiveUid === 'default') {
        const { extractUidFromPath } = await import('../scanner/path-classifier')
        effectiveUid = extractUidFromPath(filePath)
      }

      if (effectiveUid && effectiveUid !== 'default') {
        uidKey = fns.mediaKeyFromStr(effectiveUid) as koffi.PointerObject
        logger.info('[decryption] Created UID key for:', effectiveUid)
      }
      camKey = fns.mediaKeyCameraParam() as koffi.PointerObject
      logger.info('[decryption] Created Camera key')

      // camKey 是后续所有解密步骤的必需密钥，创建失败时直接返回
      if (!camKey) {
        if (uidKey)
          try {
            fns.freeMediaKey(uidKey)
          } catch {
            /* ignore */
          }
        return { hasParams: false, error: t('main.decryption.error.cameraKeyFailed') }
      }

      try {
        // 降级 2：UID 不可用时，遍历候选 UID 列表逐个尝试
        if (!uidKey && candidateUids && candidateUids.length > 0) {
          logger.info('[decryption] Trying candidate UIDs:', candidateUids.length)
          for (const candidateUid of candidateUids) {
            const tryKey = fns.mediaKeyFromStr(candidateUid) as koffi.PointerObject
            if (!tryKey) continue
            try {
              const tryResult = decodeCameraParamsFromFile(fns, fileData, tryKey, camKey)
              if (tryResult.hasParams) {
                logger.info('[decryption] Candidate UID succeeded:', candidateUid)
                return tryResult
              }
              logger.info('[decryption] Candidate UID failed:', candidateUid, tryResult.error)
            } finally {
              try {
                fns.freeMediaKey(tryKey)
              } catch {
                /* ignore */
              }
            }
          }
          logger.info('[decryption] All candidate UIDs exhausted')
        }

        // 降级 3：所有候选 UID 均失败时，用 cameraParam 固定密钥降级（最终兜底）
        // 上游 param_codec.dart: uid == null ? MediaKey.cameraParam() : MediaKey.fromStr(uid)
        let usedFallbackKey = false
        if (!uidKey) {
          logger.info('[decryption] No UID available, falling back to cameraParam key')
          uidKey = camKey
          usedFallbackKey = true
        }

        const result = decodeCameraParamsFromFile(fns, fileData, uidKey, camKey)

        // 降级 3 触发且解密失败时，附加更明确的错误信息
        if (!result.hasParams && usedFallbackKey && result.error?.includes('FindNoEndFlag')) {
          return {
            hasParams: false,
            error: t('main.decryption.error.uidRequired', {
              hint: t('main.decryption.error.findNoEndFlagHint')
            })
          }
        }

        return result
      } finally {
        // 无论解密成功与否，都必须释放密钥 C 内存
        // uidKey 可能与 camKey 指向同一指针（降级场景），需避免 double-free
        if (uidKey && uidKey !== camKey)
          try {
            fns.freeMediaKey(uidKey)
          } catch {
            /* ignore */
          }
        if (camKey)
          try {
            fns.freeMediaKey(camKey)
          } catch {
            /* ignore */
          }
      }
    } catch (err) {
      logger.error(t('main.decryption.log.unexpectedError', { op: 'decryption' }), err)
      return {
        hasParams: false,
        error: err instanceof Error ? err.message : t('main.decryption.error.unknown')
      }
    }
  })
}

/**
 * 「电脑端优先本地解析照片」宿主适配器需要的两段原始文本。
 * 复用既有 koffi 解码链（同一 DLL、同一 UID/Camera 双密钥、同一 mutex 与释放纪律），
 * 不再新建 helper 进程，也不重复实现 FFI 绑定。
 */
export interface LocalPhotoRawTexts {
  readonly cameraText: string
  readonly photoText: string
}

/**
 * 由游戏原图直接产出上游 parseLocalPhotoMetadata 的输入文本。
 * 校验口径对齐上游 `windows-app/Services/LocalPhotoDecoder.cs:56-72`：
 * 绝对/可读文件、大小上限、JPEG SOI、UID 数字串、源照片 SHA256 复核。
 * 任一不满足即抛错（由上层 withLocalPhotoFallback 决定是否回退在线候补）。
 */
export async function decodeLocalPhotoRawTexts(
  filePath: string,
  uid: string,
  sha256: string
): Promise<LocalPhotoRawTexts> {
  if (
    typeof filePath !== 'string' ||
    filePath.length === 0 ||
    typeof uid !== 'string' ||
    !/^[0-9]{1,20}$/.test(uid) ||
    typeof sha256 !== 'string' ||
    !/^[a-fA-F0-9]{64}$/.test(sha256)
  ) {
    throw new ValidationError('Invalid local photo request')
  }

  return withMutex(async () => {
    const fns = getBoundFunctions()
    let fileData: Buffer
    try {
      const stat = await fsp.stat(filePath)
      if (stat.size < 4 || stat.size > MAX_FILE_SIZE) {
        throw new ValidationError('Invalid local photo size')
      }
      fileData = await fsp.readFile(filePath)
    } catch (cause) {
      // message 不含本机绝对路径；原始错误经 cause 携带（约定 §2），
      // cause 不跨 IPC（toIpcError 剥除），仅供主进程日志排查。
      throw new FileSystemError('Original photo unavailable', undefined, { cause })
    }
    if (fileData[0] !== 0xff || fileData[1] !== 0xd8) {
      throw new ValidationError('Invalid local photo format')
    }
    const actualHash = createHash('sha256').update(fileData).digest('hex')
    if (actualHash !== sha256.toLowerCase()) {
      throw new ValidationError('Local photo hash mismatch')
    }

    const uidKey = fns.mediaKeyFromStr(uid) as koffi.PointerObject
    const camKey = fns.mediaKeyCameraParam() as koffi.PointerObject
    if (!uidKey || !camKey) {
      if (uidKey)
        try {
          fns.freeMediaKey(uidKey)
        } catch {
          /* ignore */
        }
      if (camKey)
        try {
          fns.freeMediaKey(camKey)
        } catch {
          /* ignore */
        }
      throw new InternalError('Local photo key unavailable')
    }
    try {
      const capture: LocalPhotoRawTextsCapture = {}
      const result = decodeCameraParamsFromFile(fns, fileData, uidKey, camKey, capture)
      if (!result.hasParams || !capture.cameraText || !capture.photoText) {
        throw new InternalError('Local photo decode failed')
      }
      return { cameraText: capture.cameraText, photoText: capture.photoText }
    } finally {
      try {
        fns.freeMediaKey(uidKey)
      } catch {
        /* ignore */
      }
      try {
        fns.freeMediaKey(camKey)
      } catch {
        /* ignore */
      }
    }
  })
}

// ============================================================
// Group 2: Media 加密 — 将相机参数 JSON 加密为密文
// ============================================================

export interface MediaEncryptResult {
  success: boolean
  data?: Buffer
  error?: string
}

export async function encodeCameraParams(jsonText: string): Promise<MediaEncryptResult> {
  return withMutex(async () => {
    try {
      const fns = getBoundFunctions()
      const inputBuf = Buffer.from(jsonText, 'utf-8')

      const r = fns.mediaEncodeCameraParamsBytes(inputBuf, inputBuf.length) as {
        status: number
        bytes: { data: koffi.PointerObject; len: number; cap: number }
      }

      logger.info('[encrypt] status:', r.status, STATUS_MESSAGES[r.status] || 'Unknown')

      if (r.status !== 0) {
        try {
          fns.freeCBytes(r.bytes)
        } catch {
          /* ignore */
        }
        return {
          success: false,
          error:
            STATUS_MESSAGES[r.status] ||
            t('main.decryption.error.encryptFailed', { status: r.status })
        }
      }

      const outputBuf = readCBytes(r.bytes)
      try {
        fns.freeCBytes(r.bytes)
      } catch {
        /* ignore */
      }

      return { success: true, data: outputBuf }
    } catch (err) {
      logger.error(t('main.decryption.log.unexpectedError', { op: 'encrypt' }), err)
      return {
        success: false,
        error: err instanceof Error ? err.message : t('main.decryption.error.unknown')
      }
    }
  })
}

// ============================================================
// Group 3: ClothDiy 分享码解码
// ============================================================

export interface ClothDiyDecodeResult {
  success: boolean
  timestamp?: number
  uidBytes?: Buffer
  networkData?: string
  /** networkData 结构化解析结果（阶段 1）：解析成功为投影对象，解析失败为 null，networkData 缺省时缺省 */
  structured?: ClothDiyStructuredOutfit | null
  error?: string
}

export async function decodeClothDiyShareCode(codeStr: string): Promise<ClothDiyDecodeResult> {
  // FIX(组17-1)：mutex 内只做本地提取（纯内存 C 调用，快且不涉网络）；
  // 网络解码移出 mutex 走子进程桥，网络慢时不再拖垮 decodeFileParams 等核心功能
  let local: { timestamp: number; uidBytes: Buffer | undefined } | null
  try {
    local = await withMutex(() => {
      const fns = getBoundFunctions()
      let shareCode: koffi.PointerObject | null = null
      try {
        // Step 1: 从分享码字符串创建 ClothDiyShareCode 对象（本地解析，无网络）
        shareCode = fns.clothDiyShareCodeFromCodeStr(codeStr) as koffi.PointerObject
        if (!shareCode) return null

        // Step 2: 提取时间戳
        const timestamp = fns.clothDiyShareCodeTimestamp(shareCode) as number
        logger.info('[clothDiy] timestamp:', timestamp)

        // Step 3: 提取 UID 字节
        const uidResult = fns.clothDiyShareCodeUidBytes(shareCode) as {
          status: number
          bytes: { data: koffi.PointerObject; len: number; cap: number }
        }
        let uidBytes: Buffer | undefined
        if (uidResult.status === 0) {
          uidBytes = readCBytes(uidResult.bytes)
        }
        try {
          fns.freeCBytes(uidResult.bytes)
        } catch {
          /* ignore */
        }
        return { timestamp, uidBytes }
      } finally {
        if (shareCode) {
          try {
            fns.freeClothDiyShareCode(shareCode)
          } catch {
            /* ignore */
          }
        }
      }
    })
  } catch (err) {
    logger.error(t('main.decryption.log.unexpectedError', { op: 'clothDiy' }), err)
    return {
      success: false,
      error: err instanceof Error ? err.message : t('main.decryption.error.unknown')
    }
  }
  if (!local) {
    return { success: false, error: t('main.decryption.error.invalidClothDiyCode') }
  }

  // Step 4: 网络解码（子进程 + 8s 硬超时，失败优雅降级，本地字段照常返回）。
  // 阶段 3：本地缓存命中则跳过子进程网络解码（离线复用）；仅网络成功结果落盘，
  // 失败不写缓存；写盘失败由缓存模块内部 warn 兜底，不影响本次返回。
  const cached = await readClothDiyCache(codeStr)
  const net =
    cached !== undefined
      ? { networkData: cached }
      : await decodeNetworkGraceful('clothDiy', codeStr)
  if (cached === undefined && net.networkData !== undefined) {
    await writeClothDiyCache(codeStr, net.networkData)
  }
  return {
    success: true,
    timestamp: local.timestamp > 0 ? local.timestamp : undefined,
    uidBytes: local.uidBytes,
    networkData: net.networkData,
    // 结构化解析（阶段 1）：networkData 缺省时同进退；解析失败降级 null，raw 照常返回
    structured:
      net.networkData === undefined ? undefined : parseClothDiyNetworkData(net.networkData),
    error: net.error
  }
}

// ============================================================
// Group 4: HomeBuild 分享码解码
// ============================================================

export interface HomeBuildDecodeResult {
  success: boolean
  server?: number
  networkData?: string
  error?: string
}

export async function decodeHomeBuildShareCode(codeStr: string): Promise<HomeBuildDecodeResult> {
  // FIX(组17-1)：与 decodeClothDiyShareCode 同构——本地提取留 mutex，网络解码走子进程桥
  let server: number | null
  try {
    server = await withMutex(() => {
      const fns = getBoundFunctions()
      let shareCode: koffi.PointerObject | null = null
      try {
        // Step 1: 从分享码字符串创建 HomeBuildShareCode 对象（本地解析，无网络）
        shareCode = fns.homeBuildShareCodeFromCodeStr(codeStr) as koffi.PointerObject
        if (!shareCode) return null

        // Step 2: 提取服务器 ID
        const serverId = fns.homeBuildShareCodeServer(shareCode) as number
        logger.info('[homeBuild] server:', serverId)
        return serverId
      } finally {
        if (shareCode) {
          try {
            fns.freeHomeBuildShareCode(shareCode)
          } catch {
            /* ignore */
          }
        }
      }
    })
  } catch (err) {
    logger.error(t('main.decryption.log.unexpectedError', { op: 'homeBuild' }), err)
    return {
      success: false,
      error: err instanceof Error ? err.message : t('main.decryption.error.unknown')
    }
  }
  if (server === null) {
    return { success: false, error: t('main.decryption.error.invalidHomeBuildCode') }
  }

  // Step 3: 网络解码（子进程 + 8s 硬超时，失败优雅降级，本地字段照常返回）
  const net = await decodeNetworkGraceful('homeBuild', codeStr)
  return {
    success: true,
    server: server > 0 ? server : undefined,
    networkData: net.networkData,
    error: net.error
  }
}

export function disposeDecryptionService(): void {
  if (lib) {
    try {
      lib.unload()
    } catch {
      /* ignore */
    }
    lib = null
    boundFns = null
    logger.info('[decryption] DLL unloaded')
  }
}
