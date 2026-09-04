/**
 * @layer L3
 * @module src/renderer/search/search-service
 * @coverage isReady() 诊断方法 + search() 降级契约 + R15 schema_hash 字段级校验
 * @dependencies vitest
 * @remarks 任务 5（P2）验证：searchService.isReady() 提供索引就绪状态诊断，
 *   便于排查"搜索返回空"是索引未就绪还是真无匹配。
 *
 * 测试策略：searchService 是单例，初始状态为 'idle'。isReady() 仅检查 this.state === 'ready'，
 *   不依赖 window/IPC，可在 node 环境直接测试。search() 在 state !== 'ready' 时返回 null
 *   是 useFilteredMediaFiles 降级链路的关键契约，一并验证。
 *
 *   R15 测试使用 vi.resetModules + 动态 import 获取单例的新实例，
 *   避免与上面测试共享单例状态。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { searchService } from './search-service'
import { INDEX_FIELD_CONFIG } from './search-index'

// R15 测试需要 mock flexsearch 索引实例，避免 import() 因 mock 数据格式不匹配而抛错
const { mockIndex } = vi.hoisted(() => ({
  mockIndex: {
    import: vi.fn(),
    add: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    search: vi.fn(() => []),
    export: vi.fn((cb: (key: string, data: string) => void) => cb('mock', '{}'))
  }
}))
vi.mock('./search-index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./search-index')>()
  return {
    ...actual,
    getSearchIndex: vi.fn(() => mockIndex),
    recreateSearchIndex: vi.fn()
  }
})

describe('searchService.isReady 诊断方法（任务 5）', () => {
  it('isReady() 应返回 boolean 类型', () => {
    const result = searchService.isReady()
    expect(typeof result).toBe('boolean')
  })

  it('isReady() 应与 getState() === "ready" 一致', () => {
    const isReady = searchService.isReady()
    const stateIsReady = searchService.getState() === 'ready'
    expect(isReady).toBe(stateIsReady)
  })

  it('单例初始状态 isReady() 应返回 false（idle 或 error，均非 ready）', () => {
    // searchService 是模块级单例，初始 state 为 'idle'
    // 未调用 init()/rebuild() 前 state 不会是 'ready'
    expect(searchService.isReady()).toBe(false)
  })
})

describe('searchService.search 降级契约（与 isReady 关联）', () => {
  it('索引未就绪时 search() 应返回 null 触发调用方降级', () => {
    // isReady() 为 false 时，search() 必须返回 null
    // 这是 useFilteredMediaFiles 降级到客户端过滤的关键信号
    if (!searchService.isReady()) {
      const result = searchService.search('任意查询词')
      expect(result).toBeNull()
    }
  })

  it('空查询时 search() 应返回 null（不应用搜索过滤）', () => {
    // 即使索引就绪，空查询也不应返回结果（设计契约）
    const result = searchService.search('')
    expect(result).toBeNull()
  })

  it('仅空白字符的查询应返回 null', () => {
    const result = searchService.search('   ')
    expect(result).toBeNull()
  })
})

// ==========================================================================
// R15：索引字段级校验（schema_hash）
// ==========================================================================
describe('R15 索引字段级校验', () => {
  it('INDEX_FIELD_CONFIG 包含全部 6 个索引字段', () => {
    expect(INDEX_FIELD_CONFIG).toContain('file_name:forward:9')
    expect(INDEX_FIELD_CONFIG).toContain('tags:strict:7')
    expect(INDEX_FIELD_CONFIG).toContain('outfit:forward:7')
    expect(INDEX_FIELD_CONFIG).toContain('scene_category:forward:5')
    expect(INDEX_FIELD_CONFIG).toContain('camera_params:forward:5')
    expect(INDEX_FIELD_CONFIG).toContain('notes:full:9')
    // 确认恰好 6 个字段（5 个 | 分隔 = 6 段）
    expect(INDEX_FIELD_CONFIG.split('|')).toHaveLength(6)
  })
})

// ==========================================================================
// R15：init() 行为测试（schema_hash 校验触发重建）
// ==========================================================================
describe('R15 init() schema_hash 校验', () => {
  let mockSearchBuildDocs: ReturnType<typeof vi.fn>
  let mockSearchExportIndex: ReturnType<typeof vi.fn>
  let mockSearchImportIndex: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()

    mockSearchBuildDocs = vi.fn()
    mockSearchExportIndex = vi.fn()
    mockSearchImportIndex = vi.fn()

    // Node 环境无 window，手动构造最小 mock
    const mockWindow = {
      electronAPI: {
        media: {
          searchBuildDocs: mockSearchBuildDocs,
          searchExportIndex: mockSearchExportIndex,
          searchImportIndex: mockSearchImportIndex
        }
      }
    }
    vi.stubGlobal('window', mockWindow)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('R15：schema_hash 不匹配时触发全量重建', async () => {
    // 导入返回旧 schemaHash（与当前不匹配）
    mockSearchImportIndex.mockResolvedValue({
      success: true,
      segments: [{ key: 'idx', data: 'mock-data' }],
      fileSize: 100,
      exportedAt: new Date().toISOString(),
      schemaHash: 'OLD_HASH_DOES_NOT_MATCH'
    })

    // rebuild 时的 buildDocs 调用（全量重建分页拉取）
    mockSearchBuildDocs.mockResolvedValue({
      success: true,
      docs: [],
      total: 0,
      hasMore: false
    })

    // persist 调用
    mockSearchExportIndex.mockResolvedValue({
      success: true,
      saved: true,
      path: '/mock/search-index'
    })

    const { searchService: freshService } = await import('./search-service')
    await freshService.init()

    // 验证 rebuild 被触发（searchBuildDocs 被调用用于全量重建 + schema_hash 计算）
    expect(mockSearchBuildDocs).toHaveBeenCalled()
    // 验证导出时包含 schemaHash
    expect(mockSearchExportIndex).toHaveBeenCalledWith(
      expect.any(Array),
      expect.stringContaining('file_name:forward:9')
    )
  })

  it('R15：无 schemaHash 的旧索引不触发重建（向后兼容）', async () => {
    // 旧索引没有 schemaHash 字段
    // 注：segments 需包含 reg 分片（文档 id 注册表）——组22-1 修复后 indexedDocCount
    // 从 reg 分片统计，缺少 reg 会按 0 计并触发偏差重建（真实导出必含 reg 分片）
    mockSearchImportIndex.mockResolvedValue({
      success: true,
      segments: [
        { key: 'idx', data: 'mock-data' },
        { key: '1.reg', data: '[1]' }
      ],
      fileSize: 100,
      exportedAt: new Date().toISOString(),
      schemaHash: '' // 旧索引无 schemaHash
    })

    // validateAndRebuildIfNeeded 的 buildDocs 调用
    mockSearchBuildDocs.mockResolvedValue({
      success: true,
      docs: [{ id: 1, file_name: 'test.jpg', tags: '', outfit: '', scene_category: '', notes: '' }],
      total: 1,
      hasMore: false
    })

    const { searchService: freshService } = await import('./search-service')
    await freshService.init()

    // schemaHash 为空时跳过校验，不调用 computeSchemaHash（不调用 searchBuildDocs limit=100）
    // 仅 validateAndRebuildIfNeeded 会调用 buildDocs（limit=1）
    // 等待 validateAndRebuildIfNeeded 的 void promise 完成
    await new Promise((r) => setTimeout(r, 50))

    // 验证没有触发全量重建（searchExportIndex 仅在 rebuild 后调用）
    expect(mockSearchExportIndex).not.toHaveBeenCalled()
    // 状态应为 ready（导入成功）
    expect(freshService.isReady()).toBe(true)
  })

  it('组22-1: 导入成功后 indexedDocCount 应为 reg 分片统计的实际文档数（而非分片数）', async () => {
    // reg 分片（文档 id 注册表）分两个 chunk 共 5 个 id，另含一个字段索引分片
    mockSearchImportIndex.mockResolvedValue({
      success: true,
      segments: [
        { key: '1.reg', data: JSON.stringify([1, 2, 3]) },
        { key: '2.reg', data: JSON.stringify([4, 5]) },
        { key: 'file_name.1.map', data: '{}' }
      ],
      fileSize: 100,
      exportedAt: new Date().toISOString(),
      schemaHash: '' // 跳过 schema 校验，聚焦计数逻辑
    })

    // DB 实际 5 条：indexed=5 与 total=5 一致，不应触发重建
    mockSearchBuildDocs.mockResolvedValue({
      success: true,
      docs: [],
      total: 5,
      hasMore: false
    })

    const { searchService: freshService } = await import('./search-service')
    await freshService.init()

    expect(freshService.isReady()).toBe(true)
    // 修复前：indexedDocCount = segments.length = 3（分片数）→ 与 total=5 偏差 40% → 必然重建
    expect(freshService.getIndexedDocCount()).toBe(5)

    // 等待 validateAndRebuildIfNeeded 完成：计数一致不应触发重建持久化
    await new Promise((r) => setTimeout(r, 50))
    expect(mockSearchExportIndex).not.toHaveBeenCalled()
  })
})
