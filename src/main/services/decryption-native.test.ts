/**
 * nuan5_decryption.dll 真实加载行为基线（native golden parity）
 *
 * 与 decryption-service.test.ts（全量 mock koffi）互补：本文件加载**真实 dll**，
 * 锁定原生库的行为基线，用于二进制更换前后的差分验证（如对齐上游
 * RanAxro/nikki_albums main 的预编译库，见 docs/plans/2026-11-08-解密库基线对齐上游main-实施计划.md）。
 *
 * 用法：
 * - 默认加载 <repo>/resources/nuan5_decryption.dll（win32 且文件存在时才运行，CI/Linux 自动跳过）；
 * - 差分验证：NUAN5_DLL_PATH=<候选dll路径> npx vitest run src/main/services/decryption-native.test.ts
 *   （显式指定路径时视为人工验证运行：文件不存在或绑定失败一律硬失败，不跳过）；
 * - 重新生成 golden：NUAN5_GOLDEN_WRITE=1 npx vitest run src/main/services/decryption-native.test.ts
 *   （golden 只锁 behavior 段，meta.dllSha256 仅供读数参考、不参与比对）。
 *
 * koffi 绑定与 decryption-service.ts getBoundFunctions()/getLib() 镜像（真相源在该文件，
 * 含 EXPECTED_ABI_VERSION=1 的契约）；本文件不 import 该模块，避免 electron app 依赖链。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import koffi from 'koffi'

// ============================================================
// C 类型定义（与 decryption-service.ts 逐字镜像）
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

const MediaEncryptionResult = koffi.struct('MediaEncryptionResult', {
  status: 'uint32_t',
  bytes: CBytes
})

const ClothDiyDecryptionResult = koffi.struct('ClothDiyDecryptionResult', {
  status: 'uint32_t',
  bytes: CBytes
})

const HomeBuildDecryptionResult = koffi.struct('HomeBuildDecryptionResult', {
  status: 'uint32_t',
  bytes: CBytes
})

const MediaKeyPtr = koffi.pointer('void')
const ClothDiyShareCodePtr = koffi.pointer('void')
const HomeBuildShareCodePtr = koffi.pointer('void')

/** 17 项 FFI 绑定（16 项函数 + abi_version），签名与 decryption-service.ts 一致 */
interface NativeBindings {
  abiVersion: koffi.KoffiFunction
  mediaDecrypt: koffi.KoffiFunction
  mediaDecodeFileBytesUnchecked: koffi.KoffiFunction
  mediaKeyCameraParam: koffi.KoffiFunction
  mediaKeyFromStr: koffi.KoffiFunction
  freeMediaKey: koffi.KoffiFunction
  freeCBytes: koffi.KoffiFunction
  clothDiyShareCodeFromCodeStr: koffi.KoffiFunction
  clothDiyShareCodeTimestamp: koffi.KoffiFunction
  clothDiyShareCodeUidBytes: koffi.KoffiFunction
  clothDiyDecodeNetwork: koffi.KoffiFunction
  freeClothDiyShareCode: koffi.KoffiFunction
  homeBuildShareCodeFromCodeStr: koffi.KoffiFunction
  homeBuildShareCodeServer: koffi.KoffiFunction
  homeBuildDecodeNetwork: koffi.KoffiFunction
  freeHomeBuildShareCode: koffi.KoffiFunction
}

// ============================================================
// 定位 dll（默认仓库资源；NUAN5_DLL_PATH 用于差分验证）
// ============================================================

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..')
const defaultDllPath = path.join(repoRoot, 'resources', 'nuan5_decryption.dll')
const explicitDllPath = process.env.NUAN5_DLL_PATH?.trim() ?? ''
const dllPath = explicitDllPath || defaultDllPath
// 显式指定路径 = 人工验证运行，必须执行；默认路径仅在 win32 且真件存在时执行（CI/Linux 跳过）
const shouldRun =
  explicitDllPath !== '' || (process.platform === 'win32' && fs.existsSync(defaultDllPath))

const GOLDEN_PATH = path.join(
  repoRoot,
  'src',
  'main',
  'services',
  '__tests__',
  'fixtures',
  'nuan5-native-golden.json'
)
const GOLDEN_WRITE = process.env.NUAN5_GOLDEN_WRITE === '1'

// 上游 rust/src/nuan5_params/decode.rs test_1（@ dc1b30b，MIT）的真实 CameraParams 密文向量，
// 与 decryption-service 的 Step 3 用法一致：media_decrypt 输入为 Base64 文本字节
const UPSTREAM_CAMERA_PARAMS_B64 =
  'q9NiCtwkEpChN5CBIvlM+7UBOn0L5iliMe9/0bUiezw2eSdCZ9TzUfs/JWBGlNv0kMcqySc5lGDPnNjAsqnZ01/iVK/X71xtAImj3Gcd03r0zGE3xXrq4ToOG8KSqPiv7+ecY4UX6H/8PO5yheO24u0LcWKh0Rzk3l9EA07xksHWQlc84xBVcOKWnYNpwGkN'

interface NativeEntry {
  status: number
  bytesLen: number | null
  sha256: string | null
}

interface CaptureShape {
  abiVersion: number
  keys: { cameraParamNonNull: boolean; fromStrNonNull: boolean; long4096NonNull: boolean }
  vectorDecrypt: NativeEntry & { looksLikeJson: boolean }
  roundtrip: {
    encodeExport: 'present' | string
    encode: NativeEntry | null
    decode: NativeEntry | null
    matchesOriginal: boolean | null
  }
  errorPaths: {
    shortB64DecodesTo8Bytes: NativeEntry
    notBase64RawNul: NativeEntry
    noStartFlagScan: NativeEntry
    emptyInput: NativeEntry
    invalidClothCodeReturnsNull: boolean
    invalidHomeCodeReturnsNull: boolean
  }
  edgeCases: {
    zeroBlock16B64: NativeEntry
    longKeyFree: boolean
  }
}

interface GoldenFile {
  meta: { dllSha256: string; platform: string; writtenAt: string }
  behavior: CaptureShape
}

let lib: koffi.IKoffiLib | null = null
let fns: NativeBindings
let camKey: koffi.PointerObject | null = null
let captured: CaptureShape | null = null

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function bindAll(target: koffi.IKoffiLib): NativeBindings {
  const bind = (name: string, ret: unknown, args: unknown[]): koffi.KoffiFunction =>
    target.func(name, ret, args) as koffi.KoffiFunction
  return {
    abiVersion: bind('abi_version', 'uint32_t', []),
    mediaDecrypt: bind('media_decrypt', MediaDecryptionResult, [
      koffi.pointer('uint8_t'),
      'size_t',
      MediaKeyPtr
    ]),
    mediaDecodeFileBytesUnchecked: bind(
      'media_decode_file_bytes_unchecked',
      MediaDecryptionResult,
      [koffi.pointer('uint8_t'), 'size_t', koffi.pointer('uint8_t'), 'size_t', MediaKeyPtr]
    ),
    mediaKeyCameraParam: bind('media_key_camera_param', MediaKeyPtr, []),
    mediaKeyFromStr: bind('media_key_from_str', MediaKeyPtr, ['string']),
    freeMediaKey: bind('free_media_key', 'void', [MediaKeyPtr]),
    freeCBytes: bind('free_c_bytes', 'void', [CBytes]),
    clothDiyShareCodeFromCodeStr: bind('cloth_diy_share_code_from_code_str', ClothDiyShareCodePtr, [
      'string'
    ]),
    clothDiyShareCodeTimestamp: bind('cloth_diy_share_code_timestamp', 'int64_t', [
      ClothDiyShareCodePtr
    ]),
    clothDiyShareCodeUidBytes: bind('cloth_diy_share_code_uid_bytes', ClothDiyDecryptionResult, [
      ClothDiyShareCodePtr
    ]),
    clothDiyDecodeNetwork: bind('cloth_diy_decode_network', ClothDiyDecryptionResult, [
      ClothDiyShareCodePtr
    ]),
    freeClothDiyShareCode: bind('free_cloth_diy_share_code', 'void', [ClothDiyShareCodePtr]),
    homeBuildShareCodeFromCodeStr: bind(
      'home_build_share_code_from_code_str',
      HomeBuildShareCodePtr,
      ['string']
    ),
    homeBuildShareCodeServer: bind('home_build_share_code_server', 'int64_t', [
      HomeBuildShareCodePtr
    ]),
    homeBuildDecodeNetwork: bind('home_build_decode_network', HomeBuildDecryptionResult, [
      HomeBuildShareCodePtr
    ]),
    freeHomeBuildShareCode: bind('free_home_build_share_code', 'void', [HomeBuildShareCodePtr])
  }
}

interface RawResult {
  status: number
  bytes: { data: koffi.PointerObject; len: number; cap: number }
}

/** 读取 CBytes 结果并立即释放（与 decryption-service readCBytes + freeCBytes 纪律一致） */
function collect(r: RawResult): { entry: NativeEntry; buf: Buffer } {
  const entry: NativeEntry = { status: r.status, bytesLen: null, sha256: null }
  let buf: Buffer = Buffer.alloc(0)
  if (r.status === 0 && r.bytes.data && r.bytes.len > 0) {
    const raw = koffi.decode(r.bytes.data, 'uint8_t', r.bytes.len) as number[]
    buf = Buffer.from(raw)
    entry.bytesLen = buf.length
    entry.sha256 = sha256Hex(buf)
  }
  try {
    fns.freeCBytes(r.bytes)
  } catch {
    /* ignore：与 service 同纪律 */
  }
  return { entry, buf }
}

function runCapture(): CaptureShape {
  const capture: CaptureShape = {
    abiVersion: fns.abiVersion() as number,
    keys: { cameraParamNonNull: false, fromStrNonNull: false, long4096NonNull: false },
    vectorDecrypt: { status: -1, bytesLen: null, sha256: null, looksLikeJson: false },
    roundtrip: { encodeExport: 'present', encode: null, decode: null, matchesOriginal: null },
    errorPaths: {
      shortB64DecodesTo8Bytes: { status: -1, bytesLen: null, sha256: null },
      notBase64RawNul: { status: -1, bytesLen: null, sha256: null },
      noStartFlagScan: { status: -1, bytesLen: null, sha256: null },
      emptyInput: { status: -1, bytesLen: null, sha256: null },
      invalidClothCodeReturnsNull: false,
      invalidHomeCodeReturnsNull: false
    },
    edgeCases: { zeroBlock16B64: { status: -1, bytesLen: null, sha256: null }, longKeyFree: false }
  }

  capture.keys.cameraParamNonNull = camKey !== null && camKey !== undefined

  // 正常：上游 CameraParams 向量解密
  const vectorInput = Buffer.from(UPSTREAM_CAMERA_PARAMS_B64, 'utf-8')
  const vector = collect(fns.mediaDecrypt(vectorInput, vectorInput.length, camKey) as RawResult)
  capture.vectorDecrypt = {
    ...vector.entry,
    looksLikeJson: vector.buf.length > 0 && /^[[{]/.test(vector.buf.toString('utf-8').trimStart())
  }

  // 正常：encode→decrypt 往返（明文取自向量解密结果，保证真实 CameraParams JSON 形状）
  let encodeFn: koffi.KoffiFunction | null = null
  try {
    encodeFn = (lib?.func('media_encode_camera_params_bytes', MediaEncryptionResult, [
      koffi.pointer('uint8_t'),
      'size_t'
    ]) ?? null) as koffi.KoffiFunction | null
    capture.roundtrip.encodeExport = encodeFn ? 'present' : 'bind-failed'
  } catch (err) {
    // 导出缺失是差分验证的直接信号：记录而非崩溃，由断言与 golden 比对呈现
    capture.roundtrip.encodeExport = err instanceof Error ? err.message : String(err)
  }
  if (encodeFn && vector.buf.length > 0) {
    const encoded = collect(encodeFn(vector.buf, vector.buf.length) as RawResult)
    capture.roundtrip.encode = encoded.entry
    if (encoded.entry.status === 0 && encoded.buf.length > 0) {
      const back = collect(fns.mediaDecrypt(encoded.buf, encoded.buf.length, camKey) as RawResult)
      capture.roundtrip.decode = back.entry
      capture.roundtrip.matchesOriginal = back.entry.status === 0 && back.buf.equals(vector.buf)
    }
  }

  // 异常：8 字节明文（Base64 文本输入）→ 解码后非 16 倍数
  const shortB64 = Buffer.from(Buffer.alloc(8).toString('base64'), 'utf-8')
  capture.errorPaths.shortB64DecodesTo8Bytes = collect(
    fns.mediaDecrypt(shortB64, shortB64.length, camKey) as RawResult
  ).entry

  // 异常：非 Base64 文本（原始 NUL 字节）
  const rawNul = Buffer.alloc(17, 0)
  capture.errorPaths.notBase64RawNul = collect(
    fns.mediaDecrypt(rawNul, rawNul.length, camKey) as RawResult
  ).entry

  // 异常：文件级扫描无起始标志（64 个 'A'，不含 0xFF 0xD9）
  const noFlag = Buffer.alloc(64, 0x41)
  const flag = Buffer.from([0xff, 0xd9])
  capture.errorPaths.noStartFlagScan = collect(
    fns.mediaDecodeFileBytesUnchecked(flag, flag.length, noFlag, noFlag.length, camKey) as RawResult
  ).entry

  // 异常：空输入
  const empty = Buffer.alloc(0)
  capture.errorPaths.emptyInput = collect(
    fns.mediaDecrypt(empty, empty.length, camKey) as RawResult
  ).entry

  // 异常：非法分享码 → from_code_str 返回 null（service 据此合成 status 8/11）
  const invalidCode = '!!!invalid-share-code!!!'
  capture.errorPaths.invalidClothCodeReturnsNull =
    (fns.clothDiyShareCodeFromCodeStr(invalidCode) as koffi.PointerObject | null) === null
  capture.errorPaths.invalidHomeCodeReturnsNull =
    (fns.homeBuildShareCodeFromCodeStr(invalidCode) as koffi.PointerObject | null) === null

  // 边界：16 字节全零块的 Base64 文本（解码后恰为合法 AES 块）
  const zeroB64 = Buffer.from(Buffer.alloc(16).toString('base64'), 'utf-8')
  capture.edgeCases.zeroBlock16B64 = collect(
    fns.mediaDecrypt(zeroB64, zeroB64.length, camKey) as RawResult
  ).entry

  // 边界：超长 key 可创建（释放无崩溃）
  let longKey: koffi.PointerObject | null = null
  try {
    longKey = fns.mediaKeyFromStr('A'.repeat(4096)) as koffi.PointerObject | null
    capture.keys.long4096NonNull = longKey !== null
    capture.edgeCases.longKeyFree = true
  } finally {
    try {
      if (longKey) fns.freeMediaKey(longKey)
    } catch {
      /* ignore */
    }
  }

  // keys.fromStrNonNull：常规 key
  let normalKey: koffi.PointerObject | null = null
  try {
    normalKey = fns.mediaKeyFromStr('wxnn-native-parity-key') as koffi.PointerObject | null
    capture.keys.fromStrNonNull = normalKey !== null
  } finally {
    try {
      if (normalKey) fns.freeMediaKey(normalKey)
    } catch {
      /* ignore */
    }
  }

  return capture
}

describe.skipIf(!shouldRun)('nuan5_decryption.dll 真实加载行为基线', () => {
  beforeAll(() => {
    if (explicitDllPath && !fs.existsSync(dllPath)) {
      throw new Error(`NUAN5_DLL_PATH 指定的候选 dll 不存在: ${dllPath}`)
    }
    if (!fs.existsSync(dllPath)) {
      throw new Error(`默认 dll 不存在: ${dllPath}`)
    }
    lib = koffi.load(dllPath)
    fns = bindAll(lib)
    camKey = fns.mediaKeyCameraParam() as koffi.PointerObject | null
    captured = runCapture()
  })

  afterAll(() => {
    try {
      if (camKey && fns) fns.freeMediaKey(camKey)
    } catch {
      /* ignore */
    }
    try {
      lib?.unload()
    } catch {
      /* ignore */
    }
    lib = null
    camKey = null
  })

  it('abi_version 返回 1（与 EXPECTED_ABI_VERSION 契约一致）', () => {
    expect(captured?.abiVersion).toBe(1)
  })

  it('media_key_camera_param 与 media_key_from_str 返回可用密钥指针', () => {
    expect(captured?.keys.cameraParamNonNull).toBe(true)
    expect(captured?.keys.fromStrNonNull).toBe(true)
  })

  it('上游 CameraParams 密文向量解密为合法 JSON（正常路径不崩溃）', () => {
    expect(captured?.vectorDecrypt.status).toBe(0)
    expect(captured?.vectorDecrypt.looksLikeJson).toBe(true)
    expect(captured?.vectorDecrypt.sha256).toBeTruthy()
  })

  it('encode 导出存在且往返解密成功（字节级还原非契约，由 golden 锁定差异）', () => {
    expect(captured?.roundtrip.encodeExport).toBe('present')
    expect(captured?.roundtrip.encode?.status).toBe(0)
    expect(captured?.roundtrip.decode?.status).toBe(0)
  })

  it('异常输入返回非零 status 而非崩溃（非 16 倍数 / 非 Base64 / 无起始标志 / 空输入）', () => {
    expect(captured?.errorPaths.shortB64DecodesTo8Bytes.status).not.toBe(0)
    expect(captured?.errorPaths.notBase64RawNul.status).not.toBe(0)
    expect(captured?.errorPaths.noStartFlagScan.status).not.toBe(0)
    expect(captured?.errorPaths.emptyInput.status).not.toBe(0)
  })

  it('非法分享码 from_code_str 返回 null（与 service 合成 status 8/11 的前提一致）', () => {
    expect(captured?.errorPaths.invalidClothCodeReturnsNull).toBe(true)
    expect(captured?.errorPaths.invalidHomeCodeReturnsNull).toBe(true)
  })

  it('边界输入行为被采集（全零块 / 超长 key 释放无崩溃）', () => {
    expect(typeof captured?.edgeCases.zeroBlock16B64.status).toBe('number')
    expect(captured?.edgeCases.longKeyFree).toBe(true)
    expect(captured?.keys.long4096NonNull).toBe(true)
  })

  it('行为基线与 golden 快照一致（差分验证判据）', () => {
    expect(captured).not.toBeNull()
    if (GOLDEN_WRITE) {
      const dllSha = sha256Hex(fs.readFileSync(dllPath))
      const golden: GoldenFile = {
        meta: {
          dllSha256: dllSha,
          platform: process.platform,
          writtenAt: new Date().toISOString()
        },
        behavior: captured as CaptureShape
      }
      fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true })
      fs.writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 2) + '\n', 'utf-8')
      console.info(`[nuan5-native] golden 已写入: ${GOLDEN_PATH}（dll sha256=${dllSha}）`)
      return
    }
    if (!fs.existsSync(GOLDEN_PATH)) {
      throw new Error(
        `golden 不存在: ${GOLDEN_PATH}。请先对基线 dll 执行 NUAN5_GOLDEN_WRITE=1 生成后再做差分验证。`
      )
    }
    const fixture = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf-8')) as GoldenFile
    expect(fixture.behavior).toEqual(captured)
  })
})
