import { describe, expect, it, vi } from 'vitest'
import {
  NETWORK_RULE_GROUP,
  buildAuthorizeScript,
  buildRevokeScript,
  buildStatusScript,
  buildElevatedArgs,
  parsePresence,
  isElevationDeclined,
  runNetworkAuth
} from './network-authorization'
import {
  buildEnumerateScript,
  parseFirewallRules,
  buildApplyScript,
  runNetworkConflict,
  planRepair,
  matchesPort,
  runRepair,
  parseConflictJournal,
  type ConflictJournalEntry,
  type FirewallRule
} from './network-conflict-repair'
import {
  buildHotspotScript,
  parseHotspotOutput,
  controlHotspot,
  nextHotspotState,
  toggleHotspot
} from './temporary-hotspot'

const okExec = (stdout: string) => vi.fn(async () => ({ stdout }))
const failExec = (message: string) => vi.fn(async () => Promise.reject(new Error(message)))

describe('network-authorization 纯函数', () => {
  it('规则组名逐字对齐上游', () => {
    expect(NETWORK_RULE_GROUP).toBe('MomoCamera LAN Authorization v1')
  })
  it('授权脚本含 TCP/LocalSubnet/Private,Public 且不含 Domain', () => {
    const script = buildAuthorizeScript(28080)
    expect(script).toContain('-Protocol TCP')
    expect(script).toContain('-LocalPort 28080')
    expect(script).toContain('-RemoteAddress LocalSubnet')
    expect(script).toContain('-Profile Private,Public')
    expect(script).not.toContain('Domain')
    expect(script).toContain(NETWORK_RULE_GROUP)
  })
  it('撤销/查询脚本指向同一规则组', () => {
    expect(buildRevokeScript()).toContain(
      `Remove-NetFirewallRule -DisplayName '${NETWORK_RULE_GROUP}'`
    )
    expect(buildStatusScript()).toContain(
      `Get-NetFirewallRule -DisplayName '${NETWORK_RULE_GROUP}'`
    )
  })
  it('提权 args 包裹 RunAs', () => {
    const args = buildElevatedArgs('Write-Output 1')
    expect(args[0]).toBe('-NoProfile')
    expect(args).toContain('-EncodedCommand')
  })
  it('parsePresence：正整数 ⇒ present，0/空/畸形 ⇒ absent', () => {
    expect(parsePresence('2\n')).toBe(true)
    expect(parsePresence('0')).toBe(false)
    expect(parsePresence('')).toBe(false)
    expect(parsePresence('abc')).toBe(false)
  })
  it('isElevationDeclined：识别取消错误', () => {
    expect(isElevationDeclined(new Error('The operation was canceled by the user'))).toBe(true)
    expect(isElevationDeclined(new Error('操作已取消'))).toBe(true)
    expect(isElevationDeclined(new Error('access denied'))).toBe(false)
  })
})

describe('runNetworkAuth 编排', () => {
  const deps = { port: 28080, isAdmin: true, execFile: okExec('1') }
  it('异常：opt-in 关闭 ⇒ disabled 零子进程', async () => {
    const execFile = vi.fn()
    const result = await runNetworkAuth({
      action: 'authorize',
      port: 28080,
      enabled: false,
      isAdmin: true,
      execFile
    })
    expect(result.status).toBe('disabled')
    expect(execFile).not.toHaveBeenCalled()
  })
  it('边界：非法端口 ⇒ failed', async () => {
    const result = await runNetworkAuth({ ...deps, action: 'authorize', enabled: true, port: 0 })
    expect(result.status).toBe('failed')
  })
  it('正常：status 读到计数 ⇒ present', async () => {
    const result = await runNetworkAuth({ ...deps, action: 'status', enabled: true })
    expect(result.status).toBe('present')
    expect(result.ruleGroup).toBe(NETWORK_RULE_GROUP)
  })
  it('正常：status 计数 0 ⇒ absent', async () => {
    const result = await runNetworkAuth({
      ...deps,
      action: 'status',
      enabled: true,
      execFile: okExec('0')
    })
    expect(result.status).toBe('absent')
  })
  it('正常：管理员 authorize ⇒ authorized', async () => {
    const result = await runNetworkAuth({ ...deps, action: 'authorize', enabled: true })
    expect(result.status).toBe('authorized')
  })
  it('异常：非管理员 UAC 拒绝 ⇒ elevation-declined', async () => {
    const result = await runNetworkAuth({
      ...deps,
      action: 'authorize',
      enabled: true,
      isAdmin: false,
      execFile: failExec('The operation was canceled by the user')
    })
    expect(result.status).toBe('elevation-declined')
  })
  it('异常：命令失败 ⇒ failed', async () => {
    const result = await runNetworkAuth({
      ...deps,
      action: 'revoke',
      enabled: true,
      execFile: failExec('boom')
    })
    expect(result.status).toBe('failed')
  })
})

describe('network-conflict 枚举解析', () => {
  it('正常：解析 JSON 数组为规则', () => {
    const json = JSON.stringify([
      {
        name: 'r1',
        displayName: 'Block Sync',
        enabled: true,
        profile: 'Private',
        action: 'Block',
        direction: 'Inbound',
        localPorts: '28080'
      }
    ])
    const rules = parseFirewallRules(json)
    expect(rules).toHaveLength(1)
    expect(rules[0].name).toBe('r1')
    expect(rules[0].action).toBe('Block')
    expect(rules[0].localPorts).toBe('28080')
  })
  it('边界：单对象（非数组）也归一为数组', () => {
    const json = JSON.stringify({
      name: 'r1',
      enabled: false,
      profile: 'Any',
      action: 'Block',
      direction: 'Inbound',
      localPorts: '*'
    })
    expect(parseFirewallRules(json)).toHaveLength(1)
  })
  it('异常：空/畸形 JSON ⇒ []', () => {
    expect(parseFirewallRules('')).toEqual([])
    expect(parseFirewallRules('{bad')).toEqual([])
    expect(parseFirewallRules('null')).toEqual([])
  })
  it('枚举脚本读取端口过滤', () => {
    expect(buildEnumerateScript()).toContain('Get-NetFirewallPortFilter')
    expect(buildEnumerateScript()).toContain('ConvertTo-Json')
  })
  it('修复脚本只改 enabled/profile，不删规则', () => {
    const script = buildApplyScript([
      { name: "r'1", changes: { enabled: true, profile: 'Private,Public' } }
    ])
    expect(script).toContain('Set-NetFirewallRule')
    expect(script).not.toContain('Remove-NetFirewallRule')
    expect(script).toContain("r''1")
  })
})

describe('runNetworkConflict 编排', () => {
  const blockRule = JSON.stringify([
    {
      name: 'b1',
      enabled: true,
      profile: 'Private',
      action: 'Block',
      direction: 'Inbound',
      localPorts: '28080'
    }
  ])
  const journalStore: { entries: ConflictJournalEntry[] | null } = { entries: null }
  const baseDeps = {
    port: 28080,
    isAdmin: true,
    execFile: okExec(blockRule),
    readJournal: async () => journalStore.entries,
    writeJournal: async (e: ConflictJournalEntry[]) => {
      journalStore.entries = e
    },
    clearJournal: async () => {
      journalStore.entries = null
    }
  }
  it('异常：opt-in 关闭 ⇒ disabled', async () => {
    const result = await runNetworkConflict({ ...baseDeps, action: 'inspect', enabled: false })
    expect(result.status).toBe('disabled')
  })
  it('正常：inspect 列出冲突规则', async () => {
    const result = await runNetworkConflict({ ...baseDeps, action: 'inspect', enabled: true })
    expect(result.status).toBe('ok')
    expect(result.conflicts?.[0].name).toBe('b1')
    expect(result.canRestore).toBe(false)
  })
  it('正常：repair 写 journal 并修复 ⇒ repaired + canRestore', async () => {
    journalStore.entries = null
    const result = await runNetworkConflict({ ...baseDeps, action: 'repair', enabled: true })
    expect(result.status).toBe('repaired')
    expect(result.changed).toBe(1)
    expect(result.canRestore).toBe(true)
    expect(journalStore.entries?.[0].name).toBe('b1')
  })
  it('正常：restore 还原并清档 ⇒ restored', async () => {
    journalStore.entries = [{ name: 'b1', enabled: true, profile: 'Private' }]
    const result = await runNetworkConflict({ ...baseDeps, action: 'restore', enabled: true })
    expect(result.status).toBe('restored')
    expect(journalStore.entries).toBeNull()
  })
  it('边界：无 journal restore ⇒ nothing-to-restore', async () => {
    journalStore.entries = null
    const result = await runNetworkConflict({ ...baseDeps, action: 'restore', enabled: true })
    expect(result.status).toBe('nothing-to-restore')
  })
  it('边界：无冲突 repair ⇒ ok changed 0', async () => {
    const result = await runNetworkConflict({
      ...baseDeps,
      action: 'repair',
      enabled: true,
      execFile: okExec('[]')
    })
    expect(result.status).toBe('ok')
    expect(result.changed).toBe(0)
  })
  it('异常：枚举失败 ⇒ failed', async () => {
    const result = await runNetworkConflict({
      ...baseDeps,
      action: 'inspect',
      enabled: true,
      execFile: failExec('boom')
    })
    expect(result.status).toBe('failed')
  })
})

describe('hotspot 纯函数与控制', () => {
  it('脚本加载 WinRT 类型并按动作选择操作', () => {
    expect(buildHotspotScript('start')).toContain('StartTetheringAsync')
    expect(buildHotspotScript('stop')).toContain('StopTetheringAsync')
    expect(buildHotspotScript('status')).not.toContain('TetheringAsync()')
    expect(buildHotspotScript('start')).toContain('NetworkOperatorTetheringManager')
  })
  it('parseHotspotOutput：正常/畸形', () => {
    expect(parseHotspotOutput('{"active":true,"ssid":"S","password":"P"}')).toEqual({
      active: true,
      ssid: 'S',
      password: 'P'
    })
    expect(parseHotspotOutput('bad')).toEqual({ active: false })
    expect(parseHotspotOutput('')).toEqual({ active: false })
  })
  it('nextHotspotState：不关外来热点', () => {
    expect(nextHotspotState({ startedHere: false, active: true }, false)).toEqual({
      startedHere: false,
      active: true
    })
  })
  const stateStore = { state: { startedHere: false, active: false } }
  const hotspotDeps = {
    execFile: okExec('{"active":true,"ssid":"S","password":"P"}'),
    readState: async () => stateStore.state,
    writeState: async (s: { startedHere: boolean; active: boolean }) => {
      stateStore.state = s
    }
  }
  it('异常：opt-in 关闭 ⇒ disabled', async () => {
    const result = await controlHotspot({ ...hotspotDeps, action: 'start', enabled: false })
    expect(result.status).toBe('disabled')
  })
  it('正常：start ⇒ started + ssid/password + startedHere', async () => {
    stateStore.state = { startedHere: false, active: false }
    const result = await controlHotspot({ ...hotspotDeps, action: 'start', enabled: true })
    expect(result.status).toBe('started')
    expect(result.ssid).toBe('S')
    expect(result.password).toBe('P')
    expect(result.state.startedHere).toBe(true)
  })
  it('边界：stop 外来热点 ⇒ unchanged 不写状态', async () => {
    stateStore.state = { startedHere: false, active: true }
    const result = await controlHotspot({ ...hotspotDeps, action: 'stop', enabled: true })
    expect(result.status).toBe('unchanged')
    expect(stateStore.state.startedHere).toBe(false)
  })
  it('正常：stop 自开热点 ⇒ stopped', async () => {
    stateStore.state = { startedHere: true, active: true }
    const result = await controlHotspot({ ...hotspotDeps, action: 'stop', enabled: true })
    expect(result.status).toBe('stopped')
    expect(result.state.active).toBe(false)
  })
  it('异常：命令失败 ⇒ failed', async () => {
    const result = await controlHotspot({
      ...hotspotDeps,
      action: 'start',
      enabled: true,
      execFile: failExec('boom')
    })
    expect(result.status).toBe('failed')
  })
})

// ===== 审查修复轮（2026-11-19）：M2/M3/M4/M6/M7/M9/M10 红灯 =====

const decodeScript = (args: string[]): string =>
  Buffer.from(args[args.length - 1], 'base64').toString('utf16le')

describe('审查修复 M2：热点归属门先于脚本执行 + 持久化 fail-closed', () => {
  it('stop 外来热点 ⇒ unchanged 且零脚本执行（不得先关再查归属）', async () => {
    const execFile = vi.fn(async () => ({ stdout: '{"active":true}' }))
    const writeState = vi.fn(async () => {})
    const result = await controlHotspot({
      action: 'stop',
      enabled: true,
      execFile,
      readState: async () => ({ startedHere: false, active: true }),
      writeState
    })
    expect(result.status).toBe('unchanged')
    expect(execFile).not.toHaveBeenCalled()
    expect(writeState).not.toHaveBeenCalled()
  })
  it('start 后 writeState 失败 ⇒ failed 带 reason（不假报 started）', async () => {
    const result = await controlHotspot({
      action: 'start',
      enabled: true,
      execFile: okExec('{"active":true,"ssid":"S","password":"P"}'),
      readState: async () => ({ startedHere: false, active: false }),
      writeState: async () => {
        throw new Error('disk full')
      }
    })
    expect(result.status).toBe('failed')
    expect(result.reason).toBeTruthy()
  })
  it('stop 自开热点但 writeState 失败 ⇒ failed（可重试，不假报 stopped）', async () => {
    const result = await controlHotspot({
      action: 'stop',
      enabled: true,
      execFile: okExec('{"active":false}'),
      readState: async () => ({ startedHere: true, active: true }),
      writeState: async () => {
        throw new Error('disk full')
      }
    })
    expect(result.status).toBe('failed')
    expect(result.reason).toBeTruthy()
  })
  it('legacy toggleHotspot：外来热点 stop ⇒ unchanged 零脚本执行', async () => {
    const execFile = vi.fn(async () => {})
    const result = await toggleHotspot({
      enabled: true,
      current: { startedHere: false, active: true },
      requested: false,
      execFile
    })
    expect(result.status).toBe('unchanged')
    expect(execFile).not.toHaveBeenCalled()
  })
  it('legacy toggleHotspot：已在跑的自开热点再 start ⇒ unchanged 零脚本执行', async () => {
    const execFile = vi.fn(async () => {})
    const result = await toggleHotspot({
      enabled: true,
      current: { startedHere: true, active: true },
      requested: true,
      execFile
    })
    expect(result.status).toBe('unchanged')
    expect(execFile).not.toHaveBeenCalled()
  })
})

describe('审查修复 M3/M6：提权内层退出码透出 + 外层 UTF8 编码', () => {
  it('buildElevatedArgs 外层含 -PassThru / ExitCode 检查 / OutputEncoding UTF8', () => {
    const script = decodeScript(buildElevatedArgs('Write-Output 1'))
    expect(script).toContain('-PassThru')
    expect(script).toContain('ExitCode')
    expect(script).toContain('[Console]::OutputEncoding')
  })
  it('isElevationDeclined 识别 ERROR_CANCELLED 数字码 1223', () => {
    expect(isElevationDeclined(new Error('powershell exited with code 1223'))).toBe(true)
  })
  it('restore 命令失败 ⇒ clearJournal 零调用（恢复基线保住）', async () => {
    const clearJournal = vi.fn(async () => {})
    const result = await runNetworkConflict({
      action: 'restore',
      port: 28080,
      enabled: true,
      isAdmin: true,
      execFile: failExec('boom'),
      readJournal: async () => [{ name: 'b1', enabled: true, profile: 'Private' }],
      writeJournal: vi.fn(async () => {}),
      clearJournal
    })
    expect(result.status).toBe('failed')
    expect(clearJournal).not.toHaveBeenCalled()
  })
})

describe('审查修复 M4/M7/M9/M10：修复方向 / journal 基线 / 注入门 / 端口口径', () => {
  const rule = (over: Partial<FirewallRule>): FirewallRule => ({
    name: 'r',
    enabled: true,
    profile: 'Any',
    action: 'Block',
    direction: 'Inbound',
    localPorts: '28080',
    ...over
  })
  it('planRepair：启用的 Block ⇒ enabled:false；禁用的 Allow ⇒ enabled:true', () => {
    const plan = planRepair(
      [rule({ name: 'b' }), rule({ name: 'a', action: 'Allow', enabled: false })],
      28080
    )
    expect(plan.find((p) => p.name === 'b')?.changes.enabled).toBe(false)
    expect(plan.find((p) => p.name === 'a')?.changes.enabled).toBe(true)
  })
  it('matchesPort 识别 Any（全端口规则不再漏检）', () => {
    expect(matchesPort(rule({ localPorts: 'Any' }), 28080)).toBe(true)
  })
  it('二次 repair：journal 合并首见优先，原始基线不被当前状态覆写', async () => {
    const written: ConflictJournalEntry[][] = []
    const rules = JSON.stringify([
      rule({ name: 'b1', enabled: false, profile: 'Private,Public' }),
      rule({ name: 'b2', profile: 'Private' })
    ])
    const result = await runNetworkConflict({
      action: 'repair',
      port: 28080,
      enabled: true,
      isAdmin: true,
      execFile: okExec(rules),
      readJournal: async () => [{ name: 'b1', enabled: true, profile: 'Private' }],
      writeJournal: async (e) => {
        written.push(e)
      },
      clearJournal: async () => {}
    })
    expect(result.status).toBe('repaired')
    expect(written[0]).toEqual(
      expect.arrayContaining([
        { name: 'b1', enabled: true, profile: 'Private' },
        { name: 'b2', enabled: true, profile: 'Private' }
      ])
    )
  })
  it('writeJournal 失败 ⇒ failed 且 apply 零执行（fail-closed）', async () => {
    const execFile = vi.fn(async () => ({ stdout: JSON.stringify([rule({ name: 'b1' })]) }))
    const result = await runNetworkConflict({
      action: 'repair',
      port: 28080,
      enabled: true,
      isAdmin: true,
      execFile,
      readJournal: async () => null,
      writeJournal: async () => {
        throw new Error('disk full')
      },
      clearJournal: async () => {}
    })
    expect(result.status).toBe('failed')
    expect(execFile).toHaveBeenCalledTimes(1) // 仅枚举，无 apply
  })
  it('port=0（runtime 缺席）⇒ failed 而非假 ok', async () => {
    const result = await runNetworkConflict({
      action: 'inspect',
      port: 0,
      enabled: true,
      isAdmin: true,
      execFile: okExec('[]'),
      readJournal: async () => null,
      writeJournal: async () => {},
      clearJournal: async () => {}
    })
    expect(result.status).toBe('failed')
    expect(result.reason).toBeTruthy()
  })
  it('runRepair 编码的是 PowerShell 脚本而非 JSON', async () => {
    const execFile = vi.fn(async () => {})
    await runRepair({ enabled: true, rules: [rule({ name: 'b1' })], port: 28080, execFile })
    expect(decodeScript(execFile.mock.calls[0][1] as string[])).toContain('Set-NetFirewallRule')
  })
  it('buildApplyScript 拒绝非法 profile（注入门）', () => {
    expect(() =>
      buildApplyScript([
        { name: 'x', changes: { enabled: true, profile: 'Any; Start-Process evil' } }
      ])
    ).toThrow()
  })
  it('parseConflictJournal：合法条目透传；形状/白名单非法 ⇒ null 整体拒绝', () => {
    expect(parseConflictJournal([{ name: 'x', enabled: true, profile: 'Any' }])).toEqual([
      { name: 'x', enabled: true, profile: 'Any' }
    ])
    expect(parseConflictJournal([{ name: 123, enabled: true, profile: 'Any' }])).toBeNull()
    expect(parseConflictJournal([{ name: 'x', enabled: 'yes', profile: 'Any' }])).toBeNull()
    expect(
      parseConflictJournal([{ name: 'x', enabled: true, profile: 'Any; Start-Process evil' }])
    ).toBeNull()
    expect(parseConflictJournal('nope')).toBeNull()
    expect(parseConflictJournal([])).toEqual([])
  })
})
