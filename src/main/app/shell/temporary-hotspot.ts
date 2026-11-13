/** Opt-in temporary mobile hotspot; never closes a hotspot the user already had running. */

export interface HotspotState {
  readonly startedHere: boolean
  readonly active: boolean
}

export function nextHotspotState(current: HotspotState, requested: boolean): HotspotState {
  if (!requested) {
    return current.startedHere ? { startedHere: false, active: false } : current
  }
  if (current.active) return current
  return { startedHere: true, active: true }
}

export async function toggleHotspot(input: {
  enabled: boolean
  current: HotspotState
  requested: boolean
  execFile?: (file: string, args: string[]) => Promise<void>
}): Promise<{ status: string; state: HotspotState }> {
  if (!input.enabled) return { status: 'disabled', state: input.current }
  const next = nextHotspotState(input.current, input.requested)
  if (!input.execFile) return { status: 'failed', state: input.current }
  try {
    await input.execFile('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Set-HotspotEnabled -Requested ${input.requested ? '1' : '0'}`
    ])
    return { status: 'toggled', state: next }
  } catch {
    return { status: 'failed', state: input.current }
  }
}
