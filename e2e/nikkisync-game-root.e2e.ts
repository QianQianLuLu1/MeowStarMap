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
 * 合成安装根（按上游 `game-directory-discovery` 源码核实）：`X6Game/` 为**目录** +
 * `InfinityNikki.exe` 为**文件**（0 字节即过 isFile）；`photoRoots` 取
 * `X6Game/Saved/GamePlayPhotos` ⇒ 建该空目录。`selectedInstallRoot ?? NIKKI_NIKKISYNC_GAME_ROOT`
 * 会短路整个注册表 / PowerShell / 驱动器枚举链 ⇒ 非安装根经环境变量传入即可让自动发现
 * 确定性失败，注册表不必真动。
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
 * 合成根三件套（落在 .cache/ 下，gitignore；目录名带时间戳避免上一轮残壳握句柄）：
 * 根 A / 根 B 都是合法安装根形态（G1 桥直调、G2 UI 手输各用其一，互不串台）；
 * ROOT_BARE 是**非安装根**空目录，经环境变量喂给自动发现，让 G3 的 reset 确定性 not-found。
 */
const SYNTH_ROOT = path.join(REPO_ROOT, '.cache', `e2e-game-root-${Date.now()}`)
const ROOT_A = path.join(SYNTH_ROOT, 'install-a')
const ROOT_B = path.join(SYNTH_ROOT, 'install-b')
const ROOT_BARE = path.join(SYNTH_ROOT, 'not-install-root')

/** 环境变量在 launch 之前就要位（helpers 的 launchEnv 展开 process.env；launchApp 不收 extraEnv） */
process.env.NIKKI_NIKKISYNC_GAME_ROOT = ROOT_BARE

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

/** 上游安装根发现判据的最小合成形态：X6Game 目录 + 主程序文件（0 字节）+ 照片根空目录 */
async function createInstallRootShape(root: string): Promise<void> {
  await fs.mkdir(path.join(root, 'X6Game', 'Saved', 'GamePlayPhotos'), { recursive: true })
  await fs.writeFile(path.join(root, 'X6Game', 'InfinityNikki.exe'), '')
}

let launched: LaunchedApp | undefined
let win: Page | undefined

test.describe.configure({ mode: 'serial' })

test.describe('照片目录保存即生效（真实应用会话）', () => {
  // 未建链 ⇒ 整件 skip（受支持的默认态），修复命令写在 reason 里。
  test.skip(gate.action === 'skip', gate.reason)

  test.beforeAll(async () => {
    test.setTimeout(150_000)
    await createInstallRootShape(ROOT_A)
    await createInstallRootShape(ROOT_B)
    await fs.mkdir(ROOT_BARE, { recursive: true })
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

  test('G1 桥直调 setGameRoot：applied:true 即时生效，installRoot 换到合成根 A', async () => {
    test.setTimeout(150_000)
    const page = win
    if (!page || !launched) {
      test.skip(true, '应用未启动')
      return
    }
    const result = await callGameRootBridge<GameRootApplyResult>(page, {
      method: 'setGameRoot',
      arg: { path: ROOT_A }
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
    const expectedRoot = path.win32.resolve(ROOT_A).toLowerCase()
    const actualRoot = path.win32
      .resolve(String(status.installation?.installRoot ?? ''))
      .toLowerCase()
    expect(actualRoot, `installRoot=${String(status.installation?.installRoot)}`).toBe(expectedRoot)
    expect(status.lastScan).toBeDefined()
  })

  test('G2 真实 UI 路径：照片目录节手输根 B 保存 ⇒ 即时生效文案可见、未生效文案不可见', async () => {
    test.setTimeout(150_000)
    const page = win
    if (!page) {
      test.skip(true, '应用未启动')
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
    await photoDirInput.fill(ROOT_B)
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
