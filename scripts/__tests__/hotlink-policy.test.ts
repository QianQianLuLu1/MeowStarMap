import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkHotlinkPolicy,
  extractCspImgSrcHosts,
  extractCspPolicyFromMainSource,
  extractMetaCspFromHtml,
  extractVersionedUaHosts,
  extractRendererImageHost,
  extractTileHosts,
  extractFixedUa,
  EXPECTED_FIXED_UA,
  AGENTS_HOTLINK_SECTION_HEADING,
  type HotlinkPolicyInput
} from '../hotlink-policy'

/**
 * hotlink-policy 单测：热链合规一致性闸门（打包前，#218 / #20 授权条款）。
 *
 * 覆盖三类：
 *   纯函数 — CSP/img-src、注册表、meta CSP、固定 UA 的解析（正常 / 异常 / 边界）
 *   判定核 — 一致性判定的全部问题码（csp-extra-host / csp-missing-host /
 *            versioned-ua-host-in-csp / csp-meta-mismatch / dist-html-csp-missing /
 *            fixed-ua-drift / hardcoded-versioned-ua / agents-doc-missing / unparsable）
 *   真实仓库契约 — 用仓库当前真实注册表/CSP/规范文件跑判定核，必须 0 问题；
 *            在注册表、CSP 两处、UA 策略、AGENTS.md 规范章节之间建立「不同批改即红」。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// ============================================================
// 夹具：形态镜像真实文件（拼接字面量 CSP / Object.freeze 注册表 / meta CSP）
// ============================================================

/** 与 src/main/app/window-manager.ts 声明形态逐字同构（三段双引号字面量 + 空行结束） */
const WINDOW_MANAGER_FIXTURE = [
  'import { app } from "electron"',
  'const CSP_POLICY =',
  "  \"default-src 'self'; script-src 'self'; object-src 'none'; \" +",
  '  "img-src \'self\' media: data: https://cdn.gongeo.us https://assets.papegames.com; " +',
  "  \"media-src 'self' media:; style-src 'self' 'unsafe-inline'\"",
  '',
  'function applyContentSecurityPolicy(): void {}'
].join('\n')

/** 与 src/main/services/reference-data/image-url.ts 注册表形态同构 */
const IMAGE_URL_FIXTURE = [
  "export const NIKKI_ALBUMS_CDN_HOST = 'cdn.nikkialbums.com'",
  "export const GONGEO_CDN_HOST = 'cdn.gongeo.us'",
  'export const AUTHORIZED_REFERENCE_IMAGE_HOSTS: Readonly<Record<string, string>> =',
  '  Object.freeze({',
  '    [NIKKI_ALBUMS_CDN_HOST]: "versioned-ua",',
  '    [GONGEO_CDN_HOST]: "existing-hotlink"',
  '  })'
].join('\n')

const TILE_HOST_FIXTURE = [
  'export const AUTHORIZED_WORLD_MAP_TILE_HOSTS: ReadonlySet<string> = new Set([',
  "  'assets.papegames.com'",
  '])'
].join('\n')

const CDN_IMAGE_URL_FIXTURE = "const CDN_HOST = 'https://cdn.gongeo.us'"
const CDN_USER_AGENT_FIXTURE = "export const CDN_USER_AGENT = 'MeowStarMap'"

const AGENTS_DOC_FIXTURE = [
  '# AGENTS.md',
  '',
  AGENTS_HOTLINK_SECTION_HEADING,
  '',
  '热链授权事实来源：gongeo.us-nikki-tracker#218 与 RanAxro/nikki_albums#20。'
].join('\n')

const DIST_HTML_FIXTURE = [
  '<!DOCTYPE html>',
  '<html lang="zh-CN"><head>',
  '  <meta charset="UTF-8" />',
  "  <meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'self'; script-src 'self'; object-src 'none'; img-src 'self' media: data: https://cdn.gongeo.us https://assets.papegames.com; media-src 'self' media:; style-src 'self' 'unsafe-inline'\">",
  '</head><body></body></html>'
].join('\n')

/** 全绿基线夹具（真实仓库当前形态的同构镜像） */
function happyInput(overrides?: Partial<HotlinkPolicyInput>): HotlinkPolicyInput {
  return {
    cdnImageUrlSrc: CDN_IMAGE_URL_FIXTURE,
    tileHostSrc: TILE_HOST_FIXTURE,
    imageUrlRegistrySrc: IMAGE_URL_FIXTURE,
    windowManagerSrc: WINDOW_MANAGER_FIXTURE,
    cdnUserAgentSrc: CDN_USER_AGENT_FIXTURE,
    agentsDocSrc: AGENTS_DOC_FIXTURE,
    distRendererHtml: DIST_HTML_FIXTURE,
    uaScanSources: [],
    ...overrides
  }
}

// ============================================================
// 纯函数：解析
// ============================================================

describe('extractCspImgSrcHosts', () => {
  it('提取 https 外部主机，排除 self/协议源/引号源', () => {
    expect(
      extractCspImgSrcHosts(
        "img-src 'self' media: data: https://CDN.gongeo.us https://assets.papegames.com;"
      )
    ).toEqual(new Set(['cdn.gongeo.us', 'assets.papegames.com']))
  })

  it('裸主机名同样算主机源（CSP 语义：无 scheme 匹配任意协议）', () => {
    expect(extractCspImgSrcHosts('img-src cdn.gongeo.us;')).toEqual(new Set(['cdn.gongeo.us']))
  })

  it('无 img-src 指令返回 null（fail-closed）', () => {
    expect(extractCspImgSrcHosts("default-src 'self';")).toBeNull()
  })
})

describe('extractCspPolicyFromMainSource', () => {
  it('拼接跨行双引号字面量为完整 CSP', () => {
    const csp = extractCspPolicyFromMainSource(WINDOW_MANAGER_FIXTURE)
    expect(csp).toContain(
      "img-src 'self' media: data: https://cdn.gongeo.us https://assets.papegames.com;"
    )
    expect(csp).toContain("style-src 'self' 'unsafe-inline'")
  })

  it('单字面量声明同样可解析', () => {
    expect(
      extractCspPolicyFromMainSource('const CSP_POLICY = "img-src https://a.test;"\n\nx')
    ).toBe('img-src https://a.test;')
  })

  it('无 CSP_POLICY 声明返回 null（fail-closed）', () => {
    expect(extractCspPolicyFromMainSource('const OTHER = "img-src https://a.test;"')).toBeNull()
  })
})

describe('extractMetaCspFromHtml', () => {
  it('属性顺序无关地提取 meta CSP', () => {
    const html = '<meta content="img-src https://a.test;" http-equiv="Content-Security-Policy">'
    expect(extractMetaCspFromHtml(html)).toBe('img-src https://a.test;')
  })

  it('无 meta CSP 返回 null（fail-closed）', () => {
    expect(extractMetaCspFromHtml('<meta charset="UTF-8" />')).toBeNull()
  })
})

describe('extractVersionedUaHosts', () => {
  it('仅收 versioned-ua 策略的主机，existing-hotlink 不在列', () => {
    expect(extractVersionedUaHosts(IMAGE_URL_FIXTURE)).toEqual(new Set(['cdn.nikkialbums.com']))
  })

  it('注册表缺失返回 null（fail-closed）', () => {
    expect(extractVersionedUaHosts("export const A = 'a.test'")).toBeNull()
  })
})

describe('注册表/UA 提取', () => {
  it('CDN_HOST、瓦片封闭集与固定 UA', () => {
    expect(extractRendererImageHost(CDN_IMAGE_URL_FIXTURE)).toBe('cdn.gongeo.us')
    expect(extractTileHosts(TILE_HOST_FIXTURE)).toEqual(new Set(['assets.papegames.com']))
    expect(extractFixedUa(CDN_USER_AGENT_FIXTURE)).toBe(EXPECTED_FIXED_UA)
  })

  it('形态漂移时返回 null（fail-closed）', () => {
    expect(extractRendererImageHost('const OTHER = "x"')).toBeNull()
    expect(extractTileHosts('const OTHER = new Map()')).toBeNull()
    expect(extractFixedUa('export const OTHER = "MeowStarMap"')).toBeNull()
  })
})

// ============================================================
// 判定核：问题码全覆盖
// ============================================================

describe('checkHotlinkPolicy', () => {
  it('全绿基线：当前真实形态 0 问题', () => {
    expect(checkHotlinkPolicy(happyInput())).toEqual([])
  })

  it('csp-extra-host：CSP 放行未登记直连主机', () => {
    const problems = checkHotlinkPolicy(
      happyInput({
        windowManagerSrc: WINDOW_MANAGER_FIXTURE.replace(
          'https://assets.papegames.com;',
          'https://assets.papegames.com https://evil.example.test;'
        )
      })
    )
    expect(problems.map((p) => p.code)).toContainEqual('csp-extra-host')
    expect(problems.find((p) => p.code === 'csp-extra-host')?.detail).toContain('evil.example.test')
  })

  it('csp-missing-host：直连注册表主机未获 CSP 放行', () => {
    const problems = checkHotlinkPolicy(
      happyInput({
        windowManagerSrc: WINDOW_MANAGER_FIXTURE.replace(' https://assets.papegames.com', ''),
        distRendererHtml: DIST_HTML_FIXTURE.replace(' https://assets.papegames.com', '')
      })
    )
    expect(problems.map((p) => p.code)).toContainEqual('csp-missing-host')
  })

  it('versioned-ua-host-in-csp：主进程取图主机被渲染层直连放行', () => {
    const problems = checkHotlinkPolicy(
      happyInput({
        windowManagerSrc: WINDOW_MANAGER_FIXTURE.replace(
          'https://cdn.gongeo.us ',
          'https://cdn.gongeo.us https://cdn.nikkialbums.com '
        ),
        distRendererHtml: DIST_HTML_FIXTURE.replace(
          'https://cdn.gongeo.us ',
          'https://cdn.gongeo.us https://cdn.nikkialbums.com '
        )
      })
    )
    expect(problems.map((p) => p.code)).toContainEqual('versioned-ua-host-in-csp')
  })

  it('csp-meta-mismatch：响应头与产物 meta CSP 外部主机不一致', () => {
    const problems = checkHotlinkPolicy(
      happyInput({
        distRendererHtml: DIST_HTML_FIXTURE.replace(' https://assets.papegames.com', '')
      })
    )
    expect(problems.map((p) => p.code)).toContainEqual('csp-meta-mismatch')
    expect(problems.find((p) => p.code === 'csp-meta-mismatch')?.detail).toContain(
      '响应头有/产物无'
    )
  })

  it('dist-html-csp-missing：产物缺失或无 meta CSP 均 fail-closed', () => {
    for (const distRendererHtml of [null, '<html><head></head></html>']) {
      const problems = checkHotlinkPolicy(happyInput({ distRendererHtml }))
      expect(problems.map((p) => p.code)).toContainEqual('dist-html-csp-missing')
    }
  })

  it('fixed-ua-drift：固定 UA 偏离上游白名单约定串', () => {
    const problems = checkHotlinkPolicy(
      happyInput({
        cdnUserAgentSrc: "export const CDN_USER_AGENT = 'MeowStarMap/2.5.7'"
      })
    )
    expect(problems.map((p) => p.code)).toContainEqual('fixed-ua-drift')
  })

  it('hardcoded-versioned-ua：源文件硬编码版本 UA 字面量（模板串与占位符不误报）', () => {
    const problems = checkHotlinkPolicy(
      happyInput({
        uaScanSources: [
          {
            path: 'src/main/services/a.ts',
            content: "headers: { 'User-Agent': 'MeowStarMap/2.5.7' }"
          }
        ]
      })
    )
    expect(problems.map((p) => p.code)).toContainEqual('hardcoded-versioned-ua')
  })

  it('模板串与注释占位不构成硬编码版本 UA（不误报）', () => {
    const problems = checkHotlinkPolicy(
      happyInput({
        uaScanSources: [
          {
            path: 'src/main/services/reference-image-service.ts',
            content: 'const UA = `MeowStarMap/${deps.getAppVersion()}` // 注释 MeowStarMap/<版本>'
          }
        ]
      })
    )
    expect(problems.map((p) => p.code)).not.toContainEqual('hardcoded-versioned-ua')
  })

  it('agents-doc-missing：规范章节被删或改名即红', () => {
    const problems = checkHotlinkPolicy(
      happyInput({ agentsDocSrc: '# AGENTS.md\n\n（热链规范已被误删）' })
    )
    expect(problems.map((p) => p.code)).toContainEqual('agents-doc-missing')
  })

  it('unparsable：任一注册表文件读不动/解析不出都 fail-closed', () => {
    const problems = checkHotlinkPolicy(
      happyInput({
        cdnImageUrlSrc: 'const DRIFTED = true',
        tileHostSrc: '',
        imageUrlRegistrySrc: ''
      })
    )
    expect(problems.filter((p) => p.code === 'unparsable').length).toBeGreaterThanOrEqual(3)
  })
})

// ============================================================
// 真实仓库契约：注册表 / CSP 两处 / UA / 规范章节 不同批改即红
// ============================================================

/** 与 pre-dist-check.collectUaScanSources 同域：src/main + src/renderer 的非测试源文件 */
function collectUaScanSourcesForContract(): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__tests__') continue
        walk(full)
      } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
        if (/\.test\.|\.stories\./.test(entry.name)) continue
        out.push({
          path: path.relative(repoRoot, full).replace(/\\/g, '/'),
          content: readFileSync(full, 'utf-8')
        })
      }
    }
  }
  walk(path.join(repoRoot, 'src', 'main'))
  walk(path.join(repoRoot, 'src', 'renderer'))
  return out
}

describe('真实仓库热链契约', () => {
  it('当前仓库 0 问题：CSP == 直连注册表并集、versioned-ua 不直连、UA 与规范在位', () => {
    const read = (relative: string): string => readFileSync(path.join(repoRoot, relative), 'utf-8')
    const problems = checkHotlinkPolicy({
      cdnImageUrlSrc: read('src/renderer/utils/resonance/cdnImageUrl.ts'),
      tileHostSrc: read('src/renderer/utils/world-map-tile-host.ts'),
      imageUrlRegistrySrc: read('src/main/services/reference-data/image-url.ts'),
      windowManagerSrc: read('src/main/app/window-manager.ts'),
      cdnUserAgentSrc: read('src/main/app/cdn-user-agent.ts'),
      agentsDocSrc: read('AGENTS.md'),
      // 源级契约用 src/renderer/index.html（与打包态 dist/renderer/index.html 同文同源，
      // 构建产物形态由 pre-dist-check 的产物级校验承担）
      distRendererHtml: read('src/renderer/index.html'),
      uaScanSources: collectUaScanSourcesForContract()
    })
    expect(problems).toEqual([])
  })
})
