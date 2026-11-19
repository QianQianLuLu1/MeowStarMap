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

/**
 * WinRT tethering script (aligns upstream TemporaryHotspot.cs). Loads the Windows Runtime
 * types, derives the manager from the internet connection profile, and awaits the async
 * operation via AsTask. Emits JSON {active, ssid?, password?}. Real execution needs a wireless
 * adapter; unit tests assert the script text and inject execFile.
 */
export function buildHotspotScript(action: 'start' | 'stop' | 'status'): string {
  const op =
    action === 'start'
      ? '$mgr.StartTetheringAsync()'
      : action === 'stop'
        ? '$mgr.StopTetheringAsync()'
        : '$null'
  const awaitBlock =
    action === 'status'
      ? ''
      : [
          `$op = ${op}`,
          `$task = [System.WindowsRuntimeSystemExtensions]::AsTask($op)`,
          `$task.Wait() | Out-Null`
        ].join('\n')
  return [
    `$ErrorActionPreference = 'Stop'`,
    `[Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager,Windows.Networking.NetworkOperators,ContentType=WindowsRuntime] | Out-Null`,
    `[Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime] | Out-Null`,
    `$connectionProfile = [Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()`,
    `$mgr = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::CreateFromConnectionProfile($connectionProfile)`,
    awaitBlock,
    `$state = $mgr.TetheringOperationalState.ToString()`,
    `$cfg = $mgr.GetCurrentAccessPointConfiguration()`,
    `[PSCustomObject]@{ active = ($state -eq 'On'); ssid = $cfg.Ssid; password = $cfg.Passphrase } | ConvertTo-Json`
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}

export interface HotspotOutput {
  active: boolean
  ssid?: string
  password?: string
}

export function parseHotspotOutput(stdout: string): HotspotOutput {
  const trimmed = stdout.trim()
  if (!trimmed) return { active: false }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    return {
      active: parsed.active === true,
      ssid: typeof parsed.ssid === 'string' ? parsed.ssid : undefined,
      password: typeof parsed.password === 'string' ? parsed.password : undefined
    }
  } catch {
    return { active: false }
  }
}

function encodeArgs(script: string): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')
  ]
}

export interface HotspotControlResult {
  status: 'started' | 'stopped' | 'unchanged' | 'disabled' | 'failed'
  state: HotspotState
  ssid?: string
  password?: string
  reason?: string
}

/**
 * start/stop/status with persisted startedHere. stop only touches a hotspot this app started;
 * a foreign hotspot is left alone (unchanged). State read/write are injected for testability.
 */
export async function controlHotspot(input: {
  action: 'start' | 'stop' | 'status'
  enabled: boolean
  execFile: (file: string, args: string[]) => Promise<{ stdout: string }>
  readState: () => Promise<HotspotState>
  writeState: (state: HotspotState) => Promise<void>
}): Promise<HotspotControlResult> {
  const persisted = await input.readState().catch(() => ({ startedHere: false, active: false }))
  if (!input.enabled) return { status: 'disabled', state: persisted }
  // stop: never close a hotspot we did not start — 归属门先于任何脚本执行（审查修复 M2）。
  if (input.action === 'stop' && !persisted.startedHere) {
    return { status: 'unchanged', state: persisted }
  }
  try {
    const { stdout } = await input.execFile(
      'powershell.exe',
      encodeArgs(buildHotspotScript(input.action))
    )
    const output = parseHotspotOutput(stdout)
    if (input.action === 'status') {
      return {
        status: 'unchanged',
        state: { startedHere: persisted.startedHere, active: output.active },
        ssid: output.ssid
      }
    }
    if (input.action === 'start') {
      if (persisted.active && output.active) {
        return { status: 'unchanged', state: persisted, ssid: output.ssid }
      }
      const state: HotspotState = { startedHere: true, active: true }
      // 持久化失败 fail-closed：不假报 started（startedHere 未落盘 ⇒ 后续 stop 不会误关）
      try {
        await input.writeState(state)
      } catch {
        return { status: 'failed', state: persisted, reason: 'hotspot state persistence failed' }
      }
      return { status: 'started', state, ssid: output.ssid, password: output.password }
    }
    const state: HotspotState = { startedHere: false, active: false }
    try {
      await input.writeState(state)
    } catch {
      return { status: 'failed', state: persisted, reason: 'hotspot state persistence failed' }
    }
    return { status: 'stopped', state }
  } catch {
    return { status: 'failed', state: persisted, reason: 'hotspot command failed' }
  }
}

/** Legacy toggle surface kept for the hotspot-toggle channel; delegates to the real WinRT script. */
export async function toggleHotspot(input: {
  enabled: boolean
  current: HotspotState
  requested: boolean
  execFile?: (file: string, args: string[]) => Promise<void>
}): Promise<{ status: string; state: HotspotState }> {
  if (!input.enabled) return { status: 'disabled', state: input.current }
  const next = nextHotspotState(input.current, input.requested)
  if (!input.execFile) return { status: 'failed', state: input.current }
  // unchanged（外来热点 / 已在跑）⇒ 零脚本执行（审查修复 M2，与 controlHotspot 同口径）
  if (next === input.current) return { status: 'unchanged', state: input.current }
  try {
    await input.execFile(
      'powershell.exe',
      encodeArgs(buildHotspotScript(input.requested ? 'start' : 'stop'))
    )
    return { status: 'toggled', state: next }
  } catch {
    return { status: 'failed', state: input.current }
  }
}
