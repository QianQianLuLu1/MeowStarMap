import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'

import {
  PC_ASSET_SPECS,
  planPcAssets,
  stagePcAssets,
  type StageFsPort
} from '../stage-nikkisync-pc-assets'

/**
 * N7 `stage-nikkisync-pc-assets.ts` 纯函数单测（正常 / 异常 / 边界三类）。
 *
 * 全部 IO 经 `StageFsPort` 注入，不依赖真实 UP 检出与 junction（CI `npm ci` 无链接）：
 * 这正是「UP 根找不到时 warn + skipped、不阻断」能在 CI 上被测到的前提。
 */
function fakeFs(existing: Set<string>) {
  const copyFile = vi.fn()
  const mkdir = vi.fn()
  const port: StageFsPort = {
    exists: (p) => existing.has(p),
    mkdir,
    copyFile
  }
  return { port, copyFile, mkdir }
}

describe('stage-nikkisync-pc-assets（N7 资源暂存）', () => {
  const upRoot = 'D:/UP/NikkiSync'
  const targetRoot = 'D:/ROOT/resources/nikkisync/pc'

  it('正常：清单 8 项，apply 时逐项拷贝且目标落在 resources/nikkisync/pc 下', () => {
    const planned = planPcAssets(upRoot, targetRoot)
    expect(planned).toHaveLength(8)
    expect(PC_ASSET_SPECS).toHaveLength(8)
    const existing = new Set<string>([upRoot, ...planned.map((item) => item.from)])
    const { port, copyFile } = fakeFs(existing)
    const warn = vi.fn()
    const res = stagePcAssets({ upRoot, targetRoot, apply: true, warn, fsPort: port })
    expect(res.status).toBe('applied')
    expect(res.copied).toHaveLength(8)
    expect(res.skipped).toEqual([])
    expect(copyFile).toHaveBeenCalledTimes(8)
    for (const item of planned) {
      // path.join 在 win32 宿主用反斜杠，比较前统一 normalize（约定 §6 只当键用）
      expect(item.to.startsWith(path.normalize(targetRoot))).toBe(true)
    }
  })

  it('异常：个别源文件缺失 ⇒ warn + 跳过该文件，其余照拷，不阻断', () => {
    const planned = planPcAssets(upRoot, targetRoot)
    const missing = planned[3]!.from
    const existing = new Set<string>([
      upRoot,
      ...planned.map((item) => item.from).filter((item) => item !== missing)
    ])
    const { port, copyFile } = fakeFs(existing)
    const warn = vi.fn()
    const res = stagePcAssets({ upRoot, targetRoot, apply: true, warn, fsPort: port })
    expect(res.status).toBe('applied')
    expect(res.skipped).toContain(missing)
    expect(res.warnings.length).toBeGreaterThan(0)
    expect(warn).toHaveBeenCalled()
    expect(copyFile).toHaveBeenCalledTimes(7)
  })

  it('边界：UP 根缺失 ⇒ warn + skipped 且零拷贝；dry-run 默认也零拷贝', () => {
    const { port, copyFile } = fakeFs(new Set<string>())
    const warn = vi.fn()
    const skipped = stagePcAssets({ upRoot, targetRoot, apply: true, warn, fsPort: port })
    expect(skipped.status).toBe('skipped')
    expect(skipped.copied).toEqual([])
    expect(copyFile).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()

    const planned = planPcAssets(upRoot, targetRoot)
    const existing = new Set<string>([upRoot, ...planned.map((item) => item.from)])
    const dry = fakeFs(existing)
    const dryRun = stagePcAssets({ upRoot, targetRoot, warn, fsPort: dry.port })
    expect(dryRun.status).toBe('dry-run')
    expect(dryRun.planned).toHaveLength(8)
    expect(dry.copyFile).not.toHaveBeenCalled()
  })
})
