/**
 * K8-a：recycle-helper 构建脚本纯函数层单测（参数拼装 / 路径探测 / 主流程分支）。
 *
 * 脚本本体是 `scripts/build-recycle-helper.cjs`（electron-builder dist:win 链首执行）；
 * 这里只测纯函数与注入依赖后的 `run()` 分支，**不真跑 csc.exe**——真实编译由
 * `npm run build:recycle-helper` 在 win32 宿主上验证（K8-a 验收），真实回收+恢复归 §13 人工验证。
 *
 * 运行：npx vitest run scripts/__tests__/build-recycle-helper.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { SpawnSyncReturns } from 'node:child_process'

/** `run()` 的注入依赖（脚本侧同形）。 */
interface RunDeps {
  projectRoot: string
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  spawn?: (
    file: string,
    args: string[],
    options: { windowsHide: boolean }
  ) => SpawnSyncReturns<Buffer>
  exists?: (path: string) => boolean
  log?: (message: string) => void
  error?: (message: string) => void
}

/** `build-recycle-helper.cjs` 的导出面（手写镜像，避免 TS 对 .cjs 的模块解析）。 */
interface RecycleHelperModule {
  HELPER_BASENAME: string
  resolveSourcePath(projectRoot: string): string
  resolveOutputPath(projectRoot: string): string
  /** 探测 csc.exe；`exists` 可注入 mock，缺失返回 null（调用方给可诊断错误，不静默）。 */
  resolveCscPath(
    env: Record<string, string | undefined>,
    exists?: (candidate: string) => boolean
  ): string | null
  buildCscArgs(sourcePath: string, outputPath: string): string[]
  run(deps?: RunDeps): number
}

const require_ = createRequire(import.meta.url)
const helper = require_('../build-recycle-helper.cjs') as RecycleHelperModule

describe('build-recycle-helper（K8-a 回收 helper 构建脚本，纯函数层）', () => {
  it('resolveSourcePath/resolveOutputPath：落在 resources/nikkisync/ 下，产物名固定', () => {
    expect(helper.resolveSourcePath('/repo')).toMatch(
      /resources[\\/]nikkisync[\\/]recycle-helper\.cs$/
    )
    expect(helper.resolveOutputPath('/repo')).toMatch(
      /resources[\\/]nikkisync[\\/]nikkisync-recycle-helper\.exe$/
    )
    expect(helper.HELPER_BASENAME).toBe('nikkisync-recycle-helper.exe')
  })

  it('resolveCscPath：%WINDIR% 参与拼装、exists 命中返回路径、缺失返回 null', () => {
    const exists = vi.fn((candidate: string) => candidate.endsWith('csc.exe'))
    const found = helper.resolveCscPath({ WINDIR: 'D:\\Win' }, exists)
    // 期望值用同款 path.join 计算，Linux CI（posix join）与 win32 宿主（win32 join）都成立
    expect(found).toBe(
      path.join('D:\\Win', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
    )
    expect(exists).toHaveBeenCalledWith(found)

    expect(helper.resolveCscPath({ WINDIR: 'D:\\Win' }, () => false)).toBeNull()
    // env 未给 WINDIR 时回落系统默认盘符路径形态
    const fallback = helper.resolveCscPath({}, () => true)
    expect(fallback).toMatch(/Microsoft\.NET[/\\]Framework64[/\\]v4\.0\.30319[/\\]csc\.exe$/)
  })

  it('buildCscArgs：/nologo /target:exe /out /r:Microsoft.VisualBasic.dll + 源文件，顺序稳定', () => {
    const args = helper.buildCscArgs('src\\recycle-helper.cs', 'out\\helper.exe')
    expect(args).toEqual([
      '/nologo',
      '/target:exe',
      '/out:out\\helper.exe',
      '/r:Microsoft.VisualBasic.dll',
      'src\\recycle-helper.cs'
    ])
  })

  it('run：非 win32 直接跳过（退出 0），不探测 csc 也不 spawn', () => {
    const log = vi.fn()
    const spawn = vi.fn()
    const code = helper.run({
      projectRoot: '/repo',
      platform: 'linux',
      spawn,
      log,
      error: vi.fn()
    })
    expect(code).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('skip'))
    expect(spawn).not.toHaveBeenCalled()
  })

  it('run：csc 缺失 ⇒ 退出 1 且 stderr 可诊断（点名 csc.exe），不 spawn 不静默', () => {
    const error = vi.fn()
    const spawn = vi.fn()
    const code = helper.run({
      projectRoot: '/repo',
      platform: 'win32',
      env: { WINDIR: 'C:\\Windows' },
      // 源文件存在、csc.exe 不存在——只否认 csc 才能走到探测分支
      exists: vi.fn((p: string) => p.endsWith('recycle-helper.cs')),
      spawn,
      log: vi.fn(),
      error
    })
    expect(code).toBe(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('csc.exe'))
    expect(spawn).not.toHaveBeenCalled()
  })

  it('run：编译成功且产物存在 ⇒ 退出 0，spawn 收到拼装好的 csc 参数', () => {
    const spawn = vi.fn(
      () =>
        ({
          status: 0,
          stdout: Buffer.from(''),
          stderr: Buffer.from('')
        }) as SpawnSyncReturns<Buffer>
    )
    // exists：csc.exe / 源文件 / 产物都放行（产物存在性由脚本检查）
    const exists = vi.fn(
      (p: string) =>
        p.endsWith('csc.exe') ||
        p.endsWith('recycle-helper.cs') ||
        p.endsWith('nikkisync-recycle-helper.exe')
    )
    const code = helper.run({
      projectRoot: '/repo',
      platform: 'win32',
      env: { WINDIR: 'C:\\Windows' },
      exists,
      spawn,
      log: vi.fn(),
      error: vi.fn()
    })
    expect(code).toBe(0)
    const [file, args, options] = spawn.mock.calls[0] as [
      string,
      string[],
      { windowsHide: boolean }
    ]
    expect(file).toBe(
      path.join('C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
    )
    // 参数形状：/nologo /target:exe /out:<output> /r:Microsoft.VisualBasic.dll <source>
    expect(args).toEqual([
      '/nologo',
      '/target:exe',
      `/out:${helper.resolveOutputPath('/repo')}`,
      '/r:Microsoft.VisualBasic.dll',
      helper.resolveSourcePath('/repo')
    ])
    expect(options).toEqual({ windowsHide: true })
  })

  it('run：csc 编译失败 ⇒ 退出 1 且编译器输出透传到 stderr（不静默）', () => {
    const error = vi.fn()
    const spawn = vi.fn(
      () =>
        ({
          status: 1,
          stdout: Buffer.from('CS1002: ; expected'),
          stderr: Buffer.from('')
        }) as unknown as SpawnSyncReturns<Buffer>
    )
    const code = helper.run({
      projectRoot: '/repo',
      platform: 'win32',
      env: { WINDIR: 'C:\\Windows' },
      exists: vi.fn((p: string) => p.endsWith('csc.exe') || p.endsWith('recycle-helper.cs')),
      spawn,
      log: vi.fn(),
      error
    })
    expect(code).toBe(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('CS1002'))
  })

  it('run：csc 报成功但产物缺失 ⇒ 退出 1（防假成功）', () => {
    const error = vi.fn()
    const spawn = vi.fn(
      () =>
        ({
          status: 0,
          stdout: Buffer.from(''),
          stderr: Buffer.from('')
        }) as SpawnSyncReturns<Buffer>
    )
    const code = helper.run({
      projectRoot: '/repo',
      platform: 'win32',
      env: { WINDIR: 'C:\\Windows' },
      // 只有 csc.exe 存在，产物 exe 不存在
      exists: vi.fn((p: string) => p.endsWith('csc.exe') || p.endsWith('recycle-helper.cs')),
      spawn,
      log: vi.fn(),
      error
    })
    expect(code).toBe(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('output missing'))
  })
})
