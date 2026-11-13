/**
 * N7：把上游 PC 端资源暂存到 `ROOT/resources/nikkisync/pc/`。
 *
 * 铁律（遵循 `scripts/AGENTS.md`）：核心逻辑导出为纯函数 + dry-run 默认（`--apply`
 * 才落地）；UP 检出根找不到时 **warn + 返回 skipped，不阻断** —— CI `npm ci` 不会带
 * `node_modules/@nikkisync/*` junction，也没有 `../NikkiSync`，这一支是受支持的默认态。
 * 本脚本不 import 任何 `src/main/` 模块（Node 环境无 Electron 上下文）。
 *
 * 用法：`npm run stage:nikkisync-pc`（预览）/ `npx tsx scripts/stage-nikkisync-pc-assets.ts --apply`
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveNikkiSyncRoot, toRootCandidates } from './link-nikkisync'

/** 一份源 → 目标的相对声明（from 相对 UP 根，to 相对目标根）。 */
export interface PcAssetSpec {
  from: string
  to: string
}

/**
 * a49764bb：上游 `assets/photo-filter-icons/manifest.json` 的 21 条 `effectEntries`。
 * 实测缺 `1090020018`，故 1..17 + 19..22 两段拼接，不臆造不存在的资源。
 */
export const PHOTO_FILTER_ICON_IDS: readonly string[] = [
  ...Array.from({ length: 17 }, (_, index) => String(1090020001 + index)),
  ...Array.from({ length: 4 }, (_, index) => String(1090020019 + index))
]

/** 1.0.40 补充包：manifest + effects/filter-<id>.webp，目标目录与上游同构（loadLocalClothingIconPack 按相对路径读）。 */
const PHOTO_FILTER_ICON_SPECS: readonly PcAssetSpec[] = [
  {
    from: path.join('assets', 'photo-filter-icons', 'manifest.json'),
    to: path.join('photo-filter-icons', 'manifest.json')
  },
  ...PHOTO_FILTER_ICON_IDS.map((id) => ({
    from: path.join('assets', 'photo-filter-icons', 'effects', `filter-${id}.webp`),
    to: path.join('photo-filter-icons', 'effects', `filter-${id}.webp`)
  }))
]

/** 4 份 legal 文档 + 品牌图 + 小程序入口码 + 3 个 PS 脚本 + 22 项滤镜图标（逐字来自上游 windows-app.ts 的 readFileSync 清单，4cb71e2 起含 wechat-mini-entry.png）。 */
export const PC_ASSET_SPECS: readonly PcAssetSpec[] = [
  {
    from: path.join('docs', 'store-submission', 'PRIVACY_POLICY.md'),
    to: 'PRIVACY_POLICY.md'
  },
  {
    from: path.join('docs', 'store-submission', 'USER_AGREEMENT.md'),
    to: 'USER_AGREEMENT.md'
  },
  {
    from: path.join('docs', 'store-submission', 'PERMISSIONS_DATA.md'),
    to: 'PERMISSIONS_DATA.md'
  },
  {
    from: path.join('docs', 'store-submission', 'SDK_SERVICES.md'),
    to: 'SDK_SERVICES.md'
  },
  { from: path.join('assets', 'branding', 'momo-camera.png'), to: 'momo-camera.png' },
  {
    // 4cb71e2：控制页 /wechat-entry.png 路由的图片源（缺失时上游不挂路由）
    from: path.join('assets', 'branding', 'wechat-mini-entry.png'),
    to: 'wechat-mini-entry.png'
  },
  {
    from: path.join('tools', 'wechat-gallery', 'resize-icon.ps1'),
    to: path.join('wechat', 'resize-icon.ps1')
  },
  {
    from: path.join('tools', 'wechat-gallery', 'resize-preview.ps1'),
    to: path.join('wechat', 'resize-preview.ps1')
  },
  {
    from: path.join('tools', 'wechat-gallery', 'rotate-png.ps1'),
    to: path.join('wechat', 'rotate-png.ps1')
  },
  ...PHOTO_FILTER_ICON_SPECS
]

export interface PlannedAsset {
  from: string
  to: string
}

/** 可注入的 IO 面：单测喂假实现，不依赖真实 UP 检出与链接。 */
export interface StageFsPort {
  exists(p: string): boolean
  mkdir(p: string): void
  copyFile(from: string, to: string): void
}

export interface StageOptions {
  upRoot: string
  targetRoot: string
  /** 缺省 false = dry-run（只产出计划，不写盘）。 */
  apply?: boolean
  warn?: (message: string) => void
  fsPort?: StageFsPort
  /** 可注入的声明清单（缺省用 PC_ASSET_SPECS）；纯函数单测借此验证目标包含性断言。 */
  specs?: readonly PcAssetSpec[]
}

export interface StageResult {
  status: 'applied' | 'dry-run' | 'skipped'
  planned: string[]
  copied: string[]
  skipped: string[]
  warnings: string[]
}

const nodeFsPort: StageFsPort = {
  exists: (p) => fs.existsSync(p),
  mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
  copyFile: (from, to) => fs.copyFileSync(from, to)
}

/** 纯函数：把声明清单展开成绝对路径对（不触磁盘）。 */
export function planPcAssets(
  upRoot: string,
  targetRoot: string,
  specs: readonly PcAssetSpec[] = PC_ASSET_SPECS
): PlannedAsset[] {
  return specs.map((spec) => ({
    from: path.join(upRoot, spec.from),
    to: path.join(targetRoot, spec.to)
  }))
}

/** 纯逻辑编排：UP 根缺失 / 单件缺失都是 warn 后跳过，绝不抛到构建链外。 */
export function stagePcAssets(options: StageOptions): StageResult {
  const { upRoot, targetRoot, apply = false, warn, fsPort = nodeFsPort, specs } = options
  const warnings: string[] = []
  const emit = (message: string): void => {
    warnings.push(message)
    warn?.(message)
  }
  const planned = planPcAssets(upRoot, targetRoot, specs)
  const result: StageResult = {
    status: 'skipped',
    planned: planned.map((item) => item.to),
    copied: [],
    skipped: [],
    warnings
  }
  if (!fsPort.exists(upRoot)) {
    emit(`[stage:nikkisync-pc] upstream root not found: ${upRoot}; skipped (CI has no junction)`)
    return result
  }
  // dry-run 与 apply 都逐件核对单件源：前者只产出 skipped，绝不写盘。
  result.status = apply ? 'applied' : 'dry-run'
  const resolvedTargetRoot = path.resolve(targetRoot)
  for (const item of planned) {
    // targetRoot 外部可控：逐件断言目标落在根内，防 spec.to 里的 `..` 路径逃逸。
    // 用 resolve + 分隔符前缀而非裸 startsWith，避免 `.../pc-evil` 之类同前缀误放行。
    if (!path.resolve(item.to).startsWith(resolvedTargetRoot + path.sep)) {
      throw new Error(`[stage:nikkisync-pc] asset target escapes targetRoot: ${item.to}`)
    }
    if (!fsPort.exists(item.from)) {
      emit(`[stage:nikkisync-pc] missing upstream asset: ${item.from}; skipped`)
      result.skipped.push(item.from)
      continue
    }
    if (!apply) continue
    fsPort.mkdir(path.dirname(item.to))
    fsPort.copyFile(item.from, item.to)
    result.copied.push(item.to)
  }
  return result
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function main(): void {
  const isDirectory = (candidate: string): boolean => {
    try {
      return fs.statSync(candidate).isDirectory()
    } catch {
      return false
    }
  }
  // 候选根复用 link-nikkisync 的同一条链（NIKKISYNC_ROOT → ../NikkiSync → vendor/NikkiSync），
  // 避免本脚本自持一套真相源。
  const upRoot = resolveNikkiSyncRoot(
    toRootCandidates({ projectRoot, envRoot: process.env.NIKKISYNC_ROOT }),
    isDirectory
  ).root
  if (!upRoot) {
    console.warn('[stage:nikkisync-pc] no usable NikkiSync checkout; skipped (not blocking)')
    return
  }
  const targetRoot = path.join(projectRoot, 'resources', 'nikkisync', 'pc')
  const result = stagePcAssets({
    upRoot,
    targetRoot,
    apply: process.argv.includes('--apply'),
    warn: (message) => console.warn(message)
  })
  console.log(
    `[stage:nikkisync-pc] status=${result.status} planned=${result.planned.length} ` +
      `copied=${result.copied.length} skipped=${result.skipped.length}`
  )
}

const invokedDirectly = (): boolean => {
  const self = path.resolve(fileURLToPath(import.meta.url))
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : ''
  // Windows 盘符大小写在两种入口下可能不一致，按小写比较
  return self.toLowerCase() === entry.toLowerCase()
}

if (invokedDirectly()) main()
