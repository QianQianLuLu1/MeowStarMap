/** Bounded HTTPS download with Range resume and SHA-256 verification (Node built-ins only). */
import { createHash } from 'node:crypto'

import { requireHttpsUrl } from './signed-feed'

export interface DownloadOptions {
  readonly limit: number
  readonly sha256?: string
  readonly offset?: number
  /** 206 续传时声明的完整资源长度（content-range 的 "/" 后段），缺省只校起点。 */
  readonly expectedSize?: number
  readonly signal?: AbortSignal
  readonly fetchImpl?: typeof fetch
}

/** 重定向逐跳重校验的上限（对齐上游 UpdateHttp 的 fail-closed 判据）。 */
const MAX_REDIRECTS = 6

export function parseContentRange(
  value: string | null,
  offset: number,
  expectedSize?: number
): boolean {
  if (!value) return false
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value)
  if (!match) return false
  if (Number(match[1]) !== offset) return false
  return expectedSize === undefined || Number(match[3]) === expectedSize
}

export async function downloadVerified(url: string, options: DownloadOptions): Promise<Buffer> {
  let current = requireHttpsUrl(url).href
  if (!Number.isFinite(options.limit) || options.limit <= 0) {
    throw new Error('Invalid download limit')
  }
  const offset = options.offset ?? 0
  if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid download offset')
  const fetchImpl = options.fetchImpl ?? fetch
  const requestInit = {
    redirect: 'manual' as const,
    ...(offset > 0 ? { headers: { Range: `bytes=${offset}-` } } : {}),
    ...(options.signal ? { signal: options.signal } : {})
  }
  // 逐跳重校验：每一跳的 Location 都重新过 https + 白名单，降级/逃逸立即 fail-closed。
  let response = await fetchImpl(current, requestInit)
  for (let hop = 0; response.status >= 300 && response.status < 400; hop += 1) {
    if (hop >= MAX_REDIRECTS) throw new Error('Too many redirects')
    const location = response.headers.get('location')
    if (!location) throw new Error('Download failed')
    current = requireHttpsUrl(new URL(location, current).href).href
    response = await fetchImpl(current, requestInit)
  }
  const expectedStatus = offset > 0 ? 206 : 200
  if (response.status !== expectedStatus) throw new Error('Download failed')
  if (
    offset > 0 &&
    !parseContentRange(response.headers.get('content-range'), offset, options.expectedSize)
  ) {
    throw new Error('Download range mismatch')
  }
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > options.limit) {
    throw new Error('Download size exceeds limit')
  }
  // 流式累计限量：超限即抛并取消流，绝不先整包缓冲再检查（防内存耗尽）。
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Download failed')
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > options.limit) throw new Error('Download size exceeds limit')
      chunks.push(Buffer.from(value))
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const bytes = Buffer.concat(chunks)
  if (options.sha256) {
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (hash !== options.sha256.toLowerCase()) throw new Error('Download hash mismatch')
  }
  return bytes
}
