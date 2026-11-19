import React from 'react'
import { SyncConsoleLayout } from './console/SyncConsoleLayout'

/**
 * T1：同步服务页装配壳——上游 NikkiSync PC 端同款控制台。
 *
 * 原单页长滚动布局已按上游 DesktopPage 的五视图 IA 拆分至 console/：
 * - Connect（服务状态/配对/设备/微信/Android/自查）→ console/ConnectView
 * - Settings（连接/目录/账号/同意/启动/外壳开关/网络/热点/法律）→ console/SettingsView
 * - Organizer（K8 最近删除队列）→ console/OrganizerView
 * - Inspiration（灵感库，复用 SyncInspirationPanel）→ console/InspirationView
 * - About（版本/下载/仓库/署名）→ console/AboutView
 * 底栏（双版本/重启/导出诊断）→ console/SyncStatusBar。
 *
 * 导出名与懒加载路径保持不变（App.tsx 零改动）；行为判据随断言迁至
 * console/ 下按视图套件（原判据不重写），本文件只保留装配冒烟。
 */
export const SyncServicePage: React.FC = () => {
  return <SyncConsoleLayout />
}
