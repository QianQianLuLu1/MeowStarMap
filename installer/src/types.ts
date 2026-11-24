export type InstallerMode = 'install' | 'upgrade' | 'repair' | 'uninstall'

export interface InstallerState {
  installed: boolean
  version: string | null
  installDir: string | null
  appRunning: boolean
  mode: InstallerMode
  payloadPath: string | null
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
