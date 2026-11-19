/** Windows firewall conflict repair, opt-in only; pure planning is separated from side effects. */

export interface FirewallRule {
  readonly name: string
  readonly displayName?: string
  readonly enabled: boolean
  readonly profile: string
  readonly localPorts?: string
  readonly action: string
  readonly direction: string
}

export interface RepairChange {
  readonly name: string
  readonly changes: Record<string, unknown>
}

export function repairRequiresOptIn(enabled: boolean): boolean {
  return enabled === true
}

export function sameIdentity(a: FirewallRule, b: FirewallRule): boolean {
  return a.name === b.name && a.action === b.action && a.direction === b.direction
}

export function matchesPort(rule: FirewallRule, port: number): boolean {
  if (!rule.localPorts) return false
  return rule.localPorts
    .split(',')
    .map((part) => part.trim())
    .some((part) => {
      const range = /^(\d+)-(\d+)$/.exec(part)
      if (range) return port >= Number(range[1]) && port <= Number(range[2])
      return part === String(port) || part === '*'
    })
}

/** Only enabled/profile fields may change; rules are never deleted. */
export function planRepair(rules: FirewallRule[], port: number): RepairChange[] {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return []
  return rules
    .filter((rule) => matchesPort(rule, port) && (rule.action === 'Block' || !rule.enabled))
    .slice(0, 32)
    .map((rule) => ({
      name: rule.name,
      changes: { enabled: true, profile: 'Private,Public' }
    }))
}

export async function runRepair(input: {
  enabled: boolean
  rules: FirewallRule[]
  port: number
  execFile?: (file: string, args: string[]) => Promise<void>
}): Promise<{ status: string; changed: number }> {
  if (!repairRequiresOptIn(input.enabled)) return { status: 'disabled', changed: 0 }
  const plan = planRepair(input.rules, input.port)
  if (plan.length === 0) return { status: 'repaired', changed: 0 }
  if (!input.execFile) return { status: 'failed', changed: 0 }
  try {
    const encoded = Buffer.from(JSON.stringify(plan), 'utf16le').toString('base64')
    await input.execFile('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encoded
    ])
    return { status: 'repaired', changed: plan.length }
  } catch {
    return { status: 'failed', changed: 0 }
  }
}

// ---- 2026-11-19 PC 对齐轮：真实枚举 / journal / inspect / repair / restore ----

export interface ConflictRuleInfo {
  name: string
  action: string
  enabled: boolean
  profile: string
}

export interface ConflictJournalEntry {
  name: string
  enabled: boolean
  profile: string
}

export interface NetworkConflictResult {
  status:
    | 'ok'
    | 'repaired'
    | 'restored'
    | 'nothing-to-restore'
    | 'disabled'
    | 'elevation-declined'
    | 'failed'
  conflicts?: ConflictRuleInfo[]
  changed?: number
  canRestore?: boolean
  reason?: string
}

/** Enumerate every firewall rule with its port filter as JSON (locale-independent). */
export function buildEnumerateScript(): string {
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$rules = @(Get-NetFirewallRule | ForEach-Object {`,
    `  $pf = $_ | Get-NetFirewallPortFilter`,
    `  [PSCustomObject]@{`,
    `    name = $_.Name`,
    `    displayName = $_.DisplayName`,
    `    enabled = ($_.Enabled.ToString() -eq 'True')`,
    `    profile = $_.Profile.ToString()`,
    `    action = $_.Action.ToString()`,
    `    direction = $_.Direction.ToString()`,
    `    localPorts = (@($pf.LocalPort) -join ',')`,
    `  }`,
    `})`,
    `ConvertTo-Json -InputObject $rules -Depth 4`
  ].join('\n')
}

/** Parse the enumeration JSON into FirewallRule[]; malformed / empty input ⇒ []. */
export function parseFirewallRules(stdout: string): FirewallRule[] {
  const trimmed = stdout.trim()
  if (!trimmed) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return []
  }
  const list = Array.isArray(parsed) ? parsed : [parsed]
  const rules: FirewallRule[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.name !== 'string') continue
    rules.push({
      name: record.name,
      displayName: typeof record.displayName === 'string' ? record.displayName : undefined,
      enabled: record.enabled === true,
      profile: typeof record.profile === 'string' ? record.profile : 'Any',
      localPorts: typeof record.localPorts === 'string' ? record.localPorts : undefined,
      action: typeof record.action === 'string' ? record.action : 'Allow',
      direction: typeof record.direction === 'string' ? record.direction : 'Inbound'
    })
  }
  return rules
}

function encodeArgs(script: string): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')
  ]
}

function elevatedArgs(script: string): string[] {
  const inner = `-NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`
  const wrapped = `Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList '${inner.replace(/'/g, "''")}'`
  return encodeArgs(wrapped)
}

function isDeclined(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /cancelled|canceled|操作已取消|用户取消|0x800704C7/i.test(message)
}

/** Apply enabled/profile changes by rule name (never deletes rules). */
export function buildApplyScript(changes: RepairChange[]): string {
  const lines = [`$ErrorActionPreference = 'Stop'`]
  for (const change of changes) {
    const enabled = change.changes.enabled === true ? 'True' : 'False'
    const profile =
      typeof change.changes.profile === 'string' ? change.changes.profile : 'Private,Public'
    const name = change.name.replace(/'/g, "''")
    lines.push(
      `Set-NetFirewallRule -Name '${name}' -Enabled ${enabled} -Profile ${profile} | Out-Null`
    )
  }
  lines.push(`Write-Output 'applied'`)
  return lines.join('\n')
}

export async function runNetworkConflict(input: {
  action: 'inspect' | 'repair' | 'restore'
  port: number
  enabled: boolean
  isAdmin: boolean
  execFile: (file: string, args: string[]) => Promise<{ stdout: string }>
  readJournal: () => Promise<ConflictJournalEntry[] | null>
  writeJournal: (entries: ConflictJournalEntry[]) => Promise<void>
  clearJournal: () => Promise<void>
}): Promise<NetworkConflictResult> {
  if (!input.enabled) return { status: 'disabled' }
  const journal = await input.readJournal().catch(() => null)
  const canRestore = Array.isArray(journal) && journal.length > 0

  if (input.action === 'restore') {
    if (!canRestore) return { status: 'nothing-to-restore', canRestore: false }
    const script = buildApplyScript(
      journal!.map((entry) => ({
        name: entry.name,
        changes: { enabled: entry.enabled, profile: entry.profile }
      }))
    )
    const args = input.isAdmin ? encodeArgs(script) : elevatedArgs(script)
    try {
      await input.execFile('powershell.exe', args)
      await input.clearJournal().catch(() => undefined)
      return { status: 'restored', changed: journal!.length, canRestore: false }
    } catch (error) {
      if (!input.isAdmin && isDeclined(error)) return { status: 'elevation-declined', canRestore }
      return { status: 'failed', canRestore, reason: 'restore command failed' }
    }
  }

  // inspect / repair both enumerate first (read-only query, no elevation).
  let rules: FirewallRule[]
  try {
    const { stdout } = await input.execFile('powershell.exe', encodeArgs(buildEnumerateScript()))
    rules = parseFirewallRules(stdout)
  } catch {
    return { status: 'failed', canRestore, reason: 'firewall enumeration failed' }
  }
  const plan = planRepair(rules, input.port)
  const conflicts: ConflictRuleInfo[] = plan.map((change) => {
    const rule = rules.find((candidate) => candidate.name === change.name)
    return {
      name: change.name,
      action: rule?.action ?? 'Block',
      enabled: rule?.enabled ?? false,
      profile: rule?.profile ?? 'Any'
    }
  })

  if (input.action === 'inspect') {
    return { status: 'ok', conflicts, changed: 0, canRestore }
  }
  if (plan.length === 0) return { status: 'ok', conflicts: [], changed: 0, canRestore }

  // Persist originals BEFORE applying so a partial failure remains restorable.
  const originals: ConflictJournalEntry[] = plan.map((change) => {
    const rule = rules.find((candidate) => candidate.name === change.name)
    return { name: change.name, enabled: rule?.enabled ?? false, profile: rule?.profile ?? 'Any' }
  })
  await input.writeJournal(originals).catch(() => undefined)
  const script = buildApplyScript(plan)
  const args = input.isAdmin ? encodeArgs(script) : elevatedArgs(script)
  try {
    await input.execFile('powershell.exe', args)
    return { status: 'repaired', conflicts, changed: plan.length, canRestore: true }
  } catch (error) {
    if (!input.isAdmin && isDeclined(error))
      return { status: 'elevation-declined', canRestore: true }
    return { status: 'failed', canRestore: true, reason: 'repair command failed' }
  }
}
