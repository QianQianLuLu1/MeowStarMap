import React, { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { AnimatePresence, motion } from 'motion/react'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { fastFade, fadeVariants, slideRightVariants, springSoft } from '../../utils/motionPresets'
import { IconClose } from '../../icons'
import { IconButton } from './IconButton'
import { cn } from '../../utils/cn'

export interface DrawerProps {
  open: boolean
  onClose: () => void
  /** 面板标题（右上角自动渲染关闭按钮） */
  title?: string
  /** 面板宽度像素，默认 400 */
  width?: number
  /** 底部操作区（确认/取消按钮组） */
  footer?: React.ReactNode
  /** 初始聚焦元素 ref */
  initialFocusRef?: React.RefObject<HTMLElement | null>
  children: React.ReactNode
  className?: string
}

/**
 * 视觉体系 v3：侧滑抽屉——BaseDialog 的兄弟容器，复用同一套焦点陷阱、
 * 遮罩与 motion 预设，仅将「居中缩放卡片」换成「右侧滑入面板」。
 *
 * 适用：中等复杂度的次级流程（批量重命名预览、插件详情、属性编辑等），
 * 弹窗直径过大或需要保持页面上下文时优先用抽屉。
 *
 * 无障碍：role="dialog" + aria-modal，焦点圈闭于面板内，Esc 关闭，关闭后焦点恢复。
 */
export const Drawer: React.FC<DrawerProps> = ({
  open,
  onClose,
  title,
  width = 400,
  footer,
  initialFocusRef,
  children,
  className
}) => {
  const overlayRef = useFocusTrap<HTMLDivElement>({
    active: open,
    onEscape: onClose,
    initialFocusRef
  })
  const { t } = useTranslation()
  // useId 保证多 Drawer 并开时 aria-labelledby 不串号（硬编码 id 会在双开时交叉解析）
  const titleId = useId()

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={overlayRef}
          variants={fadeVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          transition={fastFade}
          role="dialog"
          aria-modal="true"
          aria-labelledby={title ? titleId : undefined}
          className="fixed inset-0 z-[100] flex justify-end"
          style={{ background: 'var(--overlay-bg)' }}
          onClick={onClose}
        >
          <motion.aside
            variants={slideRightVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={springSoft}
            className={cn(
              'h-full glass-card rounded-none rounded-l-xl flex flex-col overflow-hidden',
              className
            )}
            style={{ width: `${width}px` }}
            onClick={(e) => e.stopPropagation()}
          >
            {title && (
              <div
                className="flex items-center justify-between px-5 py-4 flex-shrink-0"
                style={{ borderBottom: '1px solid var(--divider)' }}
              >
                <h3
                  id={titleId}
                  className="text-base font-medium"
                  style={{ color: 'var(--text-primary)' }}
                >
                  {title}
                </h3>
                <IconButton aria-label={t('common.close')} onClick={onClose}>
                  <IconClose size={18} />
                </IconButton>
              </div>
            )}
            <div className="flex-1 overflow-y-auto p-5">{children}</div>
            {footer && (
              <div
                className="flex justify-end gap-3 px-5 py-4 flex-shrink-0"
                style={{ borderTop: '1px solid var(--divider)' }}
              >
                {footer}
              </div>
            )}
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
