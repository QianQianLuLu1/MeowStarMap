// 操作历史命名空间：对应主进程 handlers/operation-history-handler.ts 注册的 operation-history:* 通道
import { call } from '../ipc'
import type { OperationHistoryListResult } from '../../../shared/types/electron-api'

/** electronAPI.operationHistory：建议改#9——操作历史持久化（支持跨重启撤销） */
export const operationHistoryAPI = {
  add: (record: {
    operationType: string
    mediaId?: number
    payload: unknown
    description: string
    createdAt: string
  }) => call<{ id: number }>('operation-history:add', record),
  list: (limit: number = 50) => call<OperationHistoryListResult>('operation-history:list', limit),
  remove: (id: number) => call<{ removed: boolean }>('operation-history:remove', id),
  clear: () => call<{ cleared: boolean }>('operation-history:clear'),
  // R8：撤销前乐观锁冲突检测
  checkConflict: (operationId: number) =>
    call<{ conflict: boolean; reason: string }>('operation-history:checkConflict', operationId)
}
