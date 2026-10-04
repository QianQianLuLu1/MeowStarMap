/**
 * 共鸣录静态数据生成脚本（生成期离线工具，运行时不依赖源仓库）。
 *
 * 从 gongeo.us-nikki-tracker（MIT, dastrokes）只读克隆中提取四项功能所需的
 * 静态数据子集，产出到 src/renderer/data/resonance/：
 *   - banners.json      卡池数据（源 data/banners.ts，快照化）
 *   - outfits.json      套装→部件映射（源 data/outfits/*.ts 合并）
 *   - catalog/*.json    图鉴目录 11 片（原样字节拷贝，剔除 sketches）
 *   - percentile.json   社区百分位静态快照
 *   - snapshot-meta.json 快照来源/版本/截止元数据
 *
 * 用法：npx tsx scripts/generate-resonance-static-data.ts --source <克隆目录>
 * 幂等：可重复执行，产物确定性（除 generatedAt 与常驻池 open-end 快照日期）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function parseArgs(): { source: string } {
  const argv = process.argv.slice(2)
  const idx = argv.indexOf('--source')
  const source = idx >= 0 ? argv[idx + 1] : process.env.RESONANCE_SOURCE
  if (!source) {
    console.error(
      '用法: tsx scripts/generate-resonance-static-data.ts --source <gongeo.us-nikki-tracker 克隆目录>'
    )
    process.exit(1)
  }
  return { source: path.resolve(source) }
}

interface BannerRun {
  version: string
  start: string
  end: string
}
interface Banner {
  bannerId: number
  bannerType: 1 | 2 | 3
  outfit4StarId: string[]
  outfit5StarId: string[]
  runs: BannerRun[]
  rewardIds?: string[]
}

const CATALOG_PARTS = [
  'items',
  'outfits',
  'makeups',
  'momo',
  'eurekas',
  'props',
  'outfitItems',
  'makeupItems',
  'makeupOutfits',
  'momoOutfits',
  'palettes'
] as const

async function main(): Promise<void> {
  const { source } = parseArgs()
  if (!fs.existsSync(path.join(source, 'data', 'banners.ts'))) {
    console.error(`源目录不合法（缺少 data/banners.ts）: ${source}`)
    process.exit(1)
  }

  const repoRoot = path.resolve(__dirname, '..')
  const outDir = path.join(repoRoot, 'src', 'renderer', 'data', 'resonance')
  const catalogOutDir = path.join(outDir, 'catalog')
  fs.mkdirSync(catalogOutDir, { recursive: true })

  // 1) 卡池数据：tsx 动态导入源 TS 模块（类型标注在运行时被剥离）
  const bannersModule = (await import(
    pathToFileURL(path.join(source, 'data', 'banners.ts')).href
  )) as { BANNER_DATA: Record<string, Banner> }
  const bannerData = bannersModule.BANNER_DATA
  const bannerIds = Object.keys(bannerData)
  if (bannerIds.length === 0) throw new Error('banners 为空')
  const bannersOut: Record<string, Banner> = {}
  for (const id of bannerIds) {
    const b = bannerData[id]
    if (!b || typeof b.bannerId !== 'number' || !Array.isArray(b.runs)) {
      throw new Error(`卡池数据异常: ${id}`)
    }
    bannersOut[id] = b
  }
  const bannersJsonPath = path.join(outDir, 'banners.json')
  fs.writeFileSync(bannersJsonPath, JSON.stringify(bannersOut))
  const latestBannerId = Math.max(...bannerIds.map(Number))

  // 2) 套装→部件映射：合并源 data/outfits/index.ts
  const outfitsModule = (await import(
    pathToFileURL(path.join(source, 'data', 'outfits', 'index.ts')).href
  )) as { default: Record<string, { id: string; items: string[] }> }
  const outfitData = outfitsModule.default
  const outfitsOut: Record<string, string[]> = {}
  for (const [outfitId, outfit] of Object.entries(outfitData)) {
    if (!Array.isArray(outfit?.items) || outfit.items.length === 0) {
      throw new Error(`套装数据异常: ${outfitId}`)
    }
    outfitsOut[outfitId] = outfit.items
  }
  const outfitsJsonPath = path.join(outDir, 'outfits.json')
  fs.writeFileSync(outfitsJsonPath, JSON.stringify(outfitsOut))

  // 3) 卡池引用完整性：每个卡池的套装必须存在
  for (const b of Object.values(bannersOut)) {
    for (const oid of [...(b.outfit5StarId ?? []), ...(b.outfit4StarId ?? [])]) {
      if (!outfitsOut[oid]) throw new Error(`卡池 ${b.bannerId} 引用了缺失套装 ${oid}`)
    }
  }

  // 4) 图鉴目录 11 片：从 public/catalog 按 <part>.<hash>.json 前缀匹配拷贝
  const catalogDir = path.join(source, 'public', 'catalog')
  const catalogFiles = fs.readdirSync(catalogDir)
  const copiedParts: string[] = []
  for (const part of CATALOG_PARTS) {
    const fileName = catalogFiles.find((f) => f === `${part}.json` || f.startsWith(`${part}.`))
    if (!fileName) throw new Error(`catalog 缺少分片: ${part}`)
    fs.copyFileSync(path.join(catalogDir, fileName), path.join(catalogOutDir, `${part}.json`))
    copiedParts.push(part)
  }

  // 5) 校验：11 片都能被解码器解开（解码器即运行时所用模块）
  const { decodeCatalogPartPayload } = await import(
    pathToFileURL(
      path.join(repoRoot, 'src', 'renderer', 'utils', 'resonance', 'catalogCompactFormat.ts')
    ).href
  )
  type DecodeFn = (part: string, payload: unknown) => unknown
  const decode = decodeCatalogPartPayload as DecodeFn
  let totalEntries = 0
  for (const part of CATALOG_PARTS) {
    const raw = fs.readFileSync(path.join(catalogOutDir, `${part}.json`), 'utf8')
    const payload: unknown = JSON.parse(raw)
    const decoded = decode(part, payload)
    if (decoded == null) throw new Error(`catalog 分片解码失败: ${part}`)
    const count = Array.isArray(decoded)
      ? decoded.length
      : Object.keys(decoded as Record<string, unknown>).length
    if (count === 0) throw new Error(`catalog 分片为空: ${part}`)
    totalEntries += count
  }

  // 6) 百分位快照 + 元数据
  const percentileRaw = fs.readFileSync(path.join(source, 'data', 'percentile.json'), 'utf8')
  const percentile = JSON.parse(percentileRaw) as { generated_at?: string; metrics?: unknown }
  if (!percentile?.metrics) throw new Error('percentile.json 结构异常')
  fs.writeFileSync(path.join(outDir, 'percentile.json'), JSON.stringify(percentile))

  const manifest = JSON.parse(fs.readFileSync(path.join(catalogDir, 'index.json'), 'utf8')) as {
    gameVersion?: string
    generatedAt?: string
  }

  const meta = {
    source: 'gongeo.us-nikki-tracker',
    sourceUrl: 'https://github.com/dastrokes/gongeo.us-nikki-tracker',
    sourceLicense: 'MIT',
    sourceAuthor: 'dastrokes',
    branch: 'master',
    generatedAt: new Date().toISOString(),
    gameVersion: manifest.gameVersion ?? null,
    catalogGeneratedAt: manifest.generatedAt ?? null,
    percentileGeneratedAt: percentile.generated_at ?? null,
    latestBannerId,
    catalogParts: copiedParts,
    totalCatalogEntries: totalEntries,
    snapshotNote:
      '静态快照，不会自动更新；过期仅影响新增卡池/物品显示与百分位参考值，不影响已有数据计算。',
    todo: '数据更新需重新克隆源仓库并重跑本脚本与 generate-resonance-names.ts'
  }
  fs.writeFileSync(path.join(outDir, 'snapshot-meta.json'), JSON.stringify(meta, null, 2))

  // 7) 体积报告
  const files = [
    bannersJsonPath,
    outfitsJsonPath,
    ...CATALOG_PARTS.map((p) => path.join(catalogOutDir, `${p}.json`)),
    path.join(outDir, 'percentile.json'),
    path.join(outDir, 'snapshot-meta.json')
  ]
  let total = 0
  console.log('=== 共鸣录静态数据生成报告 ===')
  for (const f of files) {
    const size = fs.statSync(f).size
    total += size
    console.log(`${path.relative(repoRoot, f)}  ${(size / 1024).toFixed(1)} KB`)
  }
  console.log(`合计: ${(total / 1024).toFixed(1)} KB`)
  console.log(`卡池数: ${bannerIds.length}, 套装数: ${Object.keys(outfitsOut).length}`)
  console.log(`gameVersion: ${meta.gameVersion}, latestBannerId: ${latestBannerId}`)
}

main().catch((err) => {
  console.error('生成失败:', err)
  process.exit(1)
})
