/**
 * atomic-file 原子落盘工具单测（fix-thumbnail-display-and-latency N2）
 *
 * 缺陷背景：缩略图直接写最终路径，渲染进程经 media:// 流式读取可能读到半截 JPEG。
 * 契约：writeFileAtomic 先写同目录 `.tmp-` 临时文件，成功后 rename 原子替换；
 * 任何失败清理临时文件并上抛，最终路径要么是旧完整文件、要么是新完整文件。
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { writeFileAtomic, tempSiblingPath } from './atomic-file'

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
