import React from 'react'
import { useTranslation } from 'react-i18next'
import { AnimatePresence, motion } from 'motion/react'
import type { ToastMessage } from '../../hooks/useToast'
import { IconClose } from '../../icons'
// P1-2：使用统一动画预设
import { slideUpVariants, springSoft } from '../../utils/motionPresets'

interface ToastProps {
  /** U-G3：支持堆叠的多条消息 */
  messages: ToastMessage[]
  /** U-G3：手动关闭回调 */
  onDismiss?: (id: string) => void
  className?: string
  /** 容器 z-index 覆盖（FullscreenViewer 等需要更高层级） */
  zIndex?: number
}

/**
 * Toast 组件：支持 success/error/info 三种类型，堆叠显示，入场+退出动画，手动关闭。
 * 仿 iOS 通知风格：圆角卡片 + 毛玻璃背景 + 轻阴影，右下角悬浮，从下方滑入。
 * P1-2：使用 motion AnimatePresence 实现平滑退出动画，替代 CSS toast-enter/toastOut。
 */
export const Toast: React.FC<ToastProps> = ({
  messages,
  onDismiss,
  className = '',
  zIndex = 50
}) => {
  const { t } = useTranslation()
  return (
    <div
      className={`fixed bottom-6 right-6 flex flex-col gap-2 max-w-md ${className}`}
      style={{ zIndex }}
    >
      <AnimatePresence>
        {messages.map((msg) => {
          // P1-U6：Toast 三态背景色改用 CSS 变量，主题可覆盖
          const bgColor =
            msg.type === 'error'
              ? 'var(--toast-error-bg)'
              : msg.type === 'info'
                ? 'var(--toast-info-bg)'
                : 'var(--toast-success-bg)'

          return (
            <motion.div
              key={msg.id}
              variants={slideUpVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={springSoft}
              layout="position"
              className="px-4 py-3 rounded-xl text-sm font-medium flex items-center gap-3"
              style={{
                background: bgColor,
                color: 'white',
                backdropFilter: 'var(--backdrop-blur)',
                WebkitBackdropFilter: 'var(--backdrop-blur)',
                boxShadow: 'var(--shadow-md)'
              }}
              role={msg.type === 'error' ? 'alert' : 'status'}
              aria-live={msg.type === 'error' ? 'assertive' : 'polite'}
            >
              <span className="flex-1">{msg.text}</span>
              {msg.action && (
                <button
                  className="px-2.5 py-1 text-xs font-semibold rounded-md transition-all hover:scale-105"
                  style={{
                    background: 'rgba(255, 255, 255, 0.2)',
                    color: 'white'
                  }}
                  onClick={() => {
                    void msg.action?.onClick()
                    // 点击动作按钮后自动关闭
                    onDismiss?.(msg.id)
                  }}
                >
                  {msg.action.label}
                </button>
              )}
              {onDismiss && (
                <button
                  className="ml-1 opacity-70 hover:opacity-100 transition-opacity flex-shrink-0"
                  onClick={() => onDismiss(msg.id)}
                  aria-label={t('common.close')}
                >
                  <IconClose size={14} />
                </button>
              )}
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
}
