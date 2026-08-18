/**
 * 解密网络解码子进程入口（utilityProcess）
 *
 * FIX(组17-1)：cloth_diy_decode_network / home_build_decode_network 是同步、无超时、
 * 内部做真实网络 I/O 的 FFI——原先在主进程全局 mutex 内执行，网络慢/被墙时冻结整个
 * 主进程事件循环并拖垮照片参数解密。本进程把网络解码整体隔离：冻结只发生在本进程，
 * 主进程侧由 bridge 用 8s Promise.race 硬超时兜底并 kill 本进程。
 *
 * 自包含约束：不得 import decryption-service / electron——utilityProcess 内 electron
 * app 模块不可用，且 service 含全部解密逻辑会把主进程依赖一并拖入。koffi 结构定义与
 * 主进程重复是刻意的：两个进程各持独立 koffi 注册表，无命名冲突。
 *
 * 与 media worker 的关键差异：WORKER_READY 推迟到 DECRYPT_WORKER_INIT 完成 DLL 加载 +
 * ABI 校验后才发送，DLL 加载失败会被主进程 15s 握手超时捕获而非"假就绪"。
 */
import koffi from 'koffi'
import type {
  DecryptionWorkerCommand,
  DecryptionWorkerEvent,
  NetworkDecodeKind
} from './worker-protocol'

// ============================================================
// 常量与 C 类型定义（与 nuan5_decryption_ffi.h 一一对应）
// ============================================================

const EXPECTED_ABI_VERSION = 1

const CBytes = koffi.struct('CBytes', {
  data: koffi.pointer('uint8_t'),
  len: 'size_t',
  cap: 'size_t'
})

const ClothDiyDecryptionResult = koffi.struct('ClothDiyDecryptionResult', {
  status: 'uint32_t',
  bytes: CBytes
})

const HomeBuildDecryptionResult = koffi.struct('HomeBuildDecryptionResult', {
  status: 'uint32_t',
  bytes: CBytes
})

// 分享码是不透明指针类型（C 中为 typedef struct）
const ClothDiyShareCodePtr = koffi.pointer('void')
const HomeBuildShareCodePtr = koffi.pointer('void')

// DLL 返回的无效分享码 status（与主进程 STATUS_MESSAGES 对应：8=InvalidClothDiyShareCode, 11=InvalidHomeBuildShareCode）
const STATUS_INVALID_CLOTHDIY = 8
const STATUS_INVALID_HOMEBUILD = 11
// 子进程内 JS 异常的合成 status（DLL 状态码均为正数，-1 不会与之冲突）
const STATUS_JS_ERROR = -1

interface BoundFunctions {
  clothDiyShareCodeFromCodeStr: koffi.KoffiFunction
  clothDiyDecodeNetwork: koffi.KoffiFunction
  freeClothDiyShareCode: koffi.KoffiFunction
  homeBuildShareCodeFromCodeStr: koffi.KoffiFunction
  homeBuildDecodeNetwork: koffi.KoffiFunction
  freeHomeBuildShareCode: koffi.KoffiFunction
  freeCBytes: koffi.KoffiFunction
}

interface CBytesLike {
  data: koffi.PointerObject
  len: number
  cap: number
}

let lib: koffi.IKoffiLib | null = null
let boundFns: BoundFunctions | null = null

// ============================================================
// 进程内 mutex：串行化所有 DLL 调用，避免并发操作 C 内存 use-after-free
// ============================================================

let mutexChain: Promise<unknown> = Promise.resolve()

async function withMutex<T>(task: () => T | Promise<T>): Promise<T> {
  const next = mutexChain.then(() => task())
  // 忽略当前任务的错误，避免一次失败阻塞后续调用
  mutexChain = next.catch(() => {})
  return next
}

// ============================================================
// 基础设施
// ============================================================

function sendEvent(event: DecryptionWorkerEvent): void {
  try {
    process.parentPort?.postMessage(event)
  } catch {
    /* 主进程已退出时忽略 */
  }
}

function workerLog(level: 'warn' | 'error', message: string): void {
  sendEvent({ type: 'DECRYPT_WORKER_LOG', payload: { level, message } })
}

/** DLL 加载 + ABI 校验 + 一次性函数绑定（INIT 时调用） */
function initDll(dllPath: string): void {
  lib = koffi.load(dllPath)

  const ver = (lib.func('abi_version', 'uint32_t', []) as koffi.KoffiFunction)() as number
  if (ver !== EXPECTED_ABI_VERSION) {
    try {
      lib.unload()
    } catch {
      /* ignore */
    }
    lib = null
    throw new Error(`ABI version mismatch: actual=${ver} expected=${EXPECTED_ABI_VERSION}`)
  }

  boundFns = {
    clothDiyShareCodeFromCodeStr: lib.func(
      'cloth_diy_share_code_from_code_str',
      ClothDiyShareCodePtr,
      ['string']
    ) as koffi.KoffiFunction,
    clothDiyDecodeNetwork: lib.func('cloth_diy_decode_network', ClothDiyDecryptionResult, [
      ClothDiyShareCodePtr
    ]) as koffi.KoffiFunction,
    freeClothDiyShareCode: lib.func('free_cloth_diy_share_code', 'void', [
      ClothDiyShareCodePtr
    ]) as koffi.KoffiFunction,
    homeBuildShareCodeFromCodeStr: lib.func(
      'home_build_share_code_from_code_str',
      HomeBuildShareCodePtr,
      ['string']
    ) as koffi.KoffiFunction,
    homeBuildDecodeNetwork: lib.func('home_build_decode_network', HomeBuildDecryptionResult, [
      HomeBuildShareCodePtr
    ]) as koffi.KoffiFunction,
    freeHomeBuildShareCode: lib.func('free_home_build_share_code', 'void', [
      HomeBuildShareCodePtr
    ]) as koffi.KoffiFunction,
    freeCBytes: lib.func('free_c_bytes', 'void', [CBytes]) as koffi.KoffiFunction
  }
}

function readCBytesToUtf8(bytes: CBytesLike): string {
  if (!bytes.data || bytes.len === 0) return ''
  const raw = koffi.decode(bytes.data, 'uint8_t', bytes.len) as number[]
  return Buffer.from(raw).toString('utf-8')
}

/** 单次网络解码（在 mutex 内同步执行；任何异常都转成合成 status 回传，不让进程退出） */
function decodeNetworkSync(
  kind: NetworkDecodeKind,
  codeStr: string
): { status: number; networkData?: string; errorMessage?: string } {
  if (!boundFns) {
    return { status: STATUS_JS_ERROR, errorMessage: 'DLL 未初始化（INIT 未完成）' }
  }
  const fns = boundFns
  let shareCode: koffi.PointerObject | null = null
  try {
    shareCode = (
      kind === 'clothDiy'
        ? fns.clothDiyShareCodeFromCodeStr(codeStr)
        : fns.homeBuildShareCodeFromCodeStr(codeStr)
    ) as koffi.PointerObject
    if (!shareCode) {
      return { status: kind === 'clothDiy' ? STATUS_INVALID_CLOTHDIY : STATUS_INVALID_HOMEBUILD }
    }

    const result = (
      kind === 'clothDiy'
        ? fns.clothDiyDecodeNetwork(shareCode)
        : fns.homeBuildDecodeNetwork(shareCode)
    ) as { status: number; bytes: CBytesLike }

    let networkData: string | undefined
    if (result.status === 0) {
      networkData = readCBytesToUtf8(result.bytes)
    }
    try {
      fns.freeCBytes(result.bytes)
    } catch {
      /* ignore */
    }
    return networkData !== undefined ? { status: 0, networkData } : { status: result.status }
  } catch (err) {
    workerLog('error', `NETWORK_DECODE 异常: ${err instanceof Error ? err.message : String(err)}`)
    return {
      status: STATUS_JS_ERROR,
      errorMessage: err instanceof Error ? err.message : String(err)
    }
  } finally {
    if (shareCode) {
      try {
        if (kind === 'clothDiy') fns.freeClothDiyShareCode(shareCode)
        else fns.freeHomeBuildShareCode(shareCode)
      } catch {
        /* ignore */
      }
    }
  }
}

function handleNetworkDecode(payload: {
  requestId: string
  kind: NetworkDecodeKind
  codeStr: string
}): void {
  // 解码调用本身必须在 mutex 串行链内执行，避免并发操作 C 内存
  void withMutex(() => {
    const result = decodeNetworkSync(payload.kind, payload.codeStr)
    sendEvent({
      type: 'NETWORK_DECODE_RESULT',
      payload: { requestId: payload.requestId, ...result }
    })
  })
}

function cleanupAndExit(exitCode: number): void {
  if (lib) {
    try {
      lib.unload()
    } catch {
      /* ignore */
    }
    lib = null
    boundFns = null
  }
  process.exit(exitCode)
}

// ============================================================
// 消息入口
// ============================================================

// 参数类型写最小结构 { data: unknown }：Node MessageEvent 与 lib.dom.d.ts 冲突（同 media-worker）
process.parentPort?.on('message', (event: { data: unknown }) => {
  const msg = event.data as DecryptionWorkerCommand
  switch (msg.type) {
    case 'DECRYPT_WORKER_INIT': {
      try {
        initDll(msg.payload.dllPath)
        // READY 必须在 DLL 加载 + ABI 校验成功后发送（见文件头注释）
        sendEvent({ type: 'WORKER_READY' })
      } catch (err) {
        workerLog('error', `DLL 初始化失败: ${err instanceof Error ? err.message : String(err)}`)
        sendEvent({
          type: 'WORKER_ERROR',
          payload: {
            message: `DLL 初始化失败: ${err instanceof Error ? err.message : String(err)}`
          }
        })
        cleanupAndExit(1)
      }
      break
    }

    case 'NETWORK_DECODE': {
      handleNetworkDecode(msg.payload)
      break
    }

    case 'DECRYPT_WORKER_DISPOSE': {
      cleanupAndExit(0)
      break
    }
  }
})

// 致命异常兜底：exit(1) 让主进程 bridge 判定为崩溃并按重启策略恢复
process.on('uncaughtException', (err) => {
  sendEvent({
    type: 'WORKER_ERROR',
    payload: { message: err instanceof Error ? err.message : String(err) }
  })
  cleanupAndExit(1)
})

process.on('unhandledRejection', (reason) => {
  sendEvent({
    type: 'WORKER_ERROR',
    payload: {
      message: `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`
    }
  })
  cleanupAndExit(1)
})

// exit 回调只清资源，不得再调 process.exit（退出码已定）
process.on('exit', () => {
  if (lib) {
    try {
      lib.unload()
    } catch {
      /* ignore */
    }
  }
})
