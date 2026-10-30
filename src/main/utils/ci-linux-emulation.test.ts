/**
 * 装置自检（`npm run test:ci-linux` 专用；普通 `npm test` 与 CI 下整件 skip）
 *
 * 为什么要有这份文件：装置是「CI 红灯的本地替身」，它一旦悄悄失效（某轴没生效、被
 * vitest 的 interop 绕过），所有据它作出的「这条红是假信号」结论就全部失去依据。
 * 本文件把每一轴钉成可判定断言——装置不成立时它先红。
 *
 * 判据来源：2026-10-19 CI run 39268051028（ubuntu-latest）的失败注记，见
 * docs/plans/2026-10-20-fix-ci-linux-path-semantics-round2.md §0。
 *
 * 2026-10-20 追加：本文件自己曾带进一盏红灯——哨兵用例（见文件末尾）拿
 * `nodePath.sep === nodePath.win32.sep` 当「装置未激活 ⇒ 我在真宿主上」的证据，而该式只在
 * Windows 宿主成立，CI（ubuntu-latest）上恒假（run 39440507242 注记：本文件 :138
 * `expected '/' to be '\'`）。已改为不依赖宿主平台的结构性判据，见
 * docs/plans/2026-10-20-fix-ci-selfcheck-host-constant-round3.md §2.3 / §4-N1。
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import { EOL as osEolNamed, homedir as osHomedirNamed, tmpdir as osTmpdirNamed } from 'node:os'
import * as osNs from 'node:os'
import nodePath from 'path'
import { fileURLToPath } from 'url'

const marker = (globalThis as Record<string, unknown>).__wxnnCiLinuxEmulation as
  { cwd: string; root: string; sandbox: string; hostTmp: string } | undefined
const ACTIVE = marker !== undefined

/**
 * 双 profile 用例：装置开 / 关都要跑，因此**不**参与「整件跳过」判定。
 * 改这两条的标题必须同步改这里，否则末尾哨兵用例会红（失焦即红，不放过）。
 */
const DUAL_PROFILE_TITLES: string[] = [
  '轴 5：electron 走惰性替身，单测不依赖二进制安装状态',
  '装置未激活时本文件必须整件跳过（否则 CI 会把自检当成业务回归）'
]

describe('CI 宿主模拟装置自检', () => {
  it.skipIf(!ACTIVE)('轴 1：path 绑定已是 posix，且显式 win32 不受影响', () => {
    expect(nodePath.sep).toBe('/')
    expect(nodePath.posix.win32).toBe(nodePath.win32)
    // 钉过 win32 的代码在装置下仍走真 win32：这是装置能「证明」修复而非复述 bug 的根基
    expect(nodePath.win32.dirname('D:\\a\\b')).toBe('D:\\a')
    // 宿主绑定在 CI 上会把 Windows 形态串当相对名——这正是本轮修的分叉
    expect(nodePath.isAbsolute('D:\\Game\\Album')).toBe(false)
  })

  it.skipIf(!ACTIVE)('轴 2：process.platform 与 os.EOL 已是 Linux 形态', () => {
    expect(process.platform).toBe('linux')
    expect(os.EOL).toBe('\n')
  })

  it.skipIf(!ACTIVE)('轴 3：cwd / homedir / tmpdir 已是 CI 上的取值形态', () => {
    expect(process.cwd()).toBe('/home/runner/work/MeowStarMap/MeowStarMap')
    expect(os.homedir()).toBe('/home/runner')
    expect(os.tmpdir()).toBe('/tmp')
    expect(os.userInfo().homedir).toBe('/home/runner')
    expect(process.env.LOCALAPPDATA).toBeUndefined()
    expect(process.env.APPDATA).toBeUndefined()
  })

  it.skipIf(!ACTIVE)(
    '轴 3b：具名与命名空间导入的 os 同样是 CI 取值（装置不得只治好 default 导入）',
    () => {
      // 判据落在「所有导入形态说同一句话」这条不变量上：轴 3 就地改写只覆盖 default 导入，
      // 具名/命名空间导入拿的是 interop 快照，于是 os.tmpdir() 在装置里仍是真宿主值；又因为
      // 装置删了 TEMP/TMP，它会回落到 Windows 兜底字面量，那条反斜杠串随后被 posix 绑定
      // 当相对名拼到模拟仓库根之后 ⇒ 成片假红（第 4 轮的 RC-1）。
      expect(osTmpdirNamed()).toBe('/tmp')
      expect(osHomedirNamed()).toBe('/home/runner')
      expect(osEolNamed).toBe('\n')
      expect(osNs.tmpdir()).toBe('/tmp')
      expect(osNs.homedir()).toBe('/home/runner')
      expect(osNs.devNull).toBe('/dev/null')
      expect(osNs.userInfo().homedir).toBe('/home/runner')
      expect(osTmpdirNamed()).toBe(os.tmpdir())
      expect(osNs.homedir()).toBe(os.homedir())
    }
  )

  it.skipIf(!ACTIVE)(
    '轴 3c：沙箱基址仍来自真宿主临时目录（os 被 mock 后不得把沙箱搬到盘根）',
    () => {
      // 与 tests/mocks/ci-linux-fs.ts 的 setHostPaths 同表达式，两侧宿主都能判：
      // 若沙箱改由被 mock 的 os 求值，这里会得到 `\tmp\wxnn-ci-linux` 形态而当场红。
      expect(marker!.sandbox).toBe(nodePath.win32.join(marker!.hostTmp, 'wxnn-ci-linux'))
      expect(fs.existsSync(marker!.sandbox)).toBe(true)
    }
  )

  it.skipIf(!ACTIVE)('轴 3d：/dev/null 经装置落到本机 null 设备', () => {
    // 判据只能用「写进去不抛」：真宿主的 null 设备在 Windows 上是 `\\.\nul`，
    // fs.existsSync 对它恒为 false（stat 打不开该设备），而打开与写入都成立；
    // 换成 existsSync 会在 Windows 开发机上假红、在 Linux 上绿，正是要消灭的宿主漂移。
    expect(() => fs.writeFileSync('/dev/null', 'probe', 'utf-8')).not.toThrow()
    const handle = fs.openSync('/dev/null', 'w')
    fs.closeSync(handle)
  })

  it.skipIf(!ACTIVE)('轴 4：posix 假路径可真的读写，且结果反向翻译回 posix 形态', () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'self-check-'))
    expect(dir.startsWith('/tmp/')).toBe(true)
    // 翻译层若没生效，这两步会在 Windows 上撞 ENOENT
    const file = nodePath.join(dir, 'a.txt')
    fs.writeFileSync(file, 'ok', 'utf-8')
    expect(fs.readFileSync(file, 'utf-8')).toBe('ok')
    expect(fs.existsSync(dir)).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
    expect(fs.existsSync(dir)).toBe(false)
  })

  it.skipIf(!ACTIVE)('轴 4a：双路径 API 的**两个**参数都要翻译（rename/copyFile）', () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'self-check-2-'))
    const src = nodePath.join(dir, 'src.jpg')
    const destDir = nodePath.join(dir, 'target')
    const dest = nodePath.join(destDir, 'dest.jpg')
    fs.mkdirSync(destDir, { recursive: true })
    fs.writeFileSync(src, 'bytes', 'utf-8')
    // dest 若漏翻，Windows 会把 '/tmp/...' 解释成 'D:\\tmp\\...' 而 ENOENT
    fs.copyFileSync(src, dest)
    expect(fs.existsSync(dest)).toBe(true)
    const moved = nodePath.join(destDir, 'moved.jpg')
    fs.renameSync(dest, moved)
    expect(fs.existsSync(moved)).toBe(true)
    expect(fs.existsSync(dest)).toBe(false)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it.skipIf(!ACTIVE)('轴 4b：经 cwd 拼出的工作区路径读到的是同一份源码', () => {
    const source = fs.readFileSync(
      nodePath.resolve(process.cwd(), 'src', 'main', 'scanner', 'uid-discovery.ts'),
      'utf-8'
    )
    expect(source).toContain('path-dialect')
  })

  it.skipIf(!ACTIVE)('轴 4c：容器里 / 不可写 ⇒ 假绝对路径 mkdir 抛 EACCES', () => {
    // 用一次性路径，避免被开发机上历史测试残留的 `D:\mock\...` 干扰（那些残留在 Windows
    // 上真的存在，会让 existsSync 返回 true，与 CI 语义无关）
    const probe = `/mock-selfcheck-${process.pid}-`
    expect(() => fs.mkdirSync(`${probe}/userData/logs`, { recursive: true })).toThrowError(/EACCES/)
    // 只读类 API 不判定可写性：CI 上 existsSync 也是 false 而不是抛错
    expect(fs.existsSync(`${probe}/userData/logs`)).toBe(false)
  })

  it.skipIf(!ACTIVE)('轴 4d：异步与 promises 侧同样翻译、同样拒绝', async () => {
    await expect(fsp.mkdir('/mock/userData/logs', { recursive: true })).rejects.toMatchObject({
      code: 'EACCES'
    })
    const dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'self-check-'))
    expect(dir.startsWith('/tmp/')).toBe(true)
    await fsp.writeFile(nodePath.join(dir, 'a.txt'), 'ok', 'utf-8')
    expect(await fsp.readFile(nodePath.join(dir, 'a.txt'), 'utf-8')).toBe('ok')
    await fsp.rm(dir, { recursive: true, force: true })
  })

  it.skipIf(!ACTIVE)('轴 4f：fs.promises 与 fs/promises 在装置里仍是同一个对象', async () => {
    const fsp = await import('fs/promises')
    // Node 本身保证同一性；包装层必须保住它，否则 `vi.spyOn(fs.promises, 'unlink')`
    // 只落在一份上，被测代码从另一份拿到的还是原函数 ⇒ 装置里的假绿
    expect(fsp.default).toBe(fs.promises)
  })

  it.skipIf(!ACTIVE)('轴 4e：fileURLToPath 派生的仓库根是 CI 工作区形态', () => {
    const here = fileURLToPath(import.meta.url)
    expect(here).toBe(
      '/home/runner/work/MeowStarMap/MeowStarMap/src/main/utils/ci-linux-emulation.test.ts'
    )
    // 本文件位于 src/main/utils ⇒ 上溯三级才是仓库根（守卫类脚本测试在 scripts/__tests__ 下是两级）
    const repoRoot = nodePath.resolve(nodePath.dirname(here), '..', '..', '..')
    expect(repoRoot).toBe('/home/runner/work/MeowStarMap/MeowStarMap')
    // 守卫类用例的标准写法：经 cwd/仓库根拼出的源码路径要真读得到
    const source = fs.readFileSync(
      nodePath.join(repoRoot, 'src/main/utils/path-dialect.ts'),
      'utf-8'
    )
    expect(source).toContain('WINDOWS_SHAPED')
  })

  it('轴 5：electron 走惰性替身，单测不依赖二进制安装状态', async () => {
    // 这条在两种 profile 下都必须成立：CI 用 --ignore-scripts 装依赖时真 electron 会抛错，
    // 基座 vitest.config.ts 的 resolve.alias 就是把那 40 个文件从 CI 红灯里捞出来的手段。
    const electron = await import('electron')
    expect(electron.app).toBeUndefined()
    expect(electron.ipcMain).toBeUndefined()
  })

  it('装置未激活时本文件必须整件跳过（否则 CI 会把自检当成业务回归）', () => {
    if (!ACTIVE) {
      expect(marker).toBeUndefined()
      // 判据**不得依赖宿主平台**：本机 `path.sep` 是 '\\'、CI（ubuntu-latest）是 '/'，
      // 拿 `nodePath.sep === nodePath.win32.sep` 当「真宿主」证据时，POSIX 宿主上恒红
      // （run 39440507242 注记即此行 `expected '/' to be '\'`）。且真 Node 下
      // `path.posix.win32 === path.win32` 恒真、装置又把 platform 改成 'linux'
      // ⇒「真宿主 vs 装置态」无法用任何环境取值区分，唯一真相源只有 marker 本身。
      // 「整件跳过」的实质是：装置轴用例一律挂着 `skipIf(!ACTIVE)` 闸门，未激活时一条都不会
      // 执行——这一点只能从本文件自身的结构读出来，在任何宿主上都成立。
      // 只在装置未激活时读：装置态下 fs/url 已被翻译层接管，而装置态根本不进这个分支。
      const self = fs.readFileSync(fileURLToPath(import.meta.url), 'utf-8')
      const ungated = [...self.matchAll(/\bit\(\s*'([^']+)'/g)].map((m) => m[1])
      const gatedCount = [...self.matchAll(/\bit\.skipIf\([^)]*\)\(\s*'([^']+)'/g)].length
      expect(ungated).toEqual(DUAL_PROFILE_TITLES)
      // 空集保护：装置轴真的还在，否则上一条会在「一个装置轴用例都没有」时恒真
      expect(gatedCount).toBeGreaterThan(0)
    }
    expect(ACTIVE).toBe(marker !== undefined)
  })
})
