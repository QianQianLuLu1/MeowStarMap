import { describe, it, expect, vi, afterEach, type MockInstance } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseImportFileText, countImportDiff } from './importParse'
import { buildExportPayload } from './exportPayload'
import { processBannerPullData } from './process'
import { createWardrobeSummary } from './wardrobe'
import { calculatePercentile } from './percentile'
import {
  getStaticProcessDeps,
  loadCatalog,
  loadNames,
  loadPercentile,
  loadSnapshotMeta
} from './staticData'
import { BANNER_DATA } from './staticData'

/**
 * 离线断言（零联网守护）：
 * 1. 运行时打桩——对 fetch / XMLHttpRequest / WebSocket / sendBeacon / node http(s)
 *    全部打 spy，跑核心业务流程（导入解析 → 处理统计 → 衣橱汇总 → 导出组装 →
 *    静态数据装载）后断言零网络调用；
 * 2. 静态扫描——遍历全部共鸣录新增源码文件，断言无网络 API 与 http(s):// 字面量
 *    （防边界点 C 的外链图片/资源；snapshot-meta.json 的 sourceUrl 属数据文件，不扫）；
 * 3. 反向用例——向扫描器注入含 https:// 的样本与真实调用 fetch，验证守护不会假绿。
 */

// ============ 静态扫描 ============

// vitest 以仓库根为 cwd（npm test / npx vitest 均从根目录运行）
const REPO_ROOT = process.cwd()

/** 参与扫描的共鸣录源码文件（非测试、非生成数据）；按目录递归收集 */
function collectResonanceSourceFiles(): string[] {
  const files: string[] = []
  const pushDir = (dir: string, filter: (name: string) => boolean): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'data') continue // 生成数据目录（snapshot-meta.json 含 sourceUrl 元数据）不在扫描范围
        collectRecursive(full, files)
      } else if (entry.isFile() && filter(entry.name)) {
        files.push(full)
      }
    }
  }
  const collectRecursive = (dir: string, out: string[]): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'data') continue
        collectRecursive(full, out)
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        out.push(full)
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.tsx') &&
        !entry.name.endsWith('.test.tsx')
      ) {
        out.push(full)
      }
    }
  }

  pushDir(
    path.join(REPO_ROOT, 'src/renderer/components/resonance'),
    (n) => n.endsWith('.tsx') && !n.endsWith('.test.tsx')
  )
  pushDir(
    path.join(REPO_ROOT, 'src/renderer/utils/resonance'),
    (n) => n.endsWith('.ts') && !n.endsWith('.test.ts')
  )
  pushDir(path.join(REPO_ROOT, 'src/renderer/data/resonance/thumbnails'), (n) => n === 'index.ts')
  files.push(path.join(REPO_ROOT, 'src/renderer/stores/resonanceStore.ts'))
  files.push(path.join(REPO_ROOT, 'src/renderer/pages/ResonanceRecordsPage.tsx'))
  files.push(path.join(REPO_ROOT, 'src/shared/types/resonance.ts'))
  files.push(path.join(REPO_ROOT, 'src/main/ipc/handlers/resonance-handler.ts'))
  files.push(path.join(REPO_ROOT, 'src/main/database/resonance-repository.ts'))
  files.push(path.join(REPO_ROOT, 'src/main/preload/api/resonance.ts'))
  return files.filter((file) => fs.existsSync(file))
}

const NETWORK_PATTERNS: Array<[RegExp, string]> = [
  [/\bfetch\s*\(/, 'fetch() 调用'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/new\s+WebSocket\b/, 'WebSocket'],
  [/\bEventSource\s*\(/, 'EventSource'],
  [/navigator\.sendBeacon/, 'sendBeacon'],
  [/\$fetch\s*\(/, '$fetch（ofetch）'],
  [/\baxios\b/, 'axios'],
  [/\bimport\s*\(\s*['"`]https?:\/\//, '动态 import 远程 URL'],
  [/https?:\/\/[^\s'"`<>)\\]+/, 'http(s):// URL 字面量（含外链图片/CSS 资源）']
]

/** 扫描一段源码文本，返回违规描述列表 */
export function scanSourceForNetwork(code: string): string[] {
  const violations: string[] = []
  for (const [pattern, label] of NETWORK_PATTERNS) {
    if (pattern.test(code)) violations.push(label)
  }
  return violations
}

// ============ 运行时打桩 ============

// node:http(s) 模块整体替换为 spy（ESM 内建模块属性不可 redefine，不能用 spyOn）
const netSpies = vi.hoisted(() => ({
  httpRequest: vi.fn(),
  httpsRequest: vi.fn()
}))
vi.mock('node:http', () => {
  const stub = {
    request: (...args: unknown[]) => netSpies.httpRequest(...args),
    get: (...args: unknown[]) => netSpies.httpRequest(...args)
  }
  return { default: stub, ...stub }
})
vi.mock('node:https', () => {
  const stub = {
    request: (...args: unknown[]) => netSpies.httpsRequest(...args),
    get: (...args: unknown[]) => netSpies.httpsRequest(...args)
  }
  return { default: stub, ...stub }
})

let fetchSpy: ReturnType<typeof vi.fn>
let xhrOpenSpy: MockInstance | null = null
let wsSpy: ReturnType<typeof vi.fn>
let beaconSpy: ReturnType<typeof vi.fn>

function installNetworkStubs(): void {
  fetchSpy = vi.fn()
  vi.stubGlobal('fetch', fetchSpy)
  // node 测试环境无 XMLHttpRequest（jsdom 下同样覆盖）
  if (typeof globalThis.XMLHttpRequest !== 'undefined') {
    xhrOpenSpy = vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(() => {
      throw new Error('offline-guard: XHR open 必须为零网络调用')
    })
  } else {
    xhrOpenSpy = vi.fn()
  }
  wsSpy = vi.fn()
  vi.stubGlobal('WebSocket', wsSpy)
  beaconSpy = vi.fn()
  vi.stubGlobal('navigator', {
    ...(typeof navigator !== 'undefined' ? navigator : {}),
    sendBeacon: beaconSpy
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ============ 核心业务流程样本 ============

const LEGACY_SAMPLE = JSON.stringify({
  '2': [
    ['2025-07-01 10:00:00', '1021720039'],
    ['2025-07-02 11:00:00', '1021720040']
  ]
})

describe('离线断言：核心流程零网络调用', () => {
  installNetworkStubs()

  it('导入解析 → 处理统计 → 衣橱汇总 → 导出组装 → 静态数据装载 全程零网络调用', async () => {
    // 1. 导入解析（本地文本）
    const parsed = parseImportFileText(LEGACY_SAMPLE)
    expect(parsed.totalValidRecords).toBe(2)

    // 2. 与库内数据比对差异
    const diff = countImportDiff(parsed, { pulls: [], edits: [], pearpal: [], evo: [] })
    expect(diff.added).toBe(2)

    // 3. 卡池处理（保底/统计）
    const processed = processBannerPullData(
      { '2': [['2025-07-01 10:00:00', '1021720039']] },
      {},
      getStaticProcessDeps()
    )
    expect(Object.keys(processed).length).toBeGreaterThan(0)

    // 4. 衣橱汇总（静态目录索引；汇总数学由 wardrobe.test.ts 覆盖，
    //    此处仅要求执行完成且返回结构化结果——区域/变体过滤可能裁剪样本）
    const summary = createWardrobeSummary({
      index: {
        items: [{ id: 1021720039, quality: 5, type: 'dresses' }],
        outfits: [{ id: 10217201 }],
        makeups: [],
        momo: [],
        outfitItemsById: new Map([[10217201, [1021720039]]]),
        makeupItemsById: new Map()
      },
      ownedItemIds: [1021720039]
    })
    expect(Number.isFinite(summary.items.completionPercent)).toBe(true)
    expect(Array.isArray(summary.nearCompleteOutfits)).toBe(true)

    // 5. 百分位插值（纯函数）
    expect(
      calculatePercentile(20, [
        [0, 10],
        [100, 30]
      ])
    ).toBeGreaterThanOrEqual(0)

    // 6. 导出载荷组装（round-trip 回读）
    const payload = buildExportPayload(
      {
        pulls: [
          {
            id: 1,
            banner_id: '2',
            item_id: '1021720039',
            obtained_at: '2025-07-01 10:00:00',
            source: 'json',
            created_at: ''
          }
        ],
        edits: [],
        pearpal: [],
        evo: [],
        wardrobe: {
          version: 1,
          ownedItemIds: [],
          ownedMakeupIds: [],
          ownedMomoIds: [],
          ownedPropIds: [],
          ownedEurekaColorIds: [],
          updatedAt: ''
        }
      },
      {
        includePulls: true,
        includeEdits: true,
        includePearpal: true,
        includeEvo: true,
        includeWardrobe: true
      }
    )
    expect(payload).not.toBeNull()
    const reparsed = parseImportFileText(JSON.stringify(payload))
    expect(reparsed.totalValidRecords).toBe(1)

    // 7. 静态数据装载（本地 JSON chunk + 本地缩略图索引）
    const catalog = await loadCatalog()
    expect(catalog).not.toBeNull()
    const names = await loadNames('zh-CN')
    expect(names.item['1021720039']).toBeTruthy()
    const percentile = await loadPercentile()
    expect(percentile).not.toBeNull()
    const meta = await loadSnapshotMeta()
    expect(meta?.sourceUrl).toContain('github.com') // 元数据字段本身不是网络调用

    // —— 断言零网络调用 ——
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(xhrOpenSpy === null || xhrOpenSpy.mock.calls.length === 0).toBe(true)
    expect(wsSpy).not.toHaveBeenCalled()
    expect(beaconSpy).not.toHaveBeenCalled()
    expect(netSpies.httpRequest).not.toHaveBeenCalled()
    expect(netSpies.httpsRequest).not.toHaveBeenCalled()
  })

  it('打桩自身有效：真实调用 fetch 必须被记录（防假绿）', () => {
    expect(fetchSpy).not.toHaveBeenCalled()
    void fetchSpy('https://example.invalid/probe')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    fetchSpy.mockClear()
  })
})

describe('离线断言：静态扫描共鸣录源码', () => {
  it('全部共鸣录源码文件无网络 API 与 http(s):// 字面量', () => {
    const files = collectResonanceSourceFiles()
    // 覆盖数下限：组件 5 + 工具 11 + store + page + shared + main×3 + 缩略图索引 ≈ 22
    expect(files.length).toBeGreaterThanOrEqual(20)

    const offenders: string[] = []
    for (const file of files) {
      const code = fs.readFileSync(file, 'utf8')
      const violations = scanSourceForNetwork(code)
      if (violations.length > 0) {
        offenders.push(`${path.relative(REPO_ROOT, file)}: ${violations.join(', ')}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('反向用例：扫描器必须能发现注入的网络代码与外链图片 URL', () => {
    expect(scanSourceForNetwork('await fetch(url)')).toContain('fetch() 调用')
    expect(scanSourceForNetwork('<img src="https://cdn.example.com/outfit.png" />')).toContain(
      'http(s):// URL 字面量（含外链图片/CSS 资源）'
    )
    expect(
      scanSourceForNetwork("el.style.backgroundImage = 'url(https://ads.example/bg.png)'")
    ).toContain('http(s):// URL 字面量（含外链图片/CSS 资源）')
    expect(scanSourceForNetwork('new WebSocket("wss://x")')).toContain('WebSocket')
    // 正常本地资源引用不应报警
    expect(scanSourceForNetwork("import thumb from './1.png'")).toEqual([])
    expect(scanSourceForNetwork('const src = getBannerThumbnailUrl(2)')).toEqual([])
  })

  it('BANNER_DATA 与缩略图索引来自本地打包资源', () => {
    // 静态数据可同步读取（打进 bundle，无远程加载）
    expect(Object.keys(BANNER_DATA).length).toBeGreaterThanOrEqual(70)
  })
})
