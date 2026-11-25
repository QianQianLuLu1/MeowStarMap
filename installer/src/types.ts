export type InstallerMode = 'install' | 'upgrade' | 'repair' | 'uninstall'

export interface InstallerState {
  installed: boolean
  version: string | null
  installDir: string | null
  appRunning: boolean
  mode: InstallerMode
  payloadPath: string | null
  /** 是否由更新流程/命令行以静默模式启动（/S、--silent、-s） */
  silent: boolean
}

export interface InstallOptions {
  installDir: string
  createDesktopShortcut: boolean
  importCertificate: boolean
}

export interface InstallSummary {
  ok: boolean
  mode: InstallerMode
  installDir: string
  version: string
  steps: string[]
  warnings: string[]
}
