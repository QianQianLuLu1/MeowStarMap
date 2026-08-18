/**
 * 全文搜索服务：索引生命周期管理
 *
 * 职责：
 * - init：启动时优先从 userData 导入已持久化的索引，校验失败则全量重建
 * - rebuild：分页拉取所有媒体数据，构建索引
 * - update：增量更新（mediaStore 变化时调用）
 * - search：返回命中的 mediaId 列表，索引未就绪时返回 null 触发降级
 *
 * 降级链：
 * flexsearch 索引就绪 → 否（索引未就绪/损坏） → 降级到客户端过滤（useFilteredMediaFiles）
 *
 * 持久化策略：
 * - 全量重建完成后立即持久化（含 schema_hash）
 * - 增量更新后 500ms 防抖持久化
 * - 失效条件：文件不存在 / exportedAt > 7 天 / schema_hash 不匹配 / 文档数偏差 > 5% → 全量重建
 */
import {
  getSearchIndex,
  recreateSearchIndex,
  INDEX_FIELD_CONFIG,
  type SearchableDoc
} from './search-index'
import { buildSearchableDoc } from './doc-builder'
import type { MediaFile } from '../stores/mediaStore'

export type SearchState = 'idle' | 'loading' | 'ready' | 'error'

/** 索引持久化有效期：超过 7 天强制重建，避免长期未使用导致索引与数据库偏差过大 */
const INDEX_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 校验偏差阈值：索引文档数与数据库总数偏差超过 5% 触发重建 */
const REBUILD_DEVIATION_RATIO = 0.05
/** 增量更新后持久化防抖时间 */
const PERSIST_DEBOUNCE_MS = 500
/** 全量重建分页大小 */
const REBUILD_PAGE_SIZE = 5000

class SearchService {
  private state: SearchState = 'idle'
  private indexedDocCount = 0
  private stateListeners = new Set<(state: SearchState) => void>()
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  /** R15：最近一次重建时的 schema_hash，persist 时写入 meta */
  private currentSchemaHash = ''

  getState(): SearchState {
    return this.state
  }

  getIndexedDocCount(): number {
    return this.indexedDocCount
  }

  /** 索引是否就绪（用于诊断搜索返回空的原因） */
  isReady(): boolean {
    return this.state === 'ready'
  }

  /** 订阅状态变化（供 UI 显示"索引中..."提示） */
  onStateChange(listener: (state: SearchState) => void): () => void {
    this.stateListeners.add(listener)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  private setState(state: SearchState): void {
    this.state = state
    this.stateListeners.forEach((l) => l(state))
  }

  /**
   * 初始化：优先从 userData 导入已持久化的索引，校验失败则全量重建。
   * 在 App.tsx 启动时调用一次（通过 useSearchIndex hook）。
   */
  async init(): Promise<void> {
    if (this.state === 'loading' || this.state === 'ready') return
    this.setState('loading')
    try {
      // HTML 预览版无 IPC，直接降级到 error（调用方走客户端过滤）
      if (!window.electronAPI?.media?.searchImportIndex) {
        console.warn('[Search] 无 IPC 环境（HTML 预览版），降级到客户端过滤')
        this.setState('error')
        return
      }

      const importRes = await window.electronAPI.media.searchImportIndex()
      const { segments, exportedAt, schemaHash: storedSchemaHash } = importRes
      if (segments.length > 0 && exportedAt) {
        // 校验：导出时间距现在 < 7 天才信任，否则重建
        const ageMs = Date.now() - new Date(exportedAt).getTime()
        if (ageMs < INDEX_TTL_MS) {
          // R15：校验 schema_hash（字段级变更触发重建）
          // storedSchemaHash 为空时跳过校验（旧索引向后兼容）
          if (storedSchemaHash) {
            const currentSchemaHash = await this.computeSchemaHash()
            if (storedSchemaHash !== currentSchemaHash) {
              console.warn(
                '[Search] 索引 schema_hash 不匹配，触发重建:',
                `stored=${storedSchemaHash}, current=${currentSchemaHash}`
              )
              await this.rebuild()
              return
            }
          }
          try {
            for (const seg of segments) {
              getSearchIndex().import(seg.key, seg.data)
            }
            // 导入成功后通过校验确认数量是否一致；不一致则后台重建
            this.setState('ready')
            // FIX(组22-1): segments.length 是导出分片数（字段索引分片 + reg 分片，通常仅个位数）
            // 而非文档数，用它做 indexedDocCount 会让 validateAndRebuildIfNeeded 的 5% 偏差
            // 校验几乎必然触发，每次启动都全量重建，持久化索引形同虚设。
            // 改为解析 reg 分片（文档 id 注册表，键形如 "N.reg"）统计实际文档数；解析失败回退 0，
            // 由既有偏差校验触发重建兜底
            this.indexedDocCount = countImportedDocs(segments)
            void this.validateAndRebuildIfNeeded()
            return
          } catch (importErr) {
            // 旧索引可能用 fastupdate: true 导出，与新配置不兼容
            console.warn('[Search] 索引导入失败，降级到全量重建:', importErr)
          }
        }
      }
      // 无缓存或缓存过期或导入失败 → 全量重建
      await this.rebuild()
    } catch (err) {
      console.error('[Search] 初始化失败，降级到客户端过滤:', err)
      this.setState('error')
    }
  }

  /**
   * 全量重建：分页拉取所有媒体数据，构建索引。
   * 万级数据 ~3-5s，UI 显示进度条。
   */
  async rebuild(): Promise<void> {
    this.setState('loading')
    // flexsearch 0.8.x 的 clear() 会破坏内部注册表状态，
    // 改用 recreateSearchIndex() 创建新实例替代
    recreateSearchIndex()
    this.indexedDocCount = 0

    if (!window.electronAPI?.media?.searchBuildDocs) {
      this.setState('error')
      return
    }

    let offset = 0
    try {
      while (true) {
        const result = await window.electronAPI.media.searchBuildDocs({
          limit: REBUILD_PAGE_SIZE,
          offset
        })
        for (const row of result.docs) {
          // 解析 tags JSON 字段为空格分隔字符串
          // 数据库可能存储为 JSON 数组字符串（如 '["礼服","夜景"]'），需解析后 join
          const tagsStr = parseTagsToString(row.tags)
          const doc: SearchableDoc = {
            id: row.id,
            file_name: row.file_name,
            tags: tagsStr,
            outfit: row.outfit,
            scene_category: row.scene_category || '',
            camera_params: '', // Phase 2 接入
            notes: row.notes
          }
          getSearchIndex().add(doc.id, doc)
        }
        this.indexedDocCount += result.docs.length
        offset += REBUILD_PAGE_SIZE
        if (!result.hasMore) break
      }
      // 持久化到 userData
      this.currentSchemaHash = await this.computeSchemaHash()
      await this.persist()
      this.setState('ready')
    } catch (err) {
      console.error('[Search] 全量重建失败:', err)
      this.setState('error')
    }
  }

  /**
   * 增量更新：当 mediaStore 的 mediaFiles 变化时调用。
   * 对比已有索引与新增/更新/删除的文档，仅更新差异部分。
   */
  update(changes: { added: MediaFile[]; updated: MediaFile[]; removed: number[] }): void {
    if (this.state !== 'ready') return
    let dirty = false
    for (const file of changes.added) {
      const doc = buildSearchableDoc(file)
      getSearchIndex().add(doc.id, doc)
      this.indexedDocCount++
      dirty = true
    }
    for (const file of changes.updated) {
      const doc = buildSearchableDoc(file)
      getSearchIndex().update(doc.id, doc) // flexsearch update = remove + add
      dirty = true
    }
    for (const id of changes.removed) {
      getSearchIndex().remove(id)
      this.indexedDocCount--
      dirty = true
    }
    if (dirty) {
      this.schedulePersist()
    }
  }

  /**
   * 搜索：返回命中的 mediaId 列表。
   * - 索引未就绪时返回 null，调用方降级到客户端过滤
   * - 空查询返回 null（不应用搜索过滤）
   *
   * 返回的 id 是 DB INTEGER 类型，调用方按需 String(id) 与 MediaFile.id 对齐
   */
  search(query: string, limit = 500): number[] | null {
    if (this.state !== 'ready') return null
    const trimmed = query.trim()
    if (!trimmed) return null

    const results = getSearchIndex().search(trimmed, { limit })
    // flexsearch Document.search 返回每字段一个结果对象，需合并去重
    const idSet = new Set<number>()
    for (const fieldResult of results) {
      // DefaultDocumentSearchResults 类型：{ field?, result: Id[] }
      const ids = (fieldResult as { result: Array<number | string> }).result
      for (const id of ids) {
        idSet.add(Number(id))
      }
    }
    return Array.from(idSet)
  }

  /** 防抖持久化：500ms 内多次更新合并为一次 export */
  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.persist().catch((err) => {
        console.warn('[Search] 防抖持久化失败:', err)
      })
    }, PERSIST_DEBOUNCE_MS)
  }

  /**
   * 持久化索引到 userData
   * flexsearch export 是同步遍历所有片段，逐个调用回调；用 Promise 包裹后等待
   */
  private async persist(): Promise<void> {
    if (!window.electronAPI?.media?.searchExportIndex) return
    const segments: Array<{ key: string; data: string }> = []
    await new Promise<void>((resolve) => {
      // export 同步遍历所有片段；用回调收集后 resolve
      getSearchIndex().export((key: string, data: string) => {
        segments.push({ key, data })
      })
      // flexsearch 0.8 同步 export 完成后回调链结束，直接 resolve
      resolve()
    })
    // call() 失败时抛出 IpcError，由调用方 try/catch 处理
    await window.electronAPI.media.searchExportIndex(segments, this.currentSchemaHash)
  }

  /**
   * 异步校验：索引文档数与数据库总数对比，不一致则重建
   * 仅查询一次（limit=1）以获取 total
   */
  private async validateAndRebuildIfNeeded(): Promise<void> {
    try {
      const result = await window.electronAPI!.media.searchBuildDocs({ limit: 1 })
      const dbTotal = result.total
      // 偏差超过 5% → 重建
      if (
        dbTotal > 0 &&
        Math.abs(dbTotal - this.indexedDocCount) > dbTotal * REBUILD_DEVIATION_RATIO
      ) {
        console.warn(
          '[Search] 索引文档数与数据库不一致，触发重建:',
          `indexed=${this.indexedDocCount}, db=${dbTotal}`
        )
        await this.rebuild()
      }
    } catch (err) {
      console.warn('[Search] 校验失败:', err)
    }
  }

  /**
   * R15：计算 schema_hash（静态字段配置 + 采样数据特征）
   *
   * 静态部分：索引字段名 + tokenize 策略 + resolution（代码变更时失效）
   * 采样部分：100 条文档中各字段是否有非空值（数据填充变化时失效）
   *
   * 开销：一次 IPC 调用（limit=100），<100ms
   */
  private async computeSchemaHash(): Promise<string> {
    // 静态部分：字段配置指纹
    const staticPart = INDEX_FIELD_CONFIG

    // 采样部分：检查各字段在 100 条样本中是否有非空值
    try {
      const result = await window.electronAPI!.media.searchBuildDocs({ limit: 100 })
      const fields = ['file_name', 'tags', 'outfit', 'scene_category', 'notes'] as const
      const samplePart = fields
        .map((f) => {
          const hasValue = result.docs.some((d) => {
            const val = d[f]
            return val !== null && val !== undefined && val !== ''
          })
          return `${f}:${hasValue ? 1 : 0}`
        })
        .join(',')
      return `${staticPart}|sample:${samplePart}`
    } catch {
      // 采样失败时仅用静态部分（不阻塞索引构建）
      return staticPart
    }
  }
}

/**
 * 解析 media_files.tags 字段为空格分隔字符串
 * 兼容三种存储格式：JSON 数组字符串、空字符串、null
 */
function parseTagsToString(tags: string): string {
  if (!tags) return ''
  try {
    const parsed = JSON.parse(tags)
    return Array.isArray(parsed) ? parsed.join(' ') : ''
  } catch {
    // 非 JSON 字符串，按原样返回（已为空格分隔）
    return tags
  }
}

/**
 * FIX(组22-1): 统计导出分片中实际导入的文档数。
 * flexsearch export 的 reg 分片（键形如 "1.reg"、"2.reg"）是文档 id 注册表，
 * 每个分片的 data 为 id 的 JSON 数组（超大会按 chunk 拆分为多个 reg 分片），
 * 文档数 = 各 reg 分片 id 数之和。无 reg 分片或解析失败返回 0，
 * 由 validateAndRebuildIfNeeded 的偏差校验触发全量重建兜底。
 */
function countImportedDocs(segments: Array<{ key: string; data: string }>): number {
  let count = 0
  for (const seg of segments) {
    if (!seg.key.endsWith('.reg')) continue
    try {
      const ids = JSON.parse(seg.data)
      if (Array.isArray(ids)) count += ids.length
    } catch {
      // 单个分片解析失败按 0 计，交给偏差校验兜底
    }
  }
  return count
}

export const searchService = new SearchService()
