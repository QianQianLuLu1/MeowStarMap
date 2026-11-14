/**
 * 热链合规一致性判定核（纯函数，零网络、零 IO；文件读取由 pre-dist-check 注入）。
 *
 * 目的：把 gongeo.us-nikki-tracker#218 与 RanAxro/nikki_albums#20 的热链授权条款
 * 钉成打包阶段闸门——「新增/变更热链时未同批同步 CSP、UA 策略或文档」即阻断打包。
 * 规范正文见根 AGENTS.md 的「热链与外部资源请求规范」章节（本闸门同时守护该章节存在）。
 *
 * 单一真相源 = 各注册表文件（本脚本只解析、不抄录主机清单，新增授权主机无需改本文件）：
 * - 渲染层直连图片主机：src/renderer/utils/resonance/cdnImageUrl.ts 的 CDN_HOST（gongeo #218）
 * - 渲染层直连瓦片主机：src/renderer/utils/world-map-tile-host.ts 的封闭集（#20 条款三）
 * - 主进程取图主机注册表：src/main/services/reference-data/image-url.ts（versioned-ua
 *   主机渲染层禁止直连，须经 media:// 本地供图）
 * - CSP 白名单：src/main/app/window-manager.ts 的 CSP_POLICY 与 src/renderer/index.html
 *   的 meta CSP（两处须逐字一致，产物级校验读 dist/renderer/index.html）
 * - UA 策略：src/main/app/cdn-user-agent.ts 的固定串（#218）+ 全 src 禁硬编码
 *   `MeowStarMap/<semver>` 版本 UA 字面量（版本化 UA 必须来自 app.getVersion()，#20 条款一）
 *
 * fail-closed：任何输入文件读不动/解析不出即判失败，绝不把「无判据」当成「合规」。
 */

// ============================================================
// 类型
// ============================================================

/** 判定问题码（fail 文案与单测共用） */
export type HotlinkProblemCode =
  | 'csp-extra-host'
  | 'csp-missing-host'
  | 'versioned-ua-host-in-csp'
  | 'csp-meta-mismatch'
  | 'dist-html-csp-missing'
  | 'fixed-ua-drift'
  | 'hardcoded-versioned-ua'
  | 'agents-doc-missing'
  | 'unparsable'

export interface HotlinkProblem {
  code: HotlinkProblemCode
  detail: string
}

export interface HotlinkPolicyInput {
  /** src/renderer/utils/resonance/cdnImageUrl.ts 源文本 */
  cdnImageUrlSrc: string
  /** src/renderer/utils/world-map-tile-host.ts 源文本 */
  tileHostSrc: string
  /** src/main/services/reference-data/image-url.ts 源文本 */
  imageUrlRegistrySrc: string
  /** src/main/app/window-manager.ts 源文本 */
  windowManagerSrc: string
  /** src/main/app/cdn-user-agent.ts 源文本 */
  cdnUserAgentSrc: string
  /** 根 AGENTS.md 源文本 */
  agentsDocSrc: string
  /** dist/renderer/index.html 产物文本；null = 产物缺失（打包前闸门会另行报缺失） */
  distRendererHtml: string | null
  /** 参与硬编码版本 UA 扫描的非测试源文件（path 相对仓库根，供问题定位） */
  uaScanSources: readonly { path: string; content: string }[]
}

// ============================================================
// 上游授权条款中的常量（条款事实，不是主机清单——主机清单只在注册表文件里）
// ============================================================

/** #218：上游网关白名单约定的固定 UA 标识（固定字符串，不含版本号） */
export const EXPECTED_FIXED_UA = 'MeowStarMap'

/** AGENTS.md 热链规范章节标题（文档漂移守护的判据） */
export const AGENTS_HOTLINK_SECTION_HEADING = '## 热链与外部资源请求规范'

/** 硬编码版本 UA 形态：MeowStarMap/2.5.6 这类字面量（模板串与 `<版本>` 占位不命中） */
const VERSIONED_UA_LITERAL = /MeowStarMap\/\d+(?:\.\d+)+/

// ============================================================
// 解析工具（全部 fail-closed：解析不出返回 null，由调用方记账）
// ============================================================

/** hostname 归一：小写 + 去尾点 */
function normalizeHost(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.$/, '')
}

/**
 * 从 CSP 文本提取 img-src 指令的外部主机集合。
 * 排除 'self'/'none' 等引号源、data:/media: 等协议源；裸主机与 https:// 前缀都算主机源。
 */
export function extractCspImgSrcHosts(cspText: string): Set<string> | null {
  const matched = /img-src\s+([^;]+);/.exec(cspText)
  if (!matched) return null
  const hosts = new Set<string>()
  for (const token of matched[1].trim().split(/\s+/)) {
    if (token.startsWith("'")) continue
    if (/^(data|media|blob|filesystem|https?:|ws|wss):$/i.test(token)) continue
    if (token === '*') continue
    const host = normalizeHost(token.replace(/^https?:\/\//i, '').replace(/\/+$/, ''))
    if (host) hosts.add(host)
  }
  return hosts
}

/**
 * 从 window-manager.ts 源文本提取 CSP_POLICY：取 `const CSP_POLICY` 声明起至空行为止的
 * 片段，拼接其中全部双引号字面量（声明以 `"..." +` 跨行拼接，单独一个字面量也可能放得下）。
 */
export function extractCspPolicyFromMainSource(src: string): string | null {
  const start = src.indexOf('const CSP_POLICY')
  if (start === -1) return null
  const rest = src.slice(start, start + 2000)
  // 空行边界需同时兼容 LF 与 CRLF（Windows 工作区 autocrlf=true 时为 \r\n\r\n）
  const end = rest.search(/\r?\n\r?\n/)
  const chunk = end === -1 ? rest : rest.slice(0, end)
  const literals = [...chunk.matchAll(/"([^"]*)"/g)].map((m) => m[1])
  if (literals.length === 0) return null
  return literals.join('')
}

/** 从 HTML 提取 Content-Security-Policy meta 的 content 属性值（属性顺序无关） */
export function extractMetaCspFromHtml(html: string): string | null {
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const meta = tag[0]
    if (!/http-equiv\s*=\s*["']?Content-Security-Policy["']?/i.test(meta)) continue
    const content = /content\s*=\s*"([^"]*)"/i.exec(meta)
    if (content) return content[1]
  }
  return null
}

/**
 * 从 image-url.ts 提取 versioned-ua 主机集合：先收 `export const XXX = 'host'` 常量表，
 * 再解析 AUTHORIZED_REFERENCE_IMAGE_HOSTS 注册表里引用这些常量的条目。
 * 字符串字面量一律引号风格无关（prettier 重排版可能改变引号）。
 */
export function extractVersionedUaHosts(src: string): Set<string> | null {
  const consts = new Map<string, string>()
  for (const m of src.matchAll(/export const (\w+)\s*=\s*(['"])([^'"]+)\2/g)) {
    consts.set(m[1], m[3])
  }
  const registry = /AUTHORIZED_REFERENCE_IMAGE_HOSTS[^{]*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/.exec(
    src
  )
  if (!registry) return null
  const hosts = new Set<string>()
  // 策略值含连字符（versioned-ua / existing-hotlink），\w 不匹配 `-`，须用 [\w-]+
  for (const entry of registry[1].matchAll(/\[(\w+)\]\s*:\s*(['"])([\w-]+)\2/g)) {
    if (entry[3] !== 'versioned-ua') continue
    const host = consts.get(entry[1])
    if (host) hosts.add(normalizeHost(host))
  }
  return hosts
}

/** 从 cdnImageUrl.ts 提取渲染层直连图片主机（CDN_HOST，含协议；引号风格无关） */
export function extractRendererImageHost(src: string): string | null {
  const matched = /const CDN_HOST\s*=\s*(['"])([^'"]+)\1/.exec(src)
  if (!matched) return null
  return normalizeHost(matched[2].replace(/^https?:\/\//i, ''))
}

/** 从 world-map-tile-host.ts 提取渲染层直连瓦片主机封闭集 */
export function extractTileHosts(src: string): Set<string> | null {
  const set = /AUTHORIZED_WORLD_MAP_TILE_HOSTS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(src)
  if (!set) return null
  const hosts = new Set<string>()
  for (const m of set[1].matchAll(/'([^']+)'/g)) hosts.add(normalizeHost(m[1]))
  return hosts
}

/** 从 cdn-user-agent.ts 提取固定 UA 串（引号风格无关） */
export function extractFixedUa(src: string): string | null {
  const matched = /export const CDN_USER_AGENT\s*=\s*(['"])([^'"]*)\1/.exec(src)
  return matched ? matched[2] : null
}

// ============================================================
// 判定核
// ============================================================

/**
 * 热链合规一致性判定（纯函数）。
 *
 * 判据链：CSP img-src 外部主机 == 渲染层直连注册表并集（图片 + 瓦片），不多不少；
 * versioned-ua 主机不在 CSP（渲染层禁直连）；两处 CSP 外部主机一致（产物级）；
 * 固定 UA 串完好；全 src 无硬编码版本 UA；AGENTS.md 规范章节在场。
 * 任何输入缺失/解析不出都产出 `unparsable` 问题，绝不静默放行。
 */
export function checkHotlinkPolicy(input: HotlinkPolicyInput): HotlinkProblem[] {
  const problems: HotlinkProblem[] = []

  // ---- 各注册表解析（任何失败都 fail-closed）----
  const rendererImageHost = extractRendererImageHost(input.cdnImageUrlSrc)
  if (!rendererImageHost) {
    problems.push({
      code: 'unparsable',
      detail: 'cdnImageUrl.ts 解析不出 CDN_HOST（渲染层直连图片主机注册表漂移）'
    })
  }
  const tileHosts = extractTileHosts(input.tileHostSrc)
  if (!tileHosts) {
    problems.push({
      code: 'unparsable',
      detail: 'world-map-tile-host.ts 解析不出 AUTHORIZED_WORLD_MAP_TILE_HOSTS（瓦片注册表漂移）'
    })
  }
  const versionedUaHosts = extractVersionedUaHosts(input.imageUrlRegistrySrc)
  if (!versionedUaHosts) {
    problems.push({
      code: 'unparsable',
      detail: 'image-url.ts 解析不出 versioned-ua 主机注册表（主进程取图注册表漂移）'
    })
  }
  const fixedUa = extractFixedUa(input.cdnUserAgentSrc)
  if (fixedUa === null) {
    problems.push({
      code: 'unparsable',
      detail: 'cdn-user-agent.ts 解析不出 CDN_USER_AGENT（固定 UA 标识漂移）'
    })
  }
  const mainCsp = extractCspPolicyFromMainSource(input.windowManagerSrc)
  const mainCspHosts = mainCsp ? extractCspImgSrcHosts(mainCsp) : null
  if (!mainCspHosts) {
    problems.push({
      code: 'unparsable',
      detail: 'window-manager.ts 解析不出 CSP_POLICY 的 img-src 主机（CSP 声明漂移）'
    })
  }

  // ---- CSP vs 渲染层直连注册表 ----
  if (mainCspHosts && rendererImageHost && tileHosts) {
    const directHosts = new Set([...tileHosts, rendererImageHost])

    for (const host of mainCspHosts) {
      if (!directHosts.has(host)) {
        problems.push({
          code: 'csp-extra-host',
          detail:
            `CSP img-src 放行了未登记为渲染层直连的外部主机 ${host}——先在上游 Issue 取得授权，` +
            '并登记进 cdnImageUrl.ts / world-map-tile-host.ts 注册表后，CSP 才能放行（见 AGENTS.md 热链规范）'
        })
      }
    }
    for (const host of directHosts) {
      if (!mainCspHosts.has(host)) {
        problems.push({
          code: 'csp-missing-host',
          detail:
            `渲染层直连注册表主机 ${host} 未获 CSP img-src 放行——window-manager.ts 与 ` +
            'src/renderer/index.html 两处 CSP 须同批补齐，否则热链被 CSP 拦成裂图'
        })
      }
    }
    for (const host of versionedUaHosts ?? []) {
      if (mainCspHosts.has(host)) {
        problems.push({
          code: 'versioned-ua-host-in-csp',
          detail:
            `versioned-ua 主机 ${host} 不得出现在 CSP img-src——该主机图片必须经主进程 fetch ` +
            '（版本化 UA + 7 天缓存）再由 media:// 本地供图，渲染层直连会绕过 #20 条款'
        })
      }
    }
  }

  // ---- 产物级：两处 CSP 一致 ----
  if (input.distRendererHtml === null) {
    problems.push({
      code: 'dist-html-csp-missing',
      detail:
        'dist/renderer/index.html 缺失或不含 CSP meta，无法做产物级一致性校验（请先 npm run build）'
    })
  } else {
    const distCsp = extractMetaCspFromHtml(input.distRendererHtml)
    const distHosts = distCsp ? extractCspImgSrcHosts(distCsp) : null
    if (!distHosts) {
      problems.push({
        code: 'dist-html-csp-missing',
        detail:
          'dist/renderer/index.html 解析不出 CSP meta（构建产物缺兜底 CSP，打包后白屏/热链被拦风险）'
      })
    } else if (mainCspHosts) {
      const mismatch = [
        ...[...mainCspHosts].filter((h) => !distHosts.has(h)).map((h) => `响应头有/产物无: ${h}`),
        ...[...distHosts].filter((h) => !mainCspHosts.has(h)).map((h) => `产物有/响应头无: ${h}`)
      ]
      if (mismatch.length > 0) {
        problems.push({
          code: 'csp-meta-mismatch',
          detail:
            `window-manager.ts 的 CSP_POLICY 与 src/renderer/index.html 的 meta CSP 外部主机不一致：` +
            `${mismatch.join('；')}（两处必须逐字一致，改一处必须同步改另一处并重新 build）`
        })
      }
    }
  }

  // ---- UA 策略 ----
  if (fixedUa !== null && fixedUa !== EXPECTED_FIXED_UA) {
    problems.push({
      code: 'fixed-ua-drift',
      detail:
        `CDN_USER_AGENT = "${fixedUa}"，偏离上游网关白名单约定的固定标识 "${EXPECTED_FIXED_UA}"` +
        '（#218：固定字符串、不含版本号/空格/附加信息；改串须先与上游重新对齐白名单）'
    })
  }
  for (const file of input.uaScanSources) {
    if (VERSIONED_UA_LITERAL.test(file.content)) {
      problems.push({
        code: 'hardcoded-versioned-ua',
        detail:
          `${file.path} 含硬编码版本 UA 字面量（MeowStarMap/<semver>）——版本化 UA 必须由 ` +
          'app.getVersion() 运行时取值，否则版本更新后 UA 谎报版本（#20 条款一）'
      })
    }
  }

  // ---- 文档漂移守护 ----
  if (!input.agentsDocSrc.includes(AGENTS_HOTLINK_SECTION_HEADING)) {
    problems.push({
      code: 'agents-doc-missing',
      detail:
        `根 AGENTS.md 缺少「${AGENTS_HOTLINK_SECTION_HEADING.replace(/^## /, '')}」章节——` +
        '热链授权事实与更新时机的规范正文是打包闸门的判据出处，不得删除或改名'
    })
  }

  return problems
}
