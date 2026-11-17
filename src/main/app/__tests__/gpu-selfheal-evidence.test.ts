/**
 * @layer L3
 * @module 启动期 GPU 自愈取证
 * @coverage writeSelfHealEvidence 行为 + 自愈重启/渲染崩溃前的留痕接线
 *
 * 修复前：启动期渲染崩溃走 requestSelfHeal 成功后直接 return 跳过错误框，
 * gpu-fallback 再静默 relaunch+exit(0)，且只写 diag.log（其写盘失败本身也是空 catch）
 * —— 用户看到「闪一下就没了」，事后连「为什么重启」都查不到。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as gpuFallback from '../gpu-fallback'
import { setForensicsEnvProvider } from '../../utils/forensics-dir'

type EvidenceFn = (
  reason: string,
  exitCode: number,
  exhausted: boolean,
  deps?: {
    log?: (stage: string, err: unknown) => void
    showFailure?: (err: unknown, stage: string) => void
  }
) => void

function getEvidence(): EvidenceFn {
  const mod = gpuFallback as unknown as { writeSelfHealEvidence?: EvidenceFn }
  expect(typeof mod.writeSelfHealEvidence, '缺少自愈留痕导出').toBe('function')
  return mod.writeSelfHealEvidence!
}

function readSrc(rel: string): string {
  const p = path.resolve(process.cwd(), rel)
  expect(fs.existsSync(p), `找不到 ${rel}`).toBe(true)
  return fs.readFileSync(p, 'utf8')
}

/** 只检查真实代码，剥离行注释 */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//')
      return idx === -1 ? line : line.slice(0, idx)
    })
    .join('\n')
}

// 默认通道修复后会真实写盘（logStartupError → 取证根 startup-errors.log）：
// 每用例把取证 provider 指向独立 tmp，afterEach 清理，防写真实 Documents。
// 这不弱化任何断言——注入 deps 的用例本就不触默认通道，只是多一层落点隔离。
let tmpBase: string

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-selfheal-evidence-'))
  setForensicsEnvProvider(() => ({
    isPackaged: true,
    defaultApp: false,
    exePath: path.join(tmpBase, 'app.exe')
  }))
})

afterEach(() => {
  setForensicsEnvProvider(null)
  fs.rmSync(tmpBase, { recursive: true, force: true })
})

describe('writeSelfHealEvidence（自愈重启前的可靠留痕）', () => {
  it('正常：未到顶时写重启留痕，不弹提示', () => {
    const log = vi.fn()
    const showFailure = vi.fn()
    getEvidence()('crashed', 1, false, { log, showFailure })

    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toBe('gpu-selfheal-relaunch')
    expect(String(log.mock.calls[0][1])).toContain('reason=crashed')
    expect(showFailure).not.toHaveBeenCalled()
  })

  it('异常：兼容档到顶时既留痕又给一次可见提示', () => {
    const log = vi.fn()
    const showFailure = vi.fn()
    getEvidence()('crashed', 1, true, { log, showFailure })

    expect(log.mock.calls[0][0]).toBe('gpu-selfheal-exhausted')
    expect(showFailure).toHaveBeenCalledTimes(1)
    expect(showFailure.mock.calls[0][1]).toBe('gpu-selfheal-exhausted')
  })

  it('边界：exitCode 非法归一为 -1；留痕抛错时仍继续给可见提示（fail-open）', () => {
    const showFailure = vi.fn()
    for (const code of [undefined, NaN, 'x'] as unknown as number[]) {
      expect(() =>
        getEvidence()('crashed', code, true, {
          log: () => {
            throw new Error('disk full')
          },
          showFailure
        })
      ).not.toThrow()
    }
    expect(showFailure).toHaveBeenCalledTimes(3)
  })

  it('边界：deps 非对象时不抛错，走默认通道', () => {
    expect(() => getEvidence()('crashed', 1, false, null as unknown as undefined)).not.toThrow()
  })
})

describe('writeSelfHealEvidence 默认通道（不注入 deps 的真实落盘行为）', () => {
  it('打包态 provider 指向 tmp：默认通道真实写出 startup-errors.log 且含 gpu-selfheal-relaunch', async () => {
    // 缺陷背景：默认通道曾走裸 require('../utils/startup-diagnostic')——electron-vite
    // 打包 CJS 产物中该相对路径不存在（MODULE_NOT_FOUND）→ 空 catch 静默 no-op；
    // vitest ESM 下 require 未定义同样 no-op。行为级钉住：不注入 deps 也必须真实留痕。
    vi.resetModules()
    // resetModules 后 forensics-dir / startup-diagnostic 均为新实例（路径缓存清零），
    // 须对新实例重新注入指向本用例 tmp 的 provider
    const { setForensicsEnvProvider: setProvider } = await import('../../utils/forensics-dir')
    setProvider(() => ({
      isPackaged: true,
      defaultApp: false,
      exePath: path.join(tmpBase, 'app.exe')
    }))
    const m = await import('../gpu-fallback')
    m.writeSelfHealEvidence('crashed', 1, false)

    const logPath = path.join(tmpBase, 'Diagnostics', 'startup-errors.log')
    expect(fs.existsSync(logPath), '默认通道必须真实写盘（裸 require 相对路径结构性失效）').toBe(
      true
    )
    expect(fs.readFileSync(logPath, 'utf8')).toContain('gpu-selfheal-relaunch')
  })
})

describe('自愈留痕接线（静态源码守卫）', () => {
  it('gpu-fallback.requestSelfHeal 在 app.relaunch() 之前写留痕', () => {
    const src = codeOnly(readSrc('src/main/app/gpu-fallback.ts'))
    expect(src).toContain('writeSelfHealEvidence')
    const writeIdx = src.indexOf('writeSelfHealEvidence(reason, exitCode, false)')
    const relaunchIdx = src.indexOf('app.relaunch()')
    expect(writeIdx).toBeGreaterThan(-1)
    expect(relaunchIdx).toBeGreaterThan(-1)
    expect(writeIdx).toBeLessThan(relaunchIdx)
  })

  it('window-manager 启动期渲染崩溃自愈 return 之前写 startup-renderer-gone 留痕', () => {
    expect(codeOnly(readSrc('src/main/app/window-manager.ts'))).toContain(
      "logStartupError('startup-renderer-gone'"
    )
  })

  it('默认通道不得用裸 require 相对路径（打包 CJS 产物 MODULE_NOT_FOUND / ESM 下 require 未定义）', () => {
    const src = codeOnly(readSrc('src/main/app/gpu-fallback.ts'))
    expect(src).not.toContain("require('../utils/startup-diagnostic')")
    expect(src).not.toContain("require('./native-load-guard')")
  })
})
