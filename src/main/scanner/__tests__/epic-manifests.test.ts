import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseEpicManifests } from '../game-directory-discovery'

// G1 锁定测试：parseEpicManifests 必须按 spec 从
// %ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item|*.json 中
// 匹配 InfinityNikki 的安装目录（InstallLocation / AppName 含 infinitynikki），
// 且清单声明目录须真实存在才采纳。
describe('parseEpicManifests（G1 Epic 清单定位）', () => {
  let tmpRoot: string
  let manifestsDir: string
  let nikkiInstall: string
  let otherInstall: string
  let savedProgramData: string | undefined

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wxnn-epic-'))
    manifestsDir = path.join(tmpRoot, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')
    fs.mkdirSync(manifestsDir, { recursive: true })
    nikkiInstall = path.join(tmpRoot, 'InfinityNikki')
    otherInstall = path.join(tmpRoot, 'SomeOtherGame')
    fs.mkdirSync(nikkiInstall, { recursive: true })
    fs.mkdirSync(otherInstall, { recursive: true })

    savedProgramData = process.env.ProgramData
    process.env.ProgramData = tmpRoot
  })

  afterEach(() => {
    if (savedProgramData === undefined) delete process.env.ProgramData
    else process.env.ProgramData = savedProgramData
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('匹配 InfinityNikki 清单的安装目录（InstallLocation + AppName 均含关键字）', async () => {
    fs.writeFileSync(
      path.join(manifestsDir, 'infinity.item'),
      JSON.stringify({
        InstallLocation: nikkiInstall,
        AppName: 'InfinityNikki',
        DisplayName: 'Infinity Nikki'
      })
    )
    const results = await parseEpicManifests()
    expect(results).toContain(nikkiInstall)
  })

  it('忽略非 InfinityNikki 清单，且不采纳不存在的安装目录', async () => {
    fs.writeFileSync(
      path.join(manifestsDir, 'other.item'),
      JSON.stringify({ InstallLocation: otherInstall, AppName: 'SomeOtherGame' })
    )
    const missingDir = path.join(tmpRoot, 'DoesNotExist')
    fs.writeFileSync(
      path.join(manifestsDir, 'ghost.item'),
      JSON.stringify({ InstallLocation: missingDir, AppName: 'InfinityNikki' })
    )
    // 非 .item/.json 扩展名应跳过
    fs.writeFileSync(path.join(manifestsDir, 'readme.txt'), 'ignore me')
    const results = await parseEpicManifests()
    expect(results).not.toContain(otherInstall)
    expect(results).not.toContain(missingDir)
    expect(results).toHaveLength(0)
  })

  it('清单目录不存在时降级返回空，不抛异常', async () => {
    // 清空 ProgramData 到一个不存在的子树
    const empty = path.join(tmpRoot, 'nope')
    process.env.ProgramData = empty
    const results = await parseEpicManifests()
    expect(results).toEqual([])
  })
})
