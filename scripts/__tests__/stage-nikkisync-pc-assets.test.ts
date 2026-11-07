import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import { getFileInfo } from 'prettier'

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
 *
 * 末尾另含一组真实仓库契约：暂存资产是上游逐字派生物，`.prettierignore` 必须整目录
 * 豁免（否则 lint-staged 根键经 matchBase 命中任意深度 .md，pre-commit 的 prettier
 * --write 会改写逐字形态）。判据落在 prettier 自身的 ignore 判定（getFileInfo）上，
 * 全程用 import.meta.url 造 URL，免疫 ci-linux 装置对 path/cwd 的 mock。
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

  it('正常：清单 9 项，apply 时逐项拷贝且目标落在 resources/nikkisync/pc 下', () => {
    const planned = planPcAssets(upRoot, targetRoot)
    expect(planned).toHaveLength(9)
    expect(PC_ASSET_SPECS).toHaveLength(9)
    const existing = new Set<string>([upRoot, ...planned.map((item) => item.from)])
    const { port, copyFile } = fakeFs(existing)
    const warn = vi.fn()
    const res = stagePcAssets({ upRoot, targetRoot, apply: true, warn, fsPort: port })
    expect(res.status).toBe('applied')
    expect(res.copied).toHaveLength(9)
    expect(res.skipped).toEqual([])
    expect(copyFile).toHaveBeenCalledTimes(9)
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
    expect(copyFile).toHaveBeenCalledTimes(8)
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
    expect(dryRun.planned).toHaveLength(9)
    expect(dry.copyFile).not.toHaveBeenCalled()
  })

  it('B11 dry-run 也逐件检查上游源：缺件计入 skipped 且零写盘', () => {
    const planned = planPcAssets(upRoot, targetRoot)
    const missing = planned[2]!.from
    const existing = new Set<string>([
      upRoot,
      ...planned.map((item) => item.from).filter((item) => item !== missing)
    ])
    const { port, copyFile, mkdir } = fakeFs(existing)
    const warn = vi.fn()
    const res = stagePcAssets({ upRoot, targetRoot, warn, fsPort: port })
    expect(res.status).toBe('dry-run')
    expect(res.skipped).toContain(missing)
    expect(res.copied).toEqual([])
    expect(copyFile).not.toHaveBeenCalled()
    expect(mkdir).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })

  it('B11 目标逃逸出 targetRoot ⇒ 抛错且零写盘（防路径穿越）', () => {
    const planned = planPcAssets(upRoot, targetRoot)
    const existing = new Set<string>([upRoot, ...planned.map((item) => item.from)])
    const { port, copyFile, mkdir } = fakeFs(existing)
    const escaping = { from: 'docs/ESCAPE.md', to: path.join('..', '..', 'escape.txt') }
    expect(() =>
      stagePcAssets({
        upRoot,
        targetRoot,
        apply: true,
        fsPort: port,
        specs: [escaping]
      })
    ).toThrow(/escape/i)
    expect(copyFile).not.toHaveBeenCalled()
    expect(mkdir).not.toHaveBeenCalled()
  })
})

describe('真实仓库契约：上游逐字资产必须豁免 prettier', () => {
  const fileInfoOptions = {
    ignorePath: new URL('../../.prettierignore', import.meta.url),
    resolveConfig: false
  }

  it.each(PC_ASSET_SPECS.filter((spec) => spec.to.endsWith('.md')).map((spec) => spec.to))(
    'legal 文档 %s 被 .prettierignore 覆盖（--write/--check 两侧都跳过）',
    async (name) => {
      const info = await getFileInfo(
        new URL(`../../resources/nikkisync/pc/${name}`, import.meta.url),
        fileInfoOptions
      )
      expect(
        info.ignored,
        `${name} 未被 .prettierignore 豁免：pre-commit 会改写上游逐字形态，stage 重跑不再幂等`
      ).toBe(true)
    }
  )

  it('子目录资产同样被整目录条目覆盖（wechat/resize-icon.ps1）', async () => {
    const info = await getFileInfo(
      new URL('../../resources/nikkisync/pc/wechat/resize-icon.ps1', import.meta.url),
      fileInfoOptions
    )
    expect(info.ignored).toBe(true)
  })

  it('自检：判据非恒真——AGENTS.md 不在 ignore 内', async () => {
    const info = await getFileInfo(new URL('../../AGENTS.md', import.meta.url), fileInfoOptions)
    expect(info.ignored).toBe(false)
  })
})
