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
  NikkiSyncShellStatusInfo,
  NikkiSyncNetworkAuthResultInfo,
  NikkiSyncNetworkConflictResultInfo,
  NikkiSyncHotspotControlResultInfo
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
import { toggleHotspot, controlHotspot, type HotspotState } from './temporary-hotspot'
import { runNetworkAuth, type NetworkAuthAction } from './network-authorization'
import { runNetworkConflict, type ConflictJournalEntry } from './network-conflict-repair'

export type ShellActionName =
  | 'icon-check'
  | 'icon-activate'
  | 'program-check'
  | 'program-stage'
  | 'program-apply'
  | 'support-submit'
  | 'network-repair'
  | 'hotspot-toggle'

/** Side-effect dependencies for the real network / hotspot actions (injected by the handler). */
export interface ShellActionDeps {
  port: number
  isAdmin: boolean
  execFile: (file: string, args: string[]) => Promise<{ stdout: string }>
  readJournal: () => Promise<ConflictJournalEntry[] | null>
  writeJournal: (entries: ConflictJournalEntry[]) => Promise<void>
  clearJournal: () => Promise<void>
  readHotspotState: () => Promise<HotspotState>
  writeHotspotState: (state: HotspotState) => Promise<void>
}

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
  emit?: (event: ShellEvent) => void,
  deps?: ShellActionDeps
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
      // 2026-11-19：接线真实防火墙枚举/修复（deps 由 handler 注入）。无 deps 时仍诚实 unavailable。
      if (!deps) {
        return {
          status: 'unavailable',
          reason: 'firewall rule enumeration is not wired in this build'
        }
      }
      return (await runNetworkConflict({
        action: 'repair',
        port: deps.port,
        enabled: true,
        isAdmin: deps.isAdmin,
        execFile: deps.execFile,
        readJournal: deps.readJournal,
        writeJournal: deps.writeJournal,
        clearJournal: deps.clearJournal
      })) as unknown as NikkiSyncShellActionResultInfo
    case 'hotspot-toggle':
      if (deps) {
        return (await controlHotspot({
          action: input.confirm === true ? 'start' : 'stop',
          enabled: true,
          execFile: deps.execFile,
          readState: deps.readHotspotState,
          writeState: deps.writeHotspotState
        })) as unknown as NikkiSyncShellActionResultInfo
      }
      return (await toggleHotspot({
        enabled: true,
        current: { startedHere: false, active: false },
        requested: input.confirm === true
      })) as NikkiSyncShellActionResultInfo
    default:
      return { status: 'unsupported-action' }
  }
}

/** `nikkisync:network-auth`：授权 / 撤销 / 查询（opt-in 门 + 真实 netsh 等价 cmdlet）。 */
export async function runNetworkAuthAction(
  action: NetworkAuthAction,
  settings: ShellSettingsReader,
  deps: ShellActionDeps
): Promise<NikkiSyncNetworkAuthResultInfo> {
  return runNetworkAuth({
    action,
    port: deps.port,
    enabled: isShellFeatureEnabled(settings, SHELL_SETTING_KEYS.networkRepair),
    isAdmin: deps.isAdmin,
    execFile: deps.execFile
  })
}

/** `nikkisync:network-conflict`：检查 / 修复 / 撤销修复（journal 持久化由 deps 注入）。 */
export async function runNetworkConflictAction(
  action: 'inspect' | 'repair' | 'restore',
  settings: ShellSettingsReader,
  deps: ShellActionDeps
): Promise<NikkiSyncNetworkConflictResultInfo> {
  return runNetworkConflict({
    action,
    port: deps.port,
    enabled: isShellFeatureEnabled(settings, SHELL_SETTING_KEYS.networkRepair),
    isAdmin: deps.isAdmin,
    execFile: deps.execFile,
    readJournal: deps.readJournal,
    writeJournal: deps.writeJournal,
    clearJournal: deps.clearJournal
  })
}

/** `nikkisync:hotspot-control`：开启 / 结束 / 查询（startedHere 持久化由 deps 注入）。 */
export async function runHotspotControlAction(
  action: 'start' | 'stop' | 'status',
  settings: ShellSettingsReader,
  deps: ShellActionDeps
): Promise<NikkiSyncHotspotControlResultInfo> {
  return controlHotspot({
    action,
    enabled: isShellFeatureEnabled(settings, SHELL_SETTING_KEYS.hotspot),
    execFile: deps.execFile,
    readState: deps.readHotspotState,
    writeState: deps.writeHotspotState
  })
}
