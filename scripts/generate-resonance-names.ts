/**
 * 共鸣录实体名称包生成脚本（生成期离线工具）。
 *
 * 从 gongeo.us-nikki-tracker（MIT, dastrokes）的 app/locales/<lang>/{banner,item,
 * outfit,makeup,momo,prop,eureka}.json 提取产物数据集中出现的实体 id 的名称，
 * 产出到 src/renderer/data/resonance/names/<lang>.json（按语言懒加载）。
 *
 * 语言映射：源有 zh→宿主 zh-CN、tw→zh-TW，其余同名；宿主 ru/th/vi 源无翻译，
 * 回退英文包并在 meta.todo 标记 TODO（不编造翻译）。
 *
 * 用法：npx tsx scripts/generate-resonance-names.ts --source <克隆目录>
 * 前置：先运行 generate-resonance-static-data.ts。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const HOST_LANGS = [
  'de',
  'en',
  'es',
  'fr',
  'ja',
  'ko',
  'pt',
  'ru',
  'th',
  'vi',
  'zh-CN',
  'zh-TW'
] as const
const SOURCE_LANG_BY_HOST: Record<string, string> = {
  de: 'de',
  en: 'en',
  es: 'es',
  fr: 'fr',
  ja: 'ja',
  ko: 'ko',
  pt: 'pt',
  'zh-CN': 'zh',
  'zh-TW': 'tw'
}
const ENTITY_FILES = ['banner', 'item', 'outfit', 'makeup', 'momo', 'prop', 'eureka'] as const

function parseArgs(): { source: string } {
  const argv = process.argv.slice(2)
  const idx = argv.indexOf('--source')
  const source = idx >= 0 ? argv[idx + 1] : process.env.RESONANCE_SOURCE
  if (!source) {
    console.error('用法: tsx scripts/generate-resonance-names.ts --source <克隆目录>')
    process.exit(1)
  }
  return { source: path.resolve(source) }
}

async function main(): Promise<void> {
  const { source } = parseArgs()
  const repoRoot = path.resolve(__dirname, '..')
  const dataDir = path.join(repoRoot, 'src', 'renderer', 'data', 'resonance')
  const namesDir = path.join(dataDir, 'names')

  // 1) 构建产物数据集的实体 id 全集
  const banners = JSON.parse(fs.readFileSync(path.join(dataDir, 'banners.json'), 'utf8')) as Record<
    string,
    { bannerId: number; outfit4StarId: string[]; outfit5StarId: string[] }
  >
  const outfits = JSON.parse(fs.readFileSync(path.join(dataDir, 'outfits.json'), 'utf8')) as Record<
    string,
    string[]
  >

  const universe: Record<string, Set<string>> = {}
  for (const e of ENTITY_FILES) universe[e] = new Set()
  for (const id of Object.keys(banners)) universe.banner.add(id)
  for (const [outfitId, items] of Object.entries(outfits)) {
    universe.outfit.add(outfitId)
    for (const itemId of items) universe.item.add(itemId)
  }

  // 2) 从 catalog 解码补全图鉴实体 id
  const { decodeCatalogPartPayload } = await import(
    pathToFileURL(
      path.join(repoRoot, 'src', 'renderer', 'utils', 'resonance', 'catalogCompactFormat.ts')
    ).href
  )
  const catalogDir = path.join(dataDir, 'catalog')
  const readCatalog = (part: string): unknown =>
    JSON.parse(fs.readFileSync(path.join(catalogDir, `${part}.json`), 'utf8'))

  const collectIds = (part: string, target: string): void => {
    const decoded = decodeCatalogPartPayload(part, readCatalog(part)) as
      Array<{ id: number }> | Record<string, number[]>
    if (Array.isArray(decoded)) {
      for (const entry of decoded) {
        if (entry && typeof entry.id === 'number') universe[target].add(String(entry.id))
      }
    } else {
      for (const key of Object.keys(decoded)) universe[target].add(key)
    }
  }
  collectIds('items', 'item')
  collectIds('outfits', 'outfit')
  collectIds('makeups', 'makeup')
  collectIds('momo', 'momo')
  collectIds('props', 'prop')
  collectIds('eurekas', 'eureka')

  // 3) 逐语言生成名称包
  fs.mkdirSync(namesDir, { recursive: true })
  const report: Array<{ lang: string; bytes: number; entries: number; fallbackOf?: string }> = []

  const loadSourceNames = (srcLang: string): Record<string, Record<string, string>> => {
    const result: Record<string, Record<string, string>> = {}
    for (const entity of ENTITY_FILES) {
      const file = path.join(source, 'app', 'locales', srcLang, `${entity}.json`)
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>
      const filtered: Record<string, string> = {}
      for (const [key, name] of Object.entries(raw)) {
        const m = /^([a-z]+)\.(\d+)\.name$/.exec(key)
        if (!m || m[1] !== entity) continue
        const id = m[2]
        if (universe[entity]?.has(id) && typeof name === 'string' && name.length > 0) {
          filtered[id] = name
        }
      }
      result[entity] = filtered
    }
    return result
  }

  // 英文包作为回退基准，先算一次
  const enNames = loadSourceNames('en')

  for (const hostLang of HOST_LANGS) {
    const srcLang = SOURCE_LANG_BY_HOST[hostLang]
    const isFallback = srcLang === undefined
    const names = isFallback ? enNames : loadSourceNames(srcLang)
    const payload = {
      meta: {
        lang: hostLang,
        generatedAt: new Date().toISOString(),
        source: 'gongeo.us-nikki-tracker (MIT, dastrokes)',
        // ru/th/vi：源项目无该语言翻译，回退英文；不编造翻译。
        todo: isFallback
          ? `TODO: 源项目缺少 ${hostLang} 实体名翻译，当前回退英文包；待后续版本补充翻译。`
          : null,
        fallbackOf: isFallback ? 'en' : null
      },
      ...names
    }
    const outPath = path.join(namesDir, `${hostLang}.json`)
    fs.writeFileSync(outPath, JSON.stringify(payload))
    const entries = ENTITY_FILES.reduce((acc, e) => acc + Object.keys(names[e]).length, 0)
    report.push({
      lang: hostLang,
      bytes: fs.statSync(outPath).size,
      entries,
      fallbackOf: isFallback ? 'en' : undefined
    })
  }

  console.log('=== 共鸣录名称包生成报告 ===')
  let total = 0
  for (const r of report) {
    total += r.bytes
    console.log(
      `names/${r.lang}.json  ${(r.bytes / 1024).toFixed(1)} KB  ${r.entries} 条${r.fallbackOf ? `  (回退 ${r.fallbackOf}, TODO)` : ''}`
    )
  }
  console.log(`合计: ${(total / 1024).toFixed(1)} KB`)
  console.log(
    `id 全集: banner=${universe.banner.size} outfit=${universe.outfit.size} item=${universe.item.size} makeup=${universe.makeup.size} momo=${universe.momo.size} prop=${universe.prop.size} eureka=${universe.eureka.size}`
  )
}

main().catch((err) => {
  console.error('生成失败:', err)
  process.exit(1)
})
