import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useUIStore, selectFocusedMediaId } from '../stores/uiStore'
import { useMediaStore, toFileUrl } from '../stores/mediaStore'
import { Histogram } from '../components/editor/Histogram'
import { useImageProcessor } from '../hooks/useImageProcessor'
import {
  processImageData,
  imageToDataUrl,
  type FilterPreset,
  type FilterParams,
  type WatermarkConfig
} from '../utils/imageProcessor'
import { mergeFilterParams } from '../utils/filter'
import { resolveExportEncoding } from '../utils/export-encoding'
import { computePreviewMaxSize, estimateInitialPreviewMaxSize } from '../utils/preview-resolution'
import { useEditHistory, type AdjustmentState } from '../hooks/useEditHistory'
// P0-C1：编辑保存后清理游戏参数缓存，避免显示旧 EXIF/参数
import { clearAllGameParamsCache } from '../hooks/useGameParams'
import { InternalError } from '../../shared/errors/app-error'
import { useEditorShortcuts } from '../hooks/useEditorShortcuts'
import { useGlobalToast } from './settings/sections'
import { useRefreshMedia } from '../hooks/useRefreshMedia'
import { EditorToolbar } from '../components/editor/EditorToolbar'
import { EditorTabs, type EditorTabId } from '../components/editor/EditorTabs'
import { CompareView } from '../components/editor/CompareView'
import { ShortcutsModal } from '../components/editor/ShortcutsModal'
import { BatchApplyDialog, type BatchApplyProgress } from '../components/editor/BatchApplyDialog'
import { ConfirmDialog } from '../components/common/ConfirmDialog'
import { EmptyState } from '../components/common/EmptyState'
import { ZoomableContainer } from '../components/common/ZoomableContainer'
import { VideoEditor } from '../components/editor/VideoEditor'
import { ErrorBoundary } from '../components/common/ErrorBoundary'
import { ZoneErrorFallback } from '../components/common/ErrorFallback'
import { IconImage } from '../icons'

export const EditorPage: React.FC = () => {
  const { t } = useTranslation()
  const {
    selectedMediaId,
    selectedMediaIds,
    navigateTo,
    pendingEditorMetadata,
    setPendingEditorMetadata
  } = useUIStore(
    useShallow((s) => ({
      selectedMediaId: selectFocusedMediaId(s),
      selectedMediaIds: s.selectedMediaIds,
      navigateTo: s.navigateTo,
      pendingEditorMetadata: s.pendingEditorMetadata,
      setPendingEditorMetadata: s.setPendingEditorMetadata
    }))
  )
  const mediaFiles = useMediaStore((s) => s.mediaFiles)
  const media = mediaFiles.find((f) => f.id === selectedMediaId)

  // F-S7 批量编辑：选中的图片（排除当前编辑的图片和视频）
  const batchApplyTargets = useMemo(() => {
    return mediaFiles.filter(
      (f) => selectedMediaIds.includes(f.id) && f.id !== selectedMediaId && f.file_type === 'image'
    )
  }, [mediaFiles, selectedMediaIds, selectedMediaId])

  const sourceUrl = useMemo(
    () => (media && media.file_type === 'image' ? toFileUrl(media.file_path) : null),
    [media]
  )

  // FIX(预览清晰度)：预览长边预算由「显示区 × devicePixelRatio × 缩放倍数」推导。
  // 修复前固定 1400 —— 2x 屏或放大查看时位图被浏览器上采样，是预览发虚的根因。
  const previewBoxRef = useRef<HTMLDivElement | null>(null)
  const [previewBox, setPreviewBox] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0
  })
  const [previewScale, setPreviewScale] = useState(1)

  useEffect(() => {
    const el = previewBoxRef.current
    if (!el) return
    const update = () => {
      const rect = el.getBoundingClientRect()
      setPreviewBox({ width: rect.width, height: rect.height })
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const previewMaxSize = useMemo(() => {
    // 容器尚未测量：用窗口尺寸估算，避免首帧退回过低分辨率
    if (previewBox.width <= 0 || previewBox.height <= 0) {
      return estimateInitialPreviewMaxSize(typeof window === 'undefined' ? null : window)
    }
    return computePreviewMaxSize(
      previewBox.width,
      previewBox.height,
      typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
      previewScale
    )
  }, [previewBox.width, previewBox.height, previewScale])

  const {
    loading,
    error: processorError,
    params,
    setParams,
    updateParam,
    updateCurve,
    updateHSL,
    filter,
    setFilter,
    applyFilterPreset,
    filterIntensity,
    setFilterIntensity,
    watermark,
    setWatermark,
    previewUrl,
    originalUrl,
    reset,
    exportDataUrl
  } = useImageProcessor({ source: sourceUrl, maxPreviewSize: previewMaxSize })

  const [activeTab, setActiveTab] = useState<EditorTabId>('basic')
  const [compareMode, setCompareMode] = useState(false)
  const [splitCompareMode, setSplitCompareMode] = useState(false)
  const [saving, setSaving] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [canPaste, setCanPaste] = useState(false)
  // F-S7 批量编辑状态
  const [batchApplyConfirm, setBatchApplyConfirm] = useState(false)
  const [batchApplying, setBatchApplying] = useState(false)
  const [batchProgress, setBatchProgress] = useState<BatchApplyProgress | null>(null)
  const [batchDone, setBatchDone] = useState(false)
  const [batchMessage, setBatchMessage] = useState('')
  // XMP 元数据导出状态：单图导出含参数副本（不修改原图）
  const [exportingWithMetadata, setExportingWithMetadata] = useState(false)
  // 性能重构 v3 改造项三：批量应用任务取消控制器（渲染进程本地）
  // 该任务的循环在渲染进程，不走 task:cancel IPC，使用本地 AbortController
  const batchAbortRef = useRef<AbortController | null>(null)
  // 性能重构 v3 改造项三：批量应用 ETA 采样（简单滑动窗口，避免引入新文件）
  const batchEtaSamplesRef = useRef<Array<{ t: number; count: number }>>([])
  const showMessage = useGlobalToast()
  const refreshMedia = useRefreshMedia()
  // F-B2：editor:save 失败时暂存 dataUrl，下次进入编辑器时提示恢复
  const [recoverData, setRecoverData] = useState<{
    dataUrl: string
    fileName: string
    timestamp: number
  } | null>(null)

  useEffect(() => {
    const hasClipboard = Boolean(localStorage.getItem('editor-params-clipboard'))
    setCanPaste(hasClipboard)
    // F-B2：检查上次保存失败的编辑结果
    try {
      const raw = localStorage.getItem('editor-failed-save')
      if (raw) {
        const parsed = JSON.parse(raw) as { dataUrl: string; fileName: string; timestamp: number }
        setRecoverData(parsed)
      }
    } catch {
      // 数据损坏时清除
      localStorage.removeItem('editor-failed-save')
    }
  }, [])

  // XMP 元数据恢复：详情页读取后通过 pendingEditorMetadata 传入编辑器
  // 挂载时一次性消费并清空，避免下次进入编辑器仍残留旧参数
  // 注意：不调用 pushHistory。useEditHistory 的初始化 effect 会将恢复后的状态作为初始状态，
  // 用户后续调整时 pushHistory 会捕获恢复后的状态，undo 可回到恢复状态。
  useEffect(() => {
    if (!pendingEditorMetadata) return
    const data = pendingEditorMetadata
    setPendingEditorMetadata(null)
    try {
      if (data.params) setParams(data.params as unknown as FilterParams)
      if (data.filter) {
        const filterParams =
          typeof data.filter.params === 'string'
            ? (JSON.parse(data.filter.params) as FilterPreset['params'])
            : (data.filter.params as FilterPreset['params'])
        setFilter({
          id: `restored-${data.exportTimestamp}`,
          name: data.filter.name,
          category: data.filter.category,
          params: filterParams
        })
      } else {
        setFilter(null)
      }
      if (typeof data.filterIntensity === 'number') setFilterIntensity(data.filterIntensity)
      if (data.watermark) {
        setWatermark(data.watermark as unknown as WatermarkConfig)
      }
      showMessage(t('editor.metadata.restored', { fileName: data.sourceFileName }), 'success')
    } catch (err) {
      showMessage(`${t('editor.metadata.restoreFailed')}: ${String(err)}`, 'error')
    }
    // 仅在挂载时消费一次，依赖空数组避免 params 变化触发重复应用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const applyHistoryState = useCallback(
    (state: AdjustmentState) => {
      setParams(state.params)
      setFilter(state.filter)
      setFilterIntensity(state.filterIntensity)
      setWatermark(state.watermark)
    },
    [setParams, setFilter, setFilterIntensity, setWatermark]
  )

  // C-O11：initialState 改用 ref 持有最新值
  // 原实现 useMemo([]) 空依赖导致 initialState 永远是首次渲染的快照，
  // 但 useEditHistory 的初始化 effect 依赖 [initialState]，仅当引用变化时重新初始化——
  // 这与"只初始化一次"的意图冲突。现在用 ref 让 useEditHistory 始终拿到最新值，
  // 而 initializedRef 保证只初始化一次（见 useEditHistory.ts）。
  const initialStateRef = useRef<AdjustmentState>({
    params: { ...params },
    filter,
    filterIntensity,
    watermark
  })
  useEffect(() => {
    initialStateRef.current = { params: { ...params }, filter, filterIntensity, watermark }
  }, [params, filter, filterIntensity, watermark])

  // useEditHistory 只在首次挂载时初始化，传入稳定的空对象避免引用变化触发重初始化
  const {
    pushHistory: pushHistoryToStack,
    undo,
    redo,
    canUndo,
    canRedo
  } = useEditHistory(initialStateRef.current, applyHistoryState)

  const pushHistory = useCallback(() => {
    pushHistoryToStack({ params: { ...params }, filter, filterIntensity, watermark })
  }, [params, filter, filterIntensity, watermark, pushHistoryToStack])

  const handleReset = useCallback(() => {
    reset()
    pushHistory()
  }, [reset, pushHistory])

  useEffect(() => {
    if (isFullscreen) {
      const original = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      return () => {
        document.body.style.overflow = original
      }
    }
  }, [isFullscreen])

  const handleCopyParams = useCallback(() => {
    const payload = JSON.stringify({ params, filter, filterIntensity, watermark })
    localStorage.setItem('editor-params-clipboard', payload)
    setCanPaste(true)
    showMessage(t('editor.page.paramsCopied'), 'success')
  }, [params, filter, filterIntensity, watermark, showMessage, t])

  const handlePasteParams = useCallback(() => {
    const raw = localStorage.getItem('editor-params-clipboard')
    if (!raw) {
      showMessage(t('editor.page.clipboardEmpty'), 'error')
      return
    }
    try {
      const parsed = JSON.parse(raw)
      if (parsed.params) setParams(parsed.params)
      if (parsed.filter !== undefined) setFilter(parsed.filter)
      if (parsed.filterIntensity !== undefined) setFilterIntensity(parsed.filterIntensity)
      if (parsed.watermark !== undefined) setWatermark(parsed.watermark)
      pushHistory()
      showMessage(t('editor.page.paramsPasted'), 'success')
    } catch {
      showMessage(t('editor.page.pasteFailed'), 'error')
    }
  }, [setParams, setFilter, setFilterIntensity, setWatermark, pushHistory, showMessage, t])

  const handleSave = useCallback(async () => {
    if (!media || !window.electronAPI) return
    setSaving(true)
    try {
      const dataUrl = await exportDataUrl(true)
      if (!dataUrl) throw new InternalError(t('editor.page.exportFailed'))
      const result = await window.electronAPI.editor.save(media.file_path, dataUrl, {
        format: media.file_ext.replace('.', '') || 'jpg',
        quality: 95
      })
      showMessage(result.message, result.success ? 'success' : 'error')
      if (result.success) {
        // P0-C1：编辑保存成功后清理游戏参数缓存，避免详情页显示旧解码结果
        clearAllGameParamsCache()
        // F-B2：保存成功后清除暂存的失败编辑结果
        localStorage.removeItem('editor-failed-save')
        await refreshMedia()
      } else {
        // F-B2：IPC 返回失败时，暂存 dataUrl 到 localStorage 供下次恢复
        try {
          localStorage.setItem(
            'editor-failed-save',
            JSON.stringify({
              dataUrl,
              fileName: media.file_name,
              timestamp: Date.now()
            })
          )
          showMessage(t('editor.recover.stored'), 'info')
        } catch {
          // localStorage quota 超限（dataUrl 过大）
          showMessage(t('editor.recover.storeFailed'), 'error')
        }
      }
    } catch (error) {
      showMessage(String(error), 'error')
      // F-B2：异常失败时也尝试暂存（此时 dataUrl 可能未生成）
    } finally {
      setSaving(false)
    }
  }, [media, exportDataUrl, showMessage, refreshMedia, t])

  const handleSaveAs = useCallback(async () => {
    if (!media || !window.electronAPI) return
    setSaving(true)
    try {
      // 显式指定 jpeg：另存为固定使用 .jpg 扩展名，PNG 源若不覆盖会产出「.jpg 扩展名的 PNG 字节」
      const dataUrl = await exportDataUrl(true, 'image/jpeg')
      if (!dataUrl) throw new InternalError(t('editor.page.exportFailed'))
      const directory = await window.electronAPI.dialog.selectDirectory()
      if (!directory) {
        setSaving(false)
        return
      }
      const result = await window.electronAPI.editor.saveAs(dataUrl, {
        directory,
        fileName: t('editor.page.editedFileSuffix', {
          name: media.file_name.replace(/\.[^.]+$/, '')
        }),
        format: 'jpg',
        quality: 95
      })
      showMessage(result.message, result.success ? 'success' : 'error')
    } catch (error) {
      showMessage(String(error), 'error')
    } finally {
      setSaving(false)
    }
  }, [media, exportDataUrl, showMessage, t])

  // XMP 元数据导出：将当前调色/滤镜/LUT/水印参数写入图片 XMP 元数据，导出副本（不修改原图）
  // 支持批量场景：若选中了多张图片，则批量导出；否则仅导出当前编辑的图片
  const handleExportWithMetadata = useCallback(async () => {
    if (!media || !window.electronAPI?.editor?.exportWithMetadata) {
      showMessage(t('editor.metadata.unavailable'), 'error')
      return
    }
    setExportingWithMetadata(true)
    try {
      // 用户选择导出目录（不修改原图，必须显式指定目标目录）
      const targetDir = await window.electronAPI.dialog.selectDirectory()
      if (!targetDir) return

      // 构造元数据输入（filter.params 序列化为 JSON 字符串便于跨平台解析）
      const metadataInput = {
        params: params as unknown as Record<string, unknown>,
        filter: filter
          ? {
              name: filter.name,
              category: filter.category,
              params: JSON.stringify(filter.params)
            }
          : null,
        filterIntensity,
        watermark: watermark as unknown as Record<string, unknown> | null
      }

      // 批量场景：选中了其他图片时一并导出（含当前图片）
      const otherTargets = batchApplyTargets.map((f) => f.file_path)
      const allPaths = [media.file_path, ...otherTargets]

      if (allPaths.length === 1) {
        const result = await window.electronAPI.editor.exportWithMetadata(
          media.file_path,
          metadataInput,
          {
            targetDir,
            format: 'jpg',
            quality: 95
          }
        )
        showMessage(
          result.success ? t('editor.metadata.exported') : result.message,
          result.success ? 'success' : 'error'
        )
      } else {
        const result = await window.electronAPI.editor.batchExportWithMetadata(
          allPaths,
          metadataInput,
          {
            targetDir,
            format: 'jpg',
            quality: 95
          }
        )
        showMessage(
          result.success
            ? t('editor.metadata.batchExported', {
                success: result.successCount,
                failed: result.failedCount
              })
            : t('editor.metadata.batchExportedWithFailures', {
                success: result.successCount,
                failed: result.failedCount
              }),
          result.success ? 'success' : 'info'
        )
      }
    } catch (error) {
      showMessage(
        error instanceof Error ? error.message : t('editor.metadata.exportFailed'),
        'error'
      )
    } finally {
      setExportingWithMetadata(false)
    }
  }, [media, params, filter, filterIntensity, watermark, batchApplyTargets, showMessage, t])

  const handleExportPreset = useCallback(async () => {
    if (!window.electronAPI) {
      showMessage(t('editor.page.presetExportUnsupported'), 'error')
      return
    }
    try {
      const name = presetName.trim() || filter?.name || t('editor.page.customPresetDefault')
      const preset = {
        name,
        category: filter?.category || 'custom',
        params: { ...params }
      }
      const result = await window.electronAPI.editor.exportPresetToFile(preset)
      if (result.canceled) return
      showMessage(
        result.success
          ? t('editor.page.presetExportSuccess')
          : result.message || t('editor.page.presetExportFailed'),
        result.success ? 'success' : 'error'
      )
    } catch (error) {
      showMessage(
        error instanceof Error ? error.message : t('editor.page.presetExportFailed'),
        'error'
      )
    }
  }, [presetName, filter, params, showMessage, t])

  const handleImportPreset = useCallback(async () => {
    if (!window.electronAPI) {
      showMessage(t('editor.page.presetImportUnsupported'), 'error')
      return
    }
    try {
      const result = await window.electronAPI.editor.importPresetFromFile()
      if (result.canceled) return
      if (!result.success || !result.preset) {
        showMessage(result.message || t('editor.page.presetImportFailed'), 'error')
        return
      }
      const imported = result.preset as {
        name: string
        category: string
        params: Partial<FilterParams>
      }
      const newPreset: FilterPreset = {
        id: `imported-${Date.now()}`,
        name: imported.name || t('editor.page.importedPresetDefault'),
        category: imported.category || 'custom',
        params: imported.params || {}
      }
      applyFilterPreset(newPreset)
      setFilterIntensity(100)
      pushHistory()
      showMessage(t('editor.page.presetImportSuccess'), 'success')
    } catch (error) {
      showMessage(
        error instanceof Error ? error.message : t('editor.page.presetImportFailed'),
        'error'
      )
    }
  }, [applyFilterPreset, setFilterIntensity, pushHistory, showMessage, t])

  const handleSavePreset = useCallback(async () => {
    if (!window.electronAPI || !window.electronAPI.editor?.exportPreset) {
      showMessage(t('editor.page.presetSaveUnsupported'), 'error')
      return
    }
    try {
      const name = presetName.trim() || filter?.name || t('editor.page.customPresetDefault')
      const preset = {
        name,
        category: 'custom',
        params: JSON.stringify({ ...params })
      }
      const result = await window.electronAPI.editor.exportPreset(preset)
      if (result.success) {
        setPresetName('')
        showMessage(t('editor.page.presetSaveSuccess'), 'success')
      } else {
        showMessage(result.message || t('editor.page.presetSaveFailed'), 'error')
      }
    } catch (error) {
      showMessage(
        error instanceof Error ? error.message : t('editor.page.presetSaveFailed'),
        'error'
      )
    }
  }, [presetName, filter, params, showMessage, t])

  const handleApplyFilterPreset = useCallback(
    (preset: FilterPreset) => {
      applyFilterPreset(preset)
      pushHistory()
    },
    [applyFilterPreset, pushHistory]
  )

  // F-S7 批量编辑：将当前调整/滤镜/水印应用到选中的图片
  // 逐张加载图片 → 应用 processImageData → 导出 dataUrl → 调用 editor:save（含原图备份机制）
  const performBatchApply = useCallback(async () => {
    if (!window.electronAPI?.editor?.save) return
    const targets = batchApplyTargets
    if (targets.length === 0) return

    setBatchApplying(true)
    setBatchDone(false)
    setBatchMessage('')
    // 性能重构 v3 改造项三：初始化 AbortController + ETA 采样
    const controller = new AbortController()
    batchAbortRef.current = controller
    batchEtaSamplesRef.current = []
    setBatchProgress({ current: 0, total: targets.length, currentFileName: '', failedCount: 0 })

    // 计算当前编辑器合并后的参数（含滤镜强度）
    const mergedParams = mergeFilterParams(params, filter, filterIntensity)
    const paramsJson = JSON.stringify(mergedParams)
    let successCount = 0
    let failedCount = 0

    // 性能重构 v3 改造项三：本地 ETA 计算（简单滑动窗口，窗口大小 10）
    // 每处理一张图片后采样一次，基于最近 N 个样本的吞吐量估算剩余时间
    const computeEta = (current: number, total: number): { etaMs: number; perSec: number } => {
      const now = Date.now()
      batchEtaSamplesRef.current.push({ t: now, count: current })
      if (batchEtaSamplesRef.current.length > 10) batchEtaSamplesRef.current.shift()
      if (batchEtaSamplesRef.current.length < 2 || current >= total) {
        return { etaMs: 0, perSec: 0 }
      }
      const first = batchEtaSamplesRef.current[0]
      const last = batchEtaSamplesRef.current[batchEtaSamplesRef.current.length - 1]
      const elapsedSec = (last.t - first.t) / 1000
      const processedInWindow = last.count - first.count
      if (elapsedSec <= 0 || processedInWindow <= 0) return { etaMs: 0, perSec: 0 }
      const perSec = processedInWindow / elapsedSec
      const remaining = total - current
      if (perSec <= 0) return { etaMs: 0, perSec: 0 }
      return { etaMs: Math.ceil((remaining / perSec) * 1000), perSec }
    }

    for (let i = 0; i < targets.length; i++) {
      // 性能重构 v3 改造项三：用户取消时立即停止，保留已处理结果
      if (controller.signal.aborted) {
        const cancelledMessage = t('editor.batchApply.cancelledMessage', {
          success: successCount,
          failed: failedCount
        })
        setBatchApplying(false)
        setBatchDone(true)
        setBatchMessage(cancelledMessage)
        showMessage(t('editor.batchApply.cancelledToast'), 'info')
        batchAbortRef.current = null
        batchEtaSamplesRef.current = []
        // 刷新图库以反映已编辑的缩略图
        refreshMedia()
        return
      }
      const target = targets[i]
      // 性能重构 v3 改造项三：每 3 张推送一次进度（避免过频 setState 阻塞 UI）
      // 同时更新 ETA
      const { etaMs, perSec } = computeEta(i, targets.length)
      setBatchProgress({
        current: i,
        total: targets.length,
        currentFileName: target.file_name,
        failedCount,
        etaMs,
        processedPerSec: perSec
      })
      try {
        // 1. 加载图片为 Image 对象
        const imgUrl = toFileUrl(target.file_path)
        if (!imgUrl)
          throw new InternalError(
            t('editor.batchApply.invalidPathError', { fileName: target.file_name })
          )
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const im = new Image()
          im.crossOrigin = 'anonymous'
          im.onload = () => resolve(im)
          im.onerror = () =>
            reject(
              new Error(t('editor.batchApply.loadFailedError', { fileName: target.file_name }))
            )
          im.src = imgUrl
        })
        // 2. 应用编辑参数 + 水印（不限制尺寸：修复前钳到 4096，长边更大的原片被静默降采样写回原路径）
        const imageData = await processImageData(img, mergedParams, { watermark })
        // 3. 导出 dataUrl：编码跟随目标扩展名，避免 PNG 目标被写成有损 JPEG
        const { mimeType, quality } = resolveExportEncoding(target.file_ext)
        const dataUrl = await imageToDataUrl(imageData, mimeType, quality)
        if (!dataUrl) throw new InternalError(t('editor.page.exportFailed'))
        // 4. 调用 editor:save（主进程会备份原图并记录编辑历史）
        const result = await window.electronAPI.editor.save(target.file_path, dataUrl, {
          format: target.file_ext.replace('.', '') || 'jpg',
          quality: 95,
          params: paramsJson
        })
        if (result.success) successCount++
        else {
          failedCount++
          console.warn(`[BatchApply] 保存失败: ${target.file_name}`, result.message)
        }
      } catch (err) {
        failedCount++
        console.warn(`[BatchApply] 处理失败: ${target.file_name}`, err)
      }
      // 让出主线程，避免长时间阻塞 UI
      await new Promise((r) => setTimeout(r, 0))
    }

    // 性能重构 v3 改造项三：推送最后一次进度（100%）
    setBatchProgress({
      current: targets.length,
      total: targets.length,
      currentFileName: '',
      failedCount,
      etaMs: 0,
      processedPerSec: 0
    })
    setBatchApplying(false)
    setBatchDone(true)
    setBatchMessage(
      failedCount > 0
        ? t('editor.batchApply.completedWithFailures', {
            success: successCount,
            failed: failedCount
          })
        : t('editor.batchApply.completedAll', { success: successCount })
    )
    showMessage(t('editor.batchApply.completedToast'), 'success')
    // 刷新图库以反映编辑后的缩略图
    refreshMedia()
    // 清理
    batchAbortRef.current = null
    batchEtaSamplesRef.current = []
  }, [batchApplyTargets, params, filter, filterIntensity, watermark, showMessage, refreshMedia, t])

  // 性能重构 v3 改造项三：取消批量应用任务
  const handleCancelBatchApply = useCallback(() => {
    if (!batchAbortRef.current) return
    batchAbortRef.current.abort()
    // 实际停止发生在 performBatchApply 循环下一次迭代
    showMessage(t('editor.batchApply.cancelRequested'), 'info')
  }, [showMessage, t])

  const handleApplyToSelected = useCallback(() => {
    if (batchApplyTargets.length === 0) {
      showMessage(t('editor.batchApply.noSelectionError'), 'error')
      return
    }
    setBatchApplyConfirm(true)
  }, [batchApplyTargets.length, showMessage, t])

  // F-B2：下载暂存的编辑结果到本地
  const handleRecoverDownload = useCallback(() => {
    if (!recoverData) return
    try {
      const link = document.createElement('a')
      link.href = recoverData.dataUrl
      const baseName = recoverData.fileName.replace(/\.[^.]+$/, '')
      link.download = t('editor.recover.downloadSuffix', { name: baseName })
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      localStorage.removeItem('editor-failed-save')
      setRecoverData(null)
      showMessage(t('editor.recover.downloaded'), 'success')
    } catch (error) {
      showMessage(String(error), 'error')
    }
  }, [recoverData, showMessage, t])

  // F-B2：丢弃暂存的编辑结果
  const handleRecoverDiscard = useCallback(() => {
    localStorage.removeItem('editor-failed-save')
    setRecoverData(null)
    showMessage(t('editor.recover.discarded'), 'info')
  }, [showMessage, t])

  const shortcutOptions = useMemo(
    () => ({
      onUndo: undo,
      onRedo: redo,
      onSave: handleSave,
      onSaveAs: handleSaveAs,
      onReset: handleReset,
      onCopyParams: handleCopyParams,
      onPasteParams: handlePasteParams,
      onToggleFullscreen: () => setIsFullscreen((prev) => !prev),
      onToggleShortcuts: () => setShowShortcuts((prev) => !prev),
      onExit: () => navigateTo('detail'),
      isFullscreen,
      showShortcuts
    }),
    [
      undo,
      redo,
      handleSave,
      handleSaveAs,
      handleReset,
      handleCopyParams,
      handlePasteParams,
      navigateTo,
      isFullscreen,
      showShortcuts
    ]
  )

  useEditorShortcuts(shortcutOptions)

  if (!media) {
    return (
      <EmptyState
        title={t('detail.emptyTitle')}
        ctaLabel={t('detail.actions.backToGallery')}
        onCta={() => navigateTo('gallery')}
      />
    )
  }

  if (media.file_type === 'video') {
    // F-S9：视频编辑器（裁剪/调速），替换原"视频文件暂不支持编辑"占位
    return <VideoEditor media={media} onExit={() => navigateTo('detail')} />
  }

  return (
    <div
      className={`h-full flex gap-4 ${isFullscreen ? 'fixed inset-0 z-50 p-4' : ''}`}
      style={isFullscreen ? { background: 'var(--bg-primary)' } : undefined}
    >
      {/* 左侧预览区 */}
      <div className="flex-1 flex flex-col min-w-0">
        <EditorToolbar
          canUndo={canUndo}
          canRedo={canRedo}
          compareMode={compareMode}
          splitCompareMode={splitCompareMode}
          isFullscreen={isFullscreen}
          saving={saving}
          loading={loading}
          canPaste={canPaste}
          applyToSelectedCount={batchApplyTargets.length}
          batchApplying={batchApplying}
          exportingWithMetadata={exportingWithMetadata}
          onUndo={undo}
          onRedo={redo}
          onReset={handleReset}
          onCompareStart={() => setCompareMode(true)}
          onCompareEnd={() => setCompareMode(false)}
          onToggleSplitCompare={() => setSplitCompareMode((prev) => !prev)}
          onToggleShortcuts={() => setShowShortcuts(true)}
          onToggleFullscreen={() => setIsFullscreen((prev) => !prev)}
          onExit={() => navigateTo('detail')}
          onSaveAs={handleSaveAs}
          onSave={handleSave}
          onCopyParams={handleCopyParams}
          onPasteParams={handlePasteParams}
          onApplyToSelected={handleApplyToSelected}
          onExportWithMetadata={handleExportWithMetadata}
        />

        <Histogram imageSrc={previewUrl} className="mb-3" />

        <div
          ref={previewBoxRef}
          className="flex-1 flex items-center justify-center relative overflow-hidden rounded-2xl"
          style={{ background: 'var(--bg-tertiary)' }}
        >
          {loading && (
            <div
              className="absolute inset-0 flex items-center justify-center z-10"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              <div
                className="w-8 h-8 border-2 border-current border-t-transparent rounded-full animate-spin"
                style={{ color: 'var(--accent)' }}
              />
            </div>
          )}
          {previewUrl && (
            // 区域级 ErrorBoundary：canvas 预览区渲染编辑后的图片，解码/缩放出错时
            // 仅替换预览区为小占位块，工具栏/直方图/右侧调色面板保持可用
            <ErrorBoundary fallback={ZoneErrorFallback}>
              {splitCompareMode ? (
                <CompareView
                  originalSrc={originalUrl}
                  editedSrc={previewUrl}
                  className="w-full h-full"
                />
              ) : (
                <ZoomablePreview
                  src={compareMode ? originalUrl || previewUrl : previewUrl}
                  alt={media.file_name}
                  onScaleChange={setPreviewScale}
                />
              )}
            </ErrorBoundary>
          )}
          {!loading && !previewUrl && (
            <div className="flex flex-col items-center" style={{ color: 'var(--text-tertiary)' }}>
              <IconImage size={64} strokeWidth={1} />
              <p className="mt-2">{processorError || t('editor.page.imageLoadFailed')}</p>
            </div>
          )}
        </div>
      </div>

      {/* U-G13：全屏模式下隐藏 EditorTabs 面板，退出后恢复显示 */}
      {!isFullscreen && (
        <EditorTabs
          activeTab={activeTab}
          onTabChange={setActiveTab}
          params={params}
          updateParam={updateParam}
          updateCurve={updateCurve}
          updateHSL={updateHSL}
          pushHistory={pushHistory}
          filter={filter}
          filterIntensity={filterIntensity}
          applyFilterPreset={handleApplyFilterPreset}
          setFilterIntensity={setFilterIntensity}
          watermark={watermark}
          setWatermark={setWatermark}
          presetName={presetName}
          setPresetName={setPresetName}
          sourceUrl={sourceUrl}
          onExportPreset={handleExportPreset}
          onImportPreset={handleImportPreset}
          onSavePreset={handleSavePreset}
        />
      )}

      {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}

      <BatchApplyDialog
        open={batchApplying || batchDone}
        progress={batchProgress}
        done={batchDone}
        message={batchMessage}
        onClose={() => {
          setBatchDone(false)
          setBatchMessage('')
        }}
        onCancel={handleCancelBatchApply}
      />

      <ConfirmDialog
        open={batchApplyConfirm}
        title={t('editor.batchApply.confirmTitle')}
        message={t('editor.batchApply.confirmMessage', { count: batchApplyTargets.length })}
        confirmText={t('editor.batchApply.confirmStart')}
        onConfirm={() => {
          setBatchApplyConfirm(false)
          performBatchApply()
        }}
        onCancel={() => setBatchApplyConfirm(false)}
      />

      {/* F-B2：恢复上次保存失败的编辑结果 */}
      <ConfirmDialog
        open={!!recoverData}
        title={t('editor.recover.title')}
        message={
          recoverData
            ? t('editor.recover.message', {
                fileName: recoverData.fileName,
                time: new Date(recoverData.timestamp).toLocaleString()
              })
            : ''
        }
        confirmText={t('editor.recover.download')}
        cancelText={t('editor.recover.discard')}
        onConfirm={handleRecoverDownload}
        onCancel={handleRecoverDiscard}
      />
    </div>
  )
}

// U-O8：编辑器预览区缩放/平移支持——滚轮缩放、拖拽平移、双击复位
// P1-U12：复用 ZoomableContainer 共享组件，仅保留图片渲染
interface ZoomablePreviewProps {
  src: string
  alt: string
  /** 缩放变化回调：驱动预览分辨率随放大倍数提升 */
  onScaleChange?: (scale: number) => void
}

const ZoomablePreview: React.FC<ZoomablePreviewProps> = ({ src, alt, onScaleChange }) => {
  return (
    <ZoomableContainer
      maxZoom={8}
      resetVariant="text"
      containerClassName="flex items-center justify-center w-full h-full overflow-hidden relative"
      onScaleChange={onScaleChange}
    >
      <img src={src} alt={alt} className="max-w-full max-h-full object-contain" draggable={false} />
    </ZoomableContainer>
  )
}
