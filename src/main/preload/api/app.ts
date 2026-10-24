// @core-change: 暴露 app.getGpuStatus()（app:gpu-status 只读探针，诊断面板用）
// 应用控制命名空间：对应主进程 handlers/app-handler.ts 注册的 app:* 通道
import { call, subscribe } from '../ipc'
import type { UpdatePayload, GpuStatusSummary } from '../../../shared/types/electron-api'

/** electronAPI.app：应用重启 / 版本 / 自动更新 / GPU 状态 */
export const appAPI = {
  relaunch: () => call<{ relaunching: boolean }>('app:relaunch'),
  // 需求五.2：以管理员权限重启（扫描目录权限不足 E003 时使用）
  relaunchAsAdmin: () => call<{ ok: boolean }>('app:relaunchAsAdmin'),
  // U1：获取应用版本号，避免渲染层硬编码
  getVersion: () => call<string>('app:getVersion'),
  // GPU 状态只读探针：硬件加速开关态/活动显卡/特性降级/独显偏好（2026-10 硬件加速优化）
  getGpuStatus: () => call<GpuStatusSummary>('app:gpu-status'),
  // 自动更新：手动触发检查（生产环境有效，dev 下主进程 no-op）
  checkUpdate: () => call<{ checking: boolean }>('app:update:check'),
  // 自动更新：用户确认后开始下载
  downloadUpdate: () => call<{ downloading: boolean }>('app:update:download'),
  // 自动更新：用户确认「安装并重启」
  installUpdate: () => call<{ installing: boolean }>('app:update:install'),
  // 自动更新：订阅主进程推送的更新状态/进度事件
  onUpdate: (callback: (payload: UpdatePayload) => void) => subscribe('app:update', callback)
}
