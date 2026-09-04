import { create } from 'zustand'
import type {
  ResonanceEditRow,
  ResonanceEvoRow,
  ResonanceGetDataResult,
  ResonancePearpalRow,
  ResonancePullRow,
  ResonanceWardrobeCategory,
  ResonanceWardrobeData
} from '../../shared/types/resonance'
import { MAX_COMMIT_BATCH_ROWS } from '../../shared/types/resonance'
import type { ParsedImportData, ImportInvalidRecord } from '../utils/resonance/importParse'
import { parseImportFileText, countImportDiff } from '../utils/resonance/importParse'
import { buildExportPayload } from '../utils/resonance/exportPayload'

/**
 * 共鸣录 store：状态为纯数据 + 纯 reducer；所有 IPC 副作用在模块级异步函数中
 * （沿用宿主 mediaStore 范式）。错误经 useErrorToast 由调用方展示，store 只记录
 * loadError 供页面空态使用，不吞异常。
 */

export type ResonanceTab = 'records' | 'wardrobe' | 'import' | 'stats'

export interface ResonanceImportProgressState {
  phase: 'preview' | 'commit'
  current: number
  total: number
}

export interface ResonanceState {
  // ---- 数据 ----
  loaded: boolean
  loading: boolean
  loadError: string | null
  pulls: ResonancePullRow[]
  edits: ResonanceEditRow[]
  pearpal: ResonancePearpalRow[]
  evo: ResonanceEvoRow[]
  wardrobe: ResonanceWardrobeData

  // ---- UI ----
  activeTab: ResonanceTab
  /** 预览成功后暂存的解析结果（提交时消费；离开导入页/切换文件时清除） */
  pendingImport: ParsedImportData | null
  importRunning: boolean
  importProgress: ResonanceImportProgressState | null

  // ---- reducers ----
  setActiveTab: (tab: ResonanceTab) => void
  setData: (data: ResonanceGetDataResult) => void
  setLoadError: (message: string | null) => void
  setLoading: (loading: boolean) => void
  setWardrobe: (wardrobe: ResonanceWardrobeData) => void
  setPendingImport: (parsed: ParsedImportData | null) => void
  setImportRunning: (running: boolean) => void
  setImportProgress: (progress: ResonanceImportProgressState | null) => void
  reset: () => void
}

const emptyWardrobe: ResonanceWardrobeData = {
  version: 1,
  ownedItemIds: [],
  ownedMakeupIds: [],
  ownedMomoIds: [],
  ownedPropIds: [],
  ownedEurekaColorIds: [],
  updatedAt: ''
}

const initialState = {
  loaded: false,
  loading: false,
  loadError: null as string | null,
  pulls: [] as ResonancePullRow[],
  edits: [] as ResonanceEditRow[],
  pearpal: [] as ResonancePearpalRow[],
  evo: [] as ResonanceEvoRow[],
  wardrobe: emptyWardrobe,
  activeTab: 'records' as ResonanceTab,
  pendingImport: null as ParsedImportData | null,
  importRunning: false,
  importProgress: null as ResonanceImportProgressState | null
}

export const useResonanceStore = create<ResonanceState>((set) => ({
  ...initialState,
  setActiveTab: (tab) => set({ activeTab: tab }),
  setData: (data) =>
    set({
      loaded: true,
      loading: false,
      loadError: null,
      pulls: data.pulls,
      edits: data.edits,
      pearpal: data.pearpal,
      evo: data.evo,
      wardrobe: data.wardrobe
    }),
  setLoadError: (message) => set({ loadError: message, loading: false }),
  setLoading: (loading) => set({ loading }),
  setWardrobe: (wardrobe) => set({ wardrobe }),
  setPendingImport: (parsed) => set({ pendingImport: parsed }),
  setImportRunning: (running) => set({ importRunning: running }),
  setImportProgress: (progress) => set({ importProgress: progress }),
  reset: () => set({ ...initialState })
}))

// ============================================================================
// 模块级异步 action（IPC 副作用）
// ============================================================================

function api(): NonNullable<typeof window.electronAPI>['resonance'] {
  const resonance = window.electronAPI?.resonance
  if (!resonance) throw new Error('electronAPI.resonance unavailable')
  return resonance
}

/** 首次进入/刷新数据：已加载或加载中则跳过；错误写入 loadError 供空态展示 */
export async function ensureResonanceLoaded(force = false): Promise<void> {
  const state = useResonanceStore.getState()
  if (state.loading) return
  if (state.loaded && !force) return
  state.setLoading(true)
  try {
    const data = await api().getData()
    useResonanceStore.getState().setData(data)
  } catch (error) {
    useResonanceStore
      .getState()
      .setLoadError(error instanceof Error ? error.message : String(error))
  }
}

/** 修改类操作后统一重拉（本地 SQLite 读快，量级可控） */
export async function refreshResonanceData(): Promise<void> {
  const data = await api().getData()
  useResonanceStore.getState().setData(data)
}

/** 手动补录一条（edits）；成功后刷新本地数据，失败向上抛给 toast */
export async function addManualRecord(
  bannerId: string,
  itemId: string,
  obtainedAt: string
): Promise<void> {
  await api().addManualRecord(bannerId, itemId, obtainedAt)
  await refreshResonanceData()
}

export async function updateManualRecord(id: number, obtainedAt: string): Promise<void> {
  await api().updateManualRecord(id, obtainedAt)
  await refreshResonanceData()
}

export async function deleteResonanceRecord(kind: 'pull' | 'edit', id: number): Promise<void> {
  await api().deleteRecord(kind, id)
  await refreshResonanceData()
}

export interface ResonancePreviewSummary {
  format: 'legacy' | 'current'
  version: number | null
  versionMismatch: boolean
  totalRecords: number
  counts: { added: number; duplicate: number; invalid: number }
  invalidSamples: ImportInvalidRecord[]
  sections: { pulls: boolean; edits: boolean; pearpal: boolean; evo: boolean; wardrobe: boolean }
}

/**
 * 导入预览：读文件（主进程）→ 渲染层解析（不可信输入守卫）→ 与库内数据比对新增/重复。
 * 结构错误向上抛（调用方 toast 显示可读文案），解析结果暂存 store 供提交使用。
 */
export async function previewImport(filePath: string): Promise<ResonancePreviewSummary> {
  const { content } = await api().readImportFile(filePath)
  const parsed = parseImportFileText(content)
  const state = useResonanceStore.getState()
  const diff = countImportDiff(parsed, {
    pulls: state.pulls,
    edits: state.edits,
    pearpal: state.pearpal,
    evo: state.evo
  })
  const summary: ResonancePreviewSummary = {
    format: parsed.format,
    version: parsed.version,
    versionMismatch: parsed.versionMismatch,
    totalRecords: parsed.totalValidRecords,
    counts: {
      added: diff.added,
      duplicate: diff.duplicate,
      invalid: parsed.invalidCount
    },
    invalidSamples: parsed.invalid,
    sections: {
      pulls: Object.keys(parsed.pulls).length > 0,
      edits: Object.keys(parsed.edits).length > 0,
      pearpal: Object.keys(parsed.pearpal).length > 0,
      evo: Object.keys(parsed.evo).length > 0,
      wardrobe: parsed.wardrobe !== null
    }
  }
  useResonanceStore.getState().setPendingImport(parsed)
  return summary
}

export interface CommitImportOptions {
  includeWardrobe: boolean
  onProgress?: (current: number, total: number) => void
  /** 返回 true 时中止后续批次（已写入部分因幂等可安全续传） */
  isCancelled?: () => boolean
}

/** 将解析结果按批次送主进程写入；返回实际新增写入行数 */
export async function commitPendingImport(options: CommitImportOptions): Promise<number> {
  const parsed = useResonanceStore.getState().pendingImport
  if (!parsed) throw new Error('resonance import: pendingImport is empty')

  const pullRows = Object.entries(parsed.pulls).flatMap(([bannerId, list]) =>
    list.map(([obtainedAt, itemId]) => ({ bannerId, itemId, obtainedAt }))
  )
  const editRows = Object.entries(parsed.edits).flatMap(([bannerId, list]) =>
    list.map(([obtainedAt, itemId]) => ({ bannerId, itemId, obtainedAt }))
  )
  const pearpalRows = Object.entries(parsed.pearpal).flatMap(([bannerId, list]) => {
    // Pearpal 记录不含真实获得时间（源语义：以处理时刻合成占位）；
    // 幂等键 UNIQUE(banner_id, item_id, pool_cnt) 不含时间，重复提交安全。
    const pearpalObtainedAt = new Date().toISOString().slice(0, 19).replace('T', ' ')
    return list.map((item) => ({
      bannerId,
      itemId: item.result,
      poolCnt: item.pool_cnt,
      obtainedAt: pearpalObtainedAt,
      raw: item as unknown as Record<string, unknown>
    }))
  })
  const evoRows = Object.entries(parsed.evo).flatMap(([bannerId, list]) =>
    list.map(([outfitId, level]) => ({ bannerId, outfitId, level }))
  )

  const batches: Array<{
    pulls: typeof pullRows
    edits: typeof editRows
    pearpal: typeof pearpalRows
    evo: typeof evoRows
    includeWardrobe?: boolean
    wardrobe?: Record<string, unknown>
  }> = []
  const maxLen = Math.max(pullRows.length, editRows.length, pearpalRows.length, evoRows.length, 1)
  for (let offset = 0; offset < maxLen; offset += MAX_COMMIT_BATCH_ROWS) {
    const end = offset + MAX_COMMIT_BATCH_ROWS
    batches.push({
      pulls: pullRows.slice(offset, end),
      edits: editRows.slice(offset, end),
      pearpal: pearpalRows.slice(offset, end),
      evo: evoRows.slice(offset, end)
    })
  }
  const total = pullRows.length + editRows.length + pearpalRows.length + evoRows.length
  const store = useResonanceStore.getState()
  store.setImportRunning(true)
  store.setImportProgress({ phase: 'commit', current: 0, total })
  let imported = 0
  try {
    for (let i = 0; i < batches.length; i++) {
      if (options.isCancelled?.()) break
      const isLast = i === batches.length - 1
      if (isLast && options.includeWardrobe && parsed.wardrobe) {
        batches[i]!.includeWardrobe = true
        batches[i]!.wardrobe = parsed.wardrobe as unknown as Record<string, unknown>
      }
      const result = await api().commitImport(batches[i]!)
      imported += result.imported
      const done = Math.min((i + 1) * MAX_COMMIT_BATCH_ROWS, total)
      options.onProgress?.(done, total)
      useResonanceStore.getState().setImportProgress({ phase: 'commit', current: done, total })
    }
    await refreshResonanceData()
    useResonanceStore.getState().setPendingImport(null)
    return imported
  } finally {
    useResonanceStore.getState().setImportRunning(false)
    useResonanceStore.getState().setImportProgress(null)
  }
}

export interface ResonanceExportRequest {
  filePath: string
  includePulls: boolean
  includeEdits: boolean
  includePearpal: boolean
  includeEvo: boolean
  includeWardrobe: boolean
}

/** 组装导出载荷并写盘；无可导出内容时返回 null（filePath 来自 saveFile 对话框） */
export async function exportResonanceData(
  request: ResonanceExportRequest
): Promise<{ path: string; recordCount: number } | null> {
  const state = useResonanceStore.getState()
  const payload = buildExportPayload(
    {
      pulls: state.pulls,
      edits: state.edits,
      pearpal: state.pearpal,
      evo: state.evo,
      wardrobe: state.wardrobe
    },
    {
      includePulls: request.includePulls,
      includeEdits: request.includeEdits,
      includePearpal: request.includePearpal,
      includeEvo: request.includeEvo,
      includeWardrobe: request.includeWardrobe
    }
  )
  if (!payload) return null
  return api().export(request.filePath, payload)
}

/** 衣橱增量更新（批量上限 5000/批，schema 与 DB 层双重防线） */
export async function updateWardrobeItems(
  adds: Array<{ category: ResonanceWardrobeCategory; itemId: number }>,
  removes: Array<{ category: ResonanceWardrobeCategory; itemId: number }>
): Promise<ResonanceWardrobeData> {
  const result = await api().updateWardrobe(adds, removes)
  useResonanceStore.getState().setWardrobe(result.wardrobe)
  return result.wardrobe
}

/** 危险操作：清空全部共鸣数据（reset 后立即重拉空数据，避免页面停留在加载态） */
export async function clearAllResonanceData(): Promise<void> {
  await api().clearAll()
  useResonanceStore.getState().reset()
  await ensureResonanceLoaded(true)
}
