/**
 * 真实数据副本测量（@perf-real，手动触发，默认整节跳过）
 *
 * 为什么需要这一份：e2e/perf.e2e.ts 的数据集是 1×1 像素占位 JPEG，本机实测
 * 「按需生成 P50 = 1ms」，而真实原图（3311×1485 / 3840×2160）实测 12~25ms/张，
 * 且真实库里 62/153 图片行 thumbnail 为 NULL——合成数据集把这些差异全部抹平了，
 * 无法复现用户报的「每次启动/切板块都要重新等一遍」。
 *
 * 本套件把真实 userData 的 database + thumbnails 克隆到 .cache/perf-real/ 下，
 * 用打包产物指向克隆目录：真实库只读，任何写入都落在克隆副本上（含扫描修复、日志、
 * Chromium 缓存），跑完整体删除。
 *
 * 用法（本机）：
 *   npm run dist:win
 *   PERF_REAL_USERDATA="C:/Users/<你>/AppData/Roaming/meow-star-map" \
 *     npx playwright test --config e2e/playwright.config.ts --grep @perf-real
 *
 * 判据（不做阈值门禁，只产数值供改前/改后对比）：
 *   R2 首启（冷 Chromium 磁盘缓存）首图显影 + 网格沉降 + 默认视图 thumbnail NULL 行数
 *   R3 板块切换（图库/重复文件/启动器缓存/回收站）各段首图显影
 *   R4 二次启动（同副本目录，热缓存）首图显影 —— 与 R2 对照，等价于用户症状
 * 结果落盘 .cache/perf-real/latest-real.json。
 */
import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeApp, launchApp, type LaunchedApp } from './helpers'
import { countLogPattern, logLineKey } from './perf-helpers'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** 克隆目录根（.cache 已整体 gitignore，真实数据不会入库） */
const CLONE_ROOT = path.join(ROOT_DIR, '.cache', 'perf-real')

const SOURCE_USER_DATA = (process.env.PERF_REAL_USERDATA ?? '').replace(/[\\/]+$/, '')
const SOURCE_DB = path.join(SOURCE_USER_DATA, 'database', 'meow_star_map.db')
/** 模块加载时刻：用于生成不会与历史运行撞名的克隆目录名 */
const processStartedAt = Date.now()
const CLONE_DIR = path.join(CLONE_ROOT, `user-data-${processStartedAt}`)

interface RealAPI {
  media: {
    list: (options?: {
      page?: number
      pageSize?: number
      cursor?: { sortValue: string | number | null; id: number } | null
      includeDeleted?: boolean
      deletedOnly?: boolean
      hideDuplicates?: boolean
      mediaSource?: string
    }) => Promise<{ files?: unknown[]; total?: number }>
  }
  thumbnail: {
    generate: (filePath: string, quality?: 'low' | 'standard' | 'high') => Promise<string | null>
  }
  file: {
    // 对照组通道：R3b 拿它与 thumbnail:generate 逐条同路径对照。
    // 历史上 file:getExif 走 assertMediaReadPath（媒体白名单优先）、而 thumbnail:generate
    // 走裸 assertFileReadPath，同一条已入库路径两套白名单判定不一致（能显示、不能生成），
    // 该差异只能靠真实运行时数据测出，读代码推不出来。round2 N2 已把生成通道改为
    // assertMediaAccessPath，两者同口径，本对照因此转为**回归守卫**：两侧必须同时放行。
    getExif: (filePath: string) => Promise<Record<string, unknown> | null>
  }
}

let launched: LaunchedApp | undefined
let cloneDirUsed = ''
/** 各场景产出的指标（不做阈值判定，供改前/改后对比与文档留档） */
const results: Array<Record<string, unknown>> = []

/** 副本日志摘录：把主进程日志里与缩略图链路相关的行打出来（取证生成失败/悬挂的真实原因） */
async function dumpLogLines(userDataDir: string, pattern: RegExp, limit = 25): Promise<string[]> {
  const dir = path.join(userDataDir, 'logs')
  const entries = await fs.readdir(dir).catch(() => [] as string[])
  const seen = new Set<string>()
  const lines: string[] = []
  for (const name of entries.filter((f) => f.endsWith('.log')).sort()) {
    const content = await fs.readFile(path.join(dir, name), 'utf-8').catch(() => '')
    content
      .split('\n')
      .filter((line) => pattern.test(line))
      .forEach((line) => {
        // main.log 与 main-<日期>.log 各存一份同一事件，按去重键合并（见 logLineKey）
        const key = logLineKey(line)
        if (seen.has(key)) return
        seen.add(key)
        lines.push(line.trim())
      })
  }
  const tail = lines.slice(-limit)
  process.stdout.write(`[real] 日志命中 ${lines.length} 行，摘录最后 ${tail.length} 行：\n`)
  for (const line of tail) process.stdout.write(`  ▸ ${line}\n`)
  return lines
}

/**
 * 只统计「已参与布局」的节点（rect 宽 > 0）。
 *
 * 依据（本机实测）：重复文件板块一次采到 26 张 media:// 图片，其中 20 张长挂骨架的
 * `getBoundingClientRect()` 全为 0×0 —— 它们是虚拟网格之外、尚未布局的隐藏卡片，
 * Chromium 对 `img[loading=lazy]` 的这类元素**根本不发起请求**（resource timing 无对应
 * entry、`currentSrc` 为空）。把它们计入「骨架未归零」会稳定产出假结论，故所有计数一律
 * 先过滤 rect 宽度。
 */
/** 首图显影：从调用开始到出现第一张真正解码成功的 media:// 图片（naturalWidth>0 排除裂图） */
async function waitFirstThumb(win: Page, timeout = 90_000): Promise<number> {
  const start = performance.now()
  await win.waitForFunction(
    () => {
      const imgs = Array.from(document.querySelectorAll('img')) as HTMLImageElement[]
      return imgs.some(
        (img) =>
          img.getBoundingClientRect().width > 0 &&
          img.src.startsWith('media://') &&
          img.complete &&
          img.naturalWidth > 0
      )
    },
    undefined,
    { timeout }
  )
  return performance.now() - start
}

/** 增量显影等待：等「已显影数量超过基线」，用于切板块（避免上一板块残留图片造成 0ms 假快） */
async function waitRevealedBeyond(win: Page, baseline: number, timeout: number): Promise<number> {
  const start = performance.now()
  await win.waitForFunction(
    (base) => {
      const imgs = Array.from(document.querySelectorAll('img')) as HTMLImageElement[]
      return (
        imgs.filter(
          (img) =>
            img.getBoundingClientRect().width > 0 &&
            img.src.startsWith('media://') &&
            img.complete &&
            img.naturalWidth > 0
        ).length > base
      )
    },
    baseline,
    { timeout }
  )
  return performance.now() - start
}

/** 网格沉降：已布局骨架卡（.skeleton）清零的时刻；超时则回报残余数量 */
async function waitSkeletonClear(
  win: Page,
  timeout = 60_000
): Promise<{ elapsedMs: number; cleared: boolean; remaining: number }> {
  const start = performance.now()
  let cleared = true
  try {
    await win.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('.skeleton')).filter(
          (el) => el.getBoundingClientRect().width > 0
        ).length === 0,
      undefined,
      {
        timeout
      }
    )
  } catch {
    cleared = false
  }
  const remaining = await win.evaluate(
    () =>
      Array.from(document.querySelectorAll('.skeleton')).filter(
        (el) => el.getBoundingClientRect().width > 0
      ).length
  )
  return { elapsedMs: performance.now() - start, cleared, remaining }
}

/** 当前 DOM 里 media:// 图片的显影/未显影统计 */
async function thumbInventory(
  win: Page
): Promise<{ total: number; revealed: number; broken: number; revealSkeletons: number }> {
  return win.evaluate(() => {
    const laidOut = (el: Element) => el.getBoundingClientRect().width > 0
    const imgs = (Array.from(document.querySelectorAll('img')) as HTMLImageElement[]).filter(
      (img) => img.src.startsWith('media://') && laidOut(img)
    )
    return {
      total: imgs.length,
      revealed: imgs.filter((img) => img.complete && img.naturalWidth > 0).length,
      broken: imgs.filter((img) => img.complete && img.naturalWidth === 0).length,
      // ThumbReveal 未显影时挂的是具名骨架节点，比泛用 .skeleton 更能定位「缩略图没出来」
      revealSkeletons: Array.from(
        document.querySelectorAll('[data-testid="thumb-reveal-skeleton"]')
      ).filter(laidOut).length
    }
  })
}

/** 侧边栏可用导航标题（诊断用：标题来自 i18n，不硬编码文案） */
async function navTitles(win: Page): Promise<string[]> {
  return win.$$eval('button[title]', (els) =>
    els.map((el) => (el as HTMLElement).title).filter(Boolean)
  )
}

/**
 * 侧边栏导航点击：标题来自 i18n（zh/en 随用户设置），故先读 DOM 实际 title 再按正则匹配，
 * 匹配不到返回 null 由调用方记为「该板块未测」，不硬编码文案。
 */
async function clickNav(win: Page, pattern: RegExp): Promise<string | null> {
  const titles = await win.$$eval('button[title]', (els) =>
    els.map((el) => (el as HTMLElement).title).filter(Boolean)
  )
  const hit = titles.find((title) => pattern.test(title))
  if (!hit) return null
  await win.click(`button[title="${hit.replace(/"/g, '\\"')}"]`)
  return hit
}

/**
 * 分桶统计 media:// 图片的加载状态：视口内 / 视口外但已布局 / 未布局（rect 宽度为 0）。
 *
 * 为什么必须分三桶（本机实测依据）：`img[loading=lazy]` 对后两类**根本不发起请求**
 * （currentSrc 为空、resource timing 无对应 URL），把它们与真卡死混在一起计数，会稳定
 * 产出「20~40 张骨架永不归零」的假结论；只有「视口内 pending」才是用户真的在等图。
 */
async function thumbSnapshotByViewport(win: Page): Promise<{
  onScreen: { total: number; revealed: number; pending: number; broken: number }
  offScreen: { total: number; revealed: number; pending: number; broken: number }
  notLaidOut: { total: number; revealed: number; pending: number; broken: number }
  skeletonsLaidOut: number
  stuckOnScreen: Array<Record<string, unknown>>
  scroll: { scrollY: number; winHeight: number; docHeight: number; scroller: string }
  offScreenTops: number[]
}> {
  return win.evaluate(() => {
    const bucket = () => ({ total: 0, revealed: 0, pending: 0, broken: 0 })
    const onScreen = bucket()
    const offScreen = bucket()
    const notLaidOut = bucket()
    const stuck: Array<Record<string, unknown>> = []
    const offTops: number[] = []
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
    const byUrl = new Map<string, PerformanceResourceTiming>()
    for (const e of entries) byUrl.set(e.name, e)

    for (const img of Array.from(document.querySelectorAll('img')) as HTMLImageElement[]) {
      if (!img.src.startsWith('media://')) continue
      const rect = img.getBoundingClientRect()
      const target =
        rect.width === 0
          ? notLaidOut
          : rect.bottom > 0 && rect.top < innerHeight
            ? onScreen
            : offScreen
      target.total++
      const loaded = img.complete && img.naturalWidth > 0
      if (loaded) target.revealed++
      else if (img.complete) target.broken++
      else target.pending++
      if (target !== onScreen) offTops.push(Math.round(rect.top))
      if (target === onScreen && !loaded && stuck.length < 6) {
        const e = byUrl.get(img.currentSrc || img.src)
        stuck.push({
          srcTail: (img.currentSrc || img.src).slice(-40),
          currentSrcEmpty: !img.currentSrc,
          loadingAttr: img.getAttribute('loading'),
          hasTimingEntry: Boolean(e),
          responseEnd: e ? Math.round(e.responseEnd) : null,
          responseStatus: e ? (e.responseStatus ?? null) : null,
          encodedBodySize: e ? e.encodedBodySize : null
        })
      }
    }
    // 滚动容器判定：window 滚不动时，需要知道真正可滚的元素是谁
    const scrollers = (Array.from(document.querySelectorAll('*')) as HTMLElement[])
      .filter((el) => el.scrollHeight - el.clientHeight > 200 && el.clientHeight > 200)
      .map((el) => `${el.tagName.toLowerCase()}.${(el.className || '').toString().slice(0, 40)}`)
    const doc = document.scrollingElement as HTMLElement | null
    return {
      onScreen,
      offScreen,
      notLaidOut,
      skeletonsLaidOut: Array.from(
        document.querySelectorAll('[data-testid="thumb-reveal-skeleton"]')
      ).filter((el) => el.getBoundingClientRect().width > 0).length,
      stuckOnScreen: stuck,
      offScreenTops: offTops.slice(0, 12),
      scroll: {
        scrollY: Math.round(window.scrollY),
        winHeight: innerHeight,
        docHeight: doc ? doc.scrollHeight : 0,
        scroller: scrollers.slice(0, 3).join(' | ') || 'window'
      }
    }
  })
}

/**
 * 副本缓存目录里的缩略图文件数。
 * 用作「切板块真的触发了多少次按需生成」的直接观测量：渲染层不发 IPC 时该值恒不变
 * （改前实测：整轮板块切换增量 0，而手工直调 generate 4 次立刻 +4）。
 */
async function countCacheFiles(): Promise<number> {
  const entries = await fs.readdir(path.join(CLONE_DIR, 'thumbnails')).catch(() => [] as string[])
  return entries.filter((name) => name.endsWith('.jpg')).length
}

/** 默认视图（图库首屏口径）里 thumbnail 为 NULL 的行数 */ async function nullThumbnailRows(
  win: Page
): Promise<{ rows: number; nullRows: number }> {
  return win.evaluate(async () => {
    const api = window.electronAPI as unknown as RealAPI
    const page = await api.media.list({ cursor: null, pageSize: 500, hideDuplicates: true })
    const files = (page.files ?? []) as Array<{ thumbnail?: string | null }>
    return { rows: files.length, nullRows: files.filter((f) => !f.thumbnail).length }
  })
}

test.describe.serial('@perf-real 真实数据副本：缩略图显影测量', () => {
  test.skip(!SOURCE_USER_DATA, '需设置 PERF_REAL_USERDATA 指向本机 userData 目录')

  test.beforeAll(async () => {
    test.setTimeout(300_000)
    // 源库必须存在且非空，否则整节测的是空气
    const stat = await fs.stat(SOURCE_DB).catch(() => null)
    expect(stat && stat.size > 0, `未找到真实数据库：${SOURCE_DB}`).toBeTruthy()

    await fs.rm(CLONE_ROOT, { recursive: true, force: true })
    await fs.mkdir(path.join(CLONE_DIR, 'database'), { recursive: true })
    // 只克隆「库 + 缩略图缓存 + 搜索索引」三类状态：
    // - database/*.db*（含 -wal/-shm/clean-exit 标记）：真实媒体记录与 app_settings
    // - 刻意不克隆 Cache/：让首启是冷 HTTP 缓存，二次启动是热缓存，形成对照
    const dbDir = path.join(SOURCE_USER_DATA, 'database')
    for (const entry of await fs.readdir(dbDir)) {
      if (!entry.startsWith('meow_star_map.db')) continue
      await fs.copyFile(path.join(dbDir, entry), path.join(CLONE_DIR, 'database', entry))
    }

    // 自定义目录重定向（关键隔离步骤）：app_settings 里的 logDir / crashDir / backupDir /
    // thumbnailCacheDir 是**绝对路径**，applyCustomDirectories 会在启动时把它们指回真实目录，
    // 使 --user-data-dir 的隔离形同虚设（实测：副本运行把日志写进 %APPDATA% 真实日志目录、
    // 把缩略图写进 D:\NikkiGallery缓存）。这里把四个设置改写到副本内部，并把真实缓存目录的
    // 内容复制进来，既保住「副本带着真实缓存」的测量前提，又不碰用户任何真实目录。
    // node:sqlite 而非 better-sqlite3：后者按 Electron ABI 编译，在 Playwright 的普通 Node
    // 测试进程里 dlopen 会报 NODE_MODULE_VERSION 不匹配。这里只需要读写 app_settings 几行。
    // 必须惰性 import：e2e/playwright.config.ts 的 testMatch '*.e2e.ts' 会在**收集阶段**就
    // import 本文件（--grep-invert 只过滤执行、不过滤收集），而 node:sqlite 需 Node ≥ 22.5
    // 且早期版本要 --experimental-sqlite —— 顶层 import 会让 e2e:smoke 在低版本 Node 上
    // 整个套件以 Cannot find module 失败。真正的守卫是下面的 describe 级 test.skip。
    const { DatabaseSync } = await import('node:sqlite').catch((err: unknown) => {
      throw new Error(
        `@perf-real 需要 node:sqlite，本机 Node ${process.version} 未能加载：` +
          `请用 Node ≥ 23.4，或设 NODE_OPTIONS=--experimental-sqlite 后再跑。原始错误：${String(err)}`
      )
    })
    const cloneDbPath = path.join(CLONE_DIR, 'database', 'meow_star_map.db')
    const sqlite = new DatabaseSync(cloneDbPath)
    let realCacheDir = ''
    try {
      const readDir = (key: string): string => {
        const row = sqlite.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
          { value: string } | undefined
        if (!row) return ''
        try {
          const parsed = JSON.parse(row.value)
          return typeof parsed === 'string' ? parsed : ''
        } catch {
          return ''
        }
      }
      realCacheDir = readDir('thumbnailCacheDir')
      const redirects: Record<string, string> = {
        thumbnailCacheDir: path.join(CLONE_DIR, 'thumbnails'),
        logDir: path.join(CLONE_DIR, 'logs'),
        crashDir: path.join(CLONE_DIR, 'crashes'),
        backupDir: path.join(CLONE_DIR, 'backups')
      }
      // 与 DatabaseManager.setSetting 同形：INSERT OR REPLACE + JSON.stringify(value)
      const upsert = sqlite.prepare(
        'INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)'
      )
      for (const [key, dir] of Object.entries(redirects)) {
        upsert.run(key, JSON.stringify(dir))
      }
    } finally {
      sqlite.close()
    }

    // 缓存来源：优先真实缓存目录（thumbnailCacheDir 指向处），回退 userData/thumbnails
    const cacheSource =
      realCacheDir && (await fs.stat(realCacheDir).catch(() => null))?.isDirectory()
        ? realCacheDir
        : path.join(SOURCE_USER_DATA, 'thumbnails')
    await fs
      .cp(cacheSource, path.join(CLONE_DIR, 'thumbnails'), { recursive: true })
      .catch(async () => {
        // 无缓存目录时退化为「全部冷生成」：目录仍需存在，避免 generator 首启自建
        await fs.mkdir(path.join(CLONE_DIR, 'thumbnails'), { recursive: true })
      })
    await fs
      .cp(path.join(SOURCE_USER_DATA, 'search-index'), path.join(CLONE_DIR, 'search-index'), {
        recursive: true
      })
      .catch(() => undefined)
    process.stdout.write(
      `[real] 缓存来源: ${cacheSource}\n[real] 自定义目录已重定向到副本：thumbnailCacheDir/logDir/crashDir/backupDir\n`
    )
    cloneDirUsed = CLONE_DIR
  })

  test.afterAll(async () => {
    await closeApp(launched, { keepUserData: true })
    launched = undefined
    // 副本含真实媒体元数据：默认跑完即删。PERF_REAL_KEEP=1 时保留，便于事后翻日志取证。
    if (cloneDirUsed && !process.env.PERF_REAL_KEEP) {
      await fs.rm(cloneDirUsed, { recursive: true, force: true }).catch(() => undefined)
    } else if (cloneDirUsed) {
      process.stdout.write(`[real] PERF_REAL_KEEP=1，保留副本：${cloneDirUsed}\n`)
    }
  })

  test('R1 克隆真实 userData（只读出源，写入全落副本）', async () => {
    const clonedFiles = await fs.readdir(path.join(CLONE_DIR, 'database'))
    const thumbCount = await fs.readdir(path.join(CLONE_DIR, 'thumbnails')).catch(() => [])
    process.stdout.write(
      `[real] 克隆目录: ${CLONE_DIR}\n[real] 库文件: ${clonedFiles.join(', ')}\n` +
        `[real] 缩略图缓存文件数: ${thumbCount.length}\n`
    )
    expect(
      clonedFiles.some((f) => f === 'meow_star_map.db'),
      '应克隆主库文件'
    ).toBeTruthy()
  })

  test('R2 首启（冷缓存）：首图显影、网格沉降、NULL 行数、日志副作用计数', async () => {
    test.setTimeout(240_000)
    const start = performance.now()
    launched = await launchApp({ userDataDir: CLONE_DIR })
    const win = await launched.app.firstWindow()
    await win.waitForLoadState('domcontentloaded', { timeout: 30_000 })
    const bootMs = performance.now() - start

    const galleryTitle = await clickNav(win, /图库|Gallery/)
    if (!galleryTitle) process.stdout.write('[real] 警告：未匹配到图库导航，R2 按默认视图测量\n')

    const firstThumbMs = await waitFirstThumb(win)
    const settle = await waitSkeletonClear(win)
    const inventory = await thumbInventory(win)
    const dbCount = await nullThumbnailRows(win)

    const writeBack = await countLogPattern(CLONE_DIR, /按需生成结果回写数据库失败/)
    const orphan = await countLogPattern(CLONE_DIR, /孤儿缩略图|Thumbnail Cleanup/)
    const worker = await countLogPattern(
      CLONE_DIR,
      /workerCallFailed|handshakeFailed|worker 超时|异常退出/
    )

    const metrics = {
      scenario: 'R2 首启（冷缓存）',
      bootMs: Math.round(bootMs),
      firstThumbnailVisibleMs: Math.round(firstThumbMs),
      skeletonSettleMs: Math.round(settle.elapsedMs),
      skeletonCleared: settle.cleared,
      skeletonRemaining: settle.remaining,
      mediaImages: inventory,
      defaultViewRows: dbCount.rows,
      defaultViewNullThumbnails: dbCount.nullRows,
      logCounts: {
        writeBackFailures: writeBack.count,
        orphanCleanup: orphan.count,
        workerDegraded: worker.count
      }
    }
    process.stdout.write(`[real] ${JSON.stringify(metrics)}\n`)
    for (const line of writeBack.samples) process.stdout.write(`  ↳ 回写失败: ${line}\n`)
    for (const line of orphan.samples) process.stdout.write(`  ↳ 孤儿清理: ${line}\n`)
    for (const line of worker.samples) process.stdout.write(`  ↳ worker: ${line}\n`)

    expect(metrics.mediaImages.revealed, '首屏应至少显影一张 media:// 缩略图').toBeGreaterThan(0)
    results.push(metrics)
  })

  test('R3 板块切换：各板块首图显影耗时', async () => {
    test.setTimeout(300_000)
    if (!launched) throw new Error('R2 未启动应用，无法测板块切换')
    const win = await launched.app.firstWindow()
    process.stdout.write(`[real] 可用导航标题: ${(await navTitles(win)).join(' | ')}\n`)
    const sections: Array<{ name: string; pattern: RegExp }> = [
      { name: '重复文件', pattern: /重复|Duplicate/ },
      // zh 里启动器缓存板块标题就是「缓存」，用整串匹配避免误命中「折叠」等
      { name: '启动器缓存', pattern: /^缓存$|启动器|Launcher/ },
      { name: '分类', pattern: /分类|Categories/ },
      { name: '回收站', pattern: /回收站|Recycle/ },
      { name: '图库（返回）', pattern: /图库|Gallery/ }
    ]
    for (const section of sections) {
      const title = await clickNav(win, section.pattern)
      if (!title) {
        process.stdout.write(`[real] ${section.name}：未找到导航项，跳过\n`)
        continue
      }
      // 切板块后先等挂载，再计时——计时起点对齐「用户点完导航」这一刻
      await win.waitForTimeout(150)
      // 基线快照：虚拟网格切板块会重挂，但仍记录 click 时已显影数量，
      // 避免「上一板块残留图片」让新板块被误读成 0ms
      const before = await thumbInventory(win)
      const cacheBefore = await countCacheFiles()
      let firstThumbMs: number | null = null
      try {
        firstThumbMs = Math.round(await waitRevealedBeyond(win, before.revealed, 15_000))
      } catch {
        // 15s 内没有任何新显影：空板块或生成卡死，记 null 由 inventory 佐证
      }
      const settle = await waitSkeletonClear(win, 10_000)
      const after = await thumbInventory(win)
      // 缓存目录增量 = 本轮切板块真的触发了多少次按需生成（改前实测恒为 0）
      const cacheDelta = (await countCacheFiles()) - cacheBefore
      const metrics = {
        scenario: `R3 切板块：${section.name}`,
        navTitle: title,
        firstThumbnailVisibleMs: firstThumbMs,
        skeletonSettleMs: Math.round(settle.elapsedMs),
        skeletonCleared: settle.cleared,
        skeletonRemaining: settle.remaining,
        onDemandGeneratedFiles: cacheDelta,
        imagesAtClick: before,
        imagesAfter: after
      }
      process.stdout.write(`[real] ${JSON.stringify(metrics)}\n`)
      results.push(metrics)
      // 客观判据：板块内「已布局」的卡片不能停在生成中骨架——要么出图，要么落占位图标
      expect(
        after.revealSkeletons,
        `${section.name}：切板块后仍有 ${after.revealSkeletons} 张已布局卡片停在按需生成骨架（未出图也未落占位）`
      ).toBe(0)
    }
  })

  test('R3b 直接调用 thumbnail:generate 取证（NULL 行到底能不能生成出来）', async () => {
    // 决定性探针：绕开渲染层，直接按「可视区按需生成」的同一条 IPC 打三次，
    // 打印每张的耗时与返回值/异常——骨架永不归零只有两种解释（返回 null / 请求悬挂），
    // 两者的修法完全不同，必须用数值区分，不能靠读代码猜。
    test.setTimeout(150_000)
    if (!launched) throw new Error('R2 未启动应用')
    const win = await launched.app.firstWindow()
    await clickNav(win, /图库|Gallery/)

    const probe = await win.evaluate(async () => {
      const api = window.electronAPI as unknown as RealAPI
      const page = await api.media.list({ cursor: null, pageSize: 500, hideDuplicates: false })
      const files = (page.files ?? []) as Array<{ file_path: string; thumbnail?: string | null }>
      const nulls = files.filter((f) => !f.thumbnail && typeof f.file_path === 'string').slice(0, 4)
      const out: Array<Record<string, unknown>> = []
      for (const f of nulls) {
        // 对照组：同一条路径，媒体白名单守卫（getExif）与裸 PathGuard 守卫（generate）各测一次
        let exif: string | null = 'ok'
        try {
          await api.file.getExif(f.file_path)
        } catch (err) {
          exif = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        }
        const t0 = performance.now()
        let result: string | null = null
        let error: string | null = null
        try {
          result = await api.thumbnail.generate(f.file_path)
        } catch (err) {
          error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        }
        out.push({
          tail: f.file_path.slice(-34),
          mediaGuardExif: exif,
          ms: Math.round(performance.now() - t0),
          result: result ? result.slice(-26) : null,
          error
        })
      }
      return { rows: files.length, nullRows: files.filter((f) => !f.thumbnail).length, probes: out }
    })
    process.stdout.write(
      `[real] R3b 直调生成：首页 ${probe.rows} 行，NULL ${probe.nullRows} 行\n` +
        probe.probes.map((p) => JSON.stringify(p)).join('\n') +
        '\n'
    )
    results.push({ scenario: 'R3b 直调 thumbnail:generate 取证', ...probe })
  })

  test('R4 二次启动（同副本、热缓存）：与 R2 对照，判定是否重复等一遍', async () => {
    test.setTimeout(240_000)
    // 关键判据：真实数据里若每次启动都要重生成，R4 首图耗时会回到 R2 量级甚至更高；
    // 若引用健康，R4 应显著低于 R2（DB 已有 thumbnail 引用 + Chromium 热缓存）
    await closeApp(launched, { keepUserData: true })
    launched = undefined

    const start = performance.now()
    launched = await launchApp({ userDataDir: CLONE_DIR })
    const win = await launched.app.firstWindow()
    await win.waitForLoadState('domcontentloaded', { timeout: 30_000 })
    const bootMs = performance.now() - start
    await clickNav(win, /图库|Gallery/)

    const firstThumbMs = await waitFirstThumb(win)
    const settle = await waitSkeletonClear(win)
    const inventory = await thumbInventory(win)
    const dbCount = await nullThumbnailRows(win)
    const writeBack = await countLogPattern(CLONE_DIR, /按需生成结果回写数据库失败/)
    const orphan = await countLogPattern(CLONE_DIR, /孤儿缩略图|Thumbnail Cleanup/)

    const metrics = {
      scenario: 'R4 二次启动（热缓存）',
      bootMs: Math.round(bootMs),
      firstThumbnailVisibleMs: Math.round(firstThumbMs),
      skeletonSettleMs: Math.round(settle.elapsedMs),
      skeletonCleared: settle.cleared,
      skeletonRemaining: settle.remaining,
      mediaImages: inventory,
      defaultViewRows: dbCount.rows,
      defaultViewNullThumbnails: dbCount.nullRows,
      logCounts: { writeBackFailures: writeBack.count, orphanCleanup: orphan.count }
    }
    process.stdout.write(`[real] ${JSON.stringify(metrics)}\n`)
    for (const line of writeBack.samples) process.stdout.write(`  ↳ 回写失败: ${line}\n`)
    for (const line of orphan.samples) process.stdout.write(`  ↳ 孤儿清理: ${line}\n`)

    results.push(metrics)
  })

  test('R4b 副本日志取证摘录（缩略图链路相关行）', async () => {
    test.setTimeout(60_000)
    const lines = await dumpLogLines(CLONE_DIR, /Thumbnail|缩略图|worker|按需生成|生成失败/i, 30)
    results.push({ scenario: 'R4b 日志命中行数', matched: lines.length })
  })

  test('R4c 卡死卡片取证：未完成的 img 到底在等什么（热缓存会话）', async () => {
    // 骨架长挂的唯一解释是「img 有非空 src 但永不 complete」（ThumbReveal 在 src 为空时
    // 直接 return null，不产骨架）。三种成因的修法完全不同，必须区分：
    // ① Chromium 根本没发起请求（loading=lazy 的视口外懒加载）→ resource timing 无该 URL
    // ② 请求发出但主进程不响应 → 有 entry 且 responseEnd 未收敛
    // ③ 返回 404/空响应 → 有 entry + responseStatus 非 200，但 img 会 onError（broken>0）
    //
    // 上一轮取证实测：20 张长挂骨架全部是 ①（currentSrc 为空、无 timing entry、
    // getBoundingClientRect 落在视口外），即「虚拟网格 overscan 挂载 + img loading=lazy」
    // 的预期懒加载，而不是卡死。故本场景按视口内/外分桶计数，并把「滚进视口后是否出图」
    // 作为客观判据——视口内仍有 pending 才是真缺陷。
    test.setTimeout(180_000)
    if (!launched) throw new Error('R2 未启动应用')
    const win = await launched.app.firstWindow()
    const title = await clickNav(win, /重复|Duplicate/)
    if (!title) throw new Error('未找到重复文件导航，无法取证')
    await win.waitForTimeout(8_000)

    const before = await thumbSnapshotByViewport(win)
    process.stdout.write(`[real] R4c 滚动前：${JSON.stringify(before)}\n`)

    // 向下滚 3 个视口高度，逐次测量「进入视口后的出图延迟」
    const scrolls: Array<Record<string, unknown>> = []
    for (let step = 0; step < 3; step++) {
      const prevOnScreen = await thumbSnapshotByViewport(win)
      // 同时尝试 window 与内部滚动容器：真实布局里 VirtuosoGrid 的滚动父元素可能不是 window，
      // 只滚 window 会得到「视口内卡片数恒定」的假象（本轮上一次实测就是这样）
      await win.evaluate(() => {
        const delta = Math.round(window.innerHeight * 0.9)
        window.scrollBy(0, delta)
        const scrollers = (Array.from(document.querySelectorAll('*')) as HTMLElement[])
          .filter((el) => el.scrollHeight - el.clientHeight > 200 && el.clientHeight > 200)
          .sort((a, b) => b.scrollHeight - b.clientHeight - (a.scrollHeight - a.clientHeight))
        scrollers[0]?.scrollBy(0, delta)
      })
      const t0 = performance.now()
      let latencyMs: number | null = null
      try {
        await win.waitForFunction(
          (base) => {
            const vis = (Array.from(document.querySelectorAll('img')) as HTMLImageElement[]).filter(
              (img) => {
                const r = img.getBoundingClientRect()
                return (
                  img.src.startsWith('media://') &&
                  r.width > 0 &&
                  r.bottom > 0 &&
                  r.top < window.innerHeight
                )
              }
            )
            return vis.filter((i) => i.complete && i.naturalWidth > 0).length > (base as number)
          },
          prevOnScreen.onScreen.revealed,
          { timeout: 10_000 }
        )
        latencyMs = Math.round(performance.now() - t0)
      } catch {
        latencyMs = null
      }
      const snap = await thumbSnapshotByViewport(win)
      scrolls.push({
        step,
        revealLatencyMs: latencyMs,
        onScreen: snap.onScreen,
        offScreenPending: snap.offScreen.pending,
        notLaidOutPending: snap.notLaidOut.pending
      })
    }
    const after = await thumbSnapshotByViewport(win)
    process.stdout.write(
      `[real] R4c 滚动序列：${JSON.stringify(scrolls)}\n[real] R4c 滚动后：${JSON.stringify(after)}\n`
    )
    for (const card of after.stuckOnScreen) {
      process.stdout.write(`  ▸ 视口内未出图卡片：${JSON.stringify(card)}\n`)
    }

    results.push({
      scenario: 'R4c 重复文件：视口内外分桶 + 滚动出图延迟',
      navTitle: title,
      beforeScroll: before,
      scrolls,
      afterScroll: after
    })

    // 客观判据：滚进视口的卡片必须在等待窗口内出图（视口外懒加载不计）
    expect(
      after.onScreen.pending,
      `滚动 3 次后视口内仍有 ${after.onScreen.pending} 张 media:// 图片未加载`
    ).toBe(0)
  })

  test('R5 结果落盘', async () => {
    await fs.mkdir(CLONE_ROOT, { recursive: true })
    const out = {
      timestamp: new Date().toISOString(),
      sourceUserData: SOURCE_USER_DATA,
      platform: `${process.platform}-${process.arch}`,
      metrics: results
    }
    const file = path.join(CLONE_ROOT, 'latest-real.json')
    await fs.writeFile(file, JSON.stringify(out, null, 2), 'utf-8')
    process.stdout.write(`[real] 结果已保存: ${file}\n`)
    expect(results.length, '至少产出 R2/R4 两条指标').toBeGreaterThanOrEqual(2)
  })
})
