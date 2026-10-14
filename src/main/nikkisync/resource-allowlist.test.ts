import { describe, expect, it, beforeEach } from 'vitest'
import path from 'node:path'
import {
  clearNikkiSyncResourcePaths,
  isNikkiSyncResourcePath,
  nikkiSyncResourcePathCount,
  registerNikkiSyncResourcePaths
} from './resource-allowlist'

/**
 * NikkiSync 资源路径授权表（阶段 4 · media:// 第 4 条规则的事实来源）。
 *
 * 这是**安全边界**的支撑件：`media://` 只能出示「渲染层被告知的确切文件」。
 * 因此本表刻意只做**精确匹配**，不做目录前缀授权（比既有规则 3 的
 * 「已索引 source_path 目录 + 扩展名白名单」更窄），并且：
 * - revision 变化即整表替换（旧资产路径不再可示，防止越权残留）；
 * - 条目数有硬上限并 FIFO 淘汰，避免长会话无界增长；
 * - `clear()` 后一律拒绝（Runtime 停止 / 未就绪态）。
 *
 * 扩展名白名单不在本表判：策略归 `media-protocol` 那道闸（职责分离），
 * 本文件只回答「这个确切路径是不是我们给出去过」。
 */

const IS_WIN = process.platform === 'win32'
const P = (s: string): string => (IS_WIN ? s : `/game${s}`)

describe('NikkiSync 资源授权表', () => {
  beforeEach(() => {
    clearNikkiSyncResourcePaths()
  })

  it('注册过的确切路径命中，未注册的同目录兄弟路径拒绝', () => {
    registerNikkiSyncResourcePaths(1, [P('D:\\Game\\X6Game\\a.png')])
    expect(isNikkiSyncResourcePath(P('D:\\Game\\X6Game\\a.png'))).toBe(true)
    // 同目录、没给出去过的文件：精确匹配必须挡住（不给目录级授权）
    expect(isNikkiSyncResourcePath(P('D:\\Game\\X6Game\\secret.txt'))).toBe(false)
    expect(isNikkiSyncResourcePath(P('D:\\Game\\X6Game\\sub\\b.png'))).toBe(false)
  })

  it('空注册不放开任何东西，空串与非字符串条目被忽略', () => {
    registerNikkiSyncResourcePaths(1, [])
    expect(nikkiSyncResourcePathCount()).toBe(0)
    expect(isNikkiSyncResourcePath('')).toBe(false)
    registerNikkiSyncResourcePaths(2, ['', '   '] as unknown[])
    expect(nikkiSyncResourcePathCount()).toBe(0)
    expect(isNikkiSyncResourcePath('   ')).toBe(false)
  })

  it('归一化：含 .. 与多余分隔符的请求路径与注册路径同一身份', () => {
    registerNikkiSyncResourcePaths(1, [
      path.resolve(IS_WIN ? 'D:\\Game\\X6Game' : '/game/x6', 'a.png')
    ])
    const base = IS_WIN ? 'D:\\Game\\X6Game' : '/game/x6'
    expect(isNikkiSyncResourcePath(`${base}${path.sep}..${path.sep}X6Game${path.sep}a.png`)).toBe(
      true
    )
    expect(isNikkiSyncResourcePath(`${base}${path.sep}${path.sep}a.png`)).toBe(true)
  })

  it(
    IS_WIN ? 'Windows 大小写不敏感（DB 存 D:\\，请求 d:\\ 不得裂图）' : '非 Windows 保留大小写敏感',
    () => {
      registerNikkiSyncResourcePaths(1, [P('D:\\Game\\X6Game\\A.PNG')])
      if (IS_WIN) {
        expect(isNikkiSyncResourcePath(P('d:\\game\\x6game\\a.png'))).toBe(true)
      } else {
        expect(isNikkiSyncResourcePath(P('D:\\Game\\X6Game\\A.PNG'))).toBe(true)
      }
    }
  )

  it('revision 变化即整表替换：旧资产路径不再可示', () => {
    registerNikkiSyncResourcePaths(1, [P('D:\\Game\\X6Game\\old.png')])
    expect(isNikkiSyncResourcePath(P('D:\\Game\\X6Game\\old.png'))).toBe(true)

    registerNikkiSyncResourcePaths(2, [P('D:\\Game\\X6Game\\new.png')])
    expect(isNikkiSyncResourcePath(P('D:\\Game\\X6Game\\new.png'))).toBe(true)
    // 扫描删掉的文件若仍留在表里，等于给已消失的资产永久授权
    expect(isNikkiSyncResourcePath(P('D:\\Game\\X6Game\\old.png'))).toBe(false)
  })

  it('同 revision 多次注册是追加而非覆盖（分页逐页登记）', () => {
    registerNikkiSyncResourcePaths(5, [P('D:\\a\\1.png')])
    registerNikkiSyncResourcePaths(5, [P('D:\\a\\2.png')])
    expect(isNikkiSyncResourcePath(P('D:\\a\\1.png'))).toBe(true)
    expect(isNikkiSyncResourcePath(P('D:\\a\\2.png'))).toBe(true)
    expect(nikkiSyncResourcePathCount()).toBe(2)
  })

  it('clear 后一律拒绝（Runtime 停止 / 未就绪态）', () => {
    registerNikkiSyncResourcePaths(1, [P('D:\\Game\\a.png')])
    clearNikkiSyncResourcePaths()
    expect(isNikkiSyncResourcePath(P('D:\\Game\\a.png'))).toBe(false)
    expect(nikkiSyncResourcePathCount()).toBe(0)
    // clear 之后重新注册须从空表开始，不能把旧条目带回来
    registerNikkiSyncResourcePaths(1, [P('D:\\Game\\b.png')])
    expect(isNikkiSyncResourcePath(P('D:\\Game\\a.png'))).toBe(false)
    expect(isNikkiSyncResourcePath(P('D:\\Game\\b.png'))).toBe(true)
  })

  it('条目有硬上限，超限按插入序淘汰最旧（防长会话无界增长）', () => {
    const many: string[] = []
    for (let i = 0; i < 40000; i += 1) many.push(P(`D:\\Game\\assets\\${i}.jpg`))
    registerNikkiSyncResourcePaths(1, many)
    const kept = nikkiSyncResourcePathCount()
    expect(kept).toBeLessThan(40000)
    expect(kept).toBeGreaterThan(0)
    // 淘汰的是最早插入的，最新登记的必须仍在表里
    expect(isNikkiSyncResourcePath(P('D:\\Game\\assets\\39999.jpg'))).toBe(true)
    expect(isNikkiSyncResourcePath(P('D:\\Game\\assets\\0.jpg'))).toBe(false)
  })

  it('重复注册同一路径不膨胀', () => {
    const p = P('D:\\Game\\dup.png')
    registerNikkiSyncResourcePaths(1, [p, p, p])
    expect(nikkiSyncResourcePathCount()).toBe(1)
  })
})
