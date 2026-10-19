import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  API_ROUTES,
  isAssetType,
  type AssetListQuery,
  type PairRequest
} from '../../../shared/sync/protocol'
import type { SyncLogger } from '../identity-service'
import { PairingError } from '../pairing-service'
import { ApiHttpError, apiErrorBody } from './api-error'
import { readBody } from './body'
import { exportJpeg } from './jpeg-export'
import { parseRangeHeader } from './range'
import type { SyncApiServices } from './types'

/**
 * API 路由层 — NikkiSync 协议 v1 全部端点 + 错误映射 + 资源流式响应。
 *
 * 认证顺序（照上游 LocalSyncServer）：GET /v1/server 与 POST /v1/pair 免签；
 * PATCH .../metadata 先读 body（签名覆盖 body）再验签；其余一律先验签再路由。
 * 错误统一 ApiErrorBody；成功 JSON 统一 `application/json; charset=utf-8` + no-store。
 *
 * 与上游的差异（均为刻意决策，见 docs/sync-integration/04-http-server-plan.md）：
 * - PATCH metadata：WXNN v1 只读（协议允许键同样 400 read-only），空对象 no-op 200
 * - 搜索/统计：协议形状的空结果桩（getServerInfo 未声明相应 capability）
 * - clothing 缩略图：404 resource_not_ready 桩（无服装字典/远程源）
 * - body 超限 400（上游 500）；PairingError.bad_request 映射 400（上游 401）
 *
 * export 扩展端点（.../resources/{rid}/export，阶段 6 E2E 联调补齐）：语义照抄
 * 上游 LocalSyncServer.exportStill —— 查询参数白名单（400）、仅就绪 JPEG 静图
 * （404）、单飞限流（429）、源字节哈希/元数据校验（409），导出为无损 EXIF 重写
 * （jpeg-export.ts），四校验头 + no-store；HEAD 只回头部。
 */

export const METADATA_ALLOWED_KEYS = new Set([
  'capture',
  'camera',
  'filter',
  'lighting',
  'photography',
  'nikki',
  'dressing',
  'interactions',
  'location'
])

export const SEARCH_QUERY_MAX_LENGTH = 80

/** 与 sync-read-repository MAX_PAGE_LIMIT 一致（此处不 import 仓储，保持 HTTP 层独立） */
const MAX_PAGE_LIMIT = 500

const AUTH_FAILURE_MESSAGE = 'Request signature is missing or invalid'
const ASSET_ID_PATTERN = /^\d+$/

export interface ApiRouterConfig {
  maxJsonBodyBytes: number
}

export type ApiRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

export function createApiRequestHandler(input: {
  services: SyncApiServices
  config: ApiRouterConfig
  logger?: SyncLogger
}): ApiRequestHandler {
  const { services, config, logger } = input

  async function verify(req: IncomingMessage, body?: Buffer): Promise<boolean> {
    const result = await services.verifyRequest({
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers: req.headers,
      ...(body === undefined ? {} : { body })
    })
    return result.ok
  }

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://wxnn.local')
    const method = req.method ?? 'GET'

    if (method === 'GET' && url.pathname === API_ROUTES.serverInfo) {
      writeJson(res, 200, await services.getServerInfo())
      return
    }
    if (method === 'POST' && url.pathname === API_ROUTES.pair) {
      await handlePair(req, res)
      return
    }
    const metadataMatch = url.pathname.match(/^\/v1\/assets\/([^/]+)\/metadata$/)
    if (method === 'PATCH' && metadataMatch) {
      const body = await readBody(req, config.maxJsonBodyBytes)
      if (!(await verify(req, body))) {
        writeJson(res, 401, apiErrorBody('unauthorized', AUTH_FAILURE_MESSAGE))
        return
      }
      await handleMetadataPatch(body, decodeURIComponent(metadataMatch[1]!), res)
      return
    }

    if (!(await verify(req))) {
      writeJson(res, 401, apiErrorBody('unauthorized', AUTH_FAILURE_MESSAGE))
      return
    }

    if (method === 'GET' && url.pathname === API_ROUTES.assets) {
      handleListAssets(url, res)
      return
    }
    if (
      method === 'GET' &&
      (url.pathname === API_ROUTES.suitSearch || url.pathname === API_ROUTES.clothingSearch)
    ) {
      handleSearch(url, res)
      return
    }
    if (method === 'GET' && url.pathname === API_ROUTES.profileStats) {
      writeJson(res, 200, {
        libraryRevision: services.getCurrentRevision(),
        topSuits: [],
        topClothing: []
      })
      return
    }
    if (method === 'GET' && url.pathname === API_ROUTES.changes) {
      await handleChanges(url, res)
      return
    }
    const clothingMatch = url.pathname.match(
      /^\/v1\/assets\/([^/]+)\/clothing\/([^/]+)\/thumbnail$/
    )
    if ((method === 'GET' || method === 'HEAD') && clothingMatch) {
      writeJson(res, 404, apiErrorBody('resource_not_ready', 'Clothing thumbnail is unavailable'))
      return
    }
    const assetMatch = url.pathname.match(/^\/v1\/assets\/([^/]+)$/)
    if (method === 'GET' && assetMatch) {
      await handleAssetDetail(decodeURIComponent(assetMatch[1]!), res)
      return
    }
    const resourceMatch = url.pathname.match(/^\/v1\/assets\/([^/]+)\/resources\/([^/]+)$/)
    if ((method === 'GET' || method === 'HEAD') && resourceMatch) {
      await handleResource(
        req,
        res,
        decodeURIComponent(resourceMatch[1]!),
        decodeURIComponent(resourceMatch[2]!)
      )
      return
    }
    const exportMatch = url.pathname.match(/^\/v1\/assets\/([^/]+)\/resources\/([^/]+)\/export$/)
    if ((method === 'GET' || method === 'HEAD') && exportMatch) {
      await handleExportStill(
        req,
        res,
        url,
        decodeURIComponent(exportMatch[1]!),
        decodeURIComponent(exportMatch[2]!)
      )
      return
    }
    writeJson(res, 404, apiErrorBody('not_found', 'Route not found'))
  }

  async function handlePair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req, config.maxJsonBodyBytes)
    let parsed: PairRequest
    try {
      parsed = JSON.parse(body.toString('utf8')) as PairRequest
    } catch {
      writeJson(res, 400, apiErrorBody('bad_request', 'Pair request must be valid JSON'))
      return
    }
    if (!parsed?.pairingToken || !parsed.device?.deviceId || !parsed.device?.publicKey) {
      writeJson(res, 400, apiErrorBody('bad_request', 'Pair request is missing required fields'))
      return
    }
    try {
      writeJson(res, 200, await services.redeemToken(parsed))
    } catch (error) {
      if (error instanceof PairingError) {
        const status =
          error.code === 'pairing_expired' ? 410 : error.code === 'pairing_invalid' ? 401 : 400
        writeJson(res, status, apiErrorBody(error.code, error.message))
        return
      }
      throw error
    }
  }

  async function handleMetadataPatch(
    body: Buffer,
    assetId: string,
    res: ServerResponse
  ): Promise<void> {
    if (!ASSET_ID_PATTERN.test(assetId)) {
      writeJson(res, 404, apiErrorBody('not_found', 'Asset not found'))
      return
    }
    const detail = await services.getAssetDetail(assetId)
    if (!detail) {
      writeJson(res, 404, apiErrorBody('not_found', 'Asset not found'))
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch {
      writeJson(res, 400, apiErrorBody('bad_request', 'Metadata patch must be valid JSON'))
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      writeJson(res, 400, apiErrorBody('bad_request', 'Metadata patch must be a JSON object'))
      return
    }
    const keys = Object.keys(parsed as Record<string, unknown>)
    if (keys.length > 0) {
      // WXNN v1 协议元数据只读（含协议允许键；上游对只读/未知键同款报错文案）
      writeJson(
        res,
        400,
        apiErrorBody('bad_request', `Metadata field is read-only or unsupported: ${keys[0]!}`)
      )
      return
    }
    writeJson(res, 200, { ...detail, revision: services.getCurrentRevision() })
  }

  function handleListAssets(url: URL, res: ServerResponse): void {
    const query: AssetListQuery = {}
    const limitParam = url.searchParams.get('limit')
    if (limitParam !== null) {
      const limit = parseNonNegativeInt(limitParam)
      if (limit === undefined || limit < 1 || limit > MAX_PAGE_LIMIT) {
        writeJson(res, 400, apiErrorBody('bad_request', 'limit must be 1..500'))
        return
      }
      query.limit = limit
    }
    const cursorParam = url.searchParams.get('cursor')
    if (cursorParam !== null && cursorParam !== '') {
      if (!isValidCursor(cursorParam)) {
        writeJson(res, 400, apiErrorBody('bad_request', 'cursor is invalid'))
        return
      }
      query.cursor = cursorParam
    }
    const typeParam = url.searchParams.get('type')
    if (typeParam !== null) {
      if (!isAssetType(typeParam)) {
        writeJson(res, 400, apiErrorBody('bad_request', 'type is invalid'))
        return
      }
      query.type = typeParam
    }
    const afterRevisionParam = url.searchParams.get('afterRevision')
    if (afterRevisionParam !== null) {
      const afterRevision = parseNonNegativeInt(afterRevisionParam)
      if (afterRevision === undefined) {
        writeJson(res, 400, apiErrorBody('bad_request', 'afterRevision is invalid'))
        return
      }
      query.afterRevision = afterRevision
    }
    if (url.searchParams.get('includeDeleted') === 'true') {
      query.includeDeleted = true
    }
    writeJson(res, 200, services.listAssets(query))
  }

  function handleSearch(url: URL, res: ServerResponse): void {
    const query = (url.searchParams.get('q') ?? '').trim()
    if (!query) {
      writeJson(res, 400, apiErrorBody('bad_request', 'q is required'))
      return
    }
    if (query.length > SEARCH_QUERY_MAX_LENGTH) {
      writeJson(res, 400, apiErrorBody('bad_request', 'q is too long'))
      return
    }
    writeJson(res, 200, { query, items: [] })
  }

  async function handleChanges(url: URL, res: ServerResponse): Promise<void> {
    const afterParam = url.searchParams.get('after')
    const after = afterParam === null ? undefined : parseNonNegativeInt(afterParam)
    if (after === undefined) {
      writeJson(res, 400, apiErrorBody('bad_request', 'after revision is required'))
      return
    }
    writeJson(res, 200, await services.getChanges(after))
  }

  async function handleAssetDetail(assetId: string, res: ServerResponse): Promise<void> {
    if (!ASSET_ID_PATTERN.test(assetId)) {
      writeJson(res, 404, apiErrorBody('not_found', 'Asset not found'))
      return
    }
    const detail = await services.getAssetDetail(assetId)
    if (!detail) {
      writeJson(res, 404, apiErrorBody('not_found', 'Asset not found'))
      return
    }
    writeJson(res, 200, detail)
  }

  async function handleResource(
    req: IncomingMessage,
    res: ServerResponse,
    assetId: string,
    resourceId: string
  ): Promise<void> {
    if (!ASSET_ID_PATTERN.test(assetId)) {
      writeJson(res, 404, apiErrorBody('resource_not_ready', 'Resource not found or not ready'))
      return
    }
    const location = await services.getResourceLocation(assetId, resourceId)
    if (!location) {
      writeJson(res, 404, apiErrorBody('resource_not_ready', 'Resource not found or not ready'))
      return
    }
    let size: number
    try {
      size = (await stat(location.absolutePath)).size
    } catch {
      writeJson(res, 404, apiErrorBody('resource_not_ready', 'Source file is unavailable'))
      return
    }
    const rangeHeader = Array.isArray(req.headers.range) ? req.headers.range[0] : req.headers.range
    const range = parseRangeHeader(rangeHeader, size)
    if (range === null) {
      try {
        res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' })
        res.end()
      } catch {
        // socket 已关闭，无法响应
      }
      return
    }
    const headers: Record<string, string | number> = {
      'Content-Type': location.resource.mimeType,
      'Accept-Ranges': 'bytes',
      ETag: `"sha256:${location.resource.sha256}"`,
      'X-NikkiSync-SHA256': location.resource.sha256,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(location.resource.fileName)}`
    }
    const isHead = req.method === 'HEAD'
    if (range) {
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`
      headers['Content-Length'] = range.end - range.start + 1
      res.writeHead(206, headers)
      if (isHead) {
        res.end()
        return
      }
      createReadStream(location.absolutePath, { start: range.start, end: range.end }).pipe(res)
      return
    }
    headers['Content-Length'] = size
    res.writeHead(200, headers)
    if (isHead) {
      res.end()
      return
    }
    createReadStream(location.absolutePath).pipe(res)
  }

  /**
   * JPEG 无损导出（照抄上游 LocalSyncServer.exportStill 语义，见文件头注记）。
   * exportBusy 单飞：同一时刻只允许一个导出（上游实例字段；此处为 handler 闭包）。
   */
  let exportBusy = false

  async function handleExportStill(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    assetId: string,
    resourceId: string
  ): Promise<void> {
    const exifParam = url.searchParams.get('exif')
    const rotationParam = url.searchParams.get('rotation')
    const invalidOptions =
      Array.from(url.searchParams.keys()).some((x) => !['exif', 'rotation'].includes(x)) ||
      url.searchParams.getAll('exif').length !== 1 ||
      url.searchParams.getAll('rotation').length !== 1 ||
      !['true', 'false'].includes(exifParam ?? '') ||
      !['0', '90', '180', '270'].includes(rotationParam ?? '') ||
      req.headers.range !== undefined
    if (invalidOptions) {
      writeJson(res, 400, apiErrorBody('bad_request', 'Invalid JPEG export options'))
      return
    }
    // includes 校验无法向 TS 窄化：守卫后二者必为合法字面量集合成员
    const exif = exifParam as 'true' | 'false'
    const rotation = rotationParam as '0' | '90' | '180' | '270'
    const unavailable = apiErrorBody('resource_not_ready', 'Ordinary JPEG resource unavailable')
    if (!ASSET_ID_PATTERN.test(assetId)) {
      writeJson(res, 404, unavailable)
      return
    }
    const [location, detail] = await Promise.all([
      services.getResourceLocation(assetId, resourceId),
      services.getAssetDetail(assetId)
    ])
    // 仅就绪普通照片的 JPEG 源（motion/缩略图/视频一律 404，对齐上游约束集）
    if (
      !location ||
      !detail ||
      detail.asset.type !== 'photo' ||
      detail.asset.state !== 'ready' ||
      location.resource.role !== 'source_primary' ||
      location.resource.mimeType !== 'image/jpeg'
    ) {
      writeJson(res, 404, unavailable)
      return
    }
    if (exportBusy) {
      writeJson(
        res,
        429,
        apiErrorBody('resource_not_ready', 'Please retry after the current export')
      )
      return
    }
    exportBusy = true
    let bytes: Buffer | undefined
    let output: Buffer | undefined
    try {
      const size = location.resource.sizeBytes
      // digest('hex') 恒小写；DB 记录的形状正则允许大写十六进制，比较前归一
      const hash = location.resource.sha256.toLowerCase()
      if (
        !Number.isSafeInteger(size) ||
        size < 4 ||
        size > 16_777_216 ||
        !/^[a-f0-9]{64}$/i.test(hash)
      ) {
        throw new Error('Resource bounds')
      }
      const file = await open(location.absolutePath, 'r')
      try {
        const before = await file.stat()
        if (!before.isFile() || before.size !== size) throw new Error('Source changed')
        bytes = Buffer.alloc(size)
        let offset = 0
        while (offset < size) {
          const part = await file.read(bytes, offset, size - offset, offset)
          if (!part.bytesRead) throw new Error('Truncated')
          offset += part.bytesRead
        }
        const after = await file.stat()
        if (
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ino !== before.ino ||
          createHash('sha256').update(bytes).digest('hex') !== hash
        ) {
          throw new Error('Source changed')
        }
      } finally {
        await file.close()
      }
      output = exportJpeg(bytes, detail.asset.metadata, {
        exif: exif === 'true',
        rotation: Number(rotation) as 0 | 90 | 180 | 270
      })
      const exportedHash = createHash('sha256').update(output).digest('hex')
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': output.length,
        'X-NikkiSync-SHA256': exportedHash,
        'X-NikkiSync-Exif': exif === 'true' ? '1' : '0',
        'X-NikkiSync-Rotation': rotation,
        'X-NikkiSync-Export': 'jpeg-exif-v1',
        'Cache-Control': 'private, no-store'
      })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      await new Promise<void>((resolve) => {
        res.once('close', resolve)
        res.end(output, resolve)
      })
    } catch (error) {
      // 409 语义覆盖源变化/元数据不可安全导出/记录越界等，不能静默吞错（与外层 catch 一致记日志）
      logger?.warn(
        `[sync] export failed: ${error instanceof Error ? error.message : String(error)}`
      )
      if (!res.headersSent) {
        writeJson(
          res,
          409,
          apiErrorBody(
            'resource_not_ready',
            'Source changed or JPEG metadata cannot be safely exported'
          )
        )
      } else {
        res.destroy()
      }
    } finally {
      bytes?.fill(0)
      output?.fill(0)
      exportBusy = false
    }
  }

  return async (req, res) => {
    try {
      await dispatch(req, res)
    } catch (error) {
      if (error instanceof ApiHttpError) {
        writeJson(res, error.status, apiErrorBody(error.code, error.message))
        return
      }
      logger?.warn(
        `[sync] unhandled request error: ${error instanceof Error ? error.message : String(error)}`
      )
      writeJson(
        res,
        500,
        apiErrorBody(
          'internal_error',
          error instanceof Error ? error.message : 'Internal server error'
        )
      )
    }
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  try {
    const data = Buffer.from(JSON.stringify(body), 'utf8')
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': data.length,
      'Cache-Control': 'no-store'
    })
    res.end(data)
  } catch {
    // 客户端已断开等场景：无法响应，忽略（与上游一致不外抛）
  }
}

function parseNonNegativeInt(value: string): number | undefined {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

/** cursor 校验与 sync-row-mappers.decodeCursor 同格式：base64url(JSON {t:string非空, id:number>0}) */
function isValidCursor(value: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    return false
  }
  if (!parsed || typeof parsed !== 'object') return false
  const record = parsed as { t?: unknown; id?: unknown }
  return (
    typeof record.t === 'string' &&
    record.t !== '' &&
    typeof record.id === 'number' &&
    Number.isInteger(record.id) &&
    record.id > 0
  )
}
