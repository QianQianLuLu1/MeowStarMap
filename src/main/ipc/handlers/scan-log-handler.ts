/**
 * 扫描诊断日志域 IPC handler。
 *
 * 暴露两个只读通道供诊断工具页回放全链路扫描日志：
 * - scan:getScanLog：返回本次（或全部）扫描的结构化诊断条目
 * - scan:clearScanLog：清空内存缓冲区（不影响当前正在进行的扫描）
 *
 * 五要素：
 * - 依赖声明：复用 scanLogStore（主进程单例），无新增依赖。
 * - 启动说明：由 setupIPC 调用 registerScanLogHandlers 注册，无副作用。
 * - 错误处理：通道为只读查询，异常由 wrapHandlerNoArgs 统一兜底。
 * - 参数校验：两通道均无入参，使用 wrapHandlerNoArgs。
 * - 基础测试：随 scan-log-store.test.ts 覆盖仓库逻辑；本 handler 仅做转发。
 */
import type { HandlerContext } from '../handler-context'
import { wrapHandlerNoArgs } from '../validator'
import { scanLogStore } from '../../scanner/scan-log-store'

export function registerScanLogHandlers(_ctx: HandlerContext): void {
  wrapHandlerNoArgs('scan:getScanLog', () => scanLogStore.getEntries())
  wrapHandlerNoArgs('scan:clearScanLog', () => {
    scanLogStore.clear()
    return { ok: true }
  })
}
