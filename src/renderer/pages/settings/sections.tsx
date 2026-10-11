// P2-E：sections.tsx 拆分为多个文件，本文件仅作统一导出入口
// 保持对外导入路径不变（App.tsx 与 SettingsPage.tsx 仍从 './settings/sections' 引入）
// 共享部分（GlobalToastProvider / useGlobalToast / 类型 / 工具函数 / SectionShell）位于 ./shared
// 各分组 Section 组件按功能域拆分到 6 个文件

export { GlobalToastProvider, useGlobalToast } from './shared'
export type { FaultType, FaultRecord, BackupRecord, CrashRecord } from './shared'

export {
  GeneralStartupSection,
  GeneralFileOpsSection,
  GeneralExportSection
} from './general-sections'
export { AppearanceThemeSection, AppearanceDisplaySection } from './appearance-sections'
export {
  ScanPathsSection,
  ScanOptionsSection,
  ImportRootsSection,
  GameRootsSection,
  ScanFallbackSection
} from './scan-sections'
export { ProfileManageSection } from './profile-sections'
export { DataBackupSection, DataCacheSection, DataClearSection } from './data-sections'
export { DiagnosticsLogsSection, DiagnosticsCrashSection } from './diagnostics-sections'
export { ScanLogDiagnosticSection } from './scan-log-diagnostic-section'
export { AboutInfoSection, AboutContactSection, AboutLicenseSection } from './about-sections'
// P2-01：语言设置区块
export { LanguageSection } from './language-sections'
// 分享码工具区块
export { ToolsShareCodeSection } from './tools-sections'
// 插件管理区块
export { PluginManageSection } from './plugin-sections'
// sync-integration 阶段5：同步服务区块（开关/状态/配对二维码/设备管理）
export { SyncServiceSection } from './sync-sections'
