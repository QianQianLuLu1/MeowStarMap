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
      // Get-NetFirewallPortFilter.LocalPort 无限制时输出 'Any'（审查修复 M10，与 '*' 同义）
      return part === String(port) || part === '*' || part === 'Any'
    })
}

/**
 * Only enabled/profile fields may change; rules are never deleted.
 * 审查修复 M4：启用的 Block ⇒ 禁用（enabled:false）；禁用的 Allow ⇒ 启用。
 * 原实现对 Block 也设 enabled:true，只会加强封锁却报告 repaired。
 */
export function planRepair(rules: FirewallRule[], port: number): RepairChange[] {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return []
  return rules
    .filter(
      (rule) => matchesPort(rule, port) && (rule.action === 'Block' ? rule.enabled : !rule.enabled)
    )
    .slice(0, 32)
    .map((rule) => ({
      name: rule.name,
      changes: { enabled: rule.action !== 'Block', profile: 'Private,Public' }
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
    // 审查修复 M9：编码的必须是 PowerShell 脚本（原实现把 JSON 当脚本执行，必然失败）
    const encoded = Buffer.from(buildApplyScript(plan), 'utf16le').toString('base64')
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
  // 审查修复 M3/M6：-PassThru 透出内层 ExitCode（失败不再假成功）；外层 UTF8 修 GBK stderr 乱码
  const wrapped = [
    `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`,
    `$p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList '${inner.replace(/'/g, "''")}'`,
    `if ($p.ExitCode -ne 0) { exit $p.ExitCode }`
  ].join('\n')
  return encodeArgs(wrapped)
}

function isDeclined(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /cancelled|canceled|操作已取消|用户取消|0x800704C7|\b1223\b/i.test(message)
}

/** profile 白名单（审查修复 M7）：journal 可被本地篡改，内插进 PowerShell 前必须封闭值域。 */
const FIREWALL_PROFILE_RE = /^(Any|Domain|Private|Public)(,(Domain|Private|Public))*$/

/** journal 逐条形状校验：任一非法 ⇒ null 整体拒绝（不做部分恢复，防篡改/损坏基线）。 */
export function parseConflictJournal(parsed: unknown): ConflictJournalEntry[] | null {
  if (!Array.isArray(parsed)) return null
  const entries: ConflictJournalEntry[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') return null
    const record = item as Record<string, unknown>
    if (typeof record.name !== 'string' || record.name.length === 0) return null
    if (typeof record.enabled !== 'boolean') return null
    if (typeof record.profile !== 'string' || !FIREWALL_PROFILE_RE.test(record.profile)) return null
    entries.push({ name: record.name, enabled: record.enabled, profile: record.profile })
  }
  return entries
}

/** Apply enabled/profile changes by rule name (never deletes rules). */
export function buildApplyScript(changes: RepairChange[]): string {
  const lines = [`$ErrorActionPreference = 'Stop'`]
  for (const change of changes) {
    const enabled = change.changes.enabled === true ? 'True' : 'False'
    const profile =
      typeof change.changes.profile === 'string' ? change.changes.profile : 'Private,Public'
    // 注入门（M7）：profile 直接内插进 cmdlet 参数，白名单外一律拒绝
    if (!FIREWALL_PROFILE_RE.test(profile)) throw new Error('Invalid firewall profile')
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
  // 审查修复 M10：runtime 缺席/未监听时 port=0，不得假 ok 掩盖「未取到端口」
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    return { status: 'failed', reason: 'invalid sync port' }
  }
  const journal = await input.readJournal().catch(() => null)
  // 审查修复 M7：形状/白名单校验后才承认基线（篡改/损坏 journal ⇒ 视同无可恢复）
  const journalEntries = parseConflictJournal(journal)
  const canRestore = journalEntries !== null && journalEntries.length > 0

  if (input.action === 'restore') {
    if (!canRestore) return { status: 'nothing-to-restore', canRestore: false }
    const script = buildApplyScript(
      journalEntries!.map((entry) => ({
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
  // 审查修复 M4：二次 repair 合并首见优先——已有基线绝不被当前（可能已修复过的）状态覆写
  const merged: ConflictJournalEntry[] = [...(journalEntries ?? [])]
  for (const entry of originals) {
    if (!merged.some((existing) => existing.name === entry.name)) merged.push(entry)
  }
  // fail-closed：journal 写失败 ⇒ 不 apply（否则做出不可恢复的修改）
  try {
    await input.writeJournal(merged)
  } catch {
    return { status: 'failed', canRestore, reason: 'journal persistence failed' }
  }
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
