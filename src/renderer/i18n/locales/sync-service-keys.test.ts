// @vitest-environment node
/**
 * 同步服务二级子页（`sync-service`）语言包守卫。
 *
 * 背景教训见同目录 `sync-gallery-keys.test.ts` 头注释：key 曾在 12 个语言包整体缺失，
 * 侧边栏直接渲染出原始 key 文本。本文件把同类回归前移成守卫。
 *
 * 覆盖四件事，缺一不可：
 *  ① 新命名空间 `syncService.*` 在 12 包齐备、非空、与 zh-CN 同构；
 *  ② **键集 == 页面实际消费的键集（等集）**——多一个键就判红，机制性拒绝死键
 *    （`status.connections` 就是这么被清掉的：上游无公开连接计数，渲染层早就不展示了）；
 *  ③ **旧键必须不存在**（反向锁）：`i18n:guard` 只做「其他包不得缺 zh-CN 的键」的单向检查，
 *    抓不到「某个包把旧键留在原地」，这是本迁移最大的假绿通道；
 *  ④ 语义不变式平移：披露文案仍点名第三方主机与下发后果、插值占位仍在、
 *    四处「同步服务」文案互相一致。
 */
import { describe, expect, it } from 'vitest'
import zhCN from './zh-CN.json'
import zhTW from './zh-TW.json'
import en from './en.json'
import ja from './ja.json'
import ko from './ko.json'
import fr from './fr.json'
import de from './de.json'
import es from './es.json'
import pt from './pt.json'
import ru from './ru.json'
import th from './th.json'
import vi from './vi.json'

type LocaleNode = Record<string, unknown>

export const LOCALES: Record<string, LocaleNode> = {
  'zh-CN': zhCN as LocaleNode,
  'zh-TW': zhTW as LocaleNode,
  en: en as LocaleNode,
  ja: ja as LocaleNode,
  ko: ko as LocaleNode,
  fr: fr as LocaleNode,
  de: de as LocaleNode,
  es: es as LocaleNode,
  pt: pt as LocaleNode,
  ru: ru as LocaleNode,
  th: th as LocaleNode,
  vi: vi as LocaleNode
}

export function readPath(node: LocaleNode | undefined, dottedKey: string): unknown {
  let cur: unknown = node
  for (const seg of dottedKey.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as LocaleNode)[seg]
  }
  return cur
}

/** 递归收集叶子键路径，用于比对 12 包的子树是否同构。 */
export function leafKeys(node: unknown, prefix = ''): string[] {
  if (!node || typeof node !== 'object') return [prefix]
  return Object.entries(node as LocaleNode).flatMap(([key, value]) =>
    leafKeys(value, prefix ? `${prefix}.${key}` : key)
  )
}

/**
 * `syncService` 子树的全部叶子（38 个）。
 * 与 `SyncServicePage.tsx` / `PairingQrDialog.tsx` 的 `t()` 调用点一一对应，
 * 两侧任何一边增删而未同步另一边，等集断言即红。
 */
const SYNC_SERVICE_LEAVES = [
  'page.title',
  'service.title',
  'service.description',
  'enable',
  'enableDesc',
  'gallerySource',
  'gallerySourceDesc',
  'gallerySourceApplied',
  'status.label',
  'status.running',
  'status.stopped',
  'status.unavailable',
  'status.address',
  'status.serverId',
  'status.tlsFingerprint',
  'status.copied',
  'pairing.title',
  'pairing.open',
  'pairing.hintRunning',
  'pairing.hintDisabled',
  'pairing.expiresIn',
  'pairing.refresh',
  'pairing.copyContent',
  'pairing.loadFailed',
  'pairing.retry',
  // K5：多 host 配对的备选地址清单标题
  'pairing.altHosts',
  'devices.title',
  'devices.empty',
  'devices.emptyHint',
  'devices.lastSeen',
  'devices.never',
  'devices.revoke',
  'devices.revokeConfirmTitle',
  'devices.revokeConfirmMessage',
  'devices.revokeConfirm',
  'devices.revoked',
  'metadata.enable',
  'metadata.enableDesc',
  'metadata.disclosure',
  // K1：启动阶段观测（SyncServicePage 状态卡的阶段行）
  'startupStages.label',
  'startupStages.stage.scanner',
  'startupStages.stage.runtimeReady',
  'startupStages.stage.lanListen',
  'startupStages.stage.cachedMetadata',
  // K2：在线解析同意块（解析开启时显示）
  'consent.title',
  'consent.endpoint',
  'consent.policyVersion',
  'consent.fields',
  'consent.enable',
  'consent.enableDesc',
  'consent.revokeNote',
  // K4：连接诊断折叠卡（观测面）
  'diagnostics.title',
  'diagnostics.bindAddress',
  'diagnostics.port',
  'diagnostics.secure',
  'diagnostics.secureOn',
  'diagnostics.secureOff',
  'diagnostics.tlsTail',
  'diagnostics.devices',
  'diagnostics.altHosts',
  // K7：上次扫描计数行（并入诊断卡；runtime-status 响应体可选段）
  'diagnostics.lastScan',
  'diagnostics.lastScanObserved',
  'diagnostics.lastScanAccepted',
  'diagnostics.lastScanIgnored',
  'diagnostics.lastScanCreated',
  'diagnostics.lastScanUpdated',
  'diagnostics.lastScanDeleted',
  'diagnostics.lastScanErrors',
  'diagnostics.lastError',
  // K6：额外照片目录节（仅作用同步库扫描器）
  'extraDirectories.title',
  'extraDirectories.scopeNote',
  'extraDirectories.empty',
  'extraDirectories.emptyHint',
  'extraDirectories.add',
  'extraDirectories.remove',
  'extraDirectories.confirmAdd',
  'extraDirectories.cancelAdd',
  'extraDirectories.rescan',
  'extraDirectories.proposalSummary',
  // K8：整理队列（批量删除，破坏性能力）
  'organizer.title',
  'organizer.toggle',
  'organizer.toggleDesc',
  'organizer.empty',
  'organizer.emptyHint',
  'organizer.unavailable',
  'organizer.unavailableHint',
  'organizer.state.preparing',
  'organizer.state.pending',
  'organizer.state.confirming',
  'organizer.state.queued',
  'organizer.state.checking',
  'organizer.state.executing',
  'organizer.state.recycled',
  'organizer.state.failed',
  'organizer.state.changed',
  'organizer.state.cancelled',
  'organizer.state.rejected',
  'organizer.filesCount',
  'organizer.online',
  'organizer.offline',
  'organizer.approve',
  'organizer.reject',
  'organizer.approveAll',
  'organizer.confirmTitle',
  'organizer.confirmBody',
  'organizer.confirmAction',
  'organizer.cancel'
]

/** 页面、状态栏与板块入口实际消费的全部键（漏加即此测试红，避免运行期渲染原始 key）。 */
const REQUIRED_KEYS = [
  ...SYNC_SERVICE_LEAVES.map((k) => `syncService.${k}`),
  'appShell.viewStatus.syncService',
  // 同步图库工具栏上的入口按钮名，与本页标题同源同值
  'syncGallery.toolbar.service'
]

describe('同步服务语言包完整性', () => {
  it('12 个语言包都定义了全部必需键且为非空字符串', () => {
    for (const [code, locale] of Object.entries(LOCALES)) {
      for (const key of REQUIRED_KEYS) {
        const value = readPath(locale, key)
        expect(value, `${code}.json 缺失 ${key}`).toBeDefined()
        expect(value, `${code}.json ${key} 应为字符串`).toBeTypeOf('string')
        expect((value as string).trim(), `${code}.json ${key} 不应为空`).not.toHaveLength(0)
      }
    }
  })

  it('12 个语言包的 syncService 子树键集与 zh-CN 完全同构（防漏键漂移）', () => {
    const baseline = leafKeys(LOCALES['zh-CN'].syncService).sort()
    for (const [code, locale] of Object.entries(LOCALES)) {
      expect(
        leafKeys(locale.syncService).sort(),
        `${code}.json syncService 键集与 zh-CN 不一致`
      ).toEqual(baseline)
    }
  })

  it('syncService 子树恰好等于页面消费的键集：多一个键就是死键，少一个键就是漏键', () => {
    for (const [code, locale] of Object.entries(LOCALES)) {
      expect(
        leafKeys(locale.syncService).sort(),
        `${code}.json syncService 键集与消费键集不等（残留死键或缺键）`
      ).toEqual([...SYNC_SERVICE_LEAVES].sort())
    }
  })

  it('旧命名空间已从 12 个语言包彻底移除（i18n:guard 只做单向 missing，抓不到 extra 残留）', () => {
    for (const [code, locale] of Object.entries(LOCALES)) {
      expect(readPath(locale, 'settings.sync'), `${code}.json 仍残留 settings.sync`).toBeUndefined()
      expect(
        readPath(locale, 'settings.groups.sync'),
        `${code}.json 仍残留 settings.groups.sync`
      ).toBeUndefined()
      expect(
        readPath(locale, 'settings.sections.syncService'),
        `${code}.json 仍残留 settings.sections.syncService`
      ).toBeUndefined()
      // settings 子树里不得再有任何以 sync 开头的叶子（兜住上面三条没枚举到的漏网键）
      const stray = leafKeys(locale.settings).filter((k) => k === 'sync' || k.startsWith('sync.'))
      expect(stray, `${code}.json settings 下残留 sync 键：${stray.join(', ')}`).toEqual([])
    }
  })

  it('页标题 / 状态栏 / 板块入口 / 段①卡片标题四处「同步服务」文案互相一致（值全部搬自旧键，零新译）', () => {
    for (const [code, locale] of Object.entries(LOCALES)) {
      const page = readPath(locale, 'syncService.page.title')
      expect(readPath(locale, 'appShell.viewStatus.syncService'), `${code}.json 状态栏不一致`).toBe(
        page
      )
      expect(readPath(locale, 'syncGallery.toolbar.service'), `${code}.json 工具栏入口不一致`).toBe(
        page
      )
      expect(readPath(locale, 'syncService.service.title'), `${code}.json 段①标题不一致`).toBe(page)
    }
  })

  it('zh-CN 二级页标题为「同步服务」', () => {
    expect(readPath(LOCALES['zh-CN'], 'syncService.page.title')).toBe('同步服务')
  })

  it('被组件测试按中文文本定位的关键值未漂移（改名不改值的硬证据）', () => {
    const zh = LOCALES['zh-CN']
    expect(readPath(zh, 'syncService.status.running')).toBe('运行中')
    expect(readPath(zh, 'syncService.status.unavailable')).toBe('同步组件未就绪')
    expect(readPath(zh, 'syncService.pairing.open')).toBe('配对新设备')
    expect(readPath(zh, 'syncService.devices.title')).toBe('已配对设备')
    expect(readPath(zh, 'syncService.devices.empty')).toBe('暂无已配对设备')
    expect(readPath(zh, 'syncService.devices.revoke')).toBe('撤销')
    expect(readPath(zh, 'syncService.devices.revokeConfirm')).toBe('撤销设备')
    expect(readPath(zh, 'syncService.enable')).toBe('启用同步服务')
    expect(readPath(zh, 'syncService.gallerySource')).toBe('图库数据源使用 NikkiSync 资产库')
    expect(readPath(zh, 'syncService.metadata.enable')).toBe('解析穿搭与拍摄参数')
  })

  it('插值占位随键搬运到位（丢了就是运行期把 {{source}} 当字面量渲染）', () => {
    for (const [code, locale] of Object.entries(LOCALES)) {
      expect(
        String(readPath(locale, 'syncService.gallerySourceApplied')),
        `${code}.json gallerySourceApplied 丢了 {{source}}`
      ).toContain('{{source}}')
      expect(
        String(readPath(locale, 'syncService.devices.revokeConfirmMessage')),
        `${code}.json revokeConfirmMessage 丢了 {{name}}`
      ).toContain('{{name}}')
    }
  })
})

/**
 * 元数据解析开关的披露文案完整性（阶段 6 的验收项，随命名空间改名一并平移到这里）。
 *
 * 这个开关一旦打开就向第三方端点发出站请求（携带 UID 与照片内嵌参数信封），
 * 因此「每个语言包都必须把这件事说清楚」是验收项，不是可选项——
 * 漏一个语言包就等于对那一半用户在未经充分披露的情况下开启了外网请求。
 */
describe('元数据解析开关的披露文案', () => {
  it('披露文案必须点名实际端点主机（与 metadata-resolver-driver 的常量同主机）', () => {
    // 这里刻意写主机字面量而不是 import 主进程常量：渲染层不得依赖 `src/main/**`，
    // 跨边界的共享位是 `src/shared/**`。同一主机由两侧各一条断言钉住：
    // `metadata-resolver-driver.test.ts` 断言 NUAN5_METADATA_ENDPOINT 以 https://nuan5.pro 开头，
    // 任一侧改动即有一处先红。
    for (const [code, locale] of Object.entries(LOCALES)) {
      expect(
        readPath(locale, 'syncService.metadata.disclosure'),
        `${code}.json disclosure 未点名出站端点主机`
      ).toContain('nuan5.pro')
    }
  })

  it('披露文案必须交代「随局域网同步下发给已配对设备」这一后果', () => {
    // 上游 publicMetadata() 只剥两把原始信封字段，第三方解码结果原样进局域网响应体；
    // 不说清这一条的披露是不完整的
    const zh = String(readPath(LOCALES['zh-CN'], 'syncService.metadata.disclosure'))
    expect(zh).toMatch(/配对|已配对/)
    expect(zh).toMatch(/局域网|本地网络/)
  })
})
