import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildUpdateFeed, writeUpdateFeed } from '../generate-update-feed'

const roots: string[] = []

function fixture(): { root: string; installer: string; output: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'update-feed-test-'))
  roots.push(root)
  const installer = path.join(root, 'MeowStarMap-Installer-2.5.8.exe')
  const output = path.join(root, 'latest.yml')
  fs.writeFileSync(installer, Buffer.alloc(128 * 1024, 0x5a))
  return { root, installer, output }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('generate-update-feed', () => {
  it('sha512 必须分块读取，不得整文件载入内存', () => {
    const { root, installer, output } = fixture()
    const options = buildUpdateFeed(
      [`--installer=${installer}`, '--version=2.5.8', `--out=${output}`],
      root
    )
    options.releaseDate = '2026-11-26T00:00:00.000Z'
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('whole-file read is forbidden')
    })

    expect(() => writeUpdateFeed(options)).not.toThrow()
    readSpy.mockRestore()
    expect(fs.readFileSync(output, 'utf8')).toContain('version: 2.5.8')
  })

  it('feed 必须先写同目录临时文件再原子替换', () => {
    const { root, installer, output } = fixture()
    const options = buildUpdateFeed(
      [`--installer=${installer}`, '--version=2.5.8', `--out=${output}`],
      root
    )
    const renameSpy = vi.spyOn(fs, 'renameSync')

    writeUpdateFeed(options)

    expect(renameSpy).toHaveBeenCalledTimes(1)
    expect(String(renameSpy.mock.calls[0][0])).toContain('.latest.yml.tmp-')
    expect(String(renameSpy.mock.calls[0][1])).toBe(output)
  })
})
