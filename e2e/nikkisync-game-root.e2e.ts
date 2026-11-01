/**
 * 照片目录「保存即生效」的真机判据（round2 计划 N5 · docs/plans/2026-11-01-review-fix-2.5.6-repack-round2-实施计划.md）
 *
 * 背景：`nikkisync:set/reset-game-root` 只写设置键的时代，应用内不存在任何动作能把刚保存的
 * 目录推给运行中的会话（重启也不自愈：runtimeEnabled 缺省关）——真实用户态下「选了自定义
 * 路径但板块不出图」。a732c2b 起落库后当场经 `applyGameRoot` 生效；本套件给这条路径真窗证据：
 *
 *   G1（零模态主判据）：桥直调 `setGameRoot(合成安装根A)` ⇒ `applied:true / needRestart:false`，
 *      且 `runtimeStatus` 的 `installation.installRoot` 等于根 A、`lastScan` 键存在。
 *   G2（真实 UI 路径，承重红灯）：同步图库 → 同步服务 → 照片目录节手输根 B → 保存 ⇒
 *      「照片目录已保存并立即生效」可见、「配置已保存，但未能立即生效」不可见，留真窗截图。
 *   G3（恢复默认守卫，如实标注为**修复后守卫**：旧 dist 从未出现 applyFailedInstallRoot、
 *      旧 handler 不回 applyError ⇒ 无法对旧 dist 取红；其牙齿由单例 (bf) 证明）：
 *      环境变量指向非安装根 ⇒ reset 真产生 installation-not-found ⇒ 断言**不出现**
 *      「该目录不是有效的游戏安装根」、走 savedDeferred；`get-game-root` 回读 `''`（值不丢）。
 *
 * 合成安装根（按上游 `game-directory-discovery` 源码核实 + 本机探针实测）：`X6Game/` 为
 * **目录** + `InfinityNikki.exe` 为**文件**——上游 `isFile` 只看形态，但合成 exe 会被本机
 * 杀软**间歇性**实时拦截（0 字节必被吞，非 PE 文本也概率性 stat 成 ENOENT），故安装根
 * **真机优先**、合成根仅作兜底并带环境自检。`photoRoots` 取 `X6Game/Saved/GamePlayPhotos`
 * ⇒ 建该空目录。`selectedInstallRoot ?? NIKKISYNC_GAME_ROOT`（上游 env 名）会短路整个
 * 注册表 / PowerShell / 驱动器枚举链 ⇒ 非安装根经该环境变量传入即可让自动发现确定性失败，
 * 注册表不必真动。
 *
 * 运行期开关刻意**不传**（复刻 `runtimeEnabled` 缺省 false 的真实用户态——保存时走
 * `scan()` 的惰性 start，正是老包死掉的那条路）。打包态复验：`NIKKI_E2E_PACKAGED=1`
 * 切 `launchApp()`（release/win-unpacked），同一判据既验 dist 也验最终产物树。
 *
 * 链接前置与门控同 `nikkisync-runtime.e2e.ts`：未建链整件 skip（受支持的默认态）。
 * 类型口径：不 `declare global` 覆写 `Window.electronAPI`（同 program 内已有同名声明），
 * 局部类型 + method/arg 派发。
 */
import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasNikkiSyncLink } from '../src/main/nikkisync/runtime-loader'
import { decideNikkiSyncGate } from './nikkisync-guard'
import { launchBuiltApp, launchApp, closeApp, collectDiagLogs, type LaunchedApp } from './helpers'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const gate = decideNikkiSyncGate({ linked: hasNikkiSyncLink(REPO_ROOT) })

/**
 * G1/G2 用的安装根：**真机根优先**（与 `nikkisync-runtime.e2e.ts` 的 resolveGameRoot 同款候选
 * 与 env 口径），无真机根时落到合成根兜底。为什么真机优先：合成 `InfinityNikki.exe` 会被本机
 * 杀软**间歇性**实时拦截（实测 0 字节必被吞、非 PE 文本也概率性 stat 成 ENOENT，同形态探针
 * 时而存活时而被吞）——非确定性 flake 源；真 exe 是杀软既有白名单文件，完全绕开。
 */
const DEFAULT_GAME_ROOT_CANDIDATES = [
  'H:\\InfinityNikki Launcher\\InfinityNikki',
  'D:\\InfinityNikki Launcher\\InfinityNikki',
  'C:\\Program Files\\InfinityNikki Launcher\\InfinityNikki'
]

async function resolveGameRoot(): Promise<string | undefined> {
  const fromEnv = (process.env.NIKKI_NIKKISYNC_GAME_ROOT ?? '').trim()
  const candidates = fromEnv
    ? [fromEnv, ...DEFAULT_GAME_ROOT_CANDIDATES]
    : DEFAULT_GAME_ROOT_CANDIDATES
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(path.join(candidate, 'X6Game'))
      if (stat.isDirectory()) return candidate
    } catch {
      // 该候选不存在，继续下一个
    }
  }
  return undefined
}

/**
 * 合成根（落在 .cache/ 下，gitignore；目录名带时间戳避免上一轮残壳握句柄）：
 * - `not-install-root` 非安装根空目录，经上游 env 短路喂给自动发现，让 G3 的 reset 确定性
 *   not-found（无 exe，杀软无感）；
 * - `install-a` 仅在**无真机根**时才创建的合成兜底根（上游判据：X6Game 目录 + InfinityNikki.exe
 *   非空文本文件——0 字节会被杀软实时隔离，非 PE 文本也可能被间歇性吞，见自检判据）。
 */
const SYNTH_ROOT = path.join(REPO_ROOT, '.cache', `e2e-game-root-${Date.now()}`)
const SYNTH_INSTALL_ROOT = path.join(SYNTH_ROOT, 'install-a')
const ROOT_BARE = path.join(SYNTH_ROOT, 'not-install-root')

/**
 * 环境变量在 launch 之前就要位（helpers 的 launchEnv 展开 process.env；launchApp 不收 extraEnv）。
 *
 * 名字必须是上游 discovery 自己读的 **`NIKKISYNC_GAME_ROOT`**（game-directory-discovery:
 * `selected ?? process.env.NIKKISYNC_GAME_ROOT`）：它只在 selectedInstallRoot 缺省时短路整条
 * 枚举链 ⇒ G1/G2 的显式 setGameRoot 不受影响，G3 的 reset（不下发 selected）确定性 not-found。
 * 本仓 `NIKKI_NIKKISYNC_GAME_ROOT` 不设——它会经 buildSessionOptions 压过设置键，反而污染默认快照。
 */
process.env.NIKKISYNC_GAME_ROOT = ROOT_BARE

interface GameRootApplyResult {
  gameRoot: string
  writable: boolean
  applied: boolean
  needRestart: boolean
  applyError?: string
}

interface GameRootInfo {
  gameRoot: string
}

interface RuntimeStatusLight {
  state: string
  installation?: { installRoot?: string } | null
  lastScan?: unknown
  error?: string
  hint?: string
}

type GameRootBridgeCall =
  | { method: 'setGameRoot'; arg: { path: string } }
  | { method: 'getGameRoot' }
  | { method: 'runtimeStatus' }

async function callGameRootBridge<T>(page: Page, call: GameRootBridgeCall): Promise<T> {
  return (await page.evaluate(async (input) => {
    const host = (window as unknown as { electronAPI?: { nikkisync?: Record<string, unknown> } })
      .electronAPI
    const bridge = host?.nikkisync
    if (!bridge) throw new Error('preload did not expose electronAPI.nikkisync')
    if (input.method === 'setGameRoot')
      return await (bridge.setGameRoot as (arg: unknown) => unknown)(input.arg)
    if (input.method === 'getGameRoot') return await (bridge.getGameRoot as () => unknown)()
    return await (bridge.getRuntimeStatus as () => unknown)()
  }, call)) as T
}

/**
 * 上游安装根发现判据的最小合成形态：X6Game 目录 + 主程序文件 + 照片根空目录。
 *
 * 上游 `isFile` 只看形态不看内容，但主程序文件**不能是 0 字节**——本机杀软会实时隔离
 * 0 字节的 `.exe`（实测：写入后 stat 即 missing，43 字节非 PE 文本存留），发现链随即
 * not-found。写非空文本内容即可。
 */
async function createInstallRootShape(root: string): Promise<void> {
  await fs.mkdir(path.join(root, 'X6Game', 'Saved', 'GamePlayPhotos'), { recursive: true })
  await fs.writeFile(
    path.join(root, 'X6Game', 'InfinityNikki.exe'),
    'e2e synthetic install root marker — not a PE binary\n'
  )
}

let launched: LaunchedApp | undefined
let win: Page | undefined
/** beforeAll 解析出的安装根：真机根优先，无真机根才落合成兜底（见常量区说明） */
let gameRoot: string | undefined
/** 环境级 skip 原因（合成兜底根未过上游判据等）；非空 ⇒ 各用例如实 skip，不伪装成逻辑失败 */
let envSkipReason: string | undefined

test.describe.configure({ mode: 'serial' })

test.describe('照片目录保存即生效（真实应用会话）', () => {
  // 未建链 ⇒ 整件 skip（受支持的默认态），修复命令写在 reason 里。
  test.skip(gate.action === 'skip', gate.reason)

  test.beforeAll(async () => {
    test.setTimeout(150_000)
    await fs.mkdir(ROOT_BARE, { recursive: true })
    // 真机根优先（杀软对合成 exe 间歇性拦截，见常量区说明）；无真机根才落合成兜底根。
    const machineRoot = await resolveGameRoot()
    if (machineRoot) {
      gameRoot = machineRoot
    } else {
      await createInstallRootShape(SYNTH_INSTALL_ROOT)
      // 环境自检（环境失败与逻辑失败分开）：测试进程内对合成根跑一次上游判据——失败 ⇒
      // 杀软隔离 / 形态漂移等环境问题，如实 skip 而非让 G1 红成假的逻辑失败（0 字节 exe
      // 被实时隔离、非 PE 文本被间歇性吞，都是这么现形的）。真机根无需自检。
      const discovery =
        (await import('@nikkisync/pc-companion/dist/src/game-directory-discovery.js')) as {
          discoverInfinityNikkiInstallation: (options?: {
            selectedInstallRoot?: string
          }) => Promise<{ installRoot?: string } | undefined>
        }
      const selfCheck = await discovery.discoverInfinityNikkiInstallation({
        selectedInstallRoot: SYNTH_INSTALL_ROOT
      })
      if (!selfCheck) {
        const exe = await fs
          .stat(path.join(SYNTH_INSTALL_ROOT, 'X6Game', 'InfinityNikki.exe'))
          .then((s) => `${s.size}B isFile=${s.isFile()}`)
          .catch((e) => `missing(${(e as NodeJS.ErrnoException).code})`)
        envSkipReason = `合成兜底根未过上游判据（杀软拦截/环境问题，非被测代码缺陷）：exe=${exe}`
      } else {
        gameRoot = SYNTH_INSTALL_ROOT
      }
    }
    // 刻意不传运行期开关环境变量：runtimeEnabled 缺省 false，生效走 setGameRoot 的惰性拉起
    launched =
      process.env.NIKKI_E2E_PACKAGED === '1' ? await launchApp() : await launchBuiltApp([], {})
    const page = await launched.app.firstWindow()
    win = page
    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 })
    // 文案判据依赖语言：固定 zh-CN 后重载（localStorage 只影响本次临时 userData）
    await page.evaluate(() => {
      localStorage.setItem('app-language', 'zh-CN')
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
  })

  test('G1 桥直调 setGameRoot：applied:true 即时生效，installRoot 换到所选安装根', async () => {
    test.setTimeout(150_000)
    test.skip(envSkipReason !== undefined, envSkipReason ?? '')
    const page = win
    if (!page || !launched || !gameRoot) {
      test.skip(true, '应用未启动或无可用安装根')
      return
    }
    const result = await callGameRootBridge<GameRootApplyResult>(page, {
      method: 'setGameRoot',
      arg: { path: gameRoot }
    })
    expect(
      result.applied,
      `setGameRoot 未当场生效：${JSON.stringify(result)}（老包该字段缺席 ⇒ undefined）`
    ).toBe(true)
    expect(result.needRestart).toBe(false)

    const status = await callGameRootBridge<RuntimeStatusLight>(page, { method: 'runtimeStatus' })
    await expect
      .poll(
        async () => {
          const latest = await callGameRootBridge<RuntimeStatusLight>(page, {
            method: 'runtimeStatus'
          })
          return latest.state
        },
        { timeout: 30_000, message: '惰性拉起后 runtime 未收敛为 running' }
      )
      .toBe('running')
    // 比较层按约定钉 win32：两侧同用 path.win32.resolve + 小写折叠（NTFS 不区分大小写是产品事实）
    const expectedRoot = path.win32.resolve(gameRoot).toLowerCase()
    const actualRoot = path.win32
      .resolve(String(status.installation?.installRoot ?? ''))
      .toLowerCase()
    expect(actualRoot, `installRoot=${String(status.installation?.installRoot)}`).toBe(expectedRoot)
    expect(status.lastScan).toBeDefined()
  })

  test('G2 真实 UI 路径：照片目录节手输安装根保存 ⇒ 即时生效文案可见、未生效文案不可见', async () => {
    test.setTimeout(150_000)
    test.skip(envSkipReason !== undefined, envSkipReason ?? '')
    const page = win
    if (!page || !gameRoot) {
      test.skip(true, '应用未启动或无可用安装根')
      return
    }
    // 同步服务是同步图库板块下的二级子页（与 nikkisync-runtime.e2e N3c 同一导航口径）
    await page.getByTitle('同步图库').first().click()
    const serviceEntry = page.getByTitle('同步服务').first()
    await serviceEntry.waitFor({ timeout: 30_000 })
    await serviceEntry.click()

    // 照片目录节常驻显示（只碰设置库，不经运行时装配）
    const photoDirInput = page.getByPlaceholder('输入或浏览选择本地目录')
    await photoDirInput.waitFor({ timeout: 30_000 })
    const container = page.locator('div.space-y-2', { has: photoDirInput })
    // 手输与 G1 同一根：同值重复保存是真实用户行为（幂等），且不受「需要两个合法根」的
    // 环境约束——scanCore 对同根只重扫不重建，保存流与文案判据完全一致
    await photoDirInput.fill(gameRoot)
    await container.getByRole('button', { name: '保存', exact: true }).click()

    // 承重判据：这条文案只存在于「重建后的 renderer chunk」——17:40 旧包的保存流是
    // 「成功提示 → 重启询问」，永远不会出现「立即生效」
    await expect(
      page.getByText('照片目录已保存并立即生效').first(),
      '保存后未出现「已保存并立即生效」——生效通道没跑通（旧包死法）'
    ).toBeVisible({ timeout: 30_000 })
    expect(
      await page.getByText('配置已保存，但未能立即生效').count(),
      '不得出现「未能立即生效」兜底文案'
    ).toBe(0)
    await page.screenshot({ path: path.join('test-results', 'nikkisync-game-root-saved.png') })
  })

  test('G3 恢复默认遇非安装根（修复后守卫）：不回「不是安装根」，走 savedDeferred，值不丢', async () => {
    test.setTimeout(150_000)
    test.skip(envSkipReason !== undefined, envSkipReason ?? '')
    const page = win
    if (!page) {
      test.skip(true, '应用未启动')
      return
    }
    // 环境变量指向非安装根 ⇒ reset 清空后走上游自动发现必然 not-found（枚举链已被短路）
    await page.getByRole('button', { name: '恢复默认', exact: true }).click()
    expect(
      await page.getByText('该目录不是有效的游戏安装根').count(),
      'reset 路不得回「该目录不是有效的游戏安装根」（对恢复默认是无效指向，D1 回归钉）'
    ).toBe(0)
    await expect(page.getByText('配置已保存，但未能立即生效').first()).toBeVisible({
      timeout: 30_000
    })
    const after = await callGameRootBridge<GameRootInfo>(page, { method: 'getGameRoot' })
    expect(after.gameRoot, '恢复默认后回读必须是空串（值已持久化，不谎报失败）').toBe('')
  })

  // eslint-disable-next-line no-empty-pattern -- Playwright hook 首参必须是对象解构模式
  test.afterAll(async ({}, testInfo) => {
    if (launched) {
      await collectDiagLogs(launched.userDataDir, testInfo.outputDir).catch(() => {})
      await closeApp(launched)
      launched = undefined
    }
    // 合成根清理失败容忍（上游 watcher 可能仍握句柄）；目录带时间戳，残留也不串轮
    await fs.rm(SYNTH_ROOT, { recursive: true, force: true }).catch(() => {})
  })
})
