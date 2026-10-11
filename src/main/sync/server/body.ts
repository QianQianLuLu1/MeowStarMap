import type { IncomingMessage } from 'node:http'
import { ApiHttpError } from './api-error'

/**
 * 读取请求体（上限保护）。
 * 协议仅 POST /v1/pair 与 PATCH .../metadata 携带 body（KB 量级）；
 * 超限返回 400（上游映射 500，这里语义更准确——见 04 计划 §3）。
 */
export async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += data.length
    if (total > maxBytes) {
      throw new ApiHttpError(400, 'bad_request', 'request body too large')
    }
    chunks.push(data)
  }
  return Buffer.concat(chunks)
}
