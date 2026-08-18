import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useMediaStore, refreshMediaAfterScan } from '../../stores/mediaStore'
import { useGlobalToast } from '../../pages/settings/sections'
import { IconRefresh, IconChevronDown } from '../../icons'

type ScanMode = 'incremental' | 'full' | 'custom'

export const ScanButton: React.FC = () => {
  const { t } = useTranslation()
  const showMessage = useGlobalToast()
  const setScanProgress = useMediaStore((s) => s.setScanProgress)
  const [scanning, setScanning] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // 扫描失败时向用户展示原因，避免静默空白页
  // 若失败原因为"未找到游戏目录"，追加引导用户手动指定路径的提示
  const reportScanFailure = useCallback(
    (reason: string | undefined) => {
      const text = reason || t('toast.unknownError')
      showMessage(`${t('toast.scanFailed')}: ${text}`, 'error')
      if (reason && (reason.includes('未找到') || reason.includes('游戏目录'))) {
        showMessage(t('toast.manualPathHintMessage'), 'info')
      }
    },
    [t, showMessage]
  )

  // 注册扫描进度监听，并在组件卸载时取消订阅
  useEffect(() => {
    if (!window.electronAPI?.scanner?.onProgress) return
    const unsubscribe = window.electronAPI.scanner.onProgress((progress) => {
      setScanProgress({ ...progress, scanning: true })
    })
    return () => {
      if (unsubscribe) unsubscribe()
    }
  }, [setScanProgress])

  // 监听扫描完成事件：主进程在 startScan 返回后立即发送，
  // 即使 IPC 返回值因某种原因延迟，UI 也能及时清除"正在扫描"状态
  // 修复：扫描完成后必须重新加载媒体列表，否则启动自动扫描的新增文件不会显示
  // P1-2：扫描失败时通过 Toast 向用户展示原因，避免静默失败导致空白页无解
  useEffect(() => {
    if (!window.electronAPI?.scanner?.onComplete) return
    const unsubscribe = window.electronAPI.scanner.onComplete(async (result) => {
      setScanning(false)
      setScanProgress({ scanning: false, status: result?.success ? 'completed' : 'failed' })
      // 扫描失败时向用户展示原因，引导自助解决（如手动指定路径）
      if (result && !result.success) {
        reportScanFailure(result.message)
      }
      // 无论扫描成功或失败，都重新加载媒体列表，确保前端与数据库同步（统一走 refreshMediaAfterScan）
      await refreshMediaAfterScan()
    })
    return () => {
      if (unsubscribe) unsubscribe()
    }
    // reportScanFailure / refreshMediaAfterScan 为稳定引用，加入依赖数组避免告警
  }, [setScanProgress, reportScanFailure, refreshMediaAfterScan])

  // 建议改#6：挂载时同步主进程当前扫描状态，
  // 避免启动自动扫描时 UI 初始为 false 与实际不一致
  useEffect(() => {
    if (!window.electronAPI?.scanner?.status) return
    void window.electronAPI.scanner.status().then((progress) => {
      if (progress?.status === 'running') {
        setScanning(true)
        setScanProgress({ ...progress, scanning: true })
      }
    })
  }, [setScanProgress])

  // 点击外部关闭菜单
  useEffect(() => {
    if (!menuOpen) return
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [menuOpen])

  const handleScan = async (mode: ScanMode) => {
    if (!window.electronAPI?.scanner || scanning) return
    setMenuOpen(false)
    setScanning(true)
    setScanProgress({ scanning: true, status: 'running' })

    // IPC 是否抛异常：抛异常时 onComplete 不会触发，需要 finally 兜底收口
    let ipcThrew = false
    try {
      let customPath: string | undefined
      if (mode === 'custom') {
        // 选择自定义目录（兜底入口，当全盘签名搜索未命中时使用）
        if (window.electronAPI?.dialog?.selectDirectory) {
          const result = await window.electronAPI.dialog.selectDirectory()
          if (!result) {
            // 用户取消选择
            setScanning(false)
            setScanProgress({ scanning: false, status: 'completed' })
            return
          }
          customPath = result
        } else {
          // 预览版无 IPC，直接取消
          setScanning(false)
          setScanProgress({ scanning: false, status: 'completed' })
          return
        }
      }

      // 从 settings 读取用户在设置页配置的自定义游戏目录并传入
      // customKnownPaths 在 worker 中作为优先路径校验存在性，命中则跳过全盘签名搜索
      const savedPaths = (await window.electronAPI.settings.get('customScanPaths', [])) as unknown
      const customKnownPaths =
        Array.isArray(savedPaths) && (savedPaths as string[]).length > 0
          ? (savedPaths as string[])
          : undefined
      const result = await window.electronAPI.scanner.start({
        incremental: mode === 'incremental',
        path: customPath,
        fullScan: mode === 'full',
        customKnownPaths
      })
      if (result.success) {
        // 成功路径在此刷新媒体列表；失败由 onComplete 回调统一处理，避免重复
        await refreshMediaAfterScan()
      }
      // result.success === false 时由 onComplete 事件回调统一处理 toast 与 status='failed'，
      // 此处不设置终态，避免覆盖 onComplete 的最终判定
    } catch (err) {
      // scanner.start IPC 本身抛异常（通道未注册 / 主进程崩溃），onComplete 不会触发
      // 标记后由 finally 兜底收口，确保 UI 退出 scanning 状态并提示失败原因
      ipcThrew = true
      reportScanFailure(err instanceof Error ? err.message : String(err))
    } finally {
      // 仅当 IPC 抛异常（onComplete 不会触发）才兜底收口为 completed；
      // 正常成功/失败统一由 onComplete 决定 status，避免 finally 把失败覆盖成 completed
      if (ipcThrew) {
        setScanning(false)
        setScanProgress({ scanning: false, status: 'completed' })
      }
    }
  }

  const scanOptions: { mode: ScanMode; label: string; desc: string }[] = [
    { mode: 'incremental', label: '增量扫描', desc: '仅扫描新增文件' },
    { mode: 'full', label: '自动定位游戏目录', desc: '文件名签名全盘搜索游戏媒体' },
    { mode: 'custom', label: '指定目录', desc: '手动选择目录扫描（兜底）' }
  ]

  return (
    <div ref={menuRef} className="relative">
      <div className="flex items-center">
        <button
          className={`icon-btn ${scanning ? 'active' : ''}`}
          onClick={() => handleScan('incremental')}
          disabled={scanning}
          title="增量扫描"
          aria-label="增量扫描"
        >
          <IconRefresh size={16} className={scanning ? 'animate-spin' : ''} />
        </button>
        <button
          className="icon-btn px-1"
          onClick={() => setMenuOpen((v) => !v)}
          disabled={scanning}
          title="扫描选项"
          aria-label="扫描选项"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <IconChevronDown size={12} />
        </button>
      </div>

      {menuOpen && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 glass-panel py-1 min-w-[180px] z-50"
          style={{ animation: 'scaleIn 150ms ease-out' }}
        >
          {scanOptions.map((opt) => (
            <button
              key={opt.mode}
              role="menuitem"
              className="w-full flex flex-col items-start px-3 py-2 text-left transition-colors hover:bg-[var(--hover-bg)]"
              onClick={() => handleScan(opt.mode)}
            >
              <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                {opt.label}
              </span>
              <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {opt.desc}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
