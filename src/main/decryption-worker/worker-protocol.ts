/**
 * 解密网络解码子进程消息协议（主↔子进程）
 *
 * 职责边界（FIX 组17-1）：
 * - 主进程 decryption-service 在全局 mutex 内只做本地 C 内存提取（from_code_str/timestamp/uid/server）
 * - 同步网络 FFI（cloth_diy_decode_network / home_build_decode_network）整体下沉到本子进程，
 *   网络慢/被墙时只冻结子进程，主进程事件循环与照片参数解密不受影响
 *
 * 与 media/scanner worker 协议的关键差异：
 * - 请求/响应语义（NETWORK_DECODE → NETWORK_DECODE_RESULT 按 requestId 关联），类似 thumbnail worker
 * - WORKER_READY 推迟到 DECRYPT_WORKER_INIT 完成 DLL 加载 + ABI 校验之后才发送：
 *   DLL 加载失败也能被主进程 15s 握手超时捕获并走崩溃通知，而不是"假就绪"
 * - 子进程内同步 FFI 冻结期间收不到任何消息，硬超时（8s）由主进程侧 Promise.race 兜底
 */

/** 网络解码类型：染色分享码 / 家园建造分享码 */
export type NetworkDecodeKind = 'clothDiy' | 'homeBuild'

/** 主进程 → 子进程命令 */
export type DecryptionWorkerCommand =
  | { type: 'DECRYPT_WORKER_INIT'; payload: { dllPath: string } }
  | {
      type: 'NETWORK_DECODE'
      payload: { requestId: string; kind: NetworkDecodeKind; codeStr: string }
    }
  | { type: 'DECRYPT_WORKER_DISPOSE' }

/** 子进程 → 主进程事件 */
export type DecryptionWorkerEvent =
  | { type: 'WORKER_READY' }
  | {
      type: 'NETWORK_DECODE_RESULT'
      payload: {
        requestId: string
        /** DLL 返回的 status（0=成功）；-1 表示子进程内 JS 异常（见 errorMessage） */
        status: number
        networkData?: string
        errorMessage?: string
      }
    }
  | { type: 'DECRYPT_WORKER_LOG'; payload: { level: 'warn' | 'error'; message: string } }
  | { type: 'WORKER_ERROR'; payload: { message: string } }

/** decodeNetwork 的成功轮次：子进程真实返回 */
export interface NetworkDecodeSuccess {
  ok: true
  status: number
  networkData?: string
  errorMessage?: string
}

/** decodeNetwork 的失败轮次：主进程侧兜底（超时/崩溃/未就绪/已释放），永不 reject */
export type NetworkDecodeFailureReason = 'timeout' | 'worker-crashed' | 'not-ready' | 'disposed'

export interface NetworkDecodeFailure {
  ok: false
  reason: NetworkDecodeFailureReason
}

export type NetworkDecodeResult = NetworkDecodeSuccess | NetworkDecodeFailure
