import { describe, expect, it, beforeEach, vi } from 'vitest'
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
 *
 * CI 复现装置（常驻）：把宿主 `path` 钉成 posix、`process.platform` 钉成 'linux'。
 * 表里的键全是 Windows 形态，开发机上宿主即 win32，撤掉生产侧的 win32 钉或撤掉无条件
 * 折叠都不会在开发机露馅；钉上之后两侧跑同一套断言，`path.posix.win32 === path.win32`
 * 保证被测代码里显式的 win32 不受本 mock 影响。
 * 工厂内必须动态 import：`vi.mock` 会被提升到文件顶部，引用顶层 import 绑定会撞 TDZ。
 */
vi.mock('path', async (importOriginal) => {
  const { posixHost } = await import('../../../tests/mocks/posix-host-path')
  return posixHost(importOriginal as () => Promise<unknown>)
})
vi.mock('node:path', async (importOriginal) => {
  const { posixHost } = await import('../../../tests/mocks/posix-host-path')
  return posixHost(importOriginal as () => Promise<unknown>)
})
Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })

const WIN_ROOT = 'D:\\Game\\X6Game'

describe('NikkiSync 资源授权表', () => {
  beforeEach(() => {
    clearNikkiSyncResourcePaths()
  })

  it('注册过的确切路径命中，未注册的同目录兄弟路径拒绝', () => {
    registerNikkiSyncResourcePaths(1, [`${WIN_ROOT}\\a.png`])
    expect(isNikkiSyncResourcePath(`${WIN_ROOT}\\a.png`)).toBe(true)
    // 同目录、没给出去过的文件：精确匹配必须挡住（不给目录级授权）
    expect(isNikkiSyncResourcePath(`${WIN_ROOT}\\secret.txt`)).toBe(false)
    expect(isNikkiSyncResourcePath(`${WIN_ROOT}\\sub\\b.png`)).toBe(false)
  })

  it('边界：前缀相似的更长文件名不得被当作已授权', () => {
    registerNikkiSyncResourcePaths(1, [`${WIN_ROOT}\\a.png`])
    expect(isNikkiSyncResourcePath(`${WIN_ROOT}\\a.pngx`)).toBe(false)
    // 目录名互为前缀也不构成授权
    expect(isNikkiSyncResourcePath('D:\\Game\\X6GameArchive\\a.png')).toBe(false)
  })

  it('空注册不放开任何东西，空串与非字符串条目被忽略', () => {
    registerNikkiSyncResourcePaths(1, [])
    expect(nikkiSyncResourcePathCount()).toBe(0)
    expect(isNikkiSyncResourcePath('')).toBe(false)
    registerNikkiSyncResourcePaths(2, ['', '   '] as unknown[])
    expect(nikkiSyncResourcePathCount()).toBe(0)
    expect(isNikkiSyncResourcePath('   ')).toBe(false)
    expect(isNikkiSyncResourcePath(42 as unknown)).toBe(false)
    expect(isNikkiSyncResourcePath(null as unknown)).toBe(false)
  })

  it('归一化：含 .. 与多余分隔符的请求路径与注册路径同一身份', () => {
    registerNikkiSyncResourcePaths(1, [`${WIN_ROOT}\\a.png`])
    expect(isNikkiSyncResourcePath(`${WIN_ROOT}\\..\\X6Game\\a.png`)).toBe(true)
    expect(isNikkiSyncResourcePath(`${WIN_ROOT}\\\\a.png`)).toBe(true)
    expect(isNikkiSyncResourcePath('D:\\Game\\X6Game\\sub\\..\\a.png')).toBe(true)
  })

  it('归一化：正斜杠写法与反斜杠写法同一身份（win32 语义与宿主无关）', () => {
    registerNikkiSyncResourcePaths(1, ['D:/Game/X6Game/a.png'])
    expect(isNikkiSyncResourcePath(`${WIN_ROOT}\\a.png`)).toBe(true)
    expect(isNikkiSyncResourcePath('D:\\Game\\X6Game\\..\\X6Game\\a.png')).toBe(true)
  })

  it('大小写不敏感：DB 存 D:\\Game\\X6Game\\A.PNG、请求 d:\\game\\x6game\\a.png 不得裂图', () => {
    registerNikkiSyncResourcePaths(1, [`${WIN_ROOT}\\A.PNG`])
    expect(isNikkiSyncResourcePath('d:\\game\\x6game\\a.png')).toBe(true)
    // 折叠只合并写法，不放宽到未登记的确切文件
    expect(isNikkiSyncResourcePath('d:\\game\\x6game\\b.png')).toBe(false)
  })

  it('revision 变化即整表替换：旧资产路径不再可示', () => {
    registerNikkiSyncResourcePaths(1, [`${WIN_ROOT}\\old.png`])
    expect(isNikkiSyncResourcePath(`${WIN_ROOT}\\old.png`)).toBe(true)

    registerNikkiSyncResourcePaths(2, [`${WIN_ROOT}\\new.png`])
    expect(isNikkiSyncResourcePath(`${WIN_ROOT}\\new.png`)).toBe(true)
    // 扫描删掉的文件若仍留在表里，等于给已消失的资产永久授权
    expect(isNikkiSyncResourcePath(`${WIN_ROOT}\\old.png`)).toBe(false)
  })

  it('同 revision 多次注册是追加而非覆盖（分页逐页登记）', () => {
    registerNikkiSyncResourcePaths(5, ['D:\\a\\1.png'])
    registerNikkiSyncResourcePaths(5, ['D:\\a\\2.png'])
    expect(isNikkiSyncResourcePath('D:\\a\\1.png')).toBe(true)
    expect(isNikkiSyncResourcePath('D:\\a\\2.png')).toBe(true)
    expect(nikkiSyncResourcePathCount()).toBe(2)
  })

  it('clear 后一律拒绝（Runtime 停止 / 未就绪态）', () => {
    registerNikkiSyncResourcePaths(1, ['D:\\Game\\a.png'])
    clearNikkiSyncResourcePaths()
    expect(isNikkiSyncResourcePath('D:\\Game\\a.png')).toBe(false)
    expect(nikkiSyncResourcePathCount()).toBe(0)
    // clear 之后重新注册须从空表开始，不能把旧条目带回来
    registerNikkiSyncResourcePaths(1, ['D:\\Game\\b.png'])
    expect(isNikkiSyncResourcePath('D:\\Game\\a.png')).toBe(false)
    expect(isNikkiSyncResourcePath('D:\\Game\\b.png')).toBe(true)
  })

  it('条目有硬上限，超限按插入序淘汰最旧（防长会话无界增长）', () => {
    const many: string[] = []
    for (let i = 0; i < 40000; i += 1) many.push(`D:\\Game\\assets\\${i}.jpg`)
    registerNikkiSyncResourcePaths(1, many)
    const kept = nikkiSyncResourcePathCount()
    expect(kept).toBeLessThan(40000)
    expect(kept).toBeGreaterThan(0)
    // 淘汰的是最早插入的，最新登记的必须仍在表里
    expect(isNikkiSyncResourcePath('D:\\Game\\assets\\39999.jpg')).toBe(true)
    expect(isNikkiSyncResourcePath('D:\\Game\\assets\\0.jpg')).toBe(false)
  })

  it('重复注册同一路径不膨胀', () => {
    const p = `${WIN_ROOT}\\dup.png`
    registerNikkiSyncResourcePaths(1, [p, p, p])
    expect(nikkiSyncResourcePathCount()).toBe(1)
  })

  it('相对路径登记后按 win32 归一为绝对键，读写同侧（异常输入不自愈成放行）', () => {
    registerNikkiSyncResourcePaths(1, ['Game\\X6Game\\a.png'])
    // 同一相对写法命中；换目录语境下的同一相对名不应被误判为已授权
    expect(isNikkiSyncResourcePath('Game\\X6Game\\a.png')).toBe(true)
    expect(isNikkiSyncResourcePath('Other\\X6Game\\a.png')).toBe(false)
  })
})
