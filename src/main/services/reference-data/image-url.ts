// @core-change: 新增参考数据 CDN 图片的按主机授权注册表与地址生成纯函数（阶段 5 取图前置判定）
/**
 * Nuan5NetworkImage 地址生成 + 按主机授权核实（纯函数，零网络、零 IO）。
 *
 * 授权事实来源（已直读原文）：
 * - RanAxro/nikki_albums **#20**：`cdn.nikkialbums.com` 上的图片资源允许接入，条件是
 *   请求标识为「应用名称/版本号」、本地缓存约 7 天、禁高频请求、禁二次分发/镜像/再托管。
 *   作者同时明确 `cloth` / `cloth_outfit` **不在其授权范围**（归 gongeo.us 作者）。
 * - dastrokes/gongeo.us-nikki-tracker **#218**：`cdn.gongeo.us` 热链**已批准**，要求携带
 *   可识别来源的 UA。本项目既有衣橱链路已通过 `app/cdn-user-agent.ts` 的 webRequest
 *   注入固定 UA 满足该条件，故本阶段**不为其新建取图路径**（避免两套 UA 规则混用）。
 *
 * 因此授权判定按 **resolved URL 的实际 hostname** 而非按 kind 硬编码信任：v1.db 属运行时
 * 数据，若上游把某类别的 baseUrl 漂移到未授权域，这里 fail-closed 返回 null（渲染层回退
 * 占位），不会把未授权主机的资源偷偷接入。
 *
 * 加速/镜像入口（设置键 `referenceData.imageMirrorBaseUrl`）只替换已授权资源的
 * protocol+host+port（含反代子路径前缀），path/query/hash 原样保留；应用不内置、
 * 不代建节点，镜像地址由用户自行填写并过 SSRF 守卫。
 */

import { createHash } from 'node:crypto'
import { isForbiddenHost } from '../../utils/remote-url-guard'
import { NETWORK_IMAGE_KINDS, type NetworkImageKind } from './nuan5-config-proto'
import type { NetworkImageTemplateInfo } from '../../../shared/types/electron-api'

/** RanAxro #20 授权的 CDN 主机（本阶段新接入，UA 须为「应用名/版本」） */
export const NIKKI_ALBUMS_CDN_HOST = 'cdn.nikkialbums.com'
/** dastrokes #218 已批准的 CDN 主机（既有热链路径，不经本阶段新取图链路） */
export const GONGEO_CDN_HOST = 'cdn.gongeo.us'

/**
 * 主机处置策略：
 * - `versioned-ua`：本阶段新接入，主进程 fetch 携带 `MeowStarMap/<版本>` 并落应用层缓存
 * - `existing-hotlink`：已由既有渲染层热链 + `cdn-user-agent.ts` 固定 UA 覆盖，不重复接入
 */
export type ReferenceImageHostPolicy = 'versioned-ua' | 'existing-hotlink'

/**
 * 已核实授权的主机注册表（封闭集）。
 * 新增主机前必须先取得对应权利方的明确授权，禁止投机性扩展。
 */
export const AUTHORIZED_REFERENCE_IMAGE_HOSTS: Readonly<Record<string, ReferenceImageHostPolicy>> =
  Object.freeze({
    [NIKKI_ALBUMS_CDN_HOST]: 'versioned-ua',
    [GONGEO_CDN_HOST]: 'existing-hotlink'
  })

export interface ResolveNetworkImageUrlInput {
  /** 图片类别（须属于 NETWORK_IMAGE_KINDS） */
  kind: NetworkImageKind | string
  /** 资源取值（正安全整数；替换模板占位串） */
  id: number
  /** `getNetworkImageTemplates()` 的当前快照 */
  templates: readonly NetworkImageTemplateInfo[]
  /** 用户自配的加速/镜像入口（空/空白 = 未配置，走原始地址） */
  mirrorBaseUrl?: string
}

export interface ResolvedReferenceImage {
  /** 实际取图地址（已应用镜像入口；主进程 fetch 的目标） */
  fetchUrl: string
  /** 缓存键 = sha256("<kind>:<id>")，与镜像无关（换镜像不失效缓存） */
  cacheKey: string
  /** **授权主机**的 hostname（UA 选择依据；配了镜像也不改写） */
  host: string
  /** 该主机的处置策略 */
  policy: ReferenceImageHostPolicy
}

/** hostname 归一：小写 + 去 FQDN 尾点（注册表精确匹配的前置） */
function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, '')
}

/**
 * 按主机核实授权状态。
 * @returns 已登记主机的策略；未登记（含空串、子域伪装、后缀伪装）返回 null = 授权不明，不接入
 */
export function getReferenceImageHostPolicy(hostname: string): ReferenceImageHostPolicy | null {
  if (typeof hostname !== 'string') return null
  const normalized = normalizeHost(hostname)
  if (!normalized) return null
  return Object.prototype.hasOwnProperty.call(AUTHORIZED_REFERENCE_IMAGE_HOSTS, normalized)
    ? AUTHORIZED_REFERENCE_IMAGE_HOSTS[normalized]
    : null
}

function isNetworkImageKind(kind: unknown): kind is NetworkImageKind {
  return typeof kind === 'string' && (NETWORK_IMAGE_KINDS as readonly string[]).includes(kind)
}

/** 缓存键：kind+id 的 sha256 hex（定长、无路径分隔符，天然无穿越面） */
export function buildReferenceImageCacheKey(kind: string, id: number): string {
  return createHash('sha256').update(`${kind}:${id}`).digest('hex')
}

/**
 * 把镜像入口套到已授权地址上：替换 protocol+host+port，镜像自带 path 作为前缀，
 * 原 path/query/hash 保留。镜像非法（不可解析 / 非 http(s) / 环回私网保留段）返回 null。
 *
 * 刻意**不回退原始地址**：用户显式配了镜像却静默走原始地址，会让「配了没生效」
 * 与「配了生效」两种状态无法区分，属静默失败。
 */
function applyMirror(origin: URL, mirrorBaseUrl: string | undefined): string | null {
  const raw = typeof mirrorBaseUrl === 'string' ? mirrorBaseUrl.trim() : ''
  if (!raw) return origin.toString()

  let mirror: URL
  try {
    mirror = new URL(raw)
  } catch {
    return null
  }
  if (mirror.protocol !== 'https:' && mirror.protocol !== 'http:') return null
  if (isForbiddenHost(normalizeHost(mirror.hostname))) return null

  const prefixed = new URL(origin.toString())
  prefixed.protocol = mirror.protocol
  prefixed.hostname = mirror.hostname
  prefixed.port = mirror.port
  prefixed.username = ''
  prefixed.password = ''
  // 镜像的 path 作为反代子路径前缀（尾斜杠归一，避免双斜杠）
  const prefix = mirror.pathname.replace(/\/+$/, '')
  if (prefix) prefixed.pathname = `${prefix}${prefixed.pathname}`
  return prefixed.toString()
}

/**
 * 按类别与取值生成实际图片地址，并按主机核实授权。
 *
 * @returns 已授权（`versioned-ua`）资源的取图信息；以下情形一律 null（调用方回退占位）：
 *   kind 非法 / id 非正安全整数 / 模板缺失 / baseUrl 不可解析或非 http(s) / replace 空 /
 *   baseUrl 指向环回私网 / 主机未登记或属既有热链（gongeo）/ 镜像入口非法。
 */
export function resolveNetworkImageUrl(
  input: ResolveNetworkImageUrlInput
): ResolvedReferenceImage | null {
  if (!input || typeof input !== 'object') return null
  const { kind, id, templates } = input
  if (!isNetworkImageKind(kind)) return null
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null
  if (!Array.isArray(templates)) return null

  // 首条命中即用（索引构建侧已按 kind 去重，此处为防御性口径）
  const template = templates.find((item) => item && item.kind === kind)
  if (!template) return null

  const baseUrl = typeof template.baseUrl === 'string' ? template.baseUrl.trim() : ''
  const replace = typeof template.replace === 'string' ? template.replace : ''
  if (!baseUrl || !replace) return null

  let origin: URL
  try {
    // replaceAll：占位串在模板中多次出现时须全量替换（上游 flutter 侧同为全量替换语义）
    origin = new URL(baseUrl.replaceAll(replace, String(id)))
  } catch {
    return null
  }
  if (origin.protocol !== 'https:' && origin.protocol !== 'http:') return null

  const host = normalizeHost(origin.hostname)
  // SSRF 兜底：v1.db 属外部数据，即便主机名不在注册表也先过危险地址段闸门
  if (isForbiddenHost(host)) return null
  // 授权核实：只有 versioned-ua（本阶段新接入）走新取图路径；
  // existing-hotlink（gongeo）返回 null 让调用方继续用既有衣橱热链；未登记 → fail-closed
  if (getReferenceImageHostPolicy(host) !== 'versioned-ua') return null

  const fetchUrl = applyMirror(origin, input.mirrorBaseUrl)
  if (fetchUrl === null) return null

  return {
    fetchUrl,
    cacheKey: buildReferenceImageCacheKey(kind, id),
    host,
    policy: 'versioned-ua'
  }
}
