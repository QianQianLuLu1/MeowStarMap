import { describe, it } from 'vitest'
import { glob } from 'tinyglobby'
import {
  searchByInstallTreeSignatureShallow,
  searchByMediaFolderSignatureShallow
} from '../game-directory-discovery'

describe('T0 诊断：函数 vs 手动 glob 对比', () => {
  it('对比 installTree 函数与手动 glob', async () => {
    const fnResult = await searchByInstallTreeSignatureShallow('H:\\', 8)
    console.log('[DIAG] searchByInstallTreeSignatureShallow =>', JSON.stringify(fnResult))

    const manual = await glob('**/{X6Game,InfinityNikki Launcher}', {
      cwd: 'H:\\',
      absolute: true,
      onlyDirectories: true,
      deep: 8,
      caseSensitiveMatch: false,
      followSymbolicLinks: false
    })
    console.log('[DIAG] manual glob count=', manual.length)
    const filtered: string[] = []
    for (const raw of manual) {
      const match = raw.replace(/[\\/]+$/, '')
      const normalized = match.replace(/\//g, '\\').toLowerCase()
      if (!normalized.includes('infinitynikki')) continue
      filtered.push(require('node:path').dirname(match))
    }
    console.log('[DIAG] manual filtered =>', JSON.stringify(Array.from(new Set(filtered))))

    const fnResult2 = await searchByMediaFolderSignatureShallow('H:\\', 8)
    console.log('[DIAG] searchByMediaFolderSignatureShallow =>', JSON.stringify(fnResult2))
  })
})
