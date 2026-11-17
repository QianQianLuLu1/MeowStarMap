/**
 * R4③：simulate-gpu-crash.cjs 收口到取证真相源的行为级单测。
 *
 * 2026-11-17 取证存储统一收口后，gpu-fallback.json 的生产读写侧（src/main/app/gpu-fallback.ts）
 * 一律走 getForensicsFilePath('gpu-fallback.json')；本脚本若仍写 userData 猜测路径，
 * 模拟标记生产侧读不到（脚本失效）。本套件钉住新写契约：
 *   - 显式覆盖（--userdata / NIKKI_USERDATA，语义=取证根目录）；
 *   - --exe 注入 install 分支（exe 同目录 Diagnostics）；
 *   - 默认态走真相源回退链（homedir\喵星图\Diagnostics）并如实 warn Documents 落点差异；
 *   - --reset 幂等、重复写入保留计数字段、互斥参数报错。
 *
 * 惯例同 build-recycle-helper.test.ts：createRequire 装载 .cjs + 手写导出面镜像 + 注入依赖，
 * 不真跑子进程；另有一条 `node --import tsx` 冒烟钉住真实运行缝（plain node 无法 require TS）。
 * 环境沙箱：USERPROFILE/HOME/APPDATA/TEMP/TMP 指 mkdtemp，afterEach 无条件还原+清理
 * （文件级成对收尾，属 test-teardown-guard 明文豁免形态，不入登记表）。
 *
 * 运行：npx vitest run scripts/__tests__/simulate-gpu-crash.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as forensics from '../../src/main/utils/forensics-dir'

/** run() 的注入依赖（脚本侧同形）。 */
interface RunDeps {
  argv?: string[]
  env?: Record<string, string | undefined>
  cwd?: string
  forensics?: typeof forensics | null
  log?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}

/** simulate-gpu-crash.cjs 的导出面（手写镜像，避免 TS 对 .cjs 的模块解析）。 */
interface SimulateGpuCrashModule {
  run(deps?: RunDeps): number
}

const require_ = createRequire(import.meta.url)
const script = require_('../simulate-gpu-crash.cjs') as SimulateGpuCrashModule
const scriptPath = fileURLToPath(new URL('../simulate-gpu-crash.cjs', import.meta.url))

/**
 * 装置态检测缝（与 src/main/utils/ci-linux-emulation.test.ts 自检同一标记）：
 * tests/ci-linux-node.setup.ts 激活时写 globalThis.__wxnnCiLinuxEmulation；
 * 普通 npm test / 真实 CI / win32 真机下为 undefined。
 */
const CI_LINUX_EMULATION_ACTIVE =
  (globalThis as Record<string, unknown>).__wxnnCiLinuxEmulation !== undefined

const ENV_KEYS = ['USERPROFILE', 'HOME', 'APPDATA', 'TEMP', 'TMP', 'NIKKI_USERDATA'] as const
let sandbox: string
let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-crash-sim-'))
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  process.env.USERPROFILE = sandbox
  process.env.HOME = sandbox
  process.env.APPDATA = path.join(sandbox, 'AppData', 'Roaming')
  process.env.TEMP = sandbox
  process.env.TMP = sandbox
  forensics.setForensicsEnvProvider(null)
})

afterEach(() => {
  forensics.setForensicsEnvProvider(null)
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(sandbox, { recursive: true, force: true })
})

const stateAt = (root: string): string => path.join(root, 'gpu-fallback.json')
const readState = (file: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>

/** 递归收集沙箱内所有 gpu-fallback.json 标记（「不写任何标记」断言用，不依赖具体落点猜测） */
function findMarkers(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (ent.name === 'gpu-fallback.json') out.push(p)
    }
  }
  walk(root)
  return out
}

describe('simulate-gpu-crash（取证根写契约，纯函数层）', () => {
  // 装置门控（仓库既有模式，同 nikkisync-baseline-pin 的 CI 门控）：本脚本是外部 CJS，
  // 其内部 require('node:fs'/'node:path') 不经装置轴 4/1（只有测试图里的 import 被 mock，
  // 见 tests/ci-linux-node.setup.ts 头注「已知失真」）——装置态下测试侧沙箱路径（/tmp/…）
  // 与脚本侧真实写盘路径（win32 解析成盘相对路径）分裂，凡经脚本真实写盘的用例必假红；
  // 真实 CI（ubuntu）两侧路径语义一致、恒绿。故仅装置态 skip，win32 真机与真实 CI 仍真实执行。
  it.skipIf(CI_LINUX_EMULATION_ACTIVE)(
    '--userdata 显式覆盖：标记落指定取证根，不触发真相源解析',
    () => {
      const root = path.join(sandbox, 'explicit-root')
      const log = vi.fn()
      const code = script.run({ argv: ['--userdata', root], forensics: null, log })
      expect(code).toBe(0)
      expect(readState(stateAt(root)).fallbackActive).toBe(true)
      expect(log.mock.calls.flat().join('\n')).toContain(stateAt(root))
    }
  )

  it.skipIf(CI_LINUX_EMULATION_ACTIVE)('NIKKI_USERDATA 环境变量覆盖（保留键，语义=取证根）', () => {
    const root = path.join(sandbox, 'env-root')
    const code = script.run({
      argv: [],
      env: { NIKKI_USERDATA: root },
      forensics: null,
      log: vi.fn()
    })
    expect(code).toBe(0)
    expect(readState(stateAt(root)).fallbackActive).toBe(true)
  })

  it.skipIf(CI_LINUX_EMULATION_ACTIVE)(
    '--exe 注入 install 分支：标记落 exe 同目录 Diagnostics',
    () => {
      const exePath = path.join(sandbox, 'install', '喵星图.exe')
      const code = script.run({ argv: ['--exe', exePath], forensics, log: vi.fn() })
      expect(code).toBe(0)
      const expected = path.join(sandbox, 'install', 'Diagnostics', 'gpu-fallback.json')
      expect(readState(expected).fallbackActive).toBe(true)
    }
  )

  it.skipIf(CI_LINUX_EMULATION_ACTIVE)(
    '--exe 相对路径按 cwd 解析为绝对路径后走 install 分支',
    () => {
      const code = script.run({
        argv: ['--exe', path.join('install', '喵星图.exe')],
        cwd: sandbox,
        forensics,
        log: vi.fn()
      })
      expect(code).toBe(0)
      const expected = path.join(sandbox, 'install', 'Diagnostics', 'gpu-fallback.json')
      expect(readState(expected).fallbackActive).toBe(true)
    }
  )

  it.skipIf(CI_LINUX_EMULATION_ACTIVE)(
    '默认态走真相源回退链（homedir 链）并 warn Documents 落点差异',
    () => {
      const warn = vi.fn()
      const code = script.run({ argv: [], forensics, log: vi.fn(), warn })
      expect(code).toBe(0)
      const expected = path.join(sandbox, '喵星图', 'Diagnostics', 'gpu-fallback.json')
      expect(readState(expected).fallbackActive).toBe(true)
      expect(warn.mock.calls.flat().join('\n')).toContain('Documents')
    }
  )

  it.skipIf(CI_LINUX_EMULATION_ACTIVE)('--reset 删除标记；不存在时幂等提示', () => {
    const root = path.join(sandbox, 'reset-root')
    expect(script.run({ argv: ['--userdata', root], forensics: null, log: vi.fn() })).toBe(0)
    expect(fs.existsSync(stateAt(root))).toBe(true)
    const log = vi.fn()
    expect(script.run({ argv: ['--userdata', root, '--reset'], forensics: null, log })).toBe(0)
    expect(fs.existsSync(stateAt(root))).toBe(false)
    expect(script.run({ argv: ['--userdata', root, '--reset'], forensics: null, log })).toBe(0)
    expect(log.mock.calls.flat().join('\n')).toContain('不存在')
  })

  it.skipIf(CI_LINUX_EMULATION_ACTIVE)(
    '重复写入保留 consecutiveFailures 等既有字段并提示重复',
    () => {
      const root = path.join(sandbox, 'repeat-root')
      fs.mkdirSync(root, { recursive: true })
      fs.writeFileSync(
        stateAt(root),
        JSON.stringify({ consecutiveFailures: 3, fallbackActive: true })
      )
      const log = vi.fn()
      expect(script.run({ argv: ['--userdata', root], forensics: null, log })).toBe(0)
      const state = readState(stateAt(root))
      expect(state.fallbackActive).toBe(true)
      expect(state.consecutiveFailures).toBe(3)
      expect(log.mock.calls.flat().join('\n')).toContain('重复')
    }
  )

  it('--userdata 与 --exe 互斥：报错退出 1，不写任何标记', () => {
    const error = vi.fn()
    const code = script.run({
      argv: ['--userdata', path.join(sandbox, 'a'), '--exe', path.join(sandbox, 'b.exe')],
      forensics,
      error
    })
    expect(code).toBe(1)
    expect(error).toHaveBeenCalled()
    expect(fs.existsSync(path.join(sandbox, 'a', 'gpu-fallback.json'))).toBe(false)
    expect(fs.existsSync(path.join(sandbox, 'Diagnostics', 'gpu-fallback.json'))).toBe(false)
  })

  it('真相源装载失败（plain node 误跑）：给出 npx tsx 指引并退出 1', () => {
    const error = vi.fn()
    const code = script.run({ argv: [], forensics: null, error })
    expect(code).toBe(1)
    expect(error.mock.calls.flat().join('\n')).toContain('tsx')
  })

  it('--exe 的值是另一个开关（--reset）：形态校验报错退出 1，不写任何标记', () => {
    // 缺陷背景：argValue 不校验值形态，`--exe --reset` 会把 --reset 当 exe 路径
    // 解析出 <--reset>/Diagnostics 写错根，且 --reset 语义被吞掉。
    const error = vi.fn()
    const code = script.run({
      argv: ['--exe', '--reset'],
      cwd: sandbox,
      forensics,
      error,
      log: vi.fn(),
      warn: vi.fn()
    })
    expect(code).toBe(1)
    expect(error).toHaveBeenCalled()
    expect(findMarkers(sandbox)).toEqual([])
  })

  it('--userdata 的值是空串：形态校验报错退出 1，不静默回落默认链', () => {
    // 缺陷背景：`--userdata ""` 被 argValue 当缺失静默回落 homedir 链——
    // 用户显式指定的取证根被无声丢弃，标记写到另一个根（脚本失效且无提示）。
    const error = vi.fn()
    const code = script.run({
      argv: ['--userdata', ''],
      cwd: sandbox,
      forensics,
      error,
      log: vi.fn(),
      warn: vi.fn()
    })
    expect(code).toBe(1)
    expect(error).toHaveBeenCalled()
    expect(findMarkers(sandbox)).toEqual([])
  })
})

describe('simulate-gpu-crash（文件形态）', () => {
  it('UTF-8 无 BOM 且文件末尾有尾随换行', () => {
    const bytes = fs.readFileSync(scriptPath)
    expect(bytes.length).toBeGreaterThan(0)
    expect(bytes[bytes.length - 1], '文件必须以换行结尾（POSIX 文本文件约定）').toBe(0x0a)
    const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    expect(hasBom, '源文件编码须为 UTF-8 无 BOM').toBe(false)
  })
})

describe('simulate-gpu-crash（真实运行缝冒烟）', () => {
  // 装置门控：轴 8（tests/mocks/ci-linux-child-process.ts）把 execFileSync 的 program/参数
  // 路径翻译成 CI 假路径（D:\home\runner\work\…），真实 tsx 子进程无法解析（装置已知失真，
  // 非产品缺陷）——真实子进程冒烟仅 win32 真机执行；真实 CI（ubuntu）无装置、照常执行。
  it.skipIf(CI_LINUX_EMULATION_ACTIVE)(
    'node --import tsx 直跑 --exe：标记真实落 install Diagnostics',
    () => {
      const exePath = path.join(sandbox, 'smoke-install', '喵星图.exe')
      execFileSync(process.execPath, ['--import', 'tsx', scriptPath, '--exe', exePath], {
        env: { ...process.env },
        timeout: 30000,
        windowsHide: true
      })
      const expected = path.join(sandbox, 'smoke-install', 'Diagnostics', 'gpu-fallback.json')
      expect(readState(expected).fallbackActive).toBe(true)
    },
    30000
  )
})
