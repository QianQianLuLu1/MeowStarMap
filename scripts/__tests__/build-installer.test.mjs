import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { embedPayload } from '../installer-payload.mjs'

const roots = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('embedPayload', () => {
  it('短写也必须循环写完整，不能静默生成损坏载荷', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-payload-short-write-'))
    roots.push(root)
    const target = path.join(root, 'installer.exe')
    const payload = path.join(root, 'payload.zip')
    fs.writeFileSync(target, 'MZ')
    fs.writeFileSync(payload, 'payload')
    fs.writeFileSync(`${payload}.json`, '{}')
    const originalWrite = fs.writeSync
    vi.spyOn(fs, 'writeSync').mockImplementationOnce((fd, buffer, offset, length) =>
      originalWrite(fd, buffer, offset, Math.min(3, length))
    )

    embedPayload(target, payload)

    const bytes = fs.readFileSync(target)
    expect(bytes.length).toBe(2 + 7 + 2 + 24)
    const zipSize = Number(bytes.readBigUInt64LE(bytes.length - 24))
    const manifestSize = Number(bytes.readBigUInt64LE(bytes.length - 16))
    const zipOffset = bytes.length - 24 - zipSize - manifestSize
    expect(bytes.subarray(zipOffset, zipOffset + zipSize).toString()).toBe('payload')
  })

  it('写入失败也必须关闭两个句柄并清理临时 exe', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-payload-test-'))
    roots.push(root)
    const target = path.join(root, 'installer.exe')
    const payload = path.join(root, 'payload.zip')
    fs.writeFileSync(target, 'MZ')
    fs.writeFileSync(payload, 'payload')
    fs.writeFileSync(`${payload}.json`, '{}')
    const opened = []
    const originalOpen = fs.openSync
    vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
      const fd = originalOpen(...args)
      opened.push(fd)
      return fd
    })
    const closeSpy = vi.spyOn(fs, 'closeSync')
    vi.spyOn(fs, 'writeSync').mockImplementationOnce(() => {
      throw new Error('disk full')
    })

    expect(() => embedPayload(target, payload)).toThrow('disk full')

    const [outFd, inputFd] = opened.slice(-2)
    expect(closeSpy).toHaveBeenCalledWith(outFd)
    expect(closeSpy).toHaveBeenCalledWith(inputFd)
    expect(fs.existsSync(`${target}.embedding`)).toBe(false)
    expect(fs.readFileSync(target, 'utf8')).toBe('MZ')
  })
})
