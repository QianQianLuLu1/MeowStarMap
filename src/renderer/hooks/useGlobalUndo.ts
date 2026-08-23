import { useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useOperationHistoryStore } from '../stores/operationHistoryStore'
import { useUIStore } from '../stores/uiStore'
import { useToast } from './useToast'

/**
 * F-S8：全局撤销 hook。
 * 在 App 顶层注册，监听 Ctrl+Z / Cmd+Z 全局快捷键，触发栈顶操作回滚。
 *
 * 设计要点：
 * 1. 仅在非编辑器视图生效（编辑器内的撤销由 useEditorShortcuts 处理 AdjustmentState）
 * 2. 输入框聚焦时跳过（避免与文本输入撤销冲突）
 * 3. 撤销后通过 Toast 显示"已撤销 xxx"，并提供"重做"提示
 *
 * 注意：本 hook 仅处理"全局操作历史"（文件操作/元数据变更），
 * 图片编辑参数的撤销重做由 useEditHistory 单独管理。
 */
export function useGlobalUndo(): void {
  const currentView = useUIStore((s) => s.currentView)
  const { showMessage } = useToast()
  const { t } = useTranslation()

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // 仅处理 Ctrl+Z / Cmd+Z（无 Shift 为撤销）
      const isUndoShortcut = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey
      if (!isUndoShortcut) return

      // 编辑器视图跳过（由 useEditorShortcuts 接管）
      if (currentView === 'editor') return

      // 输入框聚焦时跳过
      const target = e.target as HTMLElement
      if (target) {
        const tag = target.tagName.toLowerCase()
        if (tag === 'input' || tag === 'textarea' || target.isContentEditable) return
      }

      // 阻止浏览器默认撤销行为
      e.preventDefault()
      e.stopPropagation()

      // 建议改#5：在回调内通过 getState() 读取最新栈，避免订阅 stack 导致
      // 每次 push/undo 都重建 handleKeyDown 并重挂 keydown 监听
      const { stack, canUndo, undo } = useOperationHistoryStore.getState()
      if (!canUndo()) {
        showMessage(t('toast.undo.none'), 'info')
        return
      }

      // 取栈顶操作的描述用于 Toast 提示
      const top = stack[stack.length - 1]
      void undo().then(async (result) => {
        if (result.success) {
          showMessage(t('toast.undo.undone', { description: top.description }), 'success')
        } else if (result.conflict) {
          // R8：乐观锁冲突——弹窗确认后强制撤销
          if (window.confirm(result.message || t('toast.undo.conflictPrompt'))) {
            const forceResult = await undo({ force: true })
            if (forceResult.success) {
              showMessage(t('toast.undo.undone', { description: top.description }), 'success')
            } else {
              showMessage(forceResult.message || t('toast.undo.failed'), 'error')
            }
          }
        } else {
          showMessage(result.message || t('toast.undo.failed'), 'error')
        }
      })
    },
    [currentView, showMessage, t]
  )

  useEffect(() => {
    // 捕获阶段注册，优先于组件级快捷键
    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [handleKeyDown])
}
