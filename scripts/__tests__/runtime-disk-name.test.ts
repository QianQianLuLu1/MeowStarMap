import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * 运行时落盘名称守卫（阶段 5：程序自己创建/上线的名称更名）。
 *
 * 为什么要有这个文件：本阶段改的是**运行时写进磁盘、协议里发给其他设备的名称值**——
 * 诊断目录常量、%TEMP% 应急日志名、配对服务默认显示名、TLS 自签证书 CN。
 * 仓库原先没有常驻用例读这些站点（scripts/__tests__/pack-identity-name.test.ts 只管打包与
 * CI 配置面，scripts/__tests__/ui-brand-name.test.ts 只管界面文案面），改漏一处不会红，
 * 而它们决定的正是用户在自己文档目录里看到的文件夹名、以及手机端显示的服务器名。
 *
 * 与阶段 3/4 同口径：正向取新名 + 反向无旧名 + 禁改项逐字锁。
 *
 * 「名称与事实分离」在本守卫里是可判定的：描述修复前实况的注释（startup-diagnostic.ts:24-25、
 * early-crash-guard.ts:45-46）逐字保留旧名，本文件反向锁定它们仍在——把历史改成新名会让注释
 * 描述一个从未存在过的状态。
 *
 * 读的是磁盘上的源文件文本、不 import 被测模块 ⇒ 不拉 electron/jsdom。
 * 根路径走 `new URL(rel, import.meta.url)`，不用 `path.resolve(dirname(fileURLToPath(...)))`：
 * 后者在 test:posix-host 装置下把 path 钉成 posix，对 Windows 形态的 import.meta.url 返回 '.'
 * （阶段 3 的 ui-brand-name.test.ts 在本 profile 下装载失败即为此，属遗留缺陷，本阶段不扩大改动面）。
 */

const selfUrl = new URL(import.meta.url)
const repoRootUrl = new URL('../../', selfUrl)

const read = (rel: string): string =>
  readFileSync(new URL(rel, repoRootUrl), { encoding: 'utf-8', flag: 'r' })

/** 用户可见名称：中文显示名（诊断目录、快捷方式、productName 同源） */
const CJK = '喵星图'
/** 无空格 Pascal 形：只允许出现在文件名/目录名这类技术前缀 */
const PACK = 'MeowStarMap'
/** 英文品牌形（三词各一空格）：局域网配对时其他设备看到的服务器名 */
const BRAND = 'Meow Star Map'
/** 旧品牌名：只允许残留在「修复前实况」叙述与禁改项里 */
const OLD = 'NikkiGallery'

describe('诊断目录落盘名取中文名（用户在文档目录里直接看得见）', () => {
  it('PRODUCT_DIAG_DIRNAME 常量为 喵星图，DIAG_SUBDIR 不变', () => {
    const src = read('src/main/utils/user-diag-path.ts')
    expect(src).toContain(`export const PRODUCT_DIAG_DIRNAME = '${CJK}'`)
    expect(src).toContain("export const DIAG_SUBDIR = 'Diagnostics'")
  })

  it('中文常量走行内 eslint 豁免（i18n 护栏对 CJK 字面量为 error）', () => {
    const src = read('src/main/utils/user-diag-path.ts')
    expect(src).toContain('// eslint-disable-next-line no-restricted-syntax')
  })

  it('权威模块内不再出现旧品牌名（含候选链注释）', () => {
    const src = read('src/main/utils/user-diag-path.ts')
    expect(src).not.toContain(OLD)
    expect(src).toContain(`1) <documents>/${CJK}/Diagnostics`)
    expect(src).toContain(`2) <homedir>/${CJK}/Diagnostics`)
    expect(src).toContain(`3) <tmpdir>/${CJK}-Diagnostics`)
  })

  it('描述当前行为的注释逐处跟随新名（四站）', () => {
    const sites: Array<[string, string]> = [
      ['src/main/utils/startup-diagnostic.ts', `用户友好目录：文档/${CJK}/Diagnostics`],
      [
        'src/main/utils/dir-manager.ts',
        `崩溃转储默认输出到用户友好目录（文档/${CJK}/Diagnostics）`
      ],
      [
        'src/main/services/crash-service.ts',
        `崩溃转储统一到用户友好目录（文档/${CJK}/Diagnostics）`
      ],
      ['src/main/index.ts', `崩溃转储目录用户友好化：文档/${CJK}/Diagnostics`]
    ]
    for (const [file, needle] of sites) {
      expect(read(file), file).toContain(needle)
    }
  })

  it('弹窗日志路径注释跟随（index.ts 兜底链 + log-service.ts 现状段）', () => {
    expect(read('src/main/index.ts')).toContain(
      `日志路径统一到用户友好目录（文档/${CJK}/Diagnostics）`
    )
    expect(read('src/main/services/log-service.ts')).toContain(
      `与真实落盘（文档/${CJK}/Diagnostics）不一致`
    )
  })

  it('修复前实况叙述保留旧名（名称与事实分离，不得抹平历史）', () => {
    // 锁单行片段：常驻守卫不依赖工作区行尾是 LF 还是 CRLF
    expect(read('src/main/utils/startup-diagnostic.ts')).toContain(
      `<homedir>/${OLD}/Diagnostics（当时常量值）`
    )
    expect(read('src/main/utils/early-crash-guard.ts')).toContain(
      `「<homedir>/${OLD}/Diagnostics」，用户在弹窗给出的目录下找不到日志`
    )
  })

  it('受保护目录的两处注释改动携带本次授权注释', () => {
    for (const file of ['src/main/services/crash-service.ts', 'src/main/services/log-service.ts']) {
      const head = read(file).split('\n').slice(0, 5).join('\n')
      expect(head, file).toMatch(/^\/\/ @core-change: \S/m)
    }
  })

  it('诊断目录断言与源码同值（11 条断言未被拆半）', () => {
    expect(read('src/main/utils/startup-diagnostic.test.ts')).toContain(
      `/${CJK}[\\\\/]Diagnostics[\\\\/]startup-errors\\.log$/`
    )
    expect(read('src/main/utils/early-crash-guard.test.ts')).toContain(
      `path.join(docs, '${CJK}', 'Diagnostics')`
    )
    expect(read('src/main/utils/early-crash-guard.test.ts')).toContain(
      `path.join('/mock/tmp', '${CJK}-Diagnostics')`
    )
    expect(read('src/main/services/crash-service.test.ts')).toContain(`/${CJK}[\\\\/]Diagnostics$/`)
    expect(read('src/main/utils/dir-manager.test.ts')).toContain(`/${CJK}[\\\\/]Diagnostics$/`)
  })

  it('断言侧不再锁定旧诊断目录名', () => {
    // early-crash-guard.test.ts 不在此列：它 :229 还写着 %TEMP% 兜底日志名（C2 的范围），
    // 等 C2 落地后再由本文件的「应急日志前缀」段整文件收口。
    const files = [
      'src/main/utils/startup-diagnostic.test.ts',
      'src/main/services/crash-service.test.ts',
      'src/main/utils/dir-manager.test.ts',
      'src/main/app/__tests__/lifecycle.test.ts'
    ]
    for (const file of files) {
      expect(read(file), file).not.toContain(OLD)
    }
    const guardTest = read('src/main/utils/early-crash-guard.test.ts')
    expect(guardTest).not.toContain(`${OLD}', 'Diagnostics'`)
    expect(guardTest).not.toContain(`${OLD}-Diagnostics'`)
  })
})

describe('%TEMP% 应急日志前缀取无空格技术标识', () => {
  it('三处应急兜底日志名用 MeowStarMap 前缀', () => {
    expect(read('src/main/utils/startup-diagnostic.ts')).toContain(`'${PACK}-startup-errors.log'`)
    expect(read('src/main/utils/startup-diagnostic.ts')).toContain(`'${PACK}-diag.log'`)
    expect(read('src/main/utils/early-crash-guard.ts')).toContain(`'${PACK}-startup-errors.log'`)
  })

  it('旧品牌名不再作为日志文件前缀出现（历史叙述用的是斜杠形态，不在此列）', () => {
    const files = [
      'src/main/utils/startup-diagnostic.ts',
      'src/main/utils/startup-diagnostic.test.ts',
      'src/main/utils/early-crash-guard.ts',
      'src/main/utils/early-crash-guard.test.ts',
      'src/main/app/__tests__/error-handlers.test.ts'
    ]
    for (const file of files) {
      expect(read(file), file).not.toContain(`${OLD}-`)
    }
  })

  it('断言侧与源码同值：兜底 fixture 与弹窗断言重锚到新前缀', () => {
    expect(read('src/main/utils/early-crash-guard.test.ts')).toContain(
      `path.join(os.tmpdir(), '${PACK}-startup-errors.log')`
    )
    const handlers = read('src/main/app/__tests__/error-handlers.test.ts')
    expect(handlers.split(`toContain('${PACK}-startup-errors.log')`).length - 1).toBe(2)
    expect(handlers).toContain(`'/mock/${CJK}/Diagnostics/startup-errors.log'`)
  })

  it('弹窗断言不得只含糊匹配品牌子串（必须逐字锚到兜底日志名）', () => {
    const handlers = read('src/main/app/__tests__/error-handlers.test.ts')
    expect(handlers).not.toContain("toContain('NikkiGallery')")
  })
})

describe('配对服务默认显示名取英文品牌形（含空格，非 ASCII 会被上游清洗）', () => {
  it('mDNS 实例名与 PairResponse.serverName 的默认值为 Meow Star Map', () => {
    expect(read('src/main/nikkisync/sync-server-view.ts')).toContain(
      `export const SYNC_SERVER_DEFAULT_NAME = '${BRAND}'`
    )
  })

  it('落库默认服务器名为 Meow Star Map', () => {
    expect(read('src/main/database/sync-metadata-repository.ts')).toContain(
      `export const DEFAULT_SERVER_NAME = '${BRAND}'`
    )
  })

  it('注释讲清清洗口径：放行空格与 _ -，清洗非 ASCII', () => {
    const src = read('src/main/nikkisync/sync-server-view.ts')
    expect(src).toContain('MdnsAdvertiser.ts:52')
    expect(src).toContain('非 ASCII')
  })

  it('旧品牌名与本机目录名不再充当服务默认值', () => {
    expect(read('src/main/nikkisync/sync-server-view.ts')).not.toContain(`'${OLD}'`)
    expect(read('src/main/database/sync-metadata-repository.ts')).not.toContain(
      "DEFAULT_SERVER_NAME = 'WXNN XiangCe'"
    )
  })

  it('测试期望值与源码同值（默认名断言未被拆半）', () => {
    expect(read('src/main/nikkisync/sync-server-view.test.ts')).toContain(`name: '${BRAND}'`)
  })

  it('已落库配对身份与上游证书标识未波及', () => {
    const meta = read('src/main/database/sync-metadata-repository.ts')
    expect(meta).toContain("wxnn-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}")
    // 移植面的 TLS CN 由 C4 处理，此处只锁上游装载缝的 CN 断言不被顺手改
    expect(read('src/main/nikkisync/sync-server.linked.test.ts')).toContain(
      "toContain('NikkiSync Local')"
    )
    // link:nikkisync 失败提示里的是开发者本机仓库目录名，不是产品名
    expect(read('src/main/nikkisync/runtime-loader.ts')).toContain('in WXNN XiangCe')
  })

  it('带空格品牌形不落到磁盘路径拼接上（三形互斥）', () => {
    const files = [
      'src/main/utils/user-diag-path.ts',
      'src/main/utils/startup-diagnostic.ts',
      'src/main/utils/early-crash-guard.ts',
      'src/main/nikkisync/sync-server-view.ts'
    ]
    for (const file of files) {
      for (const line of read(file).split('\n')) {
        if (!line.includes(BRAND)) continue
        expect(line, `${file}: ${line.trim()}`).not.toMatch(/path\.join|tmpdir\(\)/)
      }
    }
  })
})

describe('TLS 自签证书 CN 取新品牌（SAN 与签名基串刻意不动）', () => {
  it('COMMON_NAME 为 Meow Star Map Local', () => {
    expect(read('src/main/sync/identity-service.ts')).toContain(
      `const COMMON_NAME = '${BRAND} Local'`
    )
  })

  it('证书主体断言与源码同值', () => {
    expect(read('src/main/sync/identity-service.test.ts')).toContain(`toContain('${BRAND} Local')`)
  })

  it('旧产品名不再充当证书 CN', () => {
    for (const file of [
      'src/main/sync/identity-service.ts',
      'src/main/sync/identity-service.test.ts'
    ]) {
      expect(read(file), file).not.toContain('WXNN Photo Manager')
    }
  })

  it('SAN dNSName 与两处签名基串 URL 逐字未动（改它们会打断已配对客户端校验）', () => {
    expect(read('src/main/sync/identity-service.ts')).toContain("const SAN_DNS_NAME = 'wxnn.local'")
    expect(read('src/main/sync/server/sync-server.ts')).toContain("'http://wxnn.local'")
    expect(read('src/main/sync/server/api-router.ts')).toContain("'http://wxnn.local'")
    expect(read('src/main/sync/identity-service.test.ts')).toContain("toContain('wxnn.local')")
  })
})

describe('桌面快捷方式名（阶段 3 已交付，此处纳入防回归而非本轮红灯）', () => {
  it('两处 .lnk 文件名仍为喵星图.lnk，测试常量同值', () => {
    const src = read('src/main/app/desktop-shortcut.ts')
    expect(src.split(`'${CJK}.lnk'`).length - 1).toBe(2)
    expect(read('src/main/app/__tests__/desktop-shortcut.test.ts')).toContain(
      `const SHORTCUT_NAME = '${CJK}.lnk'`
    )
  })
})
