/**
 * P1-1：motion 动画统一预设
 *
 * 所有 motion 动画必须使用此处导出的预设，禁止在组件内硬编码 transition/variants，
 * 确保全局动画风格一致（Windows 11 Fluent Design 轻动效）。
 *
 * 导入路径统一为 'motion/react'（motion@12 即 framer-motion 新版包名）
 */

import type { Variants, Transition } from 'motion/react'

// ============ 过渡预设 ============

/**
 * 柔和弹簧：按钮悬停、卡片上浮、对话框开关
 * stiffness 300 + damping 30 = 平稳无过冲，接近 Windows 11 Fluent 连接动画
 */
export const springSoft: Transition = {
  type: 'spring',
  stiffness: 300,
  damping: 30,
  mass: 0.8
}

/**
 * 弹性弹簧：拖拽回弹、活泼交互
 * stiffness 400 + damping 15 = 轻微过冲，增加趣味性
 */
export const springBouncy: Transition = {
  type: 'spring',
  stiffness: 400,
  damping: 15,
  mass: 0.5
}

/**
 * 快速淡入淡出：适用于遮罩层等不需要位移的元素
 */
export const fastFade: Transition = {
  duration: 0.2,
  ease: [0.4, 0, 0.2, 1]
}

// ============ 变体预设 ============

/**
 * 简单淡入淡出
 */
export const fadeVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 }
}

/**
 * 缩放淡入淡出：对话框、弹窗
 * scale 0.95→1 配合弹簧过渡，营造从中心展开的效果
 */
export const scaleFadeVariants: Variants = {
  initial: { opacity: 0, scale: 0.95 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.95 }
}

/**
 * 从下方滑入：Toast、底部出现元素
 * y 20px 偏移配合弹簧过渡
 */
export const slideUpVariants: Variants = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 20 }
}

/**
 * 从右侧滑入：侧边面板、抽屉
 * x 40px 偏移配合柔和弹簧
 */
export const slideRightVariants: Variants = {
  initial: { opacity: 0, x: 40 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: 40 }
}
