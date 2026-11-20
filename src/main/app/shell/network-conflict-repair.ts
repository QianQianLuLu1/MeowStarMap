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
 * 审查修复 M4 的方向在 2026-11-20 再收窄（见 planRepair）：只碰**入站启用的 Block**。
 */
/** 修复目标判据（与恢复侧的交叉校验共用）：本端口 + 入站 + Block。 */
function isRepairTarget(rule: FirewallRule, port: number): boolean {
  return matchesPort(rule, port) && rule.direction === 'Inbound' && rule.action === 'Block'
}

/**
 * 只处理「入站 + Block + 启用」的冲突规则：禁用它对端口的封锁即解除冲突。
 * 2026-11-20 收窄口径（原实现会动任意方向的同端口规则）：
 * - **不碰出站**：禁用他人 Outbound Block 属削弱出站管控，与本功能目的无关；
 * - **不启用 Allow**：枚举里没有 Program，无法确认是被禁用的本程序规则，
 *   贸然启用等于替别人放开端口；
 * - **不改 profile**：原实现一律改写为 `Private,Public`，会把 Domain 抹掉并把规则扩散到公共网络。
 */
export function planRepair(rules: FirewallRule[], port: number): RepairChange[] {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return []
  return (
    rules
      .filter((rule) => rule.enabled && isRepairTarget(rule, port))
      // profile 无法安全落基线（白名单外）的规则不进计划：宁可少修，不可做出不可恢复的改动
      .filter((rule) => FIREWALL_PROFILE_RE.test(rule.profile))
      .slice(0, 32)
      .map((rule) => ({ name: rule.name, changes: { enabled: false } }))
  )
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
      // 归一 profile 空白：PowerShell 对多 profile 规则输出 `Domain, Private`（带空格），
      // 原样落 journal 会被 FIREWALL_PROFILE_RE 拒掉 ⇒ canRestore 永久 false、基线静默丢失。
      profile: typeof record.profile === 'string' ? record.profile.replace(/\s+/g, '') : 'Any',
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
    // UAC 拒绝抛非终止错误：不声明 Stop 会继续执行，`$null.ExitCode`/`exit $null` 最终得到
    // 退出码 0 ⇒ 外层 resolve ⇒ 把「用户取消」报成 repaired。终止性 + 空进程两道闸。
    `$ErrorActionPreference = 'Stop'`,
    `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`,
    `$p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList '${inner.replace(/'/g, "''")}'`,
    `if ($null -eq $p) { exit 1223 }`,
    `if ($p.ExitCode -ne 0) { exit $p.ExitCode }`
  ].join('\n')
  return encodeArgs(wrapped)
}

function isDeclined(error: unknown): boolean {
  // 退出码主判据（与 network-authorization.isElevationDeclined 同口径）：error.message
  // 不含退出码，只靠正则会把 `exit 1223` 的提权拒绝误归为通用 failed。
  const code = (error as { code?: unknown } | null)?.code
  if (code === 1223 || code === 0x800704c7) return true
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
    // journal 落在 userData 下、同用户可写：恢复前按当前枚举交叉校验，只承认「本端口入站 Block」
    // 规则——否则改一条 JSON 就能借提权 PowerShell 打开任意被禁用的防火墙规则。
    let rules: FirewallRule[]
    try {
      const { stdout } = await input.execFile('powershell.exe', encodeArgs(buildEnumerateScript()))
      rules = parseFirewallRules(stdout)
    } catch {
      return { status: 'failed', canRestore, reason: 'firewall enumeration failed' }
    }
    const allowed = new Set(
      rules.filter((rule) => isRepairTarget(rule, input.port)).map((r) => r.name)
    )
    const entries = journalEntries!.filter((entry) => allowed.has(entry.name))
    // 基线里的规则已被删除/改名 ⇒ 没有可安全恢复的对象，如实回 nothing-to-restore
    if (entries.length === 0) return { status: 'nothing-to-restore', canRestore: false }
    const script = buildApplyScript(
      entries.map((entry) => ({
        name: entry.name,
        changes: { enabled: entry.enabled, profile: entry.profile }
      }))
    )
    const args = input.isAdmin ? encodeArgs(script) : elevatedArgs(script)
    try {
      await input.execFile('powershell.exe', args)
      await input.clearJournal().catch(() => undefined)
      return { status: 'restored', changed: entries.length, canRestore: false }
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
