/**
 * 扫描全链路诊断区块。
 *
 * 从主进程拉取 scanLogStore 的结构化日志，按阶段渲染时间线，精准定位扫描失效节点。
 * 状态点按 kind 着色：ok=绿 / path-missing=黄 / permission=红 / empty=灰 / other=蓝。
 *
 * 设计：深色玻璃拟态 + 科技蓝青色调，与设置页 glass-card 风格统一。
 * 所有 UI 文案走 i18n（diagnostics.scan.*），无硬编码中文。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../../../i18n'

const KIND_META: Record<string, { dot: string; ring: string }> = {
  ok: { dot: 'bg-emerald-400', ring: 'ring-emerald-400/30' },
  'path-missing': { dot: 'bg-amber-400', ring: 'ring-amber-400/30' },
  permission: { dot: 'bg-red-400', ring: 'ring-red-400/30' },
  empty: { dot: 'bg-slate-400', ring: 'ring-slate-400/30' },
  other: { dot: 'bg-cyan-400', ring: 'ring-cyan-400/30' }
}

const KIND_ORDER = ['ok', 'path-missing', 'permission', 'empty', 'other'] as const
const KIND_LABEL_KEY: Record<string, string> = {
  ok: 'diagnostics.scan.legendOk',
  'path-missing': 'diagnostics.scan.legendPathMissing',
  permission: 'diagnostics.scan.legendPermission',
  empty: 'diagnostics.scan.legendEmpty',
  other: 'diagnostics.scan.legendInfo'
}

interface ScanLogEntry {
  id: number
  ts: number
  stage: string
  level: 'info' | 'warn' | 'error'
  kind: string
  message: string
  detail?: unknown
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(
    d.getMilliseconds()
  ).padStart(3, '0')}`
}

export function ScanLogDiagnosticSection() {
  const { t } = useI18n()
  const [entries, setEntries] = useState<ScanLogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const timerRef = useRef<number | null>(null)

  const load = useCallback(async () => {
    if (!window.electronAPI?.scanner?.getScanLog) return
    setLoading(true)
    try {
      const data = await window.electronAPI.scanner.getScanLog()
      setEntries(data ?? [])
    } catch {
      /* IPC 失败时静默，不阻塞诊断页 */
    } finally {
      setLoading(false)
    }
  }, [])

  const clear = useCallback(async () => {
    try {
      await window.electronAPI?.scanner?.clearScanLog()
    } catch {
      /* ignore */
    }
    setEntries([])
  }, [])

  const copy = useCallback(async () => {
    const text = entries
      .map((e) => `[${formatTime(e.ts)}] [${e.stage}] ${e.level} (${e.kind}) ${e.message}`)
      .join('\n')
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      /* ignore */
    }
  }, [entries])

  useEffect(() => {
    void load()
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current)
    }
  }, [load])

  useEffect(() => {
    if (timerRef.current) window.clearInterval(timerRef.current)
    if (autoRefresh) {
      timerRef.current = window.setInterval(() => void load(), 1500)
    }
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current)
    }
  }, [autoRefresh, load])

  const hasData = entries.length > 0

  return (
    <section className="glass-card p-5 mb-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="glass-card-title flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-cyan-400" />
          {t('diagnostics.scan.title')}
        </h3>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="accent-cyan-400"
            />
            {t('diagnostics.scan.autoRefresh')}
          </label>
          <button className="btn btn-ghost btn-sm" onClick={() => void load()} disabled={loading}>
            {loading ? `${t('diagnostics.scan.refresh')}…` : t('diagnostics.scan.refresh')}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => void copy()} disabled={!hasData}>
            {t('diagnostics.scan.copy')}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => void clear()} disabled={!hasData}>
            {t('diagnostics.scan.clear')}
          </button>
        </div>
      </div>

      {/* 图例 */}
      <div className="flex flex-wrap gap-3 mb-4 text-xs text-slate-400">
        {KIND_ORDER.map((k) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className={`inline-block w-2.5 h-2.5 rounded-full ${KIND_META[k].dot}`} />
            {t(KIND_LABEL_KEY[k])}
          </span>
        ))}
      </div>

      {!hasData ? (
        <div className="text-center py-10 text-slate-500 text-sm">
          {t('diagnostics.scan.emptyHint')}
        </div>
      ) : (
        <ol className="relative border-l border-slate-700/60 ml-2 space-y-3">
          {entries.map((e) => {
            const meta = KIND_META[e.kind] ?? KIND_META.other
            return (
              <li key={e.id} className="ml-4">
                <span
                  className={`absolute -left-[7px] flex w-3.5 h-3.5 rounded-full ${meta.dot} ring-4 ${meta.ring}`}
                />
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-xs font-mono text-slate-500">{formatTime(e.ts)}</span>
                  <span className="text-sm font-medium text-slate-200">[{e.stage}]</span>
                  <span
                    className={`text-xs px-1.5 py-0.5 rounded ${
                      e.level === 'error'
                        ? 'bg-red-500/15 text-red-300'
                        : e.level === 'warn'
                          ? 'bg-amber-500/15 text-amber-300'
                          : 'bg-slate-500/15 text-slate-300'
                    }`}
                  >
                    {e.level}
                  </span>
                </div>
                <p className="mt-0.5 text-sm text-slate-300 break-words">{e.message}</p>
                {e.detail !== undefined && e.detail !== null && (
                  <pre className="mt-1 max-h-32 overflow-auto rounded bg-slate-900/60 p-2 text-xs text-slate-400 whitespace-pre-wrap break-all">
                    {typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail, null, 2)}
                  </pre>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
