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
import { logger } from '../utils/logger'
import { t } from '../i18n'
import { findDllPath } from '../decryption-worker/dll-path'
import type { DecryptionWorkerBridge } from '../decryption-worker/bridge'
import type { NetworkDecodeKind, NetworkDecodeResult } from '../decryption-worker/worker-protocol'
import {
  type DecryptionResult,
  type CameraParams,
  type RichCameraParams,
  type PhotographyInfo,
  type NikkiParams,
  type DressingParams,
  type InteractionParams,
  type ObjectParams,
  type SocialPhotoJSON,
  type EditPhotoState,
  type LocationInfo,
  type TaskInfo,
  type ClothParams,
  type EurekaParams,
  type MomoHiddenState
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
    throw new Error(
      t('main.decryption.error.abiMismatch', { actual: ver, expected: EXPECTED_ABI_VERSION })
    )
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

function parseCameraParams(text: string): CameraParams | undefined {
  if (!text) return undefined

  let arr: unknown[]
  text = text.trim()

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
  }

  return {
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
      arr[29] && arr[29] !== 'None'
        ? { id: String(arr[29]), strength: Number(arr[30]) || 0 }
        : undefined,
    light:
      arr[17] && arr[17] !== 'None'
        ? { id: String(arr[17]), strength: Number(arr[18]) || 0 }
        : undefined,
    rawParams: text
  }
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

  // 地点（原始坐标）
  let location: LocationInfo | null = null
  if (photoInfo) {
    const x = num(pick(photoInfo, 'nikki_loc_x', 'nikkiLocX', 'NikkiLocX'))
    const y = num(pick(photoInfo, 'nikki_loc_y', 'nikkiLocY', 'NikkiLocY'))
    const z = num(pick(photoInfo, 'nikki_loc_z', 'nikkiLocZ', 'NikkiLocZ'))
    location = { pos: { x, y, z }, name: null }
  }

  // 天气
  const weather = socialPhoto
    ? num(pick(socialPhoto, 'weather_type', 'weatherType', 'WeatherType')) || null
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

  return { edit, date, time, location, weather, photoWall, tasks }
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

        // 从 ID 拆解（对齐上游 cloth_parser.rs）
        const outfitFeature = rawId % 10000
        const clothType = Math.floor(rawId / 10000) % 100
        const state = Math.floor(rawId / 1000000) % 10
        const species = Math.floor(rawId / 10000000) % 1000

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

function decodeCameraParamsFromFile(
  fns: BoundFunctions,
  fileData: Buffer,
  uidKey: koffi.PointerObject,
  camKey: koffi.PointerObject
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
    return { hasParams: false, error: t('main.decryption.error.cameraParamsNotFound') }
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

  logger.info('[decryption] Full parse result:', {
    hasPhotography: !!photography,
    hasNikki: !!nikki,
    hasDressing: !!dressing,
    clothesCount: dressing?.clothes.length ?? 0,
    hasInteractions: !!interactions
  })

  return { hasParams: true, camera: richCamera, photography, nikki, dressing, interactions }
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

  // Step 4: 网络解码（子进程 + 8s 硬超时，失败优雅降级，本地字段照常返回）
  const net = await decodeNetworkGraceful('clothDiy', codeStr)
  return {
    success: true,
    timestamp: local.timestamp > 0 ? local.timestamp : undefined,
    uidBytes: local.uidBytes,
    networkData: net.networkData,
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
