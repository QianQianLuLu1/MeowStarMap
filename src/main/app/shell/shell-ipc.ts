/**
 * Thin IPC dispatch for the Windows shell capabilities.
 *
 * Every action is gated by an explicit opt-in setting. No signed feed, CNB upload
 * credential or support gateway is available in this repository, so enabled actions
 * that would need one return a deterministic `unavailable` result rather than
 * pretending the capability succeeded.
 */
import type {
  NikkiSyncShellActionInput,
  NikkiSyncShellActionResultInfo,
  NikkiSyncShellStatusInfo
} from '../../../shared/types/electron-api'

import {
  SHELL_SETTING_KEYS,
  isShellFeatureEnabled,
  readShellFlags,
  type ShellSettingsReader,
  type ShellEvent
} from './shell-capabilities'
import { checkIconUpdate } from './shell-capabilities'
import { stageProgramUpdate } from './program-update-client'
import { configuredEndpoint, submitDiagnosticReport } from './support-gateway-client'
import { toggleHotspot } from './temporary-hotspot'

export type ShellActionName =
  | 'icon-check'
  | 'icon-activate'
  | 'program-check'
  | 'program-stage'
  | 'program-apply'
  | 'support-submit'
  | 'network-repair'
  | 'hotspot-toggle'

const ACTION_FLAGS: Record<ShellActionName, string> = {
  'icon-check': SHELL_SETTING_KEYS.iconUpdate,
  'icon-activate': SHELL_SETTING_KEYS.iconUpdate,
  'program-check': SHELL_SETTING_KEYS.programUpdate,
  'program-stage': SHELL_SETTING_KEYS.programUpdate,
  'program-apply': SHELL_SETTING_KEYS.programUpdate,
  'support-submit': SHELL_SETTING_KEYS.support,
  'network-repair': SHELL_SETTING_KEYS.networkRepair,
  'hotspot-toggle': SHELL_SETTING_KEYS.hotspot
}

export function getShellStatus(
  settings: ShellSettingsReader,
  facts?: { trayActive?: boolean; localPhotoResolverActive?: boolean }
): NikkiSyncShellStatusInfo {
  return {
    enabled: readShellFlags(settings),
    // F2：两键是真实观测（托盘句柄 / 会话挂载），不是设置开关；缺席缺省 false，不伪造。
    trayActive: facts?.trayActive ?? false,
    localPhotoResolverActive: facts?.localPhotoResolverActive ?? false
  }
}

export async function runShellAction(
  action: ShellActionName,
  input: NikkiSyncShellActionInput,
  settings: ShellSettingsReader,
  emit?: (event: ShellEvent) => void
): Promise<NikkiSyncShellActionResultInfo> {
  if (!isShellFeatureEnabled(settings, ACTION_FLAGS[action])) return { status: 'disabled' }
  emit?.({ type: 'checking' })
  switch (action) {
    case 'icon-check':
      return (await checkIconUpdate({ enabled: true })) as NikkiSyncShellActionResultInfo
    case 'icon-activate':
      return input.confirm === true
        ? { status: 'unavailable', reason: 'no signed delta has been staged' }
        : { status: 'confirmation-required' }
    case 'program-check':
    case 'program-stage':
      return (await stageProgramUpdate({ enabled: true })) as NikkiSyncShellActionResultInfo
    case 'program-apply':
      return input.confirm === true
        ? { status: 'unavailable', reason: 'EXE self-replacement is out of scope' }
        : { status: 'confirmation-required' }
    case 'support-submit':
      return (await submitDiagnosticReport({
        optIn: true,
        endpoint: configuredEndpoint(process.env) ?? undefined
      })) as NikkiSyncShellActionResultInfo
    case 'network-repair':
      // 本构建未接线防火墙规则枚举（需要管理员态 COM/PowerShell），绝不报 repaired 伪成功。
      // runRepair 纯函数保留在 network-conflict-repair.ts 供未来接线，其单测不变。
      return {
        status: 'unavailable',
        reason: 'firewall rule enumeration is not wired in this build'
      }
    case 'hotspot-toggle':
      return (await toggleHotspot({
        enabled: true,
        current: { startedHere: false, active: false },
        requested: input.confirm === true
      })) as NikkiSyncShellActionResultInfo
    default:
      return { status: 'unsupported-action' }
  }
}
