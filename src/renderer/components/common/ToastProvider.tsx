import React, { useContext, createContext } from 'react'
import { useToast, type ToastType, type ToastMessage } from '../../hooks/useToast'
import { Toast } from './Toast'

// ============ 全局 Toast Context ============
// 视觉体系 v3：从 pages/settings/shared.tsx 迁移至组件层——Toast 是全局反馈设施
// 而非设置页专属，原位置导致 8 个页面文件依赖 settings 目录，模块归属错位。
// pages/settings/shared.tsx 保留 re-export，既有调用点零改动。

type ShowMessageFn = (text: string, type?: ToastType, action?: ToastMessage['action']) => void
const GlobalToastContext = createContext<ShowMessageFn>(() => {})

/**
 * 全局 Toast Provider：在 App.tsx 根节点包裹，让所有页面共享同一个 Toast 实例
 */
export const GlobalToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { messages, showMessage, dismiss } = useToast()
  return (
    <GlobalToastContext.Provider value={showMessage}>
      {children}
      <Toast messages={messages} onDismiss={dismiss} />
    </GlobalToastContext.Provider>
  )
}

/** 全局 Toast Hook，任意页面可调用获取 showMessage */
export function useGlobalToast(): ShowMessageFn {
  return useContext(GlobalToastContext)
}

// 暴露内部 Context 供同目录 Section 组件直接消费（避免重复创建 Context）
export { GlobalToastContext }
