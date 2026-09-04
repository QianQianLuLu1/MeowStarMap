import React from 'react'
import { useTranslation } from 'react-i18next'
import { AnimatePresence, motion } from 'motion/react'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { fadeVariants, scaleFadeVariants, fastFade, springSoft } from '../../utils/motionPresets'
import { IconClose } from '../../icons'
import { IconButton } from './IconButton'

type DialogSize = 'sm' | 'md' | 'lg' | 'xl'

const SIZE_CLASS: Record<DialogSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl'
}

interface BaseDialogProps {
  open: boolean
  onClose: () => void
  children: React.ReactNode
  /** 卡片最大宽度档位，默认 md */
  size?: DialogSize
  /** 初始聚焦元素 ref（不传则聚焦第一个可聚焦元素） */
  // React 19 的 useRef<T>(null) 返回 RefObject<T | null>，故需接受 null 联合类型
  initialFocusRef?: React.RefObject<HTMLElement | null>
  /** aria-labelledby 的 id */
  ariaLabelledby?: string
  /** 点击遮罩是否关闭，默认 true */
  closeOnOverlayClick?: boolean
  /** 是否启用焦点陷阱，默认 true（FeedbackDialog 等历史组件迁移后统一启用） */
  trapFocus?: boolean
  /** 自定义卡片 className（追加到默认类之后，用于 max-h、overflow 等） */
  cardClassName?: string
  /** 自定义遮罩 className（追加到默认类之后） */
  overlayClassName?: string
  /** P1-U2：遮罩背景色，默认 var(--overlay-bg)；批量操作/重要操作可传 var(--overlay-bg-strong) 增强视觉对比 */
  overlayBackground?: string
  /** 标题：传入后自动渲染 Header（标题文字 + 右上角关闭按钮）
   *  不传时调用方需自行渲染 Header（向后兼容历史调用方） */
  title?: string
  /** 底部内容：传入后自动渲染 Footer（如确认/取消按钮组）
   *  不传时调用方需自行渲染 Footer（向后兼容历史调用方） */
  footer?: React.ReactNode
  /** 标题区域自定义渲染（覆盖 title 字符串，用于含图标/链接的复杂标题） */
  headerExtra?: React.ReactNode
}

/**
 * P1-U13：对话框公共骨架
 *
 * 封装 5 个 Dialog 重复的模板逻辑：
 * - AnimatePresence + motion 双层结构（遮罩 fade + 卡片 scaleFade）
 * - useFocusTrap 焦点陷阱 + Esc 关闭 + 焦点恢复
 * - 遮罩点击关闭 + 内容点击阻止冒泡
 * - 统一 z-index、overlay 背景、glass-card 卡片样式、motion 预设
 *
 * 扩展：可选 title / footer prop，自动渲染 Header（标题 + 关闭按钮）/ Footer（按钮组），
 * 消除 ShortcutsModal / ImportWizard / WatermarkDialog 等 11 处重复的手写 Header/Footer 模板。
 *
 * 调用方仅需传入 children（卡片内容）和必要的回调。
 *
 * 使用方式：
 *   // 简单模式（向后兼容，不传 title/footer）
 *   <BaseDialog open={open} onClose={onClose}>
 *     <p>自定义内容</p>
 *   </BaseDialog>
 *
 *   // 完整模式（推荐新代码用）
 *   <BaseDialog
 *     open={open}
 *     onClose={onClose}
 *     title="编辑名称"
 *     footer={
 *       <DialogFooter onCancel={onClose} onConfirm={handleSave} />
 *     }
 *   >
 *     <input ... />
 *   </BaseDialog>
 */
export const BaseDialog: React.FC<BaseDialogProps> = ({
  open,
  onClose,
  children,
  size = 'md',
  initialFocusRef,
  ariaLabelledby,
  closeOnOverlayClick = true,
  trapFocus = true,
  cardClassName = '',
  overlayClassName = '',
  overlayBackground = 'var(--overlay-bg)',
  title,
  footer,
  headerExtra
}) => {
  // trapFocus=false 时不启用焦点陷阱（极少数场景：对话框内含需外部焦点的控件）
  const overlayRef = useFocusTrap<HTMLDivElement>({
    active: open && trapFocus,
    onEscape: onClose,
    initialFocusRef
  })
  const { t } = useTranslation()

  const handleOverlayClick = closeOnOverlayClick ? onClose : undefined

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={trapFocus ? overlayRef : undefined}
          variants={fadeVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          transition={fastFade}
          role="dialog"
          aria-modal="true"
          aria-labelledby={ariaLabelledby}
          className={`fixed inset-0 z-[100] flex items-center justify-center ${overlayClassName}`}
          style={{ background: overlayBackground }}
          onClick={handleOverlayClick}
        >
          <motion.div
            variants={scaleFadeVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={springSoft}
            className={`glass-card p-6 w-full ${SIZE_CLASS[size]} mx-4 space-y-4 ${cardClassName}`}
            onClick={(e) => e.stopPropagation()}
          >
            {title && (
              <div className="flex items-center justify-between">
                <h3
                  className="text-base font-medium"
                  style={{ color: 'var(--text-primary)' }}
                  id={ariaLabelledby}
                >
                  {title}
                </h3>
                <div className="flex items-center gap-2">
                  {headerExtra}
                  <IconButton aria-label={t('common.close')} onClick={onClose}>
                    <IconClose size={18} />
                  </IconButton>
                </div>
              </div>
            )}
            {children}
            {footer && <div className="flex justify-end gap-3 pt-2">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
