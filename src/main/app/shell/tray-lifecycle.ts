/** Module-level tray handle so startup/shutdown can create and destroy exactly one instance. */

export interface TrayHandleLike {
  notify(title: string, body: string): void
  dispose(): void
}

let handle: TrayHandleLike | undefined

/** When disabled, destroy any existing tray and never invoke the factory. */
export async function syncTray(
  enabled: boolean,
  factory: () => TrayHandleLike | Promise<TrayHandleLike>
): Promise<boolean> {
  if (!enabled) {
    disposeTray()
    return false
  }
  if (handle) return true
  handle = await factory()
  return true
}

export function disposeTray(): boolean {
  if (!handle) return false
  const current = handle
  handle = undefined
  current.dispose()
  return true
}

/** F2：托盘句柄的真实观测（不是设置开关）；供 shell-status 如实透出。 */
export function isTrayActive(): boolean {
  return handle !== undefined
}
