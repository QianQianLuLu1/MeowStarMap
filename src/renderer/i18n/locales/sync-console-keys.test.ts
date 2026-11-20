// @vitest-environment node
/**
 * 同步控制台（`sync-gallery/console/`）语言包守卫。
 *
 * 与同目录 `sync-service-keys.test.ts` 同一套路：`syncConsole.*` 曾在 12 个语言包整体缺失，
 * 控制台会直接渲染出原始 key 文本。本文件把回归前移成守卫，覆盖四件事：
 *  ① `syncConsole.*` 在 12 包齐备、非空、与 zh-CN 同构；
 *  ② **键集 == 控制台实际消费的键集（等集）**——多一个键就判红，机制性拒绝死键；
 *    动态键（`settings.network.status.*` / `settings.hotspot.status.*`）按共享枚举闭集展开；
 *  ③ 旧命名空间 `syncService.*` / `syncGallery.*` 必须原样保留（本次收尾不得顺手清理旧键）；
 *  ④ 语义不变式：插值占位（{{count}}/{{path}}/{{approved}}/{{skipped}}）12 包齐备、
 *    测试钉住的中文文案不漂移、易撞名的按钮/状态文案互不重复（jsdom 不隐藏折叠内容，
 *    getByRole/getByText 依赖全页唯一性）。
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

const LOCALES: Record<string, LocaleNode> = {
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

function readPath(node: LocaleNode | undefined, dottedKey: string): unknown {
  let cur: unknown = node
  for (const seg of dottedKey.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as LocaleNode)[seg]
  }
  return cur
}

/** 递归收集叶子键路径，用于比对 12 包的子树是否同构。 */
function leafKeys(node: unknown, prefix = ''): string[] {
  if (!node || typeof node !== 'object') return [prefix]
  return Object.entries(node as LocaleNode).flatMap(([key, value]) =>
    leafKeys(value, prefix ? `${prefix}.${key}` : key)
  )
}

/**
 * `syncConsole` 子树的全部叶子（192 个）。
 * 与控制台各视图/卡片的 `t('syncConsole.…')` 调用点一一对应：
 *  - nav/heading ← console-views.ts（CONSOLE_NAV_KEYS / CONSOLE_HEADING_KEYS）
 *  - connect.* ← ConnectView / SelfCheckCard
 *  - settings.* ← SettingsView / NetworkPermissionCard / HotspotCard
 *    （status.* 为 networkAuth / networkConflict / hotspotControl 返回枚举的闭集展开）
 *  - organizer.* ← OrganizerView；about.* ← AboutView；statusBar.* ← SyncStatusBar
 * 两侧任何一边增删而未同步另一边，等集断言即红。
 */
const SYNC_CONSOLE_LEAVES = [
  'nav.connect',
  'nav.settings',
  'nav.organizer',
  'nav.inspiration',
  'nav.about',
  'heading.connect.title',
  'heading.connect.subtitle',
  'heading.settings.title',
  'heading.settings.subtitle',
  'heading.organizer.title',
  'heading.organizer.subtitle',
  'heading.inspiration.title',
  'heading.inspiration.subtitle',
  'heading.inspiration.cardTitle',
  'heading.inspiration.cardDescription',
  'heading.about.title',
  'heading.about.subtitle',
  'connect.stats.label',
  'connect.stats.assetsUnit',
  'connect.stats.devicesUnit',
  'connect.stats.caption',
  'connect.stats.unavailable',
  'shell.brandName',
  'shell.brandLatin',
  'shell.brandAlt',
  'shell.navAria',
  'shell.footerCompat',
  'shell.footerDisclaimer',
  'status.running',
  'status.stopped',
  'status.unavailable',
  'connect.section.title',
  'connect.section.networkHint',
  'connect.firstRun.hint',
  'connect.android.title',
  'connect.android.description',
  'connect.android.stepInstall',
  'connect.android.stepPair',
  'connect.android.stepBrowse',
  'connect.wechat.title',
  'connect.wechat.description',
  'connect.wechat.entrySummary',
  'connect.wechat.entryAlt',
  'connect.wechat.entryHint',
  'connect.wechat.platforms',
  'connect.wechat.step1',
  'connect.wechat.step2',
  'connect.wechat.step3',
  'connect.wechat.note',
  'connect.android.paired',
  'connect.android.pairedHint',
  'connect.android.newQrNote',
  'connect.android.newQr',
  'connect.android.download',
  'connect.android.export',
  'connect.android.exportNote',
  'connect.guide.title',
  'connect.guide.summary',
  'connect.guide.step1Title',
  'connect.guide.step1Body',
  'connect.guide.step2Title',
  'connect.guide.step2Body',
  'connect.guide.step3Title',
  'connect.guide.step3Body',
  'connect.guide.quark',
  'connect.guide.baidu',
  'connect.guide.openNetwork',
  'connect.guide.openScan',
  'connect.privacyNote',
  'connect.selfCheck.title',
  'connect.selfCheck.connectionTitle',
  'connect.selfCheck.serviceLabel',
  'connect.selfCheck.serviceUnavailable',
  'connect.selfCheck.serviceOnline',
  'connect.selfCheck.serviceOffline',
  'connect.selfCheck.connectionStep1',
  'connect.selfCheck.connectionStep2',
  'connect.selfCheck.connectionStep3',
  'connect.selfCheck.openNetwork',
  'connect.selfCheck.metadataTitle',
  'connect.selfCheck.metadataStep1',
  'connect.selfCheck.metadataStep2',
  'connect.selfCheck.metadataStep3',
  'connect.selfCheck.openScan',
  'settings.connection.title',
  'settings.connection.address',
  'settings.connection.addressUnknown',
  'settings.static.albumUpdate',
  'settings.static.albumUpdateValue',
  'settings.static.tray',
  'settings.static.trayValue',
  'settings.startup.title',
  'settings.startup.launchAtLogin',
  'settings.startup.launchAtLoginDesc',
  'settings.legal.title',
  'settings.legal.privacy',
  'settings.legal.terms',
  'settings.legal.services',
  'settings.legal.unavailable',
  'settings.network.title',
  'settings.network.description',
  'settings.network.disabled',
  'settings.network.enableJump',
  'settings.network.unavailable',
  'settings.network.authorize',
  'settings.network.revoke',
  'settings.network.note',
  'settings.network.conflictTitle',
  'settings.network.conflictDesc',
  'settings.network.inspect',
  'settings.network.repair',
  'settings.network.restore',
  'settings.network.conflictsFound',
  'settings.network.noConflicts',
  'settings.network.conflictNote',
  'settings.network.status.authorized',
  'settings.network.status.revoked',
  'settings.network.status.present',
  'settings.network.status.absent',
  'settings.network.status.disabled',
  'settings.network.status.elevation-declined',
  'settings.network.status.failed',
  'settings.network.status.ok',
  'settings.network.status.repaired',
  'settings.network.status.restored',
  'settings.network.status.nothing-to-restore',
  'settings.hotspot.title',
  'settings.hotspot.description',
  'settings.hotspot.disabled',
  'settings.hotspot.unavailable',
  'settings.hotspot.start',
  'settings.hotspot.stop',
  'settings.hotspot.openSettings',
  'settings.hotspot.ssid',
  'settings.hotspot.password',
  'settings.hotspot.hide',
  'settings.hotspot.reveal',
  'settings.hotspot.note',
  'settings.hotspot.status.started',
  'settings.hotspot.status.stopped',
  'settings.hotspot.status.unchanged',
  'settings.hotspot.status.disabled',
  'settings.hotspot.status.failed',
  'organizer.batchResult',
  'organizer.openRecycleBin',
  'organizer.batchFailed',
  'about.version.title',
  'about.version.tagline',
  'about.version.host',
  'about.version.aligned',
  'about.version.commit',
  'about.version.author',
  'about.version.attribution',
  'about.download.title',
  'about.download.networkHint',
  'about.download.cnb',
  'about.download.cnbNote',
  'about.download.quark',
  'about.download.quarkNote',
  'about.download.baidu',
  'about.download.baiduNote',
  'about.download.github',
  'about.download.githubNote',
  'about.update.unavailable',
  'about.update.started',
  'about.update.check',
  'about.update.note',
  'about.feedback.title',
  'about.feedback.exportNote',
  'about.feedback.support',
  'about.feedback.supportNote',
  'about.repos.title',
  'about.repos.momo',
  'about.repos.nuannuanStudio',
  'about.repos.nikkiAlbums',
  'about.repos.meowStarMap',
  'about.repos.nuan5',
  'about.repos.gongeo',
  'about.repos.nikkiAlbumsNote',
  'about.repos.meowStarMapNote',
  'about.repos.nuan5Note',
  'about.repos.gongeoNote',
  'statusBar.unavailable',
  'statusBar.restartSuccess',
  'statusBar.restartFailed',
  'statusBar.version',
  'statusBar.aligned',
  'statusBar.restart',
  'statusBar.export',
  'statusBar.exported',
  'statusBar.exportFailed',
  'statusBar.recoveryHint'
]

/** 动态状态键的闭集（与 shared 枚举一致，未知码走 defaultValue 兜底不新增键）。 */
const NETWORK_STATUS_CODES = [
  'authorized',
  'revoked',
  'present',
  'absent',
  'disabled',
  'elevation-declined',
  'failed',
  'ok',
  'repaired',
  'restored',
  'nothing-to-restore'
]
const HOTSPOT_STATUS_CODES = ['started', 'stopped', 'unchanged', 'disabled', 'failed']

describe('syncConsole 语言包守卫（12 locale）', () => {
  it('① 12 包 syncConsole 子树齐备、非空、与 zh-CN 同构', () => {
    const baseline = leafKeys(readPath(LOCALES['zh-CN'], 'syncConsole')).sort()
    expect(baseline.length).toBeGreaterThan(0)
    for (const [code, node] of Object.entries(LOCALES)) {
      const subtree = readPath(node, 'syncConsole')
      expect(subtree, `${code} 缺少 syncConsole 命名空间`).toBeTypeOf('object')
      expect(leafKeys(subtree).sort(), `${code} 子树与 zh-CN 不同构`).toEqual(baseline)
      for (const leaf of baseline) {
        const value = readPath(node, `syncConsole.${leaf}`)
        expect(typeof value, `${code}:${leaf} 应为字符串`).toBe('string')
        expect((value as string).trim().length, `${code}:${leaf} 不得为空串`).toBeGreaterThan(0)
      }
    }
  })

  it('② 键集 == 控制台实际消费键集（等集，拒绝死键与漏键）', () => {
    const actual = leafKeys(readPath(LOCALES['zh-CN'], 'syncConsole')).sort()
    expect(actual).toEqual([...SYNC_CONSOLE_LEAVES].sort())
  })

  it('②b 动态状态键覆盖共享枚举闭集', () => {
    for (const code of NETWORK_STATUS_CODES) {
      expect(SYNC_CONSOLE_LEAVES).toContain(`settings.network.status.${code}`)
    }
    for (const code of HOTSPOT_STATUS_CODES) {
      expect(SYNC_CONSOLE_LEAVES).toContain(`settings.hotspot.status.${code}`)
    }
  })

  it('③ 旧命名空间 syncService / syncGallery 在 12 包原样保留', () => {
    for (const [code, node] of Object.entries(LOCALES)) {
      expect(readPath(node, 'syncService'), `${code} 不得丢失 syncService`).toBeTypeOf('object')
      expect(readPath(node, 'syncGallery'), `${code} 不得丢失 syncGallery`).toBeTypeOf('object')
    }
    // 旧键抽样钉住：迁移不得改动既有值
    expect(readPath(LOCALES['zh-CN'], 'syncService.enable')).toBe('启用同步服务')
  })

  it('④ 插值占位 12 包齐备（{{count}}/{{path}}/{{approved}}/{{skipped}}）', () => {
    const expectations: Array<[string, string[]]> = [
      ['settings.network.conflictsFound', ['{{count}}']],
      ['organizer.batchResult', ['{{approved}}', '{{skipped}}']],
      ['statusBar.exported', ['{{path}}']]
    ]
    for (const [code, node] of Object.entries(LOCALES)) {
      for (const [leaf, placeholders] of expectations) {
        const value = readPath(node, `syncConsole.${leaf}`) as string
        for (const ph of placeholders) {
          expect(value, `${code}:${leaf} 缺少占位 ${ph}`).toContain(ph)
        }
      }
    }
  })

  it('④b 测试钉住的 zh-CN 文案不漂移', () => {
    const pinned: Array<[string, string]> = [
      ['nav.connect', '手机连接'],
      ['nav.settings', '同步设置'],
      ['nav.organizer', '最近删除'],
      ['nav.inspiration', '灵感库'],
      ['nav.about', '关于'],
      ['connect.android.title', 'Android App'],
      ['connect.android.newQr', '生成新二维码'],
      ['connect.android.download', '下载 Android APK'],
      ['connect.android.export', '导出诊断包'],
      ['connect.guide.title', '首次使用引导'],
      ['connect.guide.quark', '夸克网盘下载'],
      ['connect.guide.baidu', '百度网盘下载'],
      ['connect.selfCheck.title', '连接自查'],
      ['connect.selfCheck.connectionTitle', '手机连不上？'],
      ['connect.selfCheck.metadataTitle', '照片参数读取不到？'],
      ['settings.legal.privacy', '隐私政策'],
      ['settings.legal.terms', '用户协议'],
      ['settings.legal.services', '服务条款'],
      ['settings.network.authorize', '允许手机连接'],
      ['settings.network.revoke', '撤销当前服务的网络授权'],
      ['settings.network.inspect', '重新检查'],
      ['settings.network.repair', '一键检查并修复'],
      ['settings.network.restore', '撤销上次修复'],
      ['settings.network.noConflicts', '未发现冲突规则'],
      ['settings.hotspot.start', '开启临时热点'],
      ['settings.hotspot.stop', '结束临时组网'],
      ['settings.hotspot.openSettings', '打开系统热点设置'],
      ['settings.hotspot.ssid', '热点名称（SSID）'],
      ['settings.hotspot.password', '热点密码'],
      ['organizer.openRecycleBin', '打开最近删除'],
      ['about.download.cnb', 'CNB 测试版'],
      ['about.download.quark', '夸克网盘'],
      ['about.download.baidu', '百度网盘'],
      ['about.download.github', 'GitHub Releases'],
      ['about.update.check', '检查更新'],
      ['about.feedback.support', '发送诊断'],
      ['statusBar.restart', '重启同步服务'],
      ['statusBar.export', '导出诊断包'],
      ['statusBar.restartSuccess', '同步服务已重启']
    ]
    for (const [leaf, value] of pinned) {
      expect(readPath(LOCALES['zh-CN'], `syncConsole.${leaf}`), leaf).toBe(value)
    }
  })

  it('④d 隐私承诺不得被裁短（不经云端 + 开启前单独征求同意）', () => {
    const zh = readPath(LOCALES['zh-CN'], 'syncConsole.connect.privacyNote') as string
    expect(zh).toContain('不经过云端')
    expect(zh).toContain('征求同意')
    const enValue = readPath(LOCALES['en'], 'syncConsole.connect.privacyNote') as string
    expect(enValue).toContain('never via the cloud')
    expect(enValue).toContain('consent')
  })

  it('④c 易撞名文案互不重复（jsdom 不隐藏折叠 details，按名定位需全页唯一）', () => {
    const zh = (leaf: string) => readPath(LOCALES['zh-CN'], `syncConsole.${leaf}`) as string
    // 引导卡与自查卡的跳转按钮不得同名
    expect(zh('connect.guide.openNetwork')).not.toBe(zh('connect.selfCheck.openNetwork'))
    expect(zh('connect.guide.openScan')).not.toBe(zh('connect.selfCheck.openScan'))
    // 自查卡状态文案不得与状态卡（syncService.status.*）的运行中/已停止撞名
    expect(zh('connect.selfCheck.serviceOnline')).not.toBe(
      readPath(LOCALES['zh-CN'], 'syncService.status.running')
    )
    expect(zh('connect.selfCheck.serviceOffline')).not.toBe(
      readPath(LOCALES['zh-CN'], 'syncService.status.stopped')
    )
    // 署名行按整串 getByText 定位，仓库注释不得包含署名子串
    expect(zh('about.repos.nikkiAlbumsNote')).not.toContain('RanAxro / Nikki Albums')
    // 网络检查结果 ok 不得宣称「无冲突」（冲突数另行展示，避免语义矛盾）
    expect(zh('settings.network.status.ok')).not.toBe(zh('settings.network.noConflicts'))
  })
})

/**
 * SyncInspirationPanel 过滤条/标签/分类/分享码扩展新增的灵感库键（18 个）。
 * status.* 值域 = inspiration-filter.ts 的 INSPIRATION_STATUSES（上游五态闭集）；
 * 既有 17 个灵感键由 sync-gallery-keys.test.ts 的 12 包同构断言继续覆盖。
 */
const INSPIRATION_NEW_KEYS = [
  'searchPlaceholder',
  'categoryPlaceholder',
  'statusLabel',
  'statusAll',
  'status.self',
  'status.want',
  'status.reproduced',
  'status.tried',
  'status.archived',
  'refresh',
  'countNote',
  'tagsLabel',
  'tagsPlaceholder',
  'categoriesLabel',
  'categoriesPlaceholder',
  'codeLabel',
  'codeRecognized',
  'filterEmpty'
]

const INSPIRATION_STATUS_CODES = ['self', 'want', 'reproduced', 'tried', 'archived']

describe('syncGallery.inspiration 新增键守卫（12 locale）', () => {
  it('12 包新增键齐备且为非空字符串', () => {
    for (const [code, node] of Object.entries(LOCALES)) {
      for (const leaf of INSPIRATION_NEW_KEYS) {
        const value = readPath(node, `syncGallery.inspiration.${leaf}`)
        expect(value, `${code} 缺失 syncGallery.inspiration.${leaf}`).toBeTypeOf('string')
        expect((value as string).trim().length, `${code}:${leaf} 不得为空串`).toBeGreaterThan(0)
      }
    }
  })

  it('12 包 inspiration 子树键集与 zh-CN 完全同构（防漏键漂移）', () => {
    const baseline = leafKeys(readPath(LOCALES['zh-CN'], 'syncGallery.inspiration')).sort()
    for (const [code, node] of Object.entries(LOCALES)) {
      expect(
        leafKeys(readPath(node, 'syncGallery.inspiration')).sort(),
        `${code} inspiration 键集与 zh-CN 不一致`
      ).toEqual(baseline)
    }
  })

  it('status.* 恰好覆盖 INSPIRATION_STATUSES 五态闭集（多一键即死键）', () => {
    for (const [code, node] of Object.entries(LOCALES)) {
      const statusKeys = leafKeys(readPath(node, 'syncGallery.inspiration.status')).sort()
      expect(statusKeys, `${code} inspiration.status 值域漂移`).toEqual(
        [...INSPIRATION_STATUS_CODES].sort()
      )
    }
  })

  it('插值占位与组件调用一致（countNote {{count}} / codeRecognized {{code}}）', () => {
    for (const [code, node] of Object.entries(LOCALES)) {
      expect(
        String(readPath(node, 'syncGallery.inspiration.countNote')),
        `${code} countNote 丢了 {{count}}`
      ).toContain('{{count}}')
      expect(
        String(readPath(node, 'syncGallery.inspiration.codeRecognized')),
        `${code} codeRecognized 丢了 {{code}}`
      ).toContain('{{code}}')
    }
  })
})
