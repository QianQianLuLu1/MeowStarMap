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
