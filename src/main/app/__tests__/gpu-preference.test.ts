/**
 * @layer L2
 * @module src/main/app/gpu-preference
 * @coverage 独显优先注册表策略：reg 参数构建 / 平台与打包守卫 / auto 只删自有格式值 / 全程 fail-open
 * @dependencies 注入式 run（不真实调 reg.exe）、electron (app)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockIsPackaged, diagLogMock } = vi.hoisted(() => ({
  mockIsPackaged: vi.fn(),
  diagLogMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { isPackaged: mockIsPackaged }
}))
vi.mock('../../utils/startup-diagnostic', () => ({ diagLog: diagLogMock }))

import {
  GPU_PREFERENCE_REG_KEY,
  MANAGED_GPU_PREFERENCE_VALUE,
  buildRegAddArgs,
  buildRegQueryArgs,
  buildRegDeleteArgs,
  applyDiscreteGpuPreference
} from '../gpu-preference'

const EXE = 'C:\\Program Files\\喵星图\\MeowStarMap.exe' // 含空格与非 ASCII，验证参数数组化无拼接

function makeRun() {
  return vi.fn(async (_args: string[]) => ({ stdout: '', stderr: '' }))
}

beforeEach(() => {
  mockIsPackaged.mockReset().mockReturnValue(true)
  diagLogMock.mockReset()
})

describe('reg 参数构建（纯函数）', () => {
  it('buildRegAddArgs：add + HKCU 键 + /v exe路径 + REG_SZ + 自有值 + /f', () => {
    expect(buildRegAddArgs(EXE)).toEqual([
      'add',
      GPU_PREFERENCE_REG_KEY,
      '/v',
      EXE,
      '/t',
      'REG_SZ',
      '/d',
      MANAGED_GPU_PREFERENCE_VALUE,
      '/f'
    ])
    expect(MANAGED_GPU_PREFERENCE_VALUE).toBe('GpuPreference=2;')
  })

  it('buildRegQueryArgs / buildRegDeleteArgs', () => {
    expect(buildRegQueryArgs(EXE)).toEqual(['query', GPU_PREFERENCE_REG_KEY, '/v', EXE])
    expect(buildRegDeleteArgs(EXE)).toEqual(['delete', GPU_PREFERENCE_REG_KEY, '/v', EXE, '/f'])
  })
})

describe('applyDiscreteGpuPreference（守卫与 fail-open）', () => {
  it('非 win32 平台 → skipped-platform，不执行任何 reg 命令', async () => {
    const run = makeRun()
    const r = await applyDiscreteGpuPreference('high-performance', {
      platform: 'darwin',
      run,
      execPath: EXE
    })
    expect(r.applied).toBe('skipped-platform')
    expect(run).not.toHaveBeenCalled()
  })

  it('dev（未打包）→ skipped-dev，不污染共享的 electron.exe 偏好', async () => {
    const run = makeRun()
    const r = await applyDiscreteGpuPreference('high-performance', {
      platform: 'win32',
      isPackaged: false,
      run,
      execPath: 'D:\\dev\\node_modules\\electron\\dist\\electron.exe'
    })
    expect(r.applied).toBe('skipped-dev')
    expect(run).not.toHaveBeenCalled()
  })

  it('high-performance（打包 + win32）→ 执行 reg add 并返回 set', async () => {
    const run = makeRun()
    const r = await applyDiscreteGpuPreference('high-performance', {
      platform: 'win32',
      isPackaged: true,
      run,
      execPath: EXE
    })
    expect(r.applied).toBe('set')
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(buildRegAddArgs(EXE))
  })

  it('mode 缺省 → 按 high-performance 处理（默认独显优先）', async () => {
    const run = makeRun()
    const r = await applyDiscreteGpuPreference(undefined, {
      platform: 'win32',
      isPackaged: true,
      run,
      execPath: EXE
    })
    expect(r.applied).toBe('set')
    expect(run).toHaveBeenCalledWith(buildRegAddArgs(EXE))
  })

  it('auto 且现值为自有格式 → 先 query 后 delete，返回 removed', async () => {
    const run = vi.fn(async (args: string[]) =>
      args[0] === 'query'
        ? { stdout: `    ${EXE}    REG_SZ    ${MANAGED_GPU_PREFERENCE_VALUE}\r\n`, stderr: '' }
        : { stdout: '', stderr: '' }
    )
    const r = await applyDiscreteGpuPreference('auto', {
      platform: 'win32',
      isPackaged: true,
      run,
      execPath: EXE
    })
    expect(r.applied).toBe('removed')
    expect(run).toHaveBeenNthCalledWith(1, buildRegQueryArgs(EXE))
    expect(run).toHaveBeenNthCalledWith(2, buildRegDeleteArgs(EXE))
  })

  it('auto 但现值为外来格式（用户/他工具设置）→ 不删除，返回 kept-foreign', async () => {
    const run = vi.fn(async (args: string[]) =>
      args[0] === 'query'
        ? { stdout: `    ${EXE}    REG_SZ    GpuPreference=1;\r\n`, stderr: '' }
        : { stdout: '', stderr: '' }
    )
    const r = await applyDiscreteGpuPreference('auto', {
      platform: 'win32',
      isPackaged: true,
      run,
      execPath: EXE
    })
    expect(r.applied).toBe('kept-foreign')
    expect(run).toHaveBeenCalledTimes(1) // 只 query，不 delete
  })

  it('auto 且值不存在（query 抛错或空输出）→ noop，不抛', async () => {
    const rejectRun = vi.fn(async (args: string[]) => {
      if (args[0] === 'query')
        throw new Error('ERROR: The system was unable to find the specified registry key or value.')
      return { stdout: '', stderr: '' }
    })
    const r1 = await applyDiscreteGpuPreference('auto', {
      platform: 'win32',
      isPackaged: true,
      run: rejectRun,
      execPath: EXE
    })
    expect(r1.applied).toBe('noop')

    const emptyRun = makeRun() // query 成功但输出无 REG_SZ
    const r2 = await applyDiscreteGpuPreference('auto', {
      platform: 'win32',
      isPackaged: true,
      run: emptyRun,
      execPath: EXE
    })
    expect(r2.applied).toBe('noop')
    expect(emptyRun).toHaveBeenCalledTimes(1)
  })

  it('reg add 执行失败 → 不抛，返回 noop 并带失败详情', async () => {
    const run = vi.fn(async () => {
      throw new Error('reg: command not found')
    })
    const r = await applyDiscreteGpuPreference('high-performance', {
      platform: 'win32',
      isPackaged: true,
      run,
      execPath: EXE
    })
    expect(r.applied).toBe('noop')
    expect(r.detail).toContain('reg: command not found')
  })

  it('auto 清理时 delete 失败 → 不抛，返回 noop 并带失败详情', async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === 'query')
        return { stdout: `    ${EXE}    REG_SZ    ${MANAGED_GPU_PREFERENCE_VALUE}\r\n`, stderr: '' }
      throw new Error('access denied')
    })
    const r = await applyDiscreteGpuPreference('auto', {
      platform: 'win32',
      isPackaged: true,
      run,
      execPath: EXE
    })
    expect(r.applied).toBe('noop')
    expect(r.detail).toContain('access denied')
  })
})
