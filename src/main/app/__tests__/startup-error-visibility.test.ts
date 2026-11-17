/**
 * @layer L3
 * @module 启动失败出口
 * @coverage showStartupFailureWithFallback 行为 + 默认弹框不静默短路 + 误导文案订正
 * @dependencies fs / path（只读源码与 locale 文本）
 *
 * 修复前的三类静默路径：
 *   1. startup-environment.ts / native-load-guard.ts 的 defaultShowErrorBox 用
 *      `electron.dialog?.showErrorBox(...)`，dialog 为 undefined 时可选链直接短路，
 *      既不弹框也不进 catch —— 用户什么也看不到。
 *   2. lifecycle.ts 三处 dialog 的 catch 只 logStartupError 就 app.quit()/exit()。
 *   3. zh-CN.json 把「另一个进程仍存活」误写成「单实例锁未释放」（OS 命名互斥体
 *      随进程死亡自动回收，不存在可残留的锁）。
 */
import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import * as nativeGuard from '../native-load-guard'

type FallbackDeps = {
  showErrorBox?: (title: string, content: string) => void
  log?: (stage: string, err: unknown) => void
  getLogPath?: () => string
}
type FallbackFn = (
  err: unknown,
  opts?: { title?: string; stage?: string; deps?: FallbackDeps }
) => void

function getFallback(): FallbackFn {
  const mod = nativeGuard as unknown as { showStartupFailureWithFallback?: FallbackFn }
  expect(typeof mod.showStartupFailureWithFallback, '缺少统一可见兜底导出').toBe('function')
  return mod.showStartupFailureWithFallback!
}

function readSrc(rel: string): string {
  const p = path.resolve(process.cwd(), rel)
  expect(fs.existsSync(p), `找不到 ${rel}`).toBe(true)
  return fs.readFileSync(p, 'utf8')
}

function countOccurrences(src: string, needle: string): number {
  return src.split(needle).length - 1
}

/** 只检查真实代码：剥离行注释，避免历史说明里的旧写法误触发/凑数 */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//')
      return idx === -1 ? line : line.slice(0, idx)
    })
    .join('\n')
}

describe('showStartupFailureWithFallback（启动失败统一可见兜底）', () => {
  it('正常：P0 弹框与同步落盘都被调用，且使用传入标题', () => {
    const showErrorBox = vi.fn()
    const log = vi.fn()
    getFallback()(new Error('boom'), {
      title: '清理失败',
      stage: 'gotLock-false-dialog-fallback',
      deps: { showErrorBox, log, getLogPath: () => '/mock/startup-errors.log' }
    })
    expect(showErrorBox).toHaveBeenCalledTimes(1)
    expect(String(showErrorBox.mock.calls[0][0])).toContain('清理失败')
    expect(String(showErrorBox.mock.calls[0][1])).toContain('boom')
    expect(log).toHaveBeenCalledWith('gotLock-false-dialog-fallback', expect.anything())
  })

  it('异常：弹框通道抛错时仍必须落盘，且不把异常抛回 unhandledRejection', () => {
    const log = vi.fn()
    expect(() =>
      getFallback()(new Error('boom'), {
        deps: {
          showErrorBox: () => {
            throw new Error('dialog unavailable')
          },
          log,
          getLogPath: () => ''
        }
      })
    ).not.toThrow()
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('边界：err=null / 非法 opts / getLogPath 返回非字符串时仍落盘且用默认标题', () => {
    const showErrorBox = vi.fn()
    const log = vi.fn()
    expect(() =>
      getFallback()(null, {
        title: 42 as unknown as string,
        stage: '' as unknown as string,
        deps: {
          showErrorBox,
          log,
          getLogPath: (() => 123) as unknown as () => string
        }
      })
    ).not.toThrow()
    expect(showErrorBox).toHaveBeenCalledTimes(1)
    expect(String(showErrorBox.mock.calls[0][0])).toContain('启动失败')
    expect(log).toHaveBeenCalledTimes(1)
  })
})

describe('默认错误框不再静默短路（静态源码守卫）', () => {
  it('startup-environment.ts 的默认弹框改走统一兜底，且不再用可选链短路', () => {
    const src = codeOnly(readSrc('src/main/app/startup-environment.ts'))
    expect(src).toContain('showStartupFailureWithFallback')
    expect(src).not.toContain('electron.dialog?.showErrorBox')
  })

  it('native-load-guard.ts 的默认弹框改走统一兜底，且不再用可选链短路', () => {
    const src = codeOnly(readSrc('src/main/app/native-load-guard.ts'))
    expect(src).toContain('showStartupFailureWithFallback')
    expect(src).not.toContain('electron.dialog?.showErrorBox')
  })

  it('三处被吞的 dialog catch 都补上可见兜底（R1 后锁块 catch 随迁 single-instance.ts）', () => {
    // R1（2026-11-15）：锁获取/失败路径前移到 single-instance.ts，两处 dialog catch
    // （gotLock-false-dialog / cleanup-failed-dialog）随之迁移；lifecycle 仅保留
    // fatal catch 的兜底。三处合计：import + catch 各文件计数如下。
    const lifecycleSrc = codeOnly(readSrc('src/main/app/lifecycle.ts'))
    // import 语句 1 次 + fatal catch 1 次
    expect(countOccurrences(lifecycleSrc, 'showStartupFailureWithFallback')).toBeGreaterThanOrEqual(
      2
    )
    const singleInstanceSrc = codeOnly(readSrc('src/main/app/single-instance.ts'))
    // import 语句 1 次 + 两处 dialog catch（对话框失败 / 清理失败框失败）
    expect(
      countOccurrences(singleInstanceSrc, 'showStartupFailureWithFallback')
    ).toBeGreaterThanOrEqual(3)
  })
})

describe('「已有实例运行」文案订正', () => {
  it('zh-CN 的 detail 不再误称「单实例锁未释放」，改为「仍在运行」', () => {
    const json = JSON.parse(readSrc('src/renderer/i18n/locales/zh-CN.json')) as {
      main: { dialog: { instanceRunning: { detail: string } } }
    }
    const detail = json.main.dialog.instanceRunning.detail
    expect(detail).not.toContain('单实例锁未释放')
    expect(detail).toContain('仍在运行')
  })
})
