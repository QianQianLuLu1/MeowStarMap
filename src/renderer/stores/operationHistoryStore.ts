import { create } from 'zustand'
import i18n from '../i18n'

/**
 * F-S8：全局操作历史类型。
 * 建议改#9：持久化到数据库 operation_history 表，支持跨重启撤销。
 * undoFn 改为按 type 分发的 handler，避免闭包捕获运行时引用。
 */
export type OperationType =
  | 'file_move'
  | 'file_rename'
  | 'file_copy'
  | 'media_soft_delete'
  | 'media_restore'
  | 'favorite_toggle'
  | 'rating_update'
  | 'category_update'
  | 'tags_update'
  | 'notes_update'

/**
 * 撤销处理器：按 type 分发，在 useFileOperations 中注册。
 * 避免原 undoFn 闭包捕获 onRefreshMedia/updateMediaFile 等运行时引用。
 */
export type UndoHandler = (
  payload: Record<string, unknown>,
  mediaId?: string
) => Promise<{ success: boolean; message?: string }>

export interface OperationRecord {
  /** 前端生成的唯一 ID（时间戳+随机数），不依赖数据库自增 ID */
  localId: string
  /** 数据库自增 ID，用于撤销后从数据库删除 */
  dbId?: number
  /** 操作类型 */
  type: OperationType
  /** 操作描述，用于 Toast 显示 */
  description: string
  /** 受影响的媒体 ID（字符串形式，与 MediaFile.id 一致） */
  mediaId?: string
  /** 回滚所需的状态信息（结构因操作类型而异） */
  payload: Record<string, unknown>
  /** 操作时间戳 */
  createdAt: number
}

interface OperationHistoryState {
  /** 操作栈（最新操作在末尾） */
  stack: OperationRecord[]
  /** 撤销中标志，避免重入 */
  undoing: boolean
  /** 推入一条操作记录（同步更新内存栈，异步写入数据库） */
  push: (record: Omit<OperationRecord, 'localId' | 'createdAt' | 'dbId'>) => void
  /** 撤销栈顶操作（最新操作）。R8：force=true 跳过乐观锁冲突检测（用户已确认） */
  undo: (options?: { force?: boolean }) => Promise<UndoResult>
  /** 清空操作栈 + 数据库 */
  clear: () => void
  /** 是否可撤销 */
  canUndo: () => boolean
  /** 注册撤销处理器（在 useFileOperations 初始化时调用），返回注销函数 */
  registerUndoHandler: (type: OperationType, handler: UndoHandler) => () => void
  /** 应用启动时从数据库加载 stack */
  loadFromDatabase: () => Promise<void>
}

/** 操作栈上限：与数据库查询 LIMIT 一致 */
const MAX_STACK_SIZE = 50

/** R8：撤销结果类型，新增 conflict 字段供前端弹窗确认 */
export interface UndoResult {
  success: boolean
  message?: string
  /** R8：true 表示检测到乐观锁冲突（媒体已被独立修改），前端应弹窗确认后 force 重新撤销 */
  conflict?: boolean
}

/** 撤销处理器注册表（模块级，避免被 zustand 序列化） */
const undoHandlers = new Map<OperationType, UndoHandler>()

/**
 * P1-F5：数据库写入失败回调（模块级）
 * zustand store 在 React 树外无法调用 useGlobalToast，通过回调注入
 * P1-U8：改为 Set 订阅模式，支持多订阅者，避免静默覆盖
 */
const dbErrorHandlers = new Set<(message: string) => void>()

export function addOperationHistoryErrorHandler(handler: (message: string) => void): void {
  dbErrorHandlers.add(handler)
}

export function removeOperationHistoryErrorHandler(handler: (message: string) => void): void {
  dbErrorHandlers.delete(handler)
}

export const useOperationHistoryStore = create<OperationHistoryState>((set, get) => ({
  stack: [],
  undoing: false,

  push: (record) => {
    const localId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const fullRecord: OperationRecord = {
      ...record,
      localId,
      createdAt: Date.now()
    }
    set((state) => {
      const next = [...state.stack, fullRecord]
      // 超过上限时丢弃最旧的操作（FIFO）
      if (next.length > MAX_STACK_SIZE) {
        next.shift()
      }
      return { stack: next }
    })
    // P1-F5：异步写入数据库，失败时通过回调通知 UI（不静默吞掉）
    // 原实现仅 console.error，违反"错误必须被处理"硬约束
    void window.electronAPI?.operationHistory
      ?.add({
        operationType: fullRecord.type,
        mediaId: fullRecord.mediaId ? Number(fullRecord.mediaId) : undefined,
        payload: fullRecord.payload,
        description: fullRecord.description,
        createdAt: new Date(fullRecord.createdAt).toISOString()
      })
      .then((result) => {
        // call() 成功返回 { id }，失败时抛出 IpcError 由下方 .catch 处理
        if (result.id != null) {
          set((state) => ({
            stack: state.stack.map((r) => (r.localId === localId ? { ...r, dbId: result.id } : r))
          }))
        }
      })
      .catch((err) => {
        console.error(i18n.t('operationHistory.log.dbWriteFailed'), err)
        // P1-F5：通过回调通知 UI，避免静默失败
        const reason = err instanceof Error ? err.message : String(err)
        dbErrorHandlers.forEach((h) =>
          h(i18n.t('operationHistory.error.dbSaveFailedFull', { reason }))
        )
      })
  },

  undo: async (options) => {
    const state = get()
    if (state.undoing || state.stack.length === 0) {
      return { success: false, message: i18n.t('toast.undo.none') }
    }
    const top = state.stack[state.stack.length - 1]
    const handler = undoHandlers.get(top.type)
    if (!handler) {
      return {
        success: false,
        message: i18n.t('operationHistory.error.handlerNotRegistered', { type: top.type })
      }
    }
    // R8：损坏 payload（解析为空对象）拒绝撤销，避免 handler 用空数据覆盖最新状态
    if (Object.keys(top.payload).length === 0) {
      return { success: false, message: i18n.t('operationHistory.error.recordCorrupted') }
    }
    // R8：乐观锁冲突检测——若未强制 force 且记录已入库，比对 snapshot_updated_at 与当前 updated_at
    if (!options?.force && top.dbId != null) {
      try {
        const conflictResult = await window.electronAPI?.operationHistory?.checkConflict(top.dbId)
        if (conflictResult?.success && conflictResult.conflict) {
          return {
            success: false,
            conflict: true,
            message: i18n.t('toast.undo.conflictPrompt')
          }
        }
      } catch (err) {
        // 冲突检测本身失败（IPC 不可用等）不阻塞撤销，仅记录
        console.warn(i18n.t('operationHistory.log.conflictCheckFailed'), err)
      }
    }
    set({ undoing: true })
    try {
      const result = await handler(top.payload, top.mediaId)
      if (result.success) {
        // 撤销成功：从内存栈移除
        set((s) => ({
          stack: s.stack.filter((r) => r.localId !== top.localId),
          undoing: false
        }))
        // 从数据库删除（fire-and-forget）
        if (top.dbId != null) {
          void window.electronAPI?.operationHistory?.remove(top.dbId).catch((err) => {
            console.error(i18n.t('operationHistory.log.dbRemoveFailed'), err)
          })
        }
      } else {
        set({ undoing: false })
      }
      return result
    } catch (error) {
      set({ undoing: false })
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  },

  clear: () => {
    set({ stack: [] })
    void window.electronAPI?.operationHistory?.clear().catch((err) => {
      console.error(i18n.t('operationHistory.log.dbClearFailed'), err)
    })
  },

  canUndo: () => get().stack.length > 0 && !get().undoing,

  registerUndoHandler: (type, handler) => {
    undoHandlers.set(type, handler)
    // P1-C8：返回注销函数，供 useEffect cleanup 调用，避免组件卸载后撤销调用已卸载闭包
    return () => {
      // 仅当当前 handler 仍是注册的那个才删除（防止被后续注册覆盖后误删）
      if (undoHandlers.get(type) === handler) {
        undoHandlers.delete(type)
      }
    }
  },

  loadFromDatabase: async () => {
    try {
      const result = await window.electronAPI?.operationHistory?.list(MAX_STACK_SIZE)
      if (!result || !Array.isArray(result.records)) return
      const records: OperationRecord[] = result.records.map((r) => {
        // payload 可能是 JSON 字符串（数据库存储）或对象
        let payload: Record<string, unknown> = {}
        try {
          payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload
        } catch {
          // 损坏的 payload 用空对象
        }
        return {
          localId: `db-${r.id}`,
          dbId: r.id,
          type: r.operationType as OperationType,
          description: r.description,
          mediaId: r.mediaId != null ? String(r.mediaId) : undefined,
          payload,
          createdAt: new Date(r.createdAt).getTime()
        }
      })
      set({ stack: records })
    } catch (err) {
      console.error(i18n.t('operationHistory.log.dbLoadFailed'), err)
    }
  }
}))
