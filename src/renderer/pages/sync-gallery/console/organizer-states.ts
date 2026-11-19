/**
 * K8：上游 DeletionQueue 状态映射（自 SyncServicePage 原样迁入，判据不变）。
 * 未知状态回退原样英文短码（不谎报，K1 启动阶段同款口径）；
 * state 值域由上游协议定义，本仓不发明新态。
 */
export const ORGANIZER_STATE_I18N_KEYS: Record<string, string> = {
  preparing: 'syncService.organizer.state.preparing',
  pending: 'syncService.organizer.state.pending',
  confirming: 'syncService.organizer.state.confirming',
  queued: 'syncService.organizer.state.queued',
  checking: 'syncService.organizer.state.checking',
  executing: 'syncService.organizer.state.executing',
  recycled: 'syncService.organizer.state.recycled',
  failed: 'syncService.organizer.state.failed',
  changed: 'syncService.organizer.state.changed',
  cancelled: 'syncService.organizer.state.cancelled',
  rejected: 'syncService.organizer.state.rejected'
}

/** K8：可执行 PC 侧动作（批准/拒绝）的状态集；终态与 executing 不再给操作钮。 */
export const ORGANIZER_ACTIONABLE_STATES = new Set([
  'preparing',
  'pending',
  'confirming',
  'queued',
  'checking'
])

/**
 * T10：子导航待批角标的计数集（上游 DesktopPage.ts 的 activeStates：
 * 比 actionable 多一个 executing——正在执行的删除也占「待处理」名额）。
 */
export const ORGANIZER_BADGE_STATES = new Set([
  'preparing',
  'pending',
  'confirming',
  'queued',
  'checking',
  'executing'
])
