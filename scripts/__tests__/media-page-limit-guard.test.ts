import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 媒体分页上界与全库拉齐的防复发守卫。
 *
 * 背景（docs/plans/2026-11-03-fix-media-recognized-count-500-limit-实施计划.md）：
 * 「图片/视频识别数量被限制为最多 500」这个 bug 已经发作两次——
 *   - 第一次 d654b9b（2026-09-08）只修了四个非网格视图，并**刻意把默认的 grid 排除在外**，
 *     还在 useFilteredMediaFiles.count.test.ts 里把「grid 600 条保持首屏 500」钉成了契约；
 *   - 第二次 39bd786（2026-10-14）引入 `limit = max(500, 已加载条数)` 做深度刷新，
 *     本地 DB 分支把它原样写成 media:list 的 pageSize，越过 media-handler 的 zod max(500)，
 *     被 wrapHandler 判 VALIDATION_ERROR、被 fetchMediaFromDatabase 的 catch 吞成 null ⇒
 *     整表刷新静默失效。nikkisync 分支单独补了 clamp 并写明原因，本地分支是它漏掉的项。
 *
 * 两次的共同机制都是「500 这个数在三处各自表述，改一处没人提醒另一处」，
 * 所以守卫钉的是**同源性与禁止式**，而不是某个具体数值。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const MEDIA_STORE_FILE = 'src/renderer/stores/mediaStore.ts'
const MEDIA_HANDLER_FILE = 'src/main/ipc/handlers/media-handler.ts'
const FILTERED_HOOK_FILE = 'src/renderer/hooks/useFilteredMediaFiles.ts'
const MEDIA_REPO_FILE = 'src/main/database/media-repository.ts'

function readSource(relPath: string): string {
  return readFileSync(path.join(repoRoot, relPath), 'utf8')
}

/**
 * 截取两个相邻顶层导出之间的源码区间（含前者、不含后者）。
 *
 * 为什么不用大括号配平找函数体：fetchMediaFromDatabase 的返回类型写成
 * `Promise<{ files: ...; } | null>`，类型字面量里的 `{}` 会先于函数体被配对命中。
 * 按「导出声明边界」切区间只依赖文件内的导出顺序，且两个锚点任一漂移即抛错判红，
 * 不会静默放宽。
 */
function extractRegion(source: string, fromDecl: string, toDecl: string): string {
  const startIdx = source.indexOf(fromDecl)
  if (startIdx === -1) throw new Error(`未找到起始声明：${fromDecl}`)
  const endIdx = source.indexOf(toDecl, startIdx + fromDecl.length)
  if (endIdx === -1) throw new Error(`未找到结束锚点声明：${toDecl}`)
  return source.slice(startIdx, endIdx)
}

/** 解析 `export const NAME = <整数>` 的数值 */
function parseConstNumber(source: string, name: string): number {
  const m = source.match(new RegExp(`export const ${name}\\s*=\\s*(\\d+)`))
  if (!m) throw new Error(`未找到常量 ${name}`)
  return Number(m[1])
}

describe('media 分页上界与全库拉齐守卫', () => {
  describe('不变式 1：页大小与两处上界同源', () => {
    it('MEDIA_PAGE_SIZE === ASSET_PAGE_LIMIT_MAX === media:list 的 zod max', () => {
      const store = readSource(MEDIA_STORE_FILE)
      const handler = readSource(MEDIA_HANDLER_FILE)
      const mediaPageSize = parseConstNumber(store, 'MEDIA_PAGE_SIZE')
      const assetPageLimitMax = parseConstNumber(store, 'ASSET_PAGE_LIMIT_MAX')
      const schemaMatch = handler.match(
        /pageSize:\s*z\.number\(\)\.int\(\)\.positive\(\)\.max\((\d+)\)/
      )
      if (!schemaMatch) {
        throw new Error('未在 media-handler 找到 pageSize 的 zod 上界声明（被改写即视为契约漂移）')
      }
      const zodMax = Number(schemaMatch[1])

      // 三处必须相等：任何一侧被单独改动，另一侧就会静默越界或静默缩页
      expect(mediaPageSize).toBe(zodMax)
      expect(assetPageLimitMax).toBe(zodMax)
    })

    it('media:list 的 pageSize 上界仍存在（不得为省事直接拆掉闸门）', () => {
      const handler = readSource(MEDIA_HANDLER_FILE)
      // 本轮的修法是「让渲染层永不越界」，不是抬高/删除上界。上界一消失，
      // 渲染层一个数字就能把主进程同步 SQLite 打成几十 MB 的结构化克隆。
      expect(handler).toMatch(/pageSize:\s*z\.number\(\)\.int\(\)\.positive\(\)\.max\(\d+\)/)
    })
  })

  describe('不变式 2：深度取数不得把目标深度当单页大小直传', () => {
    it('fetchMediaFromDatabase 传给 media:list 的 pageSize 一律经 Math.min 收口', () => {
      const body = extractRegion(
        readSource(MEDIA_STORE_FILE),
        'export async function fetchMediaFromDatabase',
        'export async function refreshMediaAfterScan'
      )
      // 首页必须以 cursor:null 起（整表刷新语义），且单页大小恒被收口在上界之内
      expect(body).toContain('cursor: null,')
      expect(body).toContain('pageSize: Math.min(')
      // 禁止式：limit 的语义是「目标深度」，原样写进 pageSize 就是第二次发作的直接机制
      expect(body).not.toMatch(/pageSize:\s*options\?\.limit/)
      expect(body).not.toMatch(/pageSize:\s*targetDepth\s*[,}]/)
    })

    it('深度取数有页数硬上限，且并发刷新按代次最新胜出', () => {
      const store = readSource(MEDIA_STORE_FILE)
      expect(store).toMatch(/MAX_DEPTH_PAGES\s*=\s*\d+/)
      expect(store).toContain('depthRefreshSeq')
      // 循环里每个 await 之后都要复查代次，否则旧循环会用过期结果覆盖新结果
      expect(store).toMatch(/myRefresh\s*!==\s*depthRefreshSeq/)
    })
  })

  describe('不变式 3：拉齐全库不得再按视图模式切开', () => {
    it('useFilteredMediaFiles 不再读 viewMode（d654b9b 的病灶正是「grid 例外」）', () => {
      const hook = readSource(FILTERED_HOOK_FILE)
      expect(hook).not.toMatch(/viewMode/)
      // 判据只剩「还有未加载页」，回收站的独立数据源例外保留
      expect(hook).toMatch(/if\s*\(hasMoreMedia\s*&&\s*currentView\s*!==\s*'recycle-bin'\)/)
    })
  })

  describe('不变式 4：分类型真计数不得被拆回只剩数组长度', () => {
    it('listMedia 首页与 total 同时机给出 typeCounts', () => {
      const repo = readSource(MEDIA_REPO_FILE)
      expect(repo).toContain('countMediaByType')
      // typeCounts 与 total 命中同一 WHERE，否则「图片 X · 视频 Y」与列表内容口径分叉
      expect(repo).toMatch(/countMediaByType\(whereClause,\s*whereParams\)/)
      expect(repo).toMatch(/typeCounts\?:\s*\{\s*image:\s*number;\s*video:\s*number\s*\}/)
    })

    it('media:list 响应仍透传 typeCounts', () => {
      const handler = readSource(MEDIA_HANDLER_FILE)
      expect(handler).toMatch(/typeCounts:\s*result\.typeCounts/)
    })

    it('渲染层仍有 store 字段承接服务端计数，且未拉齐时才取真值', () => {
      const store = readSource(MEDIA_STORE_FILE)
      expect(store).toContain('mediaImageCount')
      expect(store).toContain('mediaVideoCount')
      const hook = readSource('src/renderer/hooks/useGallerySummaryCounts.ts')
      // 判据必须是 hasMoreMedia（数组确定不完整），不能改成「永远优先服务端」——
      // 那会让收藏/场景/日期/评分/搜索/分组这类纯前端筛选显示筛选前的总数。
      expect(hook).toMatch(/hasMoreMedia\s*&&/)
    })
  })
})
