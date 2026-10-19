import React, { useEffect, useState, useCallback, useContext, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '../../components/common/ConfirmDialog'
import { IconCheckCircle, IconChevronRight, IconCopy, IconShield } from '../../icons'
import {
  GlobalToastContext,
  SettingsCard,
  formatTimestamp,
  formatSize,
  FAULT_TYPE_META,
  type FaultType,
  type FaultRecord,
  type CrashRecord
} from './shared'

// ============ 日志与诊断 ============

export const DiagnosticsLogsSection: React.FC = () => {
  const { t } = useTranslation()
  const [faults, setFaults] = useState<FaultRecord[]>([])
  const [logDirPath, setLogDirPath] = useState('')
  const [faultCount, setFaultCount] = useState(0)
  const [totalSize, setTotalSize] = useState(0)
  const [fileCount, setFileCount] = useState(0)
  const [expandedFaultId, setExpandedFaultId] = useState<string | null>(null)
  const [logLoading, setLogLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [showClearLogConfirm, setShowClearLogConfirm] = useState(false)
  // P3-2：聚合视图开关（默认时间序，可切换为聚合模式）
  const [aggregateView, setAggregateView] = useState(false)
  const showMessage = useContext(GlobalToastContext)

  const loadLogData = useCallback(async () => {
    if (!window.electronAPI?.log) return
    setLogLoading(true)
    try {
      const [listRes, dirRes, statsRes] = await Promise.all([
        window.electronAPI.log.listFaults(),
        window.electronAPI.log.getDirectoryPath(),
        window.electronAPI.log.getStats()
      ])
      if (listRes?.success && Array.isArray(listRes.faults)) {
        setFaults(listRes.faults)
        setFaultCount(listRes.faults.length)
      }
      if (dirRes?.success && typeof dirRes.path === 'string') setLogDirPath(dirRes.path)
      if (statsRes?.success) {
        setFaultCount(statsRes.faultCount ?? 0)
        setTotalSize(statsRes.totalSize ?? 0)
        setFileCount(statsRes.fileCount ?? 0)
      }
    } catch (err) {
      console.error(t('diagnostics.logs.loadFailed'), err)
    } finally {
      setLogLoading(false)
    }
  }, [t])

  useEffect(() => {
    loadLogData()
  }, [loadLogData])

  // P3-2：错误聚合——按 type + summary 分组，统计每组出现次数和最近时间
  // 相同错误合并显示，避免大量重复故障刷屏
  const aggregatedFaults = useMemo(() => {
    if (!aggregateView) return []
    const groups = new Map<
      string,
      {
        key: string
        type: string
        summary: string
        count: number
        lastTimestamp: string
        firstTimestamp: string
        sample: FaultRecord
      }
    >()
    for (const fault of faults) {
      // 聚合键：type + summary 前 80 字符（避免过长 summary 导致无法聚合）
      const summaryKey = (fault.summary || '').slice(0, 80)
      const key = `${fault.type}::${summaryKey}`
      const existing = groups.get(key)
      if (existing) {
        existing.count++
        if (fault.timestamp > existing.lastTimestamp) existing.lastTimestamp = fault.timestamp
        if (fault.timestamp < existing.firstTimestamp) existing.firstTimestamp = fault.timestamp
      } else {
        groups.set(key, {
          key,
          type: fault.type,
          summary: fault.summary,
          count: 1,
          lastTimestamp: fault.timestamp,
          firstTimestamp: fault.timestamp,
          sample: fault
        })
      }
    }
    // 按出现次数降序，次数相同按最近时间倒序
    return Array.from(groups.values()).sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count
      return b.lastTimestamp.localeCompare(a.lastTimestamp)
    })
  }, [faults, aggregateView])

  // P3-3：错误趋势分析——按日期统计故障数量，用于柱状图展示
  // 取最近 14 天的数据，每天统计总数和按 type 分组数
  const trendData = useMemo(() => {
    if (faults.length === 0) return []
    const days = 14
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const dayMs = 24 * 60 * 60 * 1000

    // 初始化最近 14 天的桶
    const buckets: Array<{
      date: string
      label: string
      total: number
      byType: Record<string, number>
    }> = []
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today.getTime() - i * dayMs)
      const dateStr = d.toISOString().slice(0, 10)
      const label = `${d.getMonth() + 1}/${d.getDate()}`
      buckets.push({ date: dateStr, label, total: 0, byType: {} })
    }

    // 按故障 timestamp 分配到对应日期桶
    for (const fault of faults) {
      const faultDate = fault.timestamp.slice(0, 10)
      const bucket = buckets.find((b) => b.date === faultDate)
      if (bucket) {
        bucket.total++
        bucket.byType[fault.type] = (bucket.byType[fault.type] || 0) + 1
      }
    }

    return buckets
  }, [faults])

  const handleOpenLogDir = async () => {
    if (!window.electronAPI?.log?.openDirectory) return
    const res = await window.electronAPI.log.openDirectory()
    if (!res?.success) showMessage(res?.message || t('logAction.openDirFailed'), 'error')
  }

  const handleExportLogs = async () => {
    if (!window.electronAPI?.log?.exportZip || exporting) return
    setExporting(true)
    try {
      const res = await window.electronAPI.log.exportZip()
      if (res?.canceled) return
      if (res?.success) showMessage(res.message || t('logAction.exportSuccess'), 'success')
      else showMessage(res?.message || t('logAction.exportFailed'), 'error')
    } catch (err) {
      showMessage(err instanceof Error ? err.message : t('logAction.exportFailed'), 'error')
    } finally {
      setExporting(false)
    }
  }

  const handleClearLogs = async () => {
    if (!window.electronAPI?.log?.clear || clearing) return
    setClearing(true)
    try {
      const res = await window.electronAPI.log.clear()
      if (res?.success) {
        showMessage(res.message || t('logAction.clearSuccess'), 'success')
        setExpandedFaultId(null)
        await loadLogData()
      } else {
        showMessage(res?.message || t('logAction.clearFailed'), 'error')
      }
    } catch (err) {
      showMessage(err instanceof Error ? err.message : t('logAction.clearFailed'), 'error')
    } finally {
      setClearing(false)
    }
  }

  const handleCopyFault = async (fault: FaultRecord) => {
    const unknown = t('diagnostics.logs.unknown')
    const text = [
      t('diagnostics.logs.copyFaultId', { id: fault.id }),
      t('diagnostics.logs.copyTime', { time: formatTimestamp(fault.timestamp) }),
      t('diagnostics.logs.copyType', {
        type: t(FAULT_TYPE_META[fault.type]?.labelKey as string) || fault.type
      }),
      t('diagnostics.logs.copySummary', { summary: fault.summary }),
      '',
      t('diagnostics.logs.copyEnvInfoTitle'),
      t('diagnostics.logs.copyAppVersion', { version: fault.appVersion || unknown }),
      t('diagnostics.logs.copyElectron', { version: fault.electronVersion || unknown }),
      t('diagnostics.logs.copyNode', { version: fault.nodeVersion || unknown }),
      t('diagnostics.logs.copyPlatform', {
        platform: fault.platform || unknown,
        osVersion: fault.osVersion || ''
      }),
      t('diagnostics.logs.copyPid', {
        pid: fault.pid || unknown,
        uptime: typeof fault.uptime === 'number' ? Math.round(fault.uptime) + 's' : unknown
      }),
      '',
      t('diagnostics.logs.copyErrorDetailTitle'),
      fault.detail
    ].join('\n')
    try {
      await navigator.clipboard.writeText(text)
      showMessage(t('logAction.copySuccess'), 'success')
    } catch {
      showMessage(t('logAction.copyFailed'), 'error')
    }
  }

  const toggleFaultExpand = (id: string) => {
    setExpandedFaultId((prev) => (prev === id ? null : id))
  }

  return (
    <>
      <div className="glass-card p-5 space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
              {t('settings.logs.title')}
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
              {t('settings.logs.desc')}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              className="btn-primary text-xs px-3 py-1.5"
              onClick={handleExportLogs}
              disabled={exporting || faultCount === 0}
              title={
                faultCount === 0
                  ? t('settings.logs.exportDisabled')
                  : t('diagnostics.logs.exportAllHint')
              }
            >
              {exporting ? t('settings.logs.exporting') : t('settings.logs.export')}
            </button>
            <button
              className="btn-danger text-xs px-3 py-1.5"
              onClick={() => setShowClearLogConfirm(true)}
              disabled={clearing || faultCount === 0}
              title={
                faultCount === 0
                  ? t('settings.logs.clearDisabled')
                  : t('diagnostics.logs.clearAllHint')
              }
            >
              {clearing ? t('settings.logs.clearing') : t('settings.logs.clear')}
            </button>
            <button
              className="btn-secondary text-xs px-3 py-1.5"
              onClick={loadLogData}
              disabled={logLoading}
              title={t('diagnostics.logs.refreshHint')}
              aria-label={t('diagnostics.logs.refreshAria')}
            >
              {logLoading ? t('common.loading') : t('settings.logs.refresh')}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <SettingsCard className="text-center">
            <div className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              {faultCount}
            </div>
            <div className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
              {t('settings.logs.faultTotal')}
            </div>
          </SettingsCard>
          <SettingsCard className="text-center">
            <div className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              {formatSize(totalSize)}
            </div>
            <div className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
              {t('settings.logs.storageUsage')}
            </div>
          </SettingsCard>
          <SettingsCard className="text-center">
            <div className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              {fileCount}
            </div>
            <div className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
              {t('settings.logs.logFiles')}
            </div>
          </SettingsCard>
        </div>

        <SettingsCard className="flex items-center justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {t('settings.logs.storageLocation')}
            </div>
            <div
              className="text-xs font-mono mt-1 truncate"
              style={{ color: 'var(--text-primary)' }}
              title={logDirPath}
            >
              {logDirPath || t('settings.logs.notInit')}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              className="btn-secondary text-xs px-3 py-1.5"
              onClick={async () => {
                const dir = await window.electronAPI?.dialog?.selectDirectory()
                if (!dir) return
                const res = await window.electronAPI?.log?.setDir(dir)
                if (res?.success && res.needRestart) {
                  const confirmed = await window.electronAPI?.dialog?.showMessageBox({
                    type: 'question',
                    title: t('settings.backup.restartTitle'),
                    message: res.message,
                    buttons: [t('settings.backup.restartNow'), t('settings.backup.restartLater')]
                  })
                  if (confirmed === 0) {
                    await window.electronAPI?.app?.relaunch()
                  }
                } else if (!res?.success) {
                  showMessage(res?.message || t('logAction.settingFailed'), 'error')
                }
              }}
              title={t('settings.logs.modifyDir')}
            >
              {t('settings.logs.modifyDir')}
            </button>
            <button
              className="btn-secondary text-xs px-3 py-1.5"
              onClick={handleOpenLogDir}
              title={t('settings.logs.openDir')}
            >
              {t('settings.logs.openDir')}
            </button>
          </div>
        </SettingsCard>

        <div className="space-y-2">
          {/* P3-3：错误趋势分析——最近 14 天柱状图 */}
          {trendData.length > 0 && faults.length > 0 && (
            <SettingsCard>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                  {t('settings.logs.trendTitle')}
                </span>
                <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  {t('settings.logs.trendTotal', {
                    count: trendData.reduce((sum, d) => sum + d.total, 0)
                  })}
                </span>
              </div>
              <div
                className="flex items-end gap-1 h-20"
                style={{ borderBottom: '1px solid var(--divider)' }}
              >
                {trendData.map((day) => {
                  const maxTotal = Math.max(...trendData.map((d) => d.total), 1)
                  const heightPercent = (day.total / maxTotal) * 100
                  return (
                    <div
                      key={day.date}
                      className="flex-1 flex flex-col items-center justify-end h-full group relative"
                      title={t('settings.logs.dayTooltip', { date: day.date, count: day.total })}
                    >
                      {day.total > 0 && (
                        <div
                          className="w-full rounded-t transition-all hover:opacity-80"
                          style={{
                            height: `${Math.max(heightPercent, 4)}%`,
                            background:
                              day.total > 5
                                ? 'var(--danger-hover)'
                                : day.total > 2
                                  ? '#ea580c'
                                  : 'var(--accent)',
                            minHeight: '2px'
                          }}
                        />
                      )}
                      {/* 悬浮提示：显示当日各类故障数 */}
                      <div
                        className="absolute bottom-full mb-1 hidden group-hover:block p-2 rounded-lg whitespace-nowrap z-10"
                        style={{
                          background: 'rgba(0, 0, 0, 0.85)',
                          color: 'white',
                          fontSize: '0.714rem'
                        }}
                      >
                        <div className="font-bold">{day.label}</div>
                        <div>{t('settings.logs.totalLabel', { count: day.total })}</div>
                        {Object.entries(day.byType).map(([type, count]) => (
                          <div key={type}>
                            {FAULT_TYPE_META[type as FaultType]?.labelKey
                              ? t(FAULT_TYPE_META[type as FaultType]!.labelKey)
                              : type}
                            : {count}
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
              {/* X 轴日期标签（每 2 天显示一个，避免拥挤） */}
              <div className="flex gap-1 mt-1">
                {trendData.map((day, idx) => (
                  <div
                    key={day.date}
                    className="flex-1 text-center"
                    style={{ fontSize: '0.643rem', color: 'var(--text-tertiary)' }}
                  >
                    {idx % 2 === 0 ? day.label : ''}
                  </div>
                ))}
              </div>
            </SettingsCard>
          )}

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                {aggregateView ? t('settings.logs.listAggregate') : t('settings.logs.listTimeline')}
              </span>
              {/* P3-2：聚合视图切换按钮 */}
              {faults.length > 0 && (
                <button
                  className="text-xs px-2 py-0.5 rounded transition-all hover:scale-105"
                  style={{
                    color: aggregateView ? 'var(--accent)' : 'var(--text-tertiary)',
                    background: aggregateView ? 'rgba(59, 130, 246, 0.1)' : 'transparent',
                    border: '1px solid var(--divider)'
                  }}
                  onClick={() => {
                    setAggregateView(!aggregateView)
                    setExpandedFaultId(null)
                  }}
                  title={
                    aggregateView
                      ? t('settings.logs.timelineTooltip')
                      : t('settings.logs.aggregateTooltip')
                  }
                >
                  {aggregateView
                    ? t('settings.logs.switchTimeline')
                    : t('settings.logs.switchAggregate')}
                </button>
              )}
            </div>
            {faults.length > 0 && (
              <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {aggregateView && aggregatedFaults.length < faults.length
                  ? t('settings.logs.listCountWithGroup', {
                      count: faults.length,
                      groups: aggregatedFaults.length
                    })
                  : t('settings.logs.listCount', { count: faults.length })}
              </span>
            )}
          </div>

          {faults.length === 0 ? (
            <div
              className="py-8 text-center rounded-lg"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              <IconCheckCircle
                size={40}
                strokeWidth={1.5}
                className="mx-auto mb-2"
                style={{ color: 'var(--text-tertiary)' }}
              />
              <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                {logLoading ? t('common.loading') : t('settings.logs.empty')}
              </p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                {t('settings.logs.emptyHint')}
              </p>
            </div>
          ) : aggregateView ? (
            // P3-2：聚合视图——按 type+summary 分组，显示出现次数和最近时间
            <div className="space-y-2 max-h-[480px] overflow-y-auto pr-1">
              {aggregatedFaults.map((group) => {
                const meta = FAULT_TYPE_META[group.type as FaultType] || FAULT_TYPE_META.manual
                const expanded = expandedFaultId === group.key
                return (
                  <div
                    key={group.key}
                    className="rounded-lg overflow-hidden transition-all"
                    style={{
                      background: 'var(--bg-tertiary)',
                      border: expanded ? `1px solid ${meta.color}` : '1px solid transparent'
                    }}
                  >
                    <button
                      className="w-full flex items-center gap-3 p-3 text-left hover:bg-[var(--hover-bg)] transition-colors"
                      onClick={() => toggleFaultExpand(group.key)}
                      aria-expanded={expanded}
                      aria-label={t('settings.logs.expandSample', { summary: group.summary })}
                    >
                      <IconChevronRight
                        size={14}
                        className="flex-shrink-0 transition-transform"
                        style={{
                          color: 'var(--text-tertiary)',
                          transform: expanded ? 'rotate(90deg)' : 'none'
                        }}
                      />
                      <span
                        className="text-xs px-2 py-0.5 rounded-full flex-shrink-0 font-medium"
                        style={{ color: meta.color, background: meta.bg }}
                      >
                        {t(meta.labelKey)}
                      </span>
                      {/* P3-2：显示出现次数徽标 */}
                      <span
                        className="text-xs px-1.5 py-0.5 rounded-full flex-shrink-0 font-mono font-bold"
                        style={{
                          color:
                            group.count > 10
                              ? 'var(--danger-hover)'
                              : group.count > 3
                                ? '#ea580c'
                                : 'var(--text-tertiary)',
                          background:
                            group.count > 10
                              ? 'var(--danger-bg)'
                              : group.count > 3
                                ? 'rgba(234, 88, 12, 0.1)'
                                : 'var(--bg-secondary)'
                        }}
                      >
                        ×{group.count}
                      </span>
                      <span
                        className="text-xs font-mono flex-shrink-0"
                        style={{ color: 'var(--text-tertiary)' }}
                        title={`${t('settings.logs.lastSeen', { time: formatTimestamp(group.lastTimestamp) })}\n${t('settings.logs.firstSeen', { time: formatTimestamp(group.firstTimestamp) })}`}
                      >
                        {formatTimestamp(group.lastTimestamp)}
                      </span>
                      <span
                        className="text-sm truncate flex-1"
                        style={{ color: 'var(--text-primary)' }}
                        title={group.summary}
                      >
                        {group.summary}
                      </span>
                    </button>
                    {expanded && (
                      <div className="px-3 pb-3 pt-1 space-y-2">
                        {/* P3-2：聚合信息——时间范围、出现次数、样本详情 */}
                        <div
                          className="text-xs flex items-center gap-3 flex-wrap"
                          style={{ color: 'var(--text-tertiary)' }}
                        >
                          <span>{t('settings.logs.occurrenceCount', { count: group.count })}</span>
                          <span>
                            {t('settings.logs.firstSeen', {
                              time: formatTimestamp(group.firstTimestamp)
                            })}
                          </span>
                          <span>
                            {t('settings.logs.lastSeen', {
                              time: formatTimestamp(group.lastTimestamp)
                            })}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className="text-xs font-medium"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            {t('settings.logs.sampleDetail')}
                          </span>
                          <button
                            className="btn-secondary text-xs px-2 py-1"
                            onClick={() => handleCopyFault(group.sample)}
                            title={t('settings.logs.copySample')}
                          >
                            <span className="flex items-center gap-1">
                              <IconCopy size={12} />
                              {t('settings.logs.copySample')}
                            </span>
                          </button>
                        </div>
                        <pre
                          className="text-xs p-3 rounded-lg overflow-x-auto whitespace-pre-wrap break-all font-mono"
                          style={{
                            background: 'rgba(0, 0, 0, 0.04)',
                            color: 'var(--text-primary)',
                            maxHeight: '300px',
                            overflowY: 'auto'
                          }}
                        >
                          {group.sample.detail}
                        </pre>
                        <div
                          className="text-xs flex items-center gap-3"
                          style={{ color: 'var(--text-tertiary)' }}
                        >
                          <span>{t('diagnostics.logs.sampleId', { id: group.sample.id })}</span>
                          <span>{t('settings.logs.sourceFile', { file: group.sample.file })}</span>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="space-y-2 max-h-[480px] overflow-y-auto pr-1">
              {faults.map((fault) => {
                const meta = FAULT_TYPE_META[fault.type] || FAULT_TYPE_META.manual
                const expanded = expandedFaultId === fault.id
                return (
                  <div
                    key={fault.id}
                    className="rounded-lg overflow-hidden transition-all"
                    style={{
                      background: 'var(--bg-tertiary)',
                      border: expanded ? `1px solid ${meta.color}` : '1px solid transparent'
                    }}
                  >
                    <button
                      className="w-full flex items-center gap-3 p-3 text-left hover:bg-[var(--hover-bg)] transition-colors"
                      onClick={() => toggleFaultExpand(fault.id)}
                      aria-expanded={expanded}
                      aria-label={t('settings.logs.expandFault', { summary: fault.summary })}
                    >
                      <IconChevronRight
                        size={14}
                        className="flex-shrink-0 transition-transform"
                        style={{
                          color: 'var(--text-tertiary)',
                          transform: expanded ? 'rotate(90deg)' : 'none'
                        }}
                      />
                      <span
                        className="text-xs px-2 py-0.5 rounded-full flex-shrink-0 font-medium"
                        style={{ color: meta.color, background: meta.bg }}
                      >
                        {t(meta.labelKey)}
                      </span>
                      <span
                        className="text-xs font-mono flex-shrink-0"
                        style={{ color: 'var(--text-tertiary)' }}
                      >
                        {formatTimestamp(fault.timestamp)}
                      </span>
                      <span
                        className="text-sm truncate flex-1"
                        style={{ color: 'var(--text-primary)' }}
                        title={fault.summary}
                      >
                        {fault.summary}
                      </span>
                    </button>
                    {expanded && (
                      <div className="px-3 pb-3 pt-1 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className="text-xs font-medium"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            {t('settings.logs.fullLog')}
                          </span>
                          <button
                            className="btn-secondary text-xs px-2 py-1"
                            onClick={() => handleCopyFault(fault)}
                            title={t('settings.logs.copy')}
                          >
                            <span className="flex items-center gap-1">
                              <IconCopy size={12} />
                              {t('settings.logs.copy')}
                            </span>
                          </button>
                        </div>
                        <pre
                          className="text-xs p-3 rounded-lg overflow-x-auto whitespace-pre-wrap break-all font-mono"
                          style={{
                            background: 'rgba(0, 0, 0, 0.04)',
                            color: 'var(--text-primary)',
                            maxHeight: '300px',
                            overflowY: 'auto'
                          }}
                        >
                          {fault.detail}
                        </pre>
                        <div
                          className="text-xs flex items-center gap-3"
                          style={{ color: 'var(--text-tertiary)' }}
                        >
                          <span>{t('settings.logs.faultId', { id: fault.id })}</span>
                          <span>{t('settings.logs.sourceFile', { file: fault.file })}</span>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          {t('settings.logs.hint')}
        </p>
      </div>

      <ConfirmDialog
        open={showClearLogConfirm}
        title={t('settings.logs.clearTitle')}
        message={t('settings.logs.clearConfirm')}
        confirmVariant="danger"
        onConfirm={() => {
          setShowClearLogConfirm(false)
          handleClearLogs()
        }}
        onCancel={() => setShowClearLogConfirm(false)}
      />
    </>
  )
}

// T13：崩溃报告管理（crashReporter dump 文件）
export const DiagnosticsCrashSection: React.FC = () => {
  const { t } = useTranslation()
  const [crashes, setCrashes] = useState<CrashRecord[]>([])
  const [totalSize, setTotalSize] = useState(0)
  const [fileCount, setFileCount] = useState(0)
  const [oldestTime, setOldestTime] = useState<string | null>(null)
  const [crashDirPath, setCrashDirPath] = useState('')
  const [loading, setLoading] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const showMessage = useContext(GlobalToastContext)

  const loadCrashData = useCallback(async () => {
    if (!window.electronAPI?.crash) return
    setLoading(true)
    try {
      const [listRes, statsRes, dirPath] = await Promise.all([
        window.electronAPI.crash.list(),
        window.electronAPI.crash.getStats(),
        window.electronAPI.crash.getDir?.()
      ])
      if (listRes?.success && Array.isArray(listRes.crashes)) {
        setCrashes(listRes.crashes)
      }
      if (statsRes?.success) {
        setFileCount(statsRes.fileCount ?? 0)
        setTotalSize(statsRes.totalSize ?? 0)
        setOldestTime(statsRes.oldestTime ?? null)
      }
      if (typeof dirPath === 'string') {
        setCrashDirPath(dirPath)
      }
    } catch (err) {
      console.error(t('diagnostics.logs.loadCrashesFailed'), err)
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    loadCrashData()
  }, [loadCrashData])

  const handleOpenDir = async () => {
    if (!window.electronAPI?.crash?.openDirectory) return
    const res = await window.electronAPI.crash.openDirectory()
    if (!res?.success) showMessage(res?.message || t('logAction.openDirFailed'), 'error')
  }

  const handleClear = async () => {
    if (!window.electronAPI?.crash?.clear || clearing) return
    setClearing(true)
    try {
      const res = await window.electronAPI.crash.clear()
      if (res?.success) {
        showMessage(res.message || t('logAction.clearSuccess'), 'success')
        await loadCrashData()
      } else {
        showMessage(res?.message || t('logAction.clearFailed'), 'error')
      }
    } catch (err) {
      showMessage(err instanceof Error ? err.message : t('logAction.clearFailed'), 'error')
    } finally {
      setClearing(false)
    }
  }

  return (
    <>
      <div className="glass-card p-5 space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
              {t('settings.crash.title')}
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
              {t('settings.crash.desc')}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              className="btn-danger text-xs px-3 py-1.5"
              onClick={() => setShowClearConfirm(true)}
              disabled={clearing || fileCount === 0}
              title={
                fileCount === 0
                  ? t('settings.crash.clearDisabled')
                  : t('diagnostics.crash.clearAllHint')
              }
            >
              {clearing ? t('settings.crash.clearing') : t('settings.crash.clear')}
            </button>
            <button
              className="btn-secondary text-xs px-3 py-1.5"
              onClick={loadCrashData}
              disabled={loading}
              title={t('diagnostics.crash.refreshHint')}
              aria-label={t('diagnostics.crash.refreshAria')}
            >
              {loading ? t('common.loading') : t('settings.crash.refresh')}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <SettingsCard className="text-center">
            <div className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              {fileCount}
            </div>
            <div className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
              {t('settings.crash.crashFiles')}
            </div>
          </SettingsCard>
          <SettingsCard className="text-center">
            <div className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              {formatSize(totalSize)}
            </div>
            <div className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
              {t('settings.crash.storageUsage')}
            </div>
          </SettingsCard>
          <SettingsCard className="text-center">
            <div className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              {oldestTime ? formatTimestamp(oldestTime).slice(0, 10) : '—'}
            </div>
            <div className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
              {t('settings.crash.oldest')}
            </div>
          </SettingsCard>
        </div>

        <SettingsCard className="flex items-center justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {t('settings.crash.storageLocation')}
            </div>
            <div
              className="text-xs font-mono mt-1 truncate"
              style={{ color: 'var(--text-primary)' }}
              title={crashDirPath}
            >
              {crashDirPath || t('settings.crash.userDataPath')}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              className="btn-secondary text-xs px-3 py-1.5"
              onClick={async () => {
                const dir = await window.electronAPI?.dialog?.selectDirectory()
                if (!dir) return
                const res = await window.electronAPI?.crash?.setDir(dir)
                if (res?.success && res.needRestart) {
                  const confirmed = await window.electronAPI?.dialog?.showMessageBox({
                    type: 'question',
                    title: t('settings.backup.restartTitle'),
                    message: res.message,
                    buttons: [t('settings.backup.restartNow'), t('settings.backup.restartLater')]
                  })
                  if (confirmed === 0) {
                    await window.electronAPI?.app?.relaunch()
                  }
                } else if (!res?.success) {
                  showMessage(res?.message || t('logAction.settingFailed'), 'error')
                }
              }}
              title={t('settings.crash.modifyDir')}
            >
              {t('settings.crash.modifyDir')}
            </button>
            <button
              className="btn-secondary text-xs px-3 py-1.5"
              onClick={handleOpenDir}
              title={t('settings.crash.openDir')}
            >
              {t('settings.crash.openDir')}
            </button>
          </div>
        </SettingsCard>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
              {t('settings.crash.listTitle')}
            </span>
            {crashes.length > 0 && (
              <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {t('settings.crash.listCount', { count: crashes.length })}
              </span>
            )}
          </div>

          {crashes.length === 0 ? (
            <div
              className="py-8 text-center rounded-lg"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              <IconShield
                size={36}
                strokeWidth={1.5}
                className="mx-auto mb-2"
                style={{ color: 'var(--text-tertiary)' }}
              />
              <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                {loading ? t('settings.crash.emptyLoading') : t('settings.crash.emptyStable')}
              </p>
            </div>
          ) : (
            <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
              {crashes.map((crash) => (
                <SettingsCard key={crash.filename} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="text-xs px-1.5 py-0.5 rounded font-medium flex-shrink-0"
                        style={{
                          background:
                            crash.processType === 'main'
                              ? 'var(--danger-bg)'
                              : crash.processType === 'renderer'
                                ? 'rgba(147, 51, 234, 0.12)'
                                : 'rgba(107, 114, 128, 0.12)',
                          color:
                            crash.processType === 'main'
                              ? 'var(--danger-hover)'
                              : crash.processType === 'renderer'
                                ? '#9333ea'
                                : '#6b7280'
                        }}
                      >
                        {t(`diagnostics.crash.processType.${crash.processType}`)}
                      </span>
                      <span
                        className="text-xs font-mono truncate"
                        style={{ color: 'var(--text-primary)' }}
                        title={crash.filename}
                      >
                        {crash.filename}
                      </span>
                    </div>
                    <span
                      className="text-xs flex-shrink-0"
                      style={{ color: 'var(--text-tertiary)' }}
                    >
                      {formatTimestamp(crash.mtime)}
                    </span>
                  </div>
                  <div
                    className="text-xs flex items-center gap-3"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    <span>
                      {t('settings.crash.size')}:{' '}
                      <span className="font-mono">{formatSize(crash.size)}</span>
                    </span>
                  </div>
                  {/* P2-1：展示崩溃原因和顶层调用栈（解析成功时） */}
                  {crash.crashReason && (
                    <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                      <span style={{ color: 'var(--text-tertiary)' }}>
                        {t('settings.crash.crashReason')}:{' '}
                      </span>
                      <span className="font-mono">{crash.crashReason}</span>
                    </div>
                  )}
                  {crash.topFrame && (
                    <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                      <span style={{ color: 'var(--text-tertiary)' }}>
                        {t('settings.crash.topFrame')}:{' '}
                      </span>
                      <span className="font-mono truncate" title={crash.topFrame}>
                        {crash.topFrame}
                      </span>
                    </div>
                  )}
                </SettingsCard>
              ))}
            </div>
          )}
        </div>

        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          {t('settings.crash.hint')}
        </p>
      </div>

      <ConfirmDialog
        open={showClearConfirm}
        title={t('settings.crash.clearTitle')}
        message={t('settings.crash.clearConfirm')}
        confirmVariant="danger"
        onConfirm={() => {
          setShowClearConfirm(false)
          handleClear()
        }}
        onCancel={() => setShowClearConfirm(false)}
      />
    </>
  )
}
