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

// ============ 流体滑块 Tab 指示器（Sidebar 导航切换） ============

/**
 * 流体滑块「前沿」曲线：快出（easeOutQuint 近似）。
 * 朝运动方向的那条边先冲出去，飞行过半即接近终点，与后沿拉开差距形成拉伸。
 */
export const fluidTabLead: [number, number, number, number] = [0.22, 1, 0.36, 1]

/**
 * 流体滑块「后沿」曲线：慢入慢出（easeInOutCubic 近似）。
 * 另一条边滞后跟随，与前沿的差值即拉伸量；两条边终态同时收敛，形变自然回收。
 */
export const fluidTabTrail: [number, number, number, number] = [0.65, 0, 0.35, 1]

/** 流体滑块单次切换时长（秒） */
export const FLUID_TAB_DURATION = 0.42

/**
 * 流体滑块最大拉伸量（px）：长距离跳转（如首项 → 末项）时限制形变上限，
 * 否则拉伸量随距离线性增长会拉出不可接受的超长条。
 */
export const FLUID_TAB_MAX_STRETCH = 28

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

/**
 * 视觉体系 v3：列表级联入场容器——配合 staggerItem 使用，子项依次错峰进入。
 * staggerChildren 间隔 45ms 控制节奏，delayChildren 让容器先落位再带动子项。
 * 仅用于页面级/区块级少量元素（工具栏、信息面板组）；
 * 虚拟列表（Virtuoso/masonic/网格）禁止逐项动画。
 */
export const staggerContainer: Variants = {
  initial: {},
  animate: {
    transition: { staggerChildren: 0.045, delayChildren: 0.06 }
  }
}

/**
 * 视觉体系 v3：列表级联入场子项——上移淡入，复用 springSoft。
 * 必须作为 staggerContainer 的直接 motion 子元素使用。
 */
export const staggerItem: Variants = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: springSoft }
}
