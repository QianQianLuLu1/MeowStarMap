import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SettingsToggle } from '../../settings/shared'
import { ConsoleRow, ConsoleSection } from './console-ui'
import { useGlobalToast } from '../../../components/common/ToastProvider'
import { ConfirmDialog } from '../../../components/common/ConfirmDialog'
import { EmptyState } from '../../../components/common/EmptyState'
import { useErrorToast } from '../../../hooks/useErrorToast'
import { useUIStore } from '../../../stores/uiStore'
import type {
  NikkiSyncOrganizerItemInfo,
  NikkiSyncOrganizerViewInfo
} from '../../../../shared/types/electron-api'
import { ORGANIZER_STATE_I18N_KEYS, ORGANIZER_ACTIONABLE_STATES } from './organizer-states'
import { SYNC_CONSOLE_HOST_VIEW } from './console-views'

// 状态轮询间隔（上游 pc-companion DesktopPageScript 同款 2s）
const STATUS_POLL_MS = 2000
// K8：整理队列（批量删除）开关。默认关属破坏性能力的双保险之一；
// 关闭时三条 organizer 通道按契约回 PRECONDITION_FAILED（错误文案指向本开关）。
const SETTING_ORGANIZER_ENABLED = 'nikkisync.organizerEnabled'

interface OrganizerViewProps {
  /** T10：开关变化上报 Layout（子导航待批角标的轮询门控随之启停）。 */
  onEnabledChange?: (enabled: boolean) => void
}

/**
 * T1/T10：最近删除视图（K8 整理队列自 SyncServicePage 原样迁入）。
 *
 * 行为契约由 console/OrganizerView.test.tsx 逐条钉住（原判据不重写）：
 * 开关默认关 / 11 态映射 / 确认弹窗拦截 / 单条 decide / 批量 approveMany
 * （仅 actionable 且在线的 id）/ 空态与不可用态。
 *
 * T10 新增：
 * - 「打开最近删除」入口 → navigateTo('recycle-bin')（宿主回收站页，深链压栈）；
 * - 批量批准结果聚合提示（approved/skipped 计数）；失败 ⇒ 错误 Toast + 行内聚合提示。
 *
 * keep-alive 纪律：2s 队列轮询按 organizerEnabled && currentView 双门控；
 * 子视图切走时本组件卸载，定时器随 cleanup 清零。
 */
export const OrganizerView: React.FC<OrganizerViewProps> = ({ onEnabledChange }) => {
  const { t } = useTranslation()
  const showMessage = useGlobalToast()
  const { showError } = useErrorToast()
  /** 卸载后作废在途轮询：切走视图即卸载，慢响应不得回写已卸载组件。 */
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])
  // K8：整理队列（破坏性能力，开关默认关）。null = 未拉到/不可用 ⇒ 队列区显示不可用而非报错
  const [organizerEnabled, setOrganizerEnabled] = useState(false)
  const [organizerQueue, setOrganizerQueue] = useState<NikkiSyncOrganizerViewInfo | null>(null)
  const [organizerUnavailable, setOrganizerUnavailable] = useState(false)
  /** K8：待确认的批准目标（single=单条，batch=全部可批准项）；null = 无待确认。 */
  const [approveTarget, setApproveTarget] = useState<
    { mode: 'single'; item: NikkiSyncOrganizerItemInfo } | { mode: 'batch' } | null
  >(null)
  const [busy, setBusy] = useState(false)
  /** T10：批量批准失败的行内聚合提示（错误 Toast 之外的常驻线索，直到下次批准成功）。 */
  const [batchFailed, setBatchFailed] = useState(false)
  const currentView = useUIStore((s) => s.currentView)
  const navigateTo = useUIStore((s) => s.navigateTo)

  /** K8：开关读回。读不到一律保持关闭（破坏性能力绝不默认生效）。 */
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const value = await window.electronAPI?.settings.get(SETTING_ORGANIZER_ENABLED, false)
        if (alive) {
          setOrganizerEnabled(value === true)
          onEnabledChange?.(value === true)
        }
      } catch {
        // 静默：保持关闭态
      }
    })()
    return () => {
      alive = false
    }
  }, [onEnabledChange])

  /**
   * K8：队列拉取。开关关闭时一次都不拉；开关开但会话未装配时通道回
   * PRECONDITION_FAILED——这是预期内状态，降级为「不可用」提示而非错误弹窗。
   */
  const refreshOrganizerQueue = useCallback(async (): Promise<void> => {
    try {
      const next = await window.electronAPI?.nikkisync.getOrganizerQueue()
      if (!aliveRef.current) return
      setOrganizerQueue(next ?? null)
      setOrganizerUnavailable(false)
    } catch {
      if (!aliveRef.current) return
      setOrganizerQueue(null)
      setOrganizerUnavailable(true)
    }
  }, [])

  useEffect(() => {
    // 仅队列区可见（开关开 + 本页在前台）时轮询；否则不留后台定时器
    if (!organizerEnabled || currentView !== SYNC_CONSOLE_HOST_VIEW) return
    void refreshOrganizerQueue()
    const timer = setInterval(() => void refreshOrganizerQueue(), STATUS_POLL_MS)
    return () => clearInterval(timer)
  }, [organizerEnabled, currentView, refreshOrganizerQueue])

  /** K8：开关切换。写入失败回滚开关态并报错；开启后立即拉一次队列。 */
  const handleOrganizerToggle = async (value: boolean): Promise<void> => {
    const api = window.electronAPI
    if (busy || !api) return
    const previous = organizerEnabled
    setBusy(true)
    setOrganizerEnabled(value)
    onEnabledChange?.(value)
    try {
      await api.settings.set(SETTING_ORGANIZER_ENABLED, value)
      if (value) void refreshOrganizerQueue()
    } catch (error) {
      setOrganizerEnabled(previous)
      onEnabledChange?.(previous)
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  /** K8：拒绝（非破坏性：不删任何文件，队列项转 rejected）。 */
  const handleReject = async (item: NikkiSyncOrganizerItemInfo): Promise<void> => {
    const api = window.electronAPI
    if (busy || !api) return
    setBusy(true)
    try {
      await api.nikkisync.decideOrganizerItem({ id: item.id, approve: false })
      await refreshOrganizerQueue()
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  /** K8：确认弹窗的确认回调——单条走 decide，批量走 approveMany；完成后刷新队列。
   * T10：批量成功且存在跳过项 ⇒ 聚合计数提示；批量失败 ⇒ 行内聚合提示常驻。 */
  const handleConfirmApprove = async (): Promise<void> => {
    const api = window.electronAPI
    const target = approveTarget
    if (busy || !api || !target) return
    setBusy(true)
    try {
      if (target.mode === 'single') {
        await api.nikkisync.decideOrganizerItem({ id: target.item.id, approve: true })
      } else {
        const ids = (organizerQueue?.items ?? [])
          .filter((item) => ORGANIZER_ACTIONABLE_STATES.has(item.state) && item.online)
          .map((item) => item.id)
        if (ids.length > 0) {
          const result = await api.nikkisync.approveOrganizerItems({ ids })
          if (result && result.skipped > 0) {
            showMessage(
              t('syncConsole.organizer.batchResult', {
                approved: result.approved,
                skipped: result.skipped
              }),
              'info'
            )
          }
        }
      }
      setBatchFailed(false)
      setApproveTarget(null)
      await refreshOrganizerQueue()
    } catch (error) {
      if (target.mode === 'batch') setBatchFailed(true)
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  // 外部行的防御式收敛：items 缺失（契约破坏/老主进程）按空队列处理，与
  // SyncConsoleLayout 的 `queue?.items ?? []` 同口径，不在渲染期抛错。
  const queueItems = organizerQueue?.items ?? []
  /** 批量批准覆盖的文件总数（约定 §4：JSX 内不做数据变换，抽成 useMemo）。 */
  const batchApproveCount = useMemo(
    () =>
      (organizerQueue?.items ?? [])
        .filter((item) => ORGANIZER_ACTIONABLE_STATES.has(item.state) && item.online)
        .reduce((sum, item) => sum + item.count, 0),
    [organizerQueue]
  )

  return (
    <div className="sc-organizer">
      <div className="flex items-center justify-end gap-3">
        {/* T10：宿主回收站入口（最近删除的最终去向，深链压栈可返回） */}
        <button
          type="button"
          className="btn-secondary text-sm"
          onClick={() => navigateTo('recycle-bin')}
        >
          {t('syncConsole.organizer.openRecycleBin')}
        </button>
      </div>

      {/* K8：整理队列（批量删除；破坏性能力默认关，开关门由主进程三通道强制） */}
      <ConsoleSection titleAs="h2" title={t('syncService.organizer.title')}>
        <div className="space-y-2">
          <SettingsToggle
            label={t('syncService.organizer.toggle')}
            description={t('syncService.organizer.toggleDesc')}
            checked={organizerEnabled}
            disabled={busy}
            onChange={(value) => void handleOrganizerToggle(value)}
          />
          {batchFailed && (
            <p
              className="text-xs"
              data-testid="sync-organizer-batch-failed"
              style={{ color: 'var(--danger)' }}
            >
              {t('syncConsole.organizer.batchFailed')}
            </p>
          )}
          {organizerEnabled && (
            <>
              {organizerUnavailable ? (
                <EmptyState
                  title={t('syncService.organizer.unavailable')}
                  subtitle={t('syncService.organizer.unavailableHint')}
                />
              ) : queueItems.length === 0 ? (
                <EmptyState
                  title={t('syncService.organizer.empty')}
                  subtitle={t('syncService.organizer.emptyHint')}
                />
              ) : (
                <>
                  {queueItems.map((item) => {
                    const actionable = ORGANIZER_ACTIONABLE_STATES.has(item.state)
                    // 已知 11 态走 i18n 映射；未知状态回退原样英文短码（不谎报，K1 同款口径）
                    const stateKey = ORGANIZER_STATE_I18N_KEYS[item.state]
                    return (
                      <div className="sc-service-rows" key={item.id}>
                        <ConsoleRow
                          label={stateKey ? t(stateKey) : item.state}
                          description={`${t('syncService.organizer.filesCount', {
                            count: item.count
                          })} · ${
                            item.online
                              ? t('syncService.organizer.online')
                              : t('syncService.organizer.offline')
                          }`}
                        >
                          {actionable && (
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                className="btn-danger text-xs"
                                disabled={busy || !item.online}
                                onClick={() => setApproveTarget({ mode: 'single', item })}
                              >
                                {t('syncService.organizer.approve')}
                              </button>
                              <button
                                type="button"
                                className="btn-ghost text-xs"
                                disabled={busy}
                                onClick={() => void handleReject(item)}
                              >
                                {t('syncService.organizer.reject')}
                              </button>
                            </div>
                          )}
                        </ConsoleRow>
                      </div>
                    )
                  })}
                  <div className="flex justify-end">
                    <button
                      type="button"
                      className="btn-danger text-sm"
                      disabled={
                        busy ||
                        !queueItems.some(
                          (item) => ORGANIZER_ACTIONABLE_STATES.has(item.state) && item.online
                        )
                      }
                      onClick={() => setApproveTarget({ mode: 'batch' })}
                    >
                      {t('syncService.organizer.approveAll')}
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </ConsoleSection>

      {/* K8：破坏性确认弹窗——列明将移入 Windows 回收站的文件总数与去向，取消可退；
          未确认绝不发起 decide/approveMany（由 approveTarget 是否为 null 把关）。 */}
      <ConfirmDialog
        open={approveTarget !== null}
        title={t('syncService.organizer.confirmTitle')}
        message={t('syncService.organizer.confirmBody', {
          count: approveTarget?.mode === 'single' ? approveTarget.item.count : batchApproveCount
        })}
        confirmText={t('syncService.organizer.confirmAction')}
        cancelText={t('syncService.organizer.cancel')}
        confirmVariant="danger"
        onConfirm={() => void handleConfirmApprove()}
        onCancel={() => setApproveTarget(null)}
      />
    </div>
  )
}
