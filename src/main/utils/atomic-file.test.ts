/**
 * atomic-file 原子落盘工具单测（fix-thumbnail-display-and-latency N2）
 *
 * 缺陷背景：缩略图直接写最终路径，渲染进程经 media:// 流式读取可能读到半截 JPEG。
 * 契约：writeFileAtomic 先写同目录 `.tmp-` 临时文件，成功后 rename 原子替换；
 * 任何失败清理临时文件并上抛，最终路径要么是旧完整文件、要么是新完整文件。
 * 2026-11-03 追加同步版 writeFileAtomicSync：给「必须抢在进程被打死之前落完」的状态文件用
 * （gpu-fallback.json / gpu-pref.json / last-exit.json），异步版对这些调用点不适用——
 * await 一次就可能落在原生 FATAL 之后，且启动/退出链整条都是同步的。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { writeFileAtomic, writeFileAtomicSync, tempSiblingPath } from './atomic-file'

describe('writeFileAtomic（N2 原子落盘）', () => {
  const tmpRoot = path.join(
    os.tmpdir(),
    'wxnn-atomic-file-test',
    `run-${process.pid}-${Date.now()}`
  )
  const finalPath = path.join(tmpRoot, 'abc.jpg')

  const tmpResidue = () => fs.readdirSync(tmpRoot).filter((n) => n.includes('.tmp-'))

  afterEach(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('正常：写入临时文件后 rename 为最终路径，无临时残留', async () => {
    fs.mkdirSync(tmpRoot, { recursive: true })
    await writeFileAtomic(finalPath, async (tmp) => {
      expect(tmp).toContain('.tmp-')
      expect(path.dirname(tmp)).toBe(tmpRoot)
      fs.writeFileSync(tmp, Buffer.alloc(16, 0xff))
    })
    expect(fs.existsSync(finalPath)).toBe(true)
    expect(fs.statSync(finalPath).size).toBe(16)
    expect(tmpResidue()).toHaveLength(0)
  })

  it('异常：写入中断 → 临时文件被清理，最终路径不残留', async () => {
    fs.mkdirSync(tmpRoot, { recursive: true })
    await expect(
      writeFileAtomic(finalPath, async (tmp) => {
        fs.writeFileSync(tmp, Buffer.alloc(8, 0x33)) // 半截
        throw new Error('写盘中断（mock）')
      })
    ).rejects.toThrow('写盘中断')
    expect(fs.existsSync(finalPath)).toBe(false)
    expect(tmpResidue()).toHaveLength(0)
  })

  it('边界：写入函数未产出临时文件（rename 失败）→ 错误上抛且最终路径不受影响', async () => {
    fs.mkdirSync(tmpRoot, { recursive: true })
    await expect(
      writeFileAtomic(finalPath, async () => {
        /* 不写任何文件 */
      })
    ).rejects.toThrow()
    expect(fs.existsSync(finalPath)).toBe(false)
  })

  it('边界：已有旧最终文件时写入失败 → 旧文件保持完整（不被半截内容覆盖）', async () => {
    fs.mkdirSync(tmpRoot, { recursive: true })
    const oldBytes = Buffer.alloc(64, 0xff)
    fs.writeFileSync(finalPath, oldBytes)
    await expect(
      writeFileAtomic(finalPath, async (tmp) => {
        fs.writeFileSync(tmp, Buffer.alloc(8, 0x33))
        throw new Error('写盘中断（mock）')
      })
    ).rejects.toThrow('写盘中断')
    expect(fs.readFileSync(finalPath).equals(oldBytes)).toBe(true)
    expect(tmpResidue()).toHaveLength(0)
  })

  it('tempSiblingPath：与最终路径同目录、含 .tmp- 标记', () => {
    const tmp = tempSiblingPath(path.join(tmpRoot, 'abc.jpg'))
    expect(path.dirname(tmp)).toBe(tmpRoot)
    expect(path.basename(tmp)).toMatch(/^\.abc\.jpg\.tmp-/)
  })
})

/**
 * 同步版的契约（2026-11-03，状态文件半截写入缺陷）。
 *
 * 两档失败必须分开判：内容写入被打断 ⇒ 最终路径**一个字节都不许动**（此时回落直接写
 * 就等于把半截覆盖请回来）；rename 失败（本机防护软件对新落文件抓句柄 ⇒ EPERM/EBUSY）
 * ⇒ 回落直接写，数据不丢优先于原子性。
 */
describe('writeFileAtomicSync（同步原子落盘）', () => {
  const syncRoot = path.join(
    os.tmpdir(),
    'wxnn-atomic-sync-test',
    `run-${process.pid}-${Date.now()}`
  )
  const finalPath = path.join(syncRoot, 'gpu-fallback.json')
  const residue = () => fs.readdirSync(syncRoot).filter((n) => n.includes('.tmp-'))

  afterEach(() => {
    try {
      fs.rmSync(syncRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('正常：一次写入即落最终路径，目录内无临时残留', () => {
    fs.mkdirSync(syncRoot, { recursive: true })
    writeFileAtomicSync(finalPath, '{"compatLevel":2}')
    expect(fs.readFileSync(finalPath, 'utf-8')).toBe('{"compatLevel":2}')
    expect(residue()).toHaveLength(0)
  })

  it('边界：最终文件已存在 → 完整替换（Windows 上 rename 会替换已存在目标）', () => {
    fs.mkdirSync(syncRoot, { recursive: true })
    fs.writeFileSync(finalPath, '{"compatLevel":0}')
    writeFileAtomicSync(finalPath, '{"compatLevel":2}')
    expect(fs.readFileSync(finalPath, 'utf-8')).toBe('{"compatLevel":2}')
    expect(residue()).toHaveLength(0)
  })

  it('异常：内容写入被打断 → 最终路径保持旧内容、临时被清、错误上抛（不得回落直接写）', () => {
    fs.mkdirSync(syncRoot, { recursive: true })
    const old = '{"compatLevel":2}'
    fs.writeFileSync(finalPath, old)
    const realWrite = fs.writeFileSync.bind(fs)
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((
      target: Parameters<typeof fs.writeFileSync>[0],
      data: unknown
    ) => {
      realWrite(target, String(data).slice(0, 4)) // 只落前缀，模拟写到一半就死
      throw new Error('simulated kill before write completed')
    }) as unknown as typeof fs.writeFileSync)
    try {
      expect(() => writeFileAtomicSync(finalPath, '{"compatLevel":1}')).toThrow('simulated kill')
      expect(fs.readFileSync(finalPath, 'utf-8'), '半截写入不得覆盖最终文件').toBe(old)
      expect(residue()).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
  })

  it('异常：rename 失败 → 回落直接写（数据不丢优先于原子性），且不留临时文件', () => {
    fs.mkdirSync(syncRoot, { recursive: true })
    fs.writeFileSync(finalPath, '{"compatLevel":0}')
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
    })
    try {
      expect(() => writeFileAtomicSync(finalPath, '{"compatLevel":2}')).not.toThrow()
      expect(fs.readFileSync(finalPath, 'utf-8')).toBe('{"compatLevel":2}')
      expect(residue()).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
  })
})
