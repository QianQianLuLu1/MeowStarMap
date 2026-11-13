/** Opt-in gates, writable icon directories and a disposable event hub for shell capabilities. */
import path from 'node:path'

export const SHELL_SETTING_KEYS = {
  iconUpdate: 'nikkisync.shellIconUpdateEnabled',
  programUpdate: 'nikkisync.shellProgramUpdateEnabled',
  tray: 'nikkisync.shellTrayEnabled',
  support: 'nikkisync.shellSupportEnabled',
  networkRepair: 'nikkisync.shellNetworkRepairEnabled',
  hotspot: 'nikkisync.shellHotspotEnabled'
} as const

export type ShellFeatureKey = keyof typeof SHELL_SETTING_KEYS

export interface ShellSettingsReader {
  getBoolean(key: string, fallback: boolean): boolean
}

export function isShellFeatureEnabled(
  settings: Record<string, boolean> | ShellSettingsReader | undefined,
  key: string
): boolean {
  if (!settings) return false
  if (typeof (settings as ShellSettingsReader).getBoolean === 'function') {
    return (settings as ShellSettingsReader).getBoolean(key, false) === true
  }
  return (settings as Record<string, boolean>)[key] === true
}

export function readShellFlags(settings: ShellSettingsReader): Record<string, boolean> {
  const flags: Record<string, boolean> = {}
  for (const [name, key] of Object.entries(SHELL_SETTING_KEYS)) {
    flags[name] = isShellFeatureEnabled(settings, key)
  }
  return flags
}

/** Deterministic path resolution only; the caller decides whether a writable pack is present. */
export function resolveWritableIconDirs(input: {
  userDataDir: string
  pcAssetsDir: string
  enabled?: boolean
}): { clothingIconsDir: string; photoFilterIconsDir: string; writableDir: string } {
  const root =
    input.enabled === false
      ? input.pcAssetsDir
      : path.join(input.userDataDir, 'nikkisync', 'icon-packs')
  return {
    clothingIconsDir: path.join(root, 'clothing-icons'),
    photoFilterIconsDir: path.join(root, 'photo-filter-icons'),
    writableDir: root
  }
}

export interface ShellEvent {
  readonly type: string
  readonly message?: string
  readonly percent?: number
}

export interface ShellEventHub {
  publish(event: ShellEvent): void
  subscribe(callback: (event: ShellEvent) => void): () => void
  dispose(): void
}

export function createShellEventHub(): ShellEventHub {
  const listeners = new Set<(event: ShellEvent) => void>()
  let disposed = false
  return {
    publish(event) {
      if (disposed) return
      for (const listener of [...listeners]) listener(event)
    },
    subscribe(callback) {
      if (disposed) return () => {}
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
    dispose() {
      listeners.clear()
      disposed = true
    }
  }
}

export function createShellState(): {
  get(): Record<string, unknown>
  set(patch: Record<string, unknown>): void
  reset(): void
} {
  let state: Record<string, unknown> = {}
  return {
    get: () => ({ ...state }),
    set: (patch) => {
      state = { ...state, ...patch }
    },
    reset: () => {
      state = {}
    }
  }
}

/** No signed feed is configured in this repository; stay honest instead of faking success. */
export async function checkIconUpdate(input: {
  enabled: boolean
  deps?: unknown
}): Promise<{ status: string; reason?: string }> {
  if (!input.enabled) return { status: 'disabled' }
  return { status: 'unavailable', reason: 'signed icon feed is not configured' }
}
