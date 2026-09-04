/**
 * @layer L1
 * @module src/main/scanner/uid-discovery（隐藏目录遍历）
 * @coverage GamePlayPhotos 为隐藏目录时，其下纯数字 UID 子目录仍被强制递归发现（spec 二.1）
 * @dependencies node:fs / node:os / node:child_process（真实 IO，无 mock）
 * @remarks Windows 下通过 attrib +h 设置隐藏属性以验证遍历不依赖 FILE_ATTRIBUTE_HIDDEN 过滤；
 *          非 Windows 跳过属性设置，仍验证常规遍历，证明发现逻辑与目录属性无关。
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync } from 'node:child_process'
import { discoverUidsFromGameDirs } from '../uid-discovery'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-hidden-'))

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

/** 在 Windows 上设置隐藏属性；其余平台静默跳过（隐藏是 Windows 专属概念） */
function makeHidden(p: string): void {
  if (process.platform === 'win32') {
    try {
      execSync(`attrib +h "${p}"`)
    } catch {
      // attrib 不可用：仅验证常规遍历
    }
  }
}

function gppRoot(suffix: string): string {
  // 每个用例用独立父目录，但 GamePlayPhotos 段必须精确（findGamePlayPhotosDir 按段精确匹配）
  return path.join(tmpRoot, suffix, 'GamePlayPhotos')
}

describe('GamePlayPhotos 隐藏目录强制遍历', () => {
  it('隐藏属性的纯数字 UID 子目录仍被动态发现', () => {
    const gpp = gppRoot('case1')
    const hiddenUid = path.join(gpp, '123456789')
    fs.mkdirSync(path.join(hiddenUid, 'NikkiPhotos_HighQuality'), { recursive: true })
    makeHidden(hiddenUid)

    const result = discoverUidsFromGameDirs([path.join(hiddenUid, 'NikkiPhotos_HighQuality')])

    expect(result).toEqual(['123456789'])
  })

  it('常规（非隐藏）UID 子目录同样被发现，证明发现逻辑与目录属性无关', () => {
    const gpp = gppRoot('case2')
    const uid = path.join(gpp, '987654321')
    fs.mkdirSync(path.join(uid, 'NikkiPhotos_LowQuality'), { recursive: true })

    const result = discoverUidsFromGameDirs([path.join(uid, 'NikkiPhotos_LowQuality')])

    expect(result).toEqual(['987654321'])
  })

  it('同一 GamePlayPhotos 下多个（含隐藏）UID 全部被发现并去重', () => {
    const gpp = gppRoot('case3')
    const uidA = path.join(gpp, '111111111')
    const uidB = path.join(gpp, '222222222')
    fs.mkdirSync(path.join(uidA, 'NikkiPhotos_HighQuality'), { recursive: true })
    fs.mkdirSync(path.join(uidB, 'NikkiPhotos_HighQuality'), { recursive: true })
    makeHidden(uidA)

    const result = discoverUidsFromGameDirs([
      path.join(uidA, 'NikkiPhotos_HighQuality'),
      path.join(uidB, 'NikkiPhotos_HighQuality')
    ])

    expect(result.sort()).toEqual(['111111111', '222222222'])
  })
})
