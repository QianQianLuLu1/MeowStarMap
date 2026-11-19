/**
 * Opt-in LAN firewall authorization (aligns upstream NetworkAuthorization.cs semantics).
 * Rule group name is verbatim upstream; TCP / LocalSubnet / Private+Public only, never Domain.
 * Uses PowerShell NetFirewall cmdlets with JSON output (locale-independent) instead of parsing
 * localized netsh text. Pure script builders / JSON parsers are separated from side effects.
 */

export const NETWORK_RULE_GROUP = 'MomoCamera LAN Authorization v1'

export type NetworkAuthAction = 'authorize' | 'revoke' | 'status'

export interface NetworkAuthResult {
  status:
    'authorized' | 'revoked' | 'present' | 'absent' | 'disabled' | 'elevation-declined' | 'failed'
  ruleGroup: string
  reason?: string
}

/** Inbound allow rule scoped to the local subnet on the sync port; Private+Public profiles only. */
export function buildAuthorizeScript(port: number): string {
  return [
    `$ErrorActionPreference = 'Stop'`,
    `New-NetFirewallRule -DisplayName '${NETWORK_RULE_GROUP}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -RemoteAddress LocalSubnet -Profile Private,Public | Out-Null`,
    `Write-Output 'authorized'`
  ].join('\n')
}

export function buildRevokeScript(): string {
  return [
    `$ErrorActionPreference = 'Stop'`,
    `Remove-NetFirewallRule -DisplayName '${NETWORK_RULE_GROUP}' -ErrorAction SilentlyContinue | Out-Null`,
    `Write-Output 'revoked'`
  ].join('\n')
}

export function buildStatusScript(): string {
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$r = @(Get-NetFirewallRule -DisplayName '${NETWORK_RULE_GROUP}' -ErrorAction SilentlyContinue)`,
    `Write-Output ($r.Count)`
  ].join('\n')
}

/** Status script prints the matching rule count; any positive integer ⇒ present. */
export function parsePresence(stdout: string): boolean {
  const trimmed = stdout.trim()
  const count = Number(trimmed)
  return Number.isInteger(count) && count > 0
}

/** Wrap a script for self-elevation (UAC). Declining the prompt surfaces as a cancellation error. */
export function buildElevatedArgs(script: string): string[] {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const inner = `-NoProfile -NonInteractive -EncodedCommand ${encoded}`
  const wrapped = `Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList '${inner.replace(/'/g, "''")}'`
  const wrappedEncoded = Buffer.from(wrapped, 'utf16le').toString('base64')
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', wrappedEncoded]
}

export function buildDirectArgs(script: string): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')
  ]
}

/** Detect a declined UAC prompt from the PowerShell cancellation error text. */
export function isElevationDeclined(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /cancelled|canceled|操作已取消|用户取消|0x800704C7/i.test(message)
}

export async function runNetworkAuth(input: {
  action: NetworkAuthAction
  port: number
  enabled: boolean
  isAdmin: boolean
  execFile: (file: string, args: string[]) => Promise<{ stdout: string }>
}): Promise<NetworkAuthResult> {
  const base = { ruleGroup: NETWORK_RULE_GROUP }
  if (!input.enabled) return { ...base, status: 'disabled' }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    return { ...base, status: 'failed', reason: 'invalid sync port' }
  }
  const script =
    input.action === 'authorize'
      ? buildAuthorizeScript(input.port)
      : input.action === 'revoke'
        ? buildRevokeScript()
        : buildStatusScript()
  // Status is a read-only query: no elevation needed. Mutations require admin; self-elevate otherwise.
  const needsElevation = input.action !== 'status' && !input.isAdmin
  const args = needsElevation ? buildElevatedArgs(script) : buildDirectArgs(script)
  try {
    const { stdout } = await input.execFile('powershell.exe', args)
    if (input.action === 'status') {
      return { ...base, status: parsePresence(stdout) ? 'present' : 'absent' }
    }
    return { ...base, status: input.action === 'authorize' ? 'authorized' : 'revoked' }
  } catch (error) {
    if (needsElevation && isElevationDeclined(error)) {
      return { ...base, status: 'elevation-declined' }
    }
    return { ...base, status: 'failed', reason: 'firewall command failed' }
  }
}
