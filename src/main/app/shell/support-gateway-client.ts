/** Anonymous diagnostic submission client; never uploads anything without explicit opt-in. */

export const RECEIPT_PATTERN = /^NS1\.([1-9][0-9]{0,11})\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/

const ALLOWED_HOSTS = ['cnb.cool', 'api.cnb.cool'] as const

export function configuredEndpoint(env: Record<string, string | undefined>): string | null {
  const raw = env.MOMO_SUPPORT_URL
  if (!raw || raw.length > 2048) return null
  try {
    const url = new URL(raw)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !ALLOWED_HOSTS.includes(url.hostname as (typeof ALLOWED_HOSTS)[number])
    ) {
      return null
    }
    return `${url.origin}${url.pathname.replace(/\/$/, '')}/v1/reports`
  } catch {
    return null
  }
}

export function parseReceipt(raw: string): { issue: string } | null {
  if (typeof raw !== 'string') return null
  const match = RECEIPT_PATTERN.exec(raw)
  return match ? { issue: match[1] as string } : null
}

export interface SupportReportInput {
  readonly platform: string
  readonly version: string
  readonly build: string
  readonly osBuild: string
  readonly errors: Array<{ Code: string; Count: number }>
}

/** Strict field whitelist: no paths, UIDs, file names or raw exception text ever leave the app. */
export function buildSupportReport(input: SupportReportInput): Record<string, unknown> {
  const textFields = [input.platform, input.version, input.build, input.osBuild]
  if (textFields.some((value) => typeof value !== 'string' || value.trim().length === 0)) {
    throw new Error('Invalid support report')
  }
  if (!Array.isArray(input.errors) || input.errors.length > 64) {
    throw new Error('Invalid support report')
  }
  return {
    Schema: 1,
    Platform: input.platform,
    Version: input.version,
    Build: input.build,
    OsBuild: input.osBuild,
    Errors: input.errors.map((entry) => ({
      Code: String(entry.Code).slice(0, 64),
      Count: Number.isFinite(entry.Count) ? Math.max(0, Math.floor(entry.Count)) : 0
    }))
  }
}

export async function submitDiagnosticReport(input: {
  endpoint?: string
  report?: Record<string, unknown>
  optIn: boolean
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<{ status: string; issue?: string; receipt?: string }> {
  if (!input.optIn || !input.endpoint) return { status: 'unavailable' }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 35000)
  try {
    const fetchImpl = input.fetchImpl ?? fetch
    const response = await fetchImpl(input.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input.report ?? {}),
      signal: controller.signal
    })
    if (response.status !== 201) return { status: 'failed' }
    const text = await response.text()
    if (text.length > 4096) return { status: 'invalid-receipt' }
    let body: Record<string, unknown>
    try {
      body = JSON.parse(text) as Record<string, unknown>
    } catch {
      return { status: 'invalid-receipt' }
    }
    const receipt = typeof body.receipt === 'string' ? body.receipt : ''
    const parsed = parseReceipt(receipt)
    if (!parsed || String(body.issue ?? '') !== parsed.issue) {
      return { status: 'invalid-receipt' }
    }
    return { status: 'submitted', issue: parsed.issue, receipt }
  } catch {
    return { status: 'failed' }
  } finally {
    clearTimeout(timeout)
  }
}
