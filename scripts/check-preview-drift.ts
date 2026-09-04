/**
 * preview.html ↔ src/renderer/ 漂移检测脚本
 * 自动审计手写预览版与 exe 源码的关键漂移点，对应 preview-html治理计划.md Task 1
 * 用法：npm run preview:check
 *
 * 检测维度（10 项）：
 *   1. 侧边栏导航项漂移（preview SIDEBAR_NAV_ITEMS vs Sidebar.tsx navItems）
 *   2. CSS 变量漂移（preview :root/.soft-pink-luxury vs globals.css + themes/soft-pink-luxury.css）
 *   3. i18n 覆盖率（preview 硬编码中文 vs zh-CN.json key 数）
 *   4. exifr 版本一致性（preview CDN vs package.json）
 *   5. 页面覆盖率（preview view IDs vs exe pages/*.tsx）
 *   6. 视图模式（preview vs exe GalleryPage viewMode 字面量）
 *   7. 编辑器工具栏（preview vs exe EditorToolbar action 标识）
 *   8. 编辑器 Tab（preview vs exe EditorTabs 7 个 tab id）
 *   9. 状态栏覆盖（gallery/detail/categories/settings 4 个核心页面）
 *  10. CDN 依赖版本一致性（preview CDN 引用 vs package.json dependencies）
 *
 * 退出码：0 = 无致命漂移；1 = 存在致命漂移（i18n 覆盖率过低等）
 * 注：导航项/页面覆盖率检测项已因预览版改为源码构建而降级为 WARN（不再阻断退出码）
 */
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

// ESM 环境下 __dirname 不存在，需从 import.meta.url 推导
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PREVIEW_PATH = path.join(ROOT, 'preview.html')
const SIDEBAR_TSX_PATH = path.join(ROOT, 'src', 'renderer', 'components', 'layout', 'Sidebar.tsx')
const GLOBALS_CSS_PATH = path.join(ROOT, 'src', 'renderer', 'styles', 'globals.css')
const THEME_PINK_CSS_PATH = path.join(
  ROOT,
  'src',
  'renderer',
  'styles',
  'themes',
  'soft-pink-luxury.css'
)
const ZH_CN_PATH = path.join(ROOT, 'src', 'renderer', 'i18n', 'locales', 'zh-CN.json')
const PACKAGE_JSON_PATHS = [path.join(ROOT, 'package.json')]
const PAGES_DIR = path.join(ROOT, 'src', 'renderer', 'pages')
const GALLERY_PAGE_TSX = path.join(PAGES_DIR, 'GalleryPage.tsx')
const EDITOR_TOOLBAR_TSX = path.join(
  ROOT,
  'src',
  'renderer',
  'components',
  'editor',
  'EditorToolbar.tsx'
)
const EDITOR_TABS_TSX = path.join(ROOT, 'src', 'renderer', 'components', 'editor', 'EditorTabs.tsx')

interface CheckResult {
  name: string
  status: 'PASS' | 'WARN' | 'FAIL'
  detail: string
}

interface PackageJson {
  dependencies?: Record<string, string>
}

const results: CheckResult[] = []

function readText(p: string): string {
  return fs.readFileSync(p, 'utf8')
}

function readJson<T>(p: string): T {
  return JSON.parse(readText(p)) as T
}

// root package.json 在未 promote 状态下不含完整依赖；
// 依次尝试候选路径，返回首个含 dependencies 字段的文件内容
function readPackageJson(): PackageJson {
  for (const p of PACKAGE_JSON_PATHS) {
    if (!fs.existsSync(p)) continue
    const pkg = readJson<PackageJson>(p)
    if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) return pkg
  }
  return {}
}

// ---------- 1. 导航项漂移 ----------
// 注：预览版已从源码构建（vite-plugin-singlefile），preview.html 为压缩 bundle，
// 不再包含可读的 SIDEBAR_NAV_ITEMS 模式。此项降级为 WARN，后续迁移到策略 A（源码一致性检测）。
function checkNavItems(): void {
  const preview = readText(PREVIEW_PATH)
  const sidebarTsx = readText(SIDEBAR_TSX_PATH)

  // 从 preview.html 提取 SIDEBAR_NAV_ITEMS 的 id
  const navBlock = preview.match(/SIDEBAR_NAV_ITEMS\s*=\s*\[([\s\S]*?)\]/)
  const previewIds = new Set<string>()
  if (navBlock) {
    const idMatches = navBlock[1].matchAll(/id:\s*['"]([^'"]+)['"]/g)
    for (const m of idMatches) previewIds.add(m[1])
  }

  // 从 Sidebar.tsx 提取 navItems 数组的 id（不含 detail/editor 等子页面）
  // Sidebar.tsx 中形如：const navItems = [ { id: 'gallery', ... }, ... ]
  const exeNavMatch = sidebarTsx.match(/const navItems[^=]*=\s*\[([\s\S]*?)\]/)
  const exeIds = new Set<string>()
  if (exeNavMatch) {
    const idMatches = exeNavMatch[1].matchAll(/id:\s*['"]([^'"]+)['"]/g)
    for (const m of idMatches) exeIds.add(m[1])
  }

  if (previewIds.size === 0 || exeIds.size === 0) {
    results.push({
      name: '导航项',
      status: 'WARN',
      detail: `解析失败（新架构 preview.html 为压缩 bundle，此项不适用）：preview=${previewIds.size} 项，exe=${exeIds.size} 项`
    })
    return
  }

  const missingInPreview = [...exeIds].filter((id) => !previewIds.has(id))
  const extraInPreview = [...previewIds].filter((id) => !exeIds.has(id))

  if (missingInPreview.length === 0 && extraInPreview.length === 0) {
    results.push({
      name: '导航项',
      status: 'PASS',
      detail: `导航项一致（${previewIds.size} 项）`
    })
  } else {
    const parts: string[] = []
    if (missingInPreview.length > 0) parts.push(`preview 缺失：${missingInPreview.join(', ')}`)
    if (extraInPreview.length > 0) parts.push(`preview 多余：${extraInPreview.join(', ')}`)
    results.push({
      name: '导航项',
      status: 'WARN',
      detail: parts.join('；')
    })
  }
}

// ---------- 2. CSS 变量漂移 ----------
function extractCssVars(css: string, selector: string): Set<string> {
  // 匹配 selector { ... } 块（容忍换行）
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]+)\\}`)
  const block = css.match(re)
  if (!block) return new Set()
  const vars = new Set<string>()
  const varRe = /(--[a-zA-Z0-9-]+)\s*:/g
  let m: RegExpExecArray | null
  while ((m = varRe.exec(block[1])) !== null) vars.add(m[1])
  return vars
}

function checkCssVars(): void {
  const preview = readText(PREVIEW_PATH)
  // exe 侧：:root 在 globals.css，.soft-pink-luxury 在 themes/soft-pink-luxury.css
  const globals = readText(GLOBALS_CSS_PATH)
  const themePink = fs.existsSync(THEME_PINK_CSS_PATH) ? readText(THEME_PINK_CSS_PATH) : ''

  const selectors = [':root', '.soft-pink-luxury']
  const parts: string[] = []
  let hasWarn = false

  for (const sel of selectors) {
    const previewVars = extractCssVars(preview, sel)
    // :root 从 globals.css 取，.soft-pink-luxury 从 themePink 取
    const exeSource = sel === ':root' ? globals : themePink
    const exeVars = extractCssVars(exeSource, sel)
    if (previewVars.size === 0 || exeVars.size === 0) {
      parts.push(`${sel}：解析失败（preview=${previewVars.size}, exe=${exeVars.size}）`)
      hasWarn = true
      continue
    }
    const missing = [...exeVars].filter((v) => !previewVars.has(v))
    const extra = [...previewVars].filter((v) => !exeVars.has(v))
    if (missing.length === 0 && extra.length === 0) {
      parts.push(`${sel}：一致（${previewVars.size} 个变量）`)
    } else {
      // CSS 变量漂移为 WARN：preview 可能不必引用每个 spacing token
      hasWarn = true
      const sub: string[] = []
      if (missing.length > 0)
        sub.push(
          `缺失 ${missing.length} 个：${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '...' : ''}`
        )
      if (extra.length > 0)
        sub.push(
          `多余 ${extra.length} 个：${extra.slice(0, 5).join(', ')}${extra.length > 5 ? '...' : ''}`
        )
      parts.push(`${sel}：${sub.join('；')}`)
    }
  }

  results.push({
    name: 'CSS 变量',
    status: hasWarn ? 'WARN' : 'PASS',
    detail: parts.join(' | ')
  })
}

// ---------- 3. i18n 覆盖率 ----------
function countKeys(obj: unknown): number {
  let n = 0
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const v of Object.values(obj as Record<string, unknown>)) {
      if (v && typeof v === 'object') n += countKeys(v)
      else n += 1
    }
  }
  return n
}

function checkI18nCoverage(): void {
  const preview = readText(PREVIEW_PATH)
  const zhCN = readJson<unknown>(ZH_CN_PATH)
  const totalKeys = countKeys(zhCN)

  // 统计 preview.html 中硬编码中文片段数量（去重）
  const chineseRe = /[\u4e00-\u9fa5]{2,}/g
  const matches = preview.match(chineseRe) || []
  const uniqueChinese = new Set(matches)

  // 覆盖率：preview 中出现的 zh-CN value 数 / totalKeys
  // 收集 zh-CN 所有字符串 value
  const values: string[] = []
  function collect(obj: unknown): void {
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const v of Object.values(obj as Record<string, unknown>)) {
        if (v && typeof v === 'object') collect(v)
        else if (typeof v === 'string' && /[\u4e00-\u9fa5]/.test(v)) values.push(v)
      }
    }
  }
  collect(zhCN)

  let hit = 0
  for (const v of values) {
    if (preview.includes(v)) hit += 1
  }
  const coverage = values.length > 0 ? Math.round((hit / values.length) * 100) : 0

  // 覆盖率低于 60% 报警（preview 手写，不可能 100% 对齐 value 文案）
  const status: CheckResult['status'] = coverage >= 60 ? 'PASS' : coverage >= 40 ? 'WARN' : 'FAIL'
  results.push({
    name: 'i18n 覆盖率',
    status,
    detail: `zh-CN key 数=${totalKeys}；preview 命中=${hit}/${values.length}（${coverage}%）；preview 硬编码中文片段=${uniqueChinese.size}`
  })
}

// ---------- 4. exifr 版本 ----------
function checkExifrVersion(): void {
  const preview = readText(PREVIEW_PATH)
  const pkg = readPackageJson()

  const cdnMatch = preview.match(/exifr@(\d+\.\d+\.\d+)/)
  const cdnVersion = cdnMatch ? cdnMatch[1] : null
  const pkgVersion = pkg.dependencies?.exifr ?? null
  // package.json 中是 ^7.1.3 形式，提取实际版本号
  const pkgClean = pkgVersion ? pkgVersion.replace(/^[^0-9]+/, '') : null

  if (!cdnVersion || !pkgClean) {
    results.push({
      name: 'exifr 版本',
      status: 'WARN',
      detail: `解析失败：cdn=${cdnVersion}, package.json=${pkgClean}`
    })
    return
  }

  if (cdnVersion === pkgClean) {
    results.push({
      name: 'exifr 版本',
      status: 'PASS',
      detail: `版本一致：${cdnVersion}`
    })
  } else {
    results.push({
      name: 'exifr 版本',
      status: 'WARN',
      detail: `版本不一致：preview CDN=${cdnVersion}, package.json=${pkgClean}`
    })
  }
}

// ---------- 5. 页面覆盖率 ----------
// preview 缺失 exe 一级页面视为漂移
// 注：预览版已从源码构建，preview.html 为压缩 bundle，不再包含可读的 case 'xxx': 模式。
// 此项降级为 WARN（新架构下页面覆盖由源码路由保证），后续迁移到策略 A（源码一致性检测）。
const ALLOWED_MISSING_PAGES = new Set(['launcher-cache'])

// CamelCase → kebab-case，并剥离 Page 后缀
// GalleryPage → gallery，RecycleBinPage → recycle-bin，OutfitGalleryPage → outfit-gallery
function pageFileToViewId(filename: string): string {
  const base = filename.replace(/\.tsx$/i, '').replace(/Page$/i, '')
  return base.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

function checkPageCoverage(): void {
  const preview = readText(PREVIEW_PATH)
  // exe 侧：扫描 pages/*.tsx 一级页面（排除 settings 子目录与 backup）
  let exePages: string[] = []
  if (fs.existsSync(PAGES_DIR)) {
    exePages = fs
      .readdirSync(PAGES_DIR)
      .filter((f) => f.endsWith('.tsx') && !f.includes('backup'))
      .map(pageFileToViewId)
  }

  // preview 侧：从 case 'xxx': / === 'xxx' / SIDEBAR_NAV_ITEMS.id 中提取视图标识
  const viewIds = new Set<string>()
  const caseMatches = preview.matchAll(/case\s+['"]([a-z-]+)['"]\s*:/g)
  for (const m of caseMatches) viewIds.add(m[1].toLowerCase())
  const viewMatches = preview.matchAll(/===?\s*['"]([a-z-]+)['"]/g)
  for (const m of viewMatches) viewIds.add(m[1].toLowerCase())

  const missing = exePages.filter((p) => !viewIds.has(p) && !ALLOWED_MISSING_PAGES.has(p))

  if (missing.length === 0) {
    results.push({
      name: '页面覆盖率',
      status: 'PASS',
      detail: `preview 覆盖全部 exe 一级页面（${exePages.length} 项）`
    })
  } else {
    results.push({
      name: '页面覆盖率',
      status: 'WARN',
      detail: `preview 缺失页面（新架构此项不适用）：${missing.join(', ')}`
    })
  }
}

// ---------- 6. 视图模式 ----------
function checkViewModes(): void {
  const preview = readText(PREVIEW_PATH)
  const galleryTsx = fs.existsSync(GALLERY_PAGE_TSX) ? readText(GALLERY_PAGE_TSX) : ''
  const knownModes = ['grid', 'list', 'timeline', 'masonry', 'event-timeline']

  const exeModes = new Set<string>()
  for (const m of galleryTsx.matchAll(/['"]?(grid|list|timeline|masonry|event-timeline)['"]?/g)) {
    exeModes.add(m[1])
  }
  if (exeModes.size === 0) {
    // 兜底：uiStore.ts 中 ViewMode 类型已声明 5 种视图，按已知集合校验
    for (const m of knownModes) exeModes.add(m)
  }

  const previewModes = new Set<string>()
  for (const m of preview.matchAll(/['"]?(grid|list|timeline|masonry|event-timeline)['"]?/g)) {
    previewModes.add(m[1])
  }

  const missing = [...exeModes].filter((m) => !previewModes.has(m))
  if (missing.length === 0) {
    results.push({ name: '视图模式', status: 'PASS', detail: `一致（${exeModes.size} 种）` })
  } else {
    results.push({
      name: '视图模式',
      status: 'WARN',
      detail: `preview 缺失视图：${missing.join(', ')}`
    })
  }
}

// ---------- 7. 编辑器工具栏 ----------
// 已知 action 集合：onUndo/onRedo/onReset/onCompareStart/onSave/onSaveAs/onCopyParams 等
const KNOWN_EDITOR_ACTIONS = [
  'undo',
  'redo',
  'reset',
  'compare',
  'save',
  'saveAs',
  'copyParams',
  'pasteParams',
  'applyToSelected',
  'fullscreen',
  'exit',
  'shortcuts'
]

// 检测文本中是否声明/引用了某个 action（on<Action> 边界匹配，或 'action' 字面量）
function hasEditorAction(text: string, action: string): boolean {
  const pascal = action.charAt(0).toUpperCase() + action.slice(1)
  return new RegExp(`\\bon${pascal}\\b|['"]${action}['"]`).test(text)
}

function checkEditorToolbar(): void {
  const preview = readText(PREVIEW_PATH)
  const toolbarTsx = fs.existsSync(EDITOR_TOOLBAR_TSX) ? readText(EDITOR_TOOLBAR_TSX) : ''

  const exeActions = new Set(KNOWN_EDITOR_ACTIONS.filter((a) => hasEditorAction(toolbarTsx, a)))
  const previewActions = new Set(KNOWN_EDITOR_ACTIONS.filter((a) => hasEditorAction(preview, a)))

  const missing = [...exeActions].filter((a) => !previewActions.has(a))
  if (missing.length === 0) {
    results.push({ name: '编辑器工具栏', status: 'PASS', detail: `一致（${exeActions.size} 项）` })
  } else {
    results.push({
      name: '编辑器工具栏',
      status: 'WARN',
      detail: `preview 缺失：${missing.join(', ')}`
    })
  }
}

// ---------- 8. 编辑器 Tab ----------
function checkEditorTabs(): void {
  const preview = readText(PREVIEW_PATH)
  const tabsTsx = fs.existsSync(EDITOR_TABS_TSX) ? readText(EDITOR_TABS_TSX) : ''
  // exe EditorTabs.tsx 声明 7 个 tab —— basic/hsl/curves/split/filters/lut/watermark
  const expectedTabs = ['basic', 'hsl', 'curves', 'split', 'filters', 'lut', 'watermark']
  const exeTabs = new Set<string>()
  for (const t of expectedTabs) {
    if (tabsTsx.includes(`'${t}'`) || tabsTsx.includes(`"${t}"`)) exeTabs.add(t)
  }
  if (exeTabs.size === 0) exeTabs.add('basic') // 兜底

  const previewTabs = new Set<string>()
  for (const t of expectedTabs) {
    if (preview.includes(`'${t}'`) || preview.includes(`"${t}"`)) previewTabs.add(t)
  }

  const missing = [...exeTabs].filter((t) => !previewTabs.has(t))
  if (missing.length === 0) {
    results.push({ name: '编辑器 Tab', status: 'PASS', detail: `一致（${exeTabs.size} 个）` })
  } else {
    results.push({
      name: '编辑器 Tab',
      status: 'WARN',
      detail: `preview 缺失：${missing.join(', ')}`
    })
  }
}

// ---------- 9. 状态栏覆盖 ----------
function checkStatusBarCoverage(): void {
  const preview = readText(PREVIEW_PATH)
  // preview 至少在 gallery/detail/categories/settings 4 个核心页面渲染 status-bar
  const pagesExpected = ['gallery', 'detail', 'categories', 'settings']
  const missingPages: string[] = []
  for (const p of pagesExpected) {
    // 简化判断：在 view === 'xxx' 分支附近 3000 字符窗口内查找 status-bar 字样
    const pageBlock = preview.match(new RegExp(`view\\s*===?\\s*['"]${p}['"][\\s\\S]{0,3000}`))
    if (!pageBlock || !pageBlock[0].includes('status-bar')) {
      missingPages.push(p)
    }
  }

  if (missingPages.length === 0) {
    results.push({ name: '状态栏覆盖', status: 'PASS', detail: `4 个核心页面均含状态栏` })
  } else {
    results.push({
      name: '状态栏覆盖',
      status: 'WARN',
      detail: `缺失页面：${missingPages.join(', ')}`
    })
  }
}

// ---------- 10. CDN 依赖版本一致性 ----------
function checkCdnVersions(): void {
  const preview = readText(PREVIEW_PATH)
  const pkg = readPackageJson()

  // preview.html 中所有 xxx@version 形式的 CDN 引用
  const cdnRefs = [...preview.matchAll(/(\w[\w-]*)@(\d+\.\d+\.\d+)/g)]
  const cdnMap = new Map<string, string>()
  for (const m of cdnRefs) cdnMap.set(m[1].toLowerCase(), m[2])

  // 仅校验 preview 实际引用且 package.json 中存在的依赖
  const TO_CHECK = ['exifr', 'react', 'react-dom', 'i18next', 'react-i18next', 'motion']
  const mismatches: string[] = []
  for (const dep of TO_CHECK) {
    const cdnVer = cdnMap.get(dep.toLowerCase())
    if (!cdnVer) continue
    const pkgVer = pkg.dependencies?.[dep]
    if (!pkgVer) continue
    const pkgClean = pkgVer.replace(/^[^0-9]+/, '')
    if (cdnVer !== pkgClean) {
      mismatches.push(`${dep}: preview=${cdnVer}, package.json=${pkgClean}`)
    }
  }

  if (mismatches.length === 0) {
    results.push({
      name: 'CDN 依赖版本',
      status: 'PASS',
      detail: `一致（${cdnMap.size} 个 CDN 引用）`
    })
  } else {
    results.push({
      name: 'CDN 依赖版本',
      status: 'WARN',
      detail: mismatches.join('；')
    })
  }
}

// ---------- 主流程 ----------
function main(): void {
  if (!fs.existsSync(PREVIEW_PATH)) {
    // preview.html 不存在时报错：强制开发者执行 build:preview 生成预览版
    // 与 lint-staged 配合：commit 时若 preview.html 缺失则阻断提交
    console.error('❌ preview.html 不存在，请先执行 npm run build:preview 生成预览版')
    console.error('   生成路径：' + PREVIEW_PATH)
    process.exit(1)
  }

  checkNavItems()
  checkCssVars()
  checkI18nCoverage()
  checkExifrVersion()
  checkPageCoverage()
  checkViewModes()
  checkEditorToolbar()
  checkEditorTabs()
  checkStatusBarCoverage()
  checkCdnVersions()

  console.log('=== preview.html 漂移检测报告 ===\n')
  console.log('| 检测项 | 状态 | 详情 |')
  console.log('|---|---|---|')
  for (const r of results) {
    const icon = r.status === 'PASS' ? '✓' : r.status === 'WARN' ? '△' : '✗'
    console.log(`| ${r.name} | ${icon} ${r.status} | ${r.detail} |`)
  }

  const failCount = results.filter((r) => r.status === 'FAIL').length
  const warnCount = results.filter((r) => r.status === 'WARN').length
  console.log(
    `\n总计：${results.length} 项；PASS=${results.length - failCount - warnCount}，WARN=${warnCount}，FAIL=${failCount}`
  )

  if (failCount > 0) {
    console.error('\n❌ 存在致命漂移，请修复后再次提交')
    process.exit(1)
  } else {
    console.log('\n✅ 无致命漂移')
    process.exit(0)
  }
}

main()
