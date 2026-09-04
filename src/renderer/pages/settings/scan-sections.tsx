import React, { useEffect, useState, useContext, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useMediaStore, fetchMediaFromDatabase } from '../../stores/mediaStore'
import { SectionShell, SettingsCard, GlobalToastContext, SettingsToggle } from './shared'
import { BaseDialog } from '../../components/common/BaseDialog'
import { IconClose, IconFolderOpen, IconRefresh } from '../../icons'
import {
  loadCustomScanPaths,
  saveCustomScanPaths,
  loadExcludedScanPaths,
  saveExcludedScanPaths,
  isGameRootsInitialized,
  markGameRootsInitialized,
  pickDefaultSelectedPaths
} from '../../utils/scan-exclusions'

// ============ 扫描与路径 ============

// 自定义游戏目录路径数量上限，与 scanner-handler.ts 的 schema max(64) 一致
const MAX_CUSTOM_PATHS = 64

/** 游戏目录候选（与 game-directory-discovery.ts 的 GameRootCandidate 契约一致） */
interface GameRootCandidate {
  path: string
  /** 目录修改时间（毫秒）；读取失败时为 0 */
  mtimeMs: number
  /** 该根下是否存在 GamePlayPhotos（Saved 变体或其无 Saved 兼容变体） */
  hasGamePlayPhotos: boolean
  source: 'custom' | 'official' | 'steam' | 'epic'
}

const SOURCE_LABEL_KEYS: Record<GameRootCandidate['source'], string> = {
  custom: 'settings.scan.sourceCustom',
  official: 'settings.scan.sourceOfficial',
  steam: 'settings.scan.sourceSteam',
  epic: 'settings.scan.sourceEpic'
}

/**
 * 游戏目录配置区：手动添加/删除自定义游戏目录路径，扫描时优先搜索这些路径。
 *
 * 数据流：
 * - 添加：dialog.selectDirectory() → 去重 → settings.set('customScanPaths', [...]) → 刷新
 * - 删除：从数组移除 → settings.set → 刷新
 * - 持久化由 settings:set 经 dbManager.setSetting 写入 app_settings 表
 */
export const ScanPathsSection: React.FC = () => {
  const { t } = useTranslation()
  const showMessage = useContext(GlobalToastContext)
  const [paths, setPaths] = useState<string[]>([])
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    const load = async () => {
      if (!window.electronAPI) return
      const saved = (await window.electronAPI.settings.get('customScanPaths', [])) as unknown
      setPaths(Array.isArray(saved) ? (saved as string[]) : [])
    }
    load()
  }, [])

  const persist = async (next: string[]) => {
    setPaths(next)
    if (window.electronAPI) {
      await window.electronAPI.settings.set('customScanPaths', next)
    }
  }

  const handleAdd = async () => {
    if (!window.electronAPI?.dialog?.selectDirectory || adding) return
    setAdding(true)
    try {
      const picked = await window.electronAPI.dialog.selectDirectory()
      if (!picked) return // 用户取消
      if (paths.includes(picked)) {
        showMessage(t('settings.scan.pathExists'), 'info')
        return
      }
      if (paths.length >= MAX_CUSTOM_PATHS) {
        showMessage(t('settings.scan.pathLimit', { max: MAX_CUSTOM_PATHS }), 'info')
        return
      }
      await persist([...paths, picked])
      showMessage(t('settings.scan.pathAdded'), 'success')
    } finally {
      setAdding(false)
    }
  }

  const handleRemove = async (index: number) => {
    const next = paths.filter((_, i) => i !== index)
    await persist(next)
    showMessage(t('settings.scan.pathRemoved'), 'success')
  }

  return (
    <SectionShell
      title={t('settings.sections.scanPaths')}
      description={t('settings.scan.pathsDescription')}
    >
      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
        {t('settings.scan.importRootsManageHint')}
      </p>

      {paths.length === 0 ? (
        <SettingsCard>
          <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
            {t('settings.scan.emptyPaths')}
          </p>
        </SettingsCard>
      ) : (
        <div className="space-y-2">
          {paths.map((p, i) => (
            <SettingsCard key={`${p}-${i}`}>
              <div className="flex items-center gap-3">
                <span
                  className="flex-1 min-w-0 truncate text-sm"
                  style={{ color: 'var(--text-primary)' }}
                  title={p}
                >
                  {p}
                </span>
                <button
                  className="icon-btn flex-shrink-0"
                  onClick={() => handleRemove(i)}
                  title={t('settings.scan.pathRemove')}
                  aria-label={t('settings.scan.pathRemove')}
                  style={{ width: 28, height: 28 }}
                >
                  <IconClose size={14} />
                </button>
              </div>
            </SettingsCard>
          ))}
        </div>
      )}
      <div>
        <button className="btn-primary text-sm" onClick={handleAdd} disabled={adding}>
          {adding ? t('settings.scan.adding') : t('settings.scan.addPath')}
        </button>
      </div>
    </SectionShell>
  )
}

/**
 * 需求三.3：多游戏目录选择。
 *
 * 数据流：
 * - 列表：scanner:detectGameRoots({ customPaths }) → GameRootCandidate[]
 * - 默认勾选：首次进入（未初始化）取「含 GamePlayPhotos 且 mtime 最新」者，并落库；
 *   已初始化则按已保存的排除集回显，尊重用户上次选择
 * - 变更：勾选集合取反后写入 settings.excludedScanPaths，扫描时由 scanner:start 传入主进程
 *
 * 无静默失败：detectGameRoots 失败时展示错误原因与「重试」按钮，不展示空列表误导用户。
 */
export const GameRootsSection: React.FC = () => {
  const { t } = useTranslation()
  const showMessage = useContext(GlobalToastContext)
  const [candidates, setCandidates] = useState<GameRootCandidate[]>([])
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const custom = await loadCustomScanPaths()
      const savedExcluded = await loadExcludedScanPaths()
      if (!window.electronAPI?.scanner?.detectGameRoots) {
        throw new Error('IPC_UNAVAILABLE')
      }
      const list = await window.electronAPI.scanner.detectGameRoots({
        customPaths: custom.length > 0 ? custom : undefined
      })
      const items = Array.isArray(list) ? (list as GameRootCandidate[]) : []
      setCandidates(items)

      const initialized = await isGameRootsInitialized()
      if (!initialized && items.length > 0) {
        // 需求三.3：默认选中修改时间最新的目录（优先含官方相册者）
        const selected = pickDefaultSelectedPaths(items)
        const nextExcluded = items.filter((c) => !selected.has(c.path)).map((c) => c.path)
        await saveExcludedScanPaths(nextExcluded)
        await markGameRootsInitialized()
        setExcluded(new Set(nextExcluded))
      } else {
        const excludedLower = new Set(savedExcluded.map((p) => p.toLowerCase()))
        setExcluded(
          new Set(items.filter((c) => excludedLower.has(c.path.toLowerCase())).map((c) => c.path))
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = async (candidate: GameRootCandidate) => {
    const next = new Set(excluded)
    if (next.has(candidate.path)) next.delete(candidate.path)
    else next.add(candidate.path)
    setExcluded(next)
    await saveExcludedScanPaths(Array.from(next))
    showMessage(t('settings.scan.gameRootsSaved'), 'success')
  }

  return (
    <SectionShell
      title={t('settings.sections.gameRoots')}
      description={t('settings.scan.gameRootsDescription')}
    >
      {loading ? (
        <SettingsCard>
          <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
            {t('settings.scan.gameRootsLoading')}
          </p>
        </SettingsCard>
      ) : error ? (
        <SettingsCard>
          <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
            {t('settings.scan.gameRootsLoadFailed', { reason: error })}
          </p>
          <button className="btn-secondary text-sm mt-2" onClick={() => void load()}>
            {t('settings.scan.gameRootsRetry')}
          </button>
        </SettingsCard>
      ) : candidates.length === 0 ? (
        <SettingsCard>
          <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
            {t('settings.scan.gameRootsEmpty')}
          </p>
        </SettingsCard>
      ) : (
        <div className="space-y-2">
          {candidates.map((c) => {
            const checked = !excluded.has(c.path)
            return (
              <SettingsCard key={c.path}>
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    className="w-4 h-4 mt-0.5"
                    checked={checked}
                    onChange={() => void toggle(c)}
                    aria-label={c.path}
                  />
                  <span className="flex-1 min-w-0">
                    <span
                      className="block truncate text-sm"
                      style={{ color: 'var(--text-primary)' }}
                      title={c.path}
                    >
                      {c.path}
                    </span>
                    <span
                      className="block text-xs mt-0.5"
                      style={{ color: 'var(--text-tertiary)' }}
                    >
                      {t(SOURCE_LABEL_KEYS[c.source] ?? 'settings.scan.sourceOfficial')}
                      {c.hasGamePlayPhotos
                        ? ` · ${t('settings.scan.hasGamePlayPhotos')}`
                        : ` · ${t('settings.scan.noGamePlayPhotos')}`}
                    </span>
                  </span>
                </label>
              </SettingsCard>
            )
          })}
        </div>
      )}
    </SectionShell>
  )
}

/**
 * 需求六：多级兜底引导（自动扫描失败时逐级启用，禁止直接返回空结果）。
 *
 * - 一级：选择「游戏安装根目录」（含 X6Game 的文件夹）→ 持久化后自动拼接并扫描；
 *   选择后先用 scanner:detectGameRoots 由主进程实际校验，未检出相册目录时明确提示，
 *   但仍允许用户继续扫描（不静默失败，也不替用户放弃）。
 * - 二级：直接选择 GamePlayPhotos 文件夹 → 跳过路径定位，直接执行 UID 遍历与扫描。
 * - 三级：两种方式选择的路径均写入 customScanPaths（支持多条），下次启动优先扫描。
 * - 权限不足（E003）：提供「一键重启并提升权限」。
 *
 * 两条兜底均走 fullScan（不带 path），由主进程 resolveScanChannels 编排官方相册通道，
 * 而非渲染层自行拼接路径，保证与自动扫描口径一致。
 */
export const ScanFallbackSection: React.FC = () => {
  const { t } = useTranslation()
  const showMessage = useContext(GlobalToastContext)
  const [busy, setBusy] = useState(false)
  const [elevating, setElevating] = useState(false)

  const runFallbackScan = async (mode: 'gameRoot' | 'gamePlayPhotos') => {
    if (busy || !window.electronAPI?.dialog?.selectDirectory) return
    const selected = await window.electronAPI.dialog.selectDirectory()
    // 参数校验：空/非字符串视为用户取消，静默返回
    if (!selected || typeof selected !== 'string' || selected.trim() === '') return

    setBusy(true)
    try {
      const custom = await loadCustomScanPaths()
      const exists = custom.some((p) => p.toLowerCase() === selected.toLowerCase())
      if (!exists) {
        if (custom.length >= MAX_CUSTOM_PATHS) {
          showMessage(t('settings.scan.pathLimit', { max: MAX_CUSTOM_PATHS }), 'info')
          return
        }
        await saveCustomScanPaths([...custom, selected])
      }

      if (mode === 'gameRoot' && window.electronAPI.scanner?.detectGameRoots) {
        const list = await window.electronAPI.scanner.detectGameRoots({
          customPaths: [selected]
        })
        const hit = (Array.isArray(list) ? (list as GameRootCandidate[]) : []).find(
          (c) => c.path.toLowerCase() === selected.toLowerCase()
        )
        // 明确提示（非静默失败）：选中的目录下未检出 GamePlayPhotos
        if (!hit?.hasGamePlayPhotos) {
          showMessage(t('settings.scan.fallbackRootNoAlbum'), 'info')
        }
      }

      const result = await window.electronAPI.scanner.start({
        fullScan: true,
        customKnownPaths: await loadCustomScanPaths(),
        excludedPaths: await loadExcludedScanPaths()
      })
      if (result?.success) {
        showMessage(
          t('settings.scan.fallbackScanSuccess', { count: result.filesFound ?? 0 }),
          'success'
        )
      } else {
        showMessage(
          t('settings.scan.fallbackScanFailed', {
            reason: result?.message || t('toast.unknownError')
          }),
          'error'
        )
        showMessage(t('settings.scan.fallbackScanHint'), 'info')
      }
    } catch (err) {
      showMessage(
        t('settings.scan.fallbackScanFailed', {
          reason: err instanceof Error ? err.message : String(err)
        }),
        'error'
      )
    } finally {
      setBusy(false)
    }
  }

  const handleRelaunchAsAdmin = async () => {
    if (elevating || !window.electronAPI?.app?.relaunchAsAdmin) return
    setElevating(true)
    try {
      await window.electronAPI.app.relaunchAsAdmin()
      showMessage(t('settings.scan.elevating'), 'info')
    } catch (err) {
      showMessage(
        t('settings.scan.elevateFailed', {
          reason: err instanceof Error ? err.message : String(err)
        }),
        'error'
      )
    } finally {
      setElevating(false)
    }
  }

  return (
    <SectionShell
      title={t('settings.sections.scanFallback')}
      description={t('settings.scan.fallbackDescription')}
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="btn-primary text-sm inline-flex items-center gap-1.5"
          onClick={() => void runFallbackScan('gameRoot')}
          disabled={busy}
        >
          <IconFolderOpen size={14} />
          {busy
            ? t('settings.scan.importRootsAddScanning')
            : t('settings.scan.fallbackPickGameRoot')}
        </button>
        <button
          className="btn-secondary text-sm inline-flex items-center gap-1.5"
          onClick={() => void runFallbackScan('gamePlayPhotos')}
          disabled={busy}
        >
          <IconFolderOpen size={14} />
          {t('settings.scan.fallbackPickAlbumDir')}
        </button>
        <button
          className="btn-secondary text-sm inline-flex items-center gap-1.5"
          onClick={() => void handleRelaunchAsAdmin()}
          disabled={elevating}
        >
          <IconRefresh size={14} />
          {elevating ? t('settings.scan.elevating') : t('settings.scan.relaunchAsAdmin')}
        </button>
      </div>
      <p className="text-xs mt-2" style={{ color: 'var(--text-tertiary)' }}>
        {t('settings.scan.fallbackHint')}
      </p>
    </SectionShell>
  )
}

export const ScanOptionsSection: React.FC = () => {
  const { t } = useTranslation()
  const [incremental, setIncremental] = useState(true)
  const [analyzing, setAnalyzing] = useState(false)
  const setMediaFiles = useMediaStore((s) => s.setMediaFiles)
  const showMessage = useContext(GlobalToastContext)

  useEffect(() => {
    const load = async () => {
      if (!window.electronAPI) return
      const i = (await window.electronAPI.settings.get('incrementalScan', true)) as boolean
      setIncremental(i)
    }
    load()
  }, [])

  const saveIncremental = async (value: boolean) => {
    setIncremental(value)
    if (window.electronAPI) await window.electronAPI.settings.set('incrementalScan', value)
    showMessage(value ? t('logAction.incrementalOn') : t('logAction.incrementalOff'))
  }

  const handleAnalyzeSceneTime = async () => {
    if (!window.electronAPI?.mediaAction?.analyzeSceneTime || analyzing) return
    setAnalyzing(true)
    try {
      const result = await window.electronAPI.mediaAction.analyzeSceneTime()
      if (result.success) {
        showMessage(
          result.message || t('logAction.sceneAnalyzed', { count: result.analyzed ?? 0 }),
          'success'
        )
        const res = await fetchMediaFromDatabase()
        if (res) setMediaFiles(res.files)
      } else {
        showMessage(result.message || t('logAction.sceneAnalyzeFailed'), 'error')
      }
    } catch (error) {
      showMessage(
        error instanceof Error ? error.message : t('logAction.sceneAnalyzeFailed'),
        'error'
      )
    } finally {
      setAnalyzing(false)
    }
  }

  return (
    <SectionShell title={t('settings.sections.scanOptions')}>
      <SettingsToggle
        label={t('settings.scan.incremental')}
        checked={incremental}
        onChange={(value) => void saveIncremental(value)}
      />
      <div className="pt-3 space-y-2" style={{ borderTop: '1px solid var(--divider)' }}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
              {t('settings.scan.sceneTimeTitle')}
            </p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
              {t('settings.scan.sceneTimeDesc')}
            </p>
          </div>
          <button
            className="btn-primary text-sm"
            onClick={handleAnalyzeSceneTime}
            disabled={analyzing}
          >
            {analyzing ? t('settings.scan.analyzing') : t('settings.scan.analyzeNow')}
          </button>
        </div>
      </div>
    </SectionShell>
  )
}

// ============ 指定目录（import_roots）管理 ============

/**
 * 指定目录管理区：列出所有经"指定目录扫描"登记的目录，并支持逐项移除。
 *
 * 背景：用户经"指定目录扫描"（scanner:start({ path })）导入后，目录会被登记进 import_roots，
 * 但此前没有任何可视化入口查看或移除，导致"只增不减"。本区块补齐这一缺口。
 *
 * 数据流：
 * - 列表：importRoot.list() → import_roots 全量路径
 * - 移除：importRoot.removeRoot(path, clearRecords)
 *     - clearRecords=false：仅删 import_roots 行（移出管理）
 *     - clearRecords=true：同时软删该目录下 media_files 记录（进回收站，可恢复）
 */
export const ImportRootsSection: React.FC = () => {
  const { t } = useTranslation()
  const showMessage = useContext(GlobalToastContext)
  const [roots, setRoots] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [pendingPath, setPendingPath] = useState<string | null>(null)
  const [clearRecords, setClearRecords] = useState(true)
  const [removing, setRemoving] = useState(false)
  // 新增：快捷「指定目录」扫描进行中标记与回调上下文
  const [scanningDir, setScanningDir] = useState(false)
  const customScanningRef = useRef(false)
  const pendingAddPathRef = useRef('')

  useEffect(() => {
    const load = async () => {
      if (!window.electronAPI?.importRoot) return
      try {
        const list = await window.electronAPI.importRoot.list()
        setRoots(Array.isArray(list) ? list : [])
      } catch (error) {
        showMessage(
          error instanceof Error ? error.message : t('settings.scan.importRootsLoadFailed'),
          'error'
        )
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [showMessage, t])

  // 订阅扫描完成事件：仅当本组件触发的"指定目录"扫描完成时刷新列表并提示，
  // 与图库 ScanButton 一致由 onComplete 收口，避免与 scanner.start 的 await 返回重复刷新。
  useEffect(() => {
    if (!window.electronAPI?.scanner?.onComplete) return
    const electronApi = window.electronAPI
    const unsubscribe = electronApi.scanner.onComplete((result) => {
      const wasCustom = customScanningRef.current
      customScanningRef.current = false
      setScanningDir(false)
      if (!wasCustom) return
      if (result && result.success) {
        void (async () => {
          try {
            const list = await electronApi.importRoot?.list()
            // 仅当拉取成功且为数组时更新；失败则保留原列表，不影响已完成的扫描结果
            if (Array.isArray(list)) setRoots(list)
          } catch {
            // 刷新失败不影响已完成的扫描结果，保留原列表
          }
        })()
        showMessage(
          t('settings.scan.importRootsAddSuccess', { path: pendingAddPathRef.current }),
          'success'
        )
      } else {
        showMessage(
          t('settings.scan.importRootsAddFailed', {
            reason: result?.message || t('toast.unknownError')
          }),
          'error'
        )
      }
    })
    return () => {
      if (unsubscribe) unsubscribe()
    }
  }, [showMessage, t])

  // 快捷「指定目录」：复用图库 ScanButton custom 分支既有链路
  // dialog.selectDirectory() → scanner.start({ path, fullScan: true })，
  // 主进程 scanner-handler 在扫描成功后自动登记 import_roots（即本列表数据源）。
  const handleAddDirectory = async (): Promise<void> => {
    if (scanningDir || !window.electronAPI?.dialog?.selectDirectory) return
    // 参数校验：目录选择返回 null/undefined/空串/非字符串 → 视为取消，静默返回
    const selected = await window.electronAPI.dialog.selectDirectory()
    if (!selected || typeof selected !== 'string' || selected.trim() === '') return

    setScanningDir(true)
    customScanningRef.current = true
    pendingAddPathRef.current = selected
    showMessage(t('settings.scan.importRootsAddScanning'), 'info')

    // IPC 是否抛异常：抛异常时 onComplete 不会触发，需要 finally 兜底收口
    let ipcThrew = false
    try {
      const savedPaths = (await window.electronAPI.settings.get('customScanPaths', [])) as unknown
      const customKnownPaths =
        Array.isArray(savedPaths) && (savedPaths as string[]).length > 0
          ? (savedPaths as string[])
          : undefined
      await window.electronAPI.scanner.start({
        path: selected,
        fullScan: true,
        customKnownPaths
      })
    } catch (err) {
      ipcThrew = true
      showMessage(
        t('settings.scan.importRootsAddFailed', {
          reason: err instanceof Error ? err.message : String(err)
        }),
        'error'
      )
    } finally {
      if (ipcThrew) {
        setScanningDir(false)
        customScanningRef.current = false
      }
    }
  }

  const handleConfirmRemove = async () => {
    if (!pendingPath || !window.electronAPI?.importRoot) return
    setRemoving(true)
    try {
      const result = await window.electronAPI.importRoot.removeRoot(pendingPath, clearRecords)
      if (result?.removed) {
        setRoots((prev) => prev.filter((p) => p !== pendingPath))
        if (result.clearFailed) {
          // FIX(组1-2): 软删失败与"该目录无媒体记录"区分提示——登记已移除，
          // 但媒体索引未清除（未进回收站），用户需知晓数据仍留在库中
          showMessage(
            `${t('settings.scan.importRootsClearFailed')}${result.clearErrorMessage ? `（${result.clearErrorMessage}）` : ''}`,
            'error'
          )
        } else {
          showMessage(
            result.cleared > 0
              ? t('settings.scan.importRootsRemovedWithCleared', { count: result.cleared })
              : t('settings.scan.importRootsRemovedOnly'),
            'success'
          )
        }
      } else {
        showMessage(t('settings.scan.importRootsRemoveFailed'), 'error')
      }
    } catch (error) {
      showMessage(
        error instanceof Error ? error.message : t('settings.scan.importRootsRemoveFailed'),
        'error'
      )
    } finally {
      setRemoving(false)
      setPendingPath(null)
    }
  }

  return (
    <SectionShell
      title={t('settings.scan.importRootsTitle')}
      description={t('settings.scan.importRootsDescription')}
    >
      <div className="flex items-center gap-3">
        <button
          className="btn-primary text-sm inline-flex items-center gap-1.5"
          onClick={handleAddDirectory}
          disabled={scanningDir}
          aria-label={t('settings.scan.importRootsAdd')}
        >
          <IconFolderOpen size={14} />
          {scanningDir
            ? t('settings.scan.importRootsAddScanning')
            : t('settings.scan.importRootsAdd')}
        </button>
      </div>
      {loading ? (
        <SettingsCard>
          <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
            {t('settings.scan.importRootsLoading')}
          </p>
        </SettingsCard>
      ) : roots.length === 0 ? (
        <SettingsCard>
          <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
            {t('settings.scan.importRootsEmpty')}
          </p>
        </SettingsCard>
      ) : (
        <div className="space-y-2">
          {roots.map((p) => (
            <SettingsCard key={p}>
              <div className="flex items-center gap-3">
                <span
                  className="flex-1 min-w-0 truncate text-sm"
                  style={{ color: 'var(--text-primary)' }}
                  title={p}
                >
                  {p}
                </span>
                <button
                  className="icon-btn flex-shrink-0"
                  onClick={() => setPendingPath(p)}
                  title={t('settings.scan.importRootsRemove')}
                  aria-label={t('settings.scan.importRootsRemove')}
                  style={{ width: 28, height: 28 }}
                >
                  <IconClose size={14} />
                </button>
              </div>
            </SettingsCard>
          ))}
        </div>
      )}

      <BaseDialog
        open={pendingPath !== null}
        onClose={() => !removing && setPendingPath(null)}
        title={t('settings.scan.importRootsConfirmTitle')}
        size="md"
        footer={
          <>
            <button
              className="btn-secondary text-sm"
              onClick={() => setPendingPath(null)}
              disabled={removing}
            >
              {t('settings.scan.importRootsConfirmCancel')}
            </button>
            <button
              className="btn-danger text-sm"
              onClick={handleConfirmRemove}
              disabled={removing}
            >
              {removing
                ? t('settings.scan.importRootsRemoving')
                : t('settings.scan.importRootsConfirmRemove')}
            </button>
          </>
        }
      >
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          {t('settings.scan.importRootsConfirmBody', { path: pendingPath ?? '' })}
        </p>
        <label className="flex items-center gap-2 mt-3 cursor-pointer">
          <input
            type="checkbox"
            checked={clearRecords}
            onChange={(e) => setClearRecords(e.target.checked)}
            className="w-4 h-4"
          />
          <span className="text-sm" style={{ color: 'var(--text-primary)' }}>
            {t('settings.scan.importRootsConfirmClearRecords')}
          </span>
        </label>
        <p className="text-xs mt-1.5" style={{ color: 'var(--text-tertiary)' }}>
          {t('settings.scan.importRootsClearRecordsHint')}
        </p>
      </BaseDialog>
    </SectionShell>
  )
}
