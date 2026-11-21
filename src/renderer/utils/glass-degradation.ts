/**
 * 玻璃效果自动降级（2026-11-20 视图闪屏软件渲染自动降级 N1）。
 *
 * 软件渲染（GPU 兼容档位 ≥1 或硬件加速被禁用）下，液态玻璃 SVG 折射 + 氛围层
 * 动画在纯 CPU 合成下逐帧全量重光栅 backdrop-filter 区域，是故障机（level2）
 * 滚动白闪/黑闪的头号负载源。glass-lite 降级链（globals.css）早已存在，本模块
 * 补上缺失的「能力检测 ⇒ 自动触发」接线：App 启动与设置页共用同一决策入口。
 *
 * 探针 fail-open：getGpuStatus 失败/缺失一律视为硬件健康，绝不因探针失败
 * 改变用户视觉设置。档位每次启动固定，探测结果会话级缓存。
 */

let softwareRendering: boolean | null = null

/** 探测本次启动是否处于软件渲染（结果缓存；fail-open false） */
export async function detectSoftwareRendering(): Promise<boolean> {
  if (softwareRendering !== null) return softwareRendering
  try {
    const status = await window.electronAPI?.app?.getGpuStatus?.()
    softwareRendering = Boolean(
      status &&
      (status.hardwareAcceleration?.enabled === false || (status.fallback?.compatLevel ?? 0) >= 1)
    )
  } catch {
    softwareRendering = false
  }
  return softwareRendering
}

/** 玻璃档位统一决策：用户 lite 档或软件渲染强制降级，均挂 html.glass-lite */
export function applyGlassMode(effect: string): void {
  document.documentElement.classList.toggle(
    'glass-lite',
    effect === 'lite' || softwareRendering === true
  )
}

/** 测试专用：清空探测缓存（生产代码不得调用） */
export function __resetGlassDegradationForTest(): void {
  softwareRendering = null
}
