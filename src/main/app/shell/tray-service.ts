/** Electron system tray, injectable so the pure host layer stays testable without Electron. */

export interface TrayLike {
  setToolTip(text: string): void
  setContextMenu(menu: unknown): void
  on(event: string, callback: () => void): void
  destroy(): void
}

export interface TrayElectronApi {
  Tray: new (icon: unknown) => TrayLike
  Menu: { buildFromTemplate(items: unknown[]): unknown }
  nativeImage: { createFromPath(p: string): unknown }
}

export interface TrayHandle {
  notify(title: string, body: string): void
  dispose(): void
}

export function createTray(options: {
  iconPath: string
  onShow: () => void
  onQuit: () => void
  electron: TrayElectronApi
}): TrayHandle {
  let icon: unknown
  try {
    icon = options.electron.nativeImage.createFromPath(options.iconPath)
  } catch {
    icon = options.iconPath
  }
  const tray = new options.electron.Tray(icon)
  tray.setToolTip('MeowStarMap')
  const template: Array<{ label: string; click: () => void }> = [
    { label: 'Show MeowStarMap', click: options.onShow },
    { label: 'Quit MeowStarMap', click: options.onQuit }
  ]
  tray.setContextMenu(options.electron.Menu.buildFromTemplate(template))
  tray.on('double-click', options.onShow)
  let disposed = false
  return {
    notify(_title: string, _body: string): void {
      // Electron's tray balloon API is Windows-only; the event hub carries progress instead.
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      tray.destroy()
    }
  }
}
