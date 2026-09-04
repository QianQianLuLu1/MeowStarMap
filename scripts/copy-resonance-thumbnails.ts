/**
 * 卡池缩略图拷贝脚本（生成期离线工具，运行时不依赖源仓库）。
 *
 * 从 gongeo.us-nikki-tracker（MIT, dastrokes）只读克隆的
 * public/images/banners/thumbnails/ 拷贝卡池缩略图到
 * src/renderer/data/resonance/thumbnails/<bannerId>.png，
 * 作为宿主本地静态资源随包分发（禁用源仓库 banners/ 原图，约 51 MB）。
 *
 * 同时生成 thumbnails/index.ts 静态 import 索引（id → 资源 URL），
 * 渲染层经该索引取图，不使用 import.meta.glob（构建期确定性、类型安全）。
 *
 * 校验：以 src/renderer/data/resonance/banners.json 的卡池 id 清单为基准，
 * 逐一确认源目录存在对应 <id>.png（缺失即失败，不做静默跳过）。
 *
 * 用法：npx tsx scripts/copy-resonance-thumbnails.ts --source <克隆目录>
 * 幂等：同名文件重复覆盖，产物确定性。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const REPO_ROOT = path.resolve(__dirname, '..')
const BANNERS_JSON = path.join(REPO_ROOT, 'src/renderer/data/resonance/banners.json')
const OUT_DIR = path.join(REPO_ROOT, 'src/renderer/data/resonance/thumbnails')
const INDEX_TS = path.join(OUT_DIR, 'index.ts')

function parseArgs(): { source: string } {
  const argv = process.argv.slice(2)
  const idx = argv.indexOf('--source')
  const source = idx >= 0 ? argv[idx + 1] : process.env.RESONANCE_SOURCE
  if (!source) {
    console.error(
      '用法: tsx scripts/copy-resonance-thumbnails.ts --source <gongeo.us-nikki-tracker 克隆目录>'
    )
    process.exit(1)
  }
  return { source: path.resolve(source) }
}

function writeIndexTs(bannerIds: string[]): void {
  const lines: string[] = [
    '// 生成文件：scripts/copy-resonance-thumbnails.ts 产物索引（勿手改）。',
    '// id → 打包内本地资源 URL；来源 gongeo.us-nikki-tracker（MIT, dastrokes）。',
    ''
  ]
  for (const id of bannerIds) {
    lines.push(`import thumb${id} from './${id}.png'`)
  }
  lines.push('')
  lines.push('export const BANNER_THUMBNAIL_URLS: Readonly<Record<string, string>> = {')
  for (const id of bannerIds) {
    lines.push(`  '${id}': thumb${id},`)
  }
  lines.push('}')
  lines.push('')
  fs.writeFileSync(INDEX_TS, lines.join('\n'), 'utf-8')
}

function main(): void {
  const { source } = parseArgs()
  const srcDir = path.join(source, 'public', 'images', 'banners', 'thumbnails')

  if (!fs.existsSync(srcDir)) {
    console.error(`源目录不存在: ${srcDir}`)
    console.error(
      '请先克隆源仓库：git clone --depth 1 https://github.com/dastrokes/gongeo.us-nikki-tracker'
    )
    process.exit(1)
  }

  const banners = JSON.parse(fs.readFileSync(BANNERS_JSON, 'utf-8')) as Record<string, unknown>
  const bannerIds = Object.keys(banners)
  if (bannerIds.length === 0) {
    console.error(`banners.json 为空或不可读: ${BANNERS_JSON}`)
    process.exit(1)
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })

  let totalBytes = 0
  let copied = 0
  for (const id of bannerIds) {
    const srcFile = path.join(srcDir, `${id}.png`)
    if (!fs.existsSync(srcFile)) {
      console.error(`缺少卡池 ${id} 的缩略图: ${srcFile}`)
      process.exit(1)
    }
    const size = fs.statSync(srcFile).size
    if (size === 0) {
      console.error(`源文件为空: ${srcFile}`)
      process.exit(1)
    }
    fs.copyFileSync(srcFile, path.join(OUT_DIR, `${id}.png`))
    totalBytes += size
    copied++
  }

  writeIndexTs(bannerIds)

  console.log('=== 卡池缩略图拷贝报告 ===')
  console.log(`来源: ${srcDir}`)
  console.log(`目标: ${path.relative(REPO_ROOT, OUT_DIR)}`)
  console.log(`拷贝: ${copied} 张, 合计 ${(totalBytes / 1024 / 1024).toFixed(2)} MB`)
  console.log(`索引: ${path.relative(REPO_ROOT, INDEX_TS)} (${bannerIds.length} 条)`)
  if (copied !== bannerIds.length) {
    console.error(`拷贝数量 ${copied} 与卡池数 ${bannerIds.length} 不一致`)
    process.exit(1)
  }
}

main()
