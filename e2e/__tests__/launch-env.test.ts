/**
 * 子进程 env 闸门单测（缺陷复现见 docs/plans/2026-10-27-fix-e2e-smoke-host-env-run-as-node-and-stale-artifact.md）。
 *
 * 要收口的缺陷：宿主 shell 导出 ELECTRON_RUN_AS_NODE=1 时，helpers 用 `{ ...process.env }`
 * 把它原样透传给被启动的应用，打包 exe 因此退化成纯 Node 解释器，把 Chromium 开关
 * （--inspect=0 / --remote-debugging-port=0 / --user-data-dir=…）判为 `bad option`、
 * exitCode=9，S1~S8 连同 fullscreen-diagnose 全线倒在 launch 之前，且没有一条是断言失败。
 * 症状与产品回归一致，故判据必须落在「交给子进程的那份 env」上，而不是运行者的 shell。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { sanitizeLaunchEnv, ELECTRON_RUN_AS_NODE } from '../launch-env'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('sanitizeLaunchEnv：剥掉宿主泄漏的 ELECTRON_RUN_AS_NODE', () => {
  it('正常：含该键时剥除，其余键值逐字保留', () => {
    const input = {
      PATH: 'C:\\Windows',
      [ELECTRON_RUN_AS_NODE]: '1',
      NODE_ENV: 'production'
    }
    const out = sanitizeLaunchEnv(input)
    expect(ELECTRON_RUN_AS_NODE in out).toBe(false)
    // 把剥掉的那一项塞回去必须与入参完全相等 ⇒ 除它以外一个字节都没动
    expect({ ...out, [ELECTRON_RUN_AS_NODE]: '1' }).toEqual(input)
  })

  it('异常：入参本就不含该键时原样返回（CI / 系统终端不受影响）', () => {
    const input = { PATH: '/usr/bin', NODE_ENV: 'production' }
    expect(sanitizeLaunchEnv(input)).toBe(input)
  })

  it('边界：值为空串也剥（Electron 判的是变量是否存在，不看值）', () => {
    expect(ELECTRON_RUN_AS_NODE in sanitizeLaunchEnv({ [ELECTRON_RUN_AS_NODE]: '' })).toBe(false)
  })

  it('边界：纯函数，不修改入参', () => {
    const input = { [ELECTRON_RUN_AS_NODE]: 'true' }
    sanitizeLaunchEnv(input)
    expect(input).toEqual({ [ELECTRON_RUN_AS_NODE]: 'true' })
  })

  it('接线：helpers 两处 electron.launch 的 env 必须都走闸门', () => {
    // 钉住「以后新增的启动点也得走闸门」：一旦出现裸的 `{ ...process.env, NODE_ENV … }`
    // 直接判红——那正是本次缺陷的形态（宿主泄漏项被透传给应用进程）
    const helpers = readFileSync(path.join(repoRoot, 'e2e', 'helpers.ts'), 'utf-8')
    expect(helpers.match(/env: launchEnv\(/g)?.length).toBe(2)
    expect(helpers).not.toContain('env: { ...process.env')
  })
})
