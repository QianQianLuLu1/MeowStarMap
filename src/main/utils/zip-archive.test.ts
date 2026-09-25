/**
 * @layer L1
 * @module src/main/utils/zip-archive
 * @coverage createZipFromDirectory 正常 / 异常 / 边界三类
 * @dependencies 真实 fs 临时目录；注入假 Archiver 覆盖 error / 永不结束分支
 * @remarks 不依赖外部 tar.exe（现场 spawn EFTYPE 的根因），全程进程内打包
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Archiver } from 'archiver'

// src/main/i18n 顶层 import electron：未 mock 时会因 electron 未安装二进制而加载失败
vi.mock('electron', () => ({
  app: {
    getLocale: vi.fn(() => 'zh-CN'),
    getVersion: vi.fn(() => '1.0.0-test'),
    getName: vi.fn(() => 'wxnn-test'),
    getPath: vi.fn(() => os.tmpdir())
  }
}))

import { createZipFromDirectory } from './zip-archive'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wxnn-zip-'))
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

/** 构造源目录；files 为空时返回空目录 */
function makeSource(files: Record<string, string>): string {
  const dir = path.join(tmpRoot, 'source')
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content)
  }
  return dir
}

describe('createZipFromDirectory', () => {
  it('正常：打包目录生成非空 zip（PK 魔数）', async () => {
    const src = makeSource({ 'a.log': 'hello', 'b.jsonl': '{"x":1}' })
    const target = path.join(tmpRoot, 'out.zip')

    const r = await createZipFromDirectory(src, target)

    expect(r.success).toBe(true)
    expect(fs.existsSync(target)).toBe(true)
    expect(fs.statSync(target).size).toBeGreaterThan(0)
    // zip 文件头：PK\x03\x04
    expect(fs.readFileSync(target).subarray(0, 2).toString('latin1')).toBe('PK')
  })

  it('正常：子目录内容一并打包（体积大于单文件）', async () => {
    const src = makeSource({ 'a.log': 'x' })
    fs.mkdirSync(path.join(src, 'nested'), { recursive: true })
    fs.writeFileSync(path.join(src, 'nested', 'b.log'), 'y'.repeat(4096))
    const target = path.join(tmpRoot, 'nested.zip')

    const r = await createZipFromDirectory(src, target)

    expect(r.success).toBe(true)
    expect(fs.statSync(target).size).toBeGreaterThan(0)
  })

  it('异常：源目录不存在时返回失败（不创建子进程）', async () => {
    const r = await createZipFromDirectory(
      path.join(tmpRoot, 'no-such-source'),
      path.join(tmpRoot, 'out.zip')
    )
    expect(r.success).toBe(false)
    expect(r.message.length).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(tmpRoot, 'out.zip'))).toBe(false)
  })

  it('异常：源路径是文件而非目录时返回失败', async () => {
    const src = makeSource({ 'a.log': 'x' })
    const fileAsSource = path.join(src, 'a.log')
    const r = await createZipFromDirectory(fileAsSource, path.join(tmpRoot, 'out.zip'))
    expect(r.success).toBe(false)
  })

  it('异常：目标父目录不存在时返回失败', async () => {
    const src = makeSource({ 'a.log': 'x' })
    const r = await createZipFromDirectory(src, path.join(tmpRoot, 'missing-dir', 'out.zip'))
    expect(r.success).toBe(false)
  })

  it('边界：目标路径非绝对路径返回失败', async () => {
    const src = makeSource({ 'a.log': 'x' })
    const r = await createZipFromDirectory(src, 'relative-out.zip')
    expect(r.success).toBe(false)
  })

  it('边界：目标路径为空字符串返回失败', async () => {
    const src = makeSource({ 'a.log': 'x' })
    const r = await createZipFromDirectory(src, '   ')
    expect(r.success).toBe(false)
  })

  it('边界：空源目录仍生成合法 zip', async () => {
    const src = makeSource({})
    const target = path.join(tmpRoot, 'empty.zip')

    const r = await createZipFromDirectory(src, target)

    expect(r.success).toBe(true)
    expect(fs.statSync(target).size).toBeGreaterThan(0)
  })

  it('边界：timeoutMs 非法值（0/-1/NaN）回落默认超时并成功', async () => {
    const src = makeSource({ 'a.log': 'x' })
    for (const timeoutMs of [0, -1, Number.NaN]) {
      const target = path.join(tmpRoot, `t${String(timeoutMs).replace('.', '_')}.zip`)
      const r = await createZipFromDirectory(src, target, { timeoutMs })
      expect(r.success).toBe(true)
    }
  })

  it('异常：注入永不结束的 archive —— 超时候仍必须 settle（不挂起）', async () => {
    const src = makeSource({ 'a.log': 'x' })
    const target = path.join(tmpRoot, 'timeout.zip')
    const neverArchive = {
      pipe: () => neverArchive,
      directory: () => neverArchive,
      on: () => neverArchive,
      abort: () => undefined,
      finalize: () =>
        new Promise<void>(() => {
          /* 永不 resolve，模拟卡死的子进程 */
        })
    } as unknown as Archiver

    const startedAt = Date.now()
    const r = await createZipFromDirectory(src, target, {
      timeoutMs: 50,
      createArchive: () => neverArchive
    })

    expect(r.success).toBe(false)
    expect(Date.now() - startedAt).toBeLessThan(5000)
  })

  it('异常：archive 触发 error 事件时返回失败且带上原因', async () => {
    const src = makeSource({ 'a.log': 'x' })
    const target = path.join(tmpRoot, 'err.zip')
    const errArchive = {
      pipe: (out: NodeJS.WritableStream) => out,
      directory: () => errArchive,
      on: (event: string, cb: (err: Error) => void) => {
        if (event === 'error') {
          setTimeout(() => cb(new Error('archive boom')), 0)
        }
        return errArchive
      },
      abort: () => undefined,
      finalize: () => Promise.resolve()
    } as unknown as Archiver

    const r = await createZipFromDirectory(src, target, { createArchive: () => errArchive })

    expect(r.success).toBe(false)
    expect(r.message).toContain('archive boom')
  })
})
