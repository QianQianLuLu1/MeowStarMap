/**
 * @layer L1
 * @module src/main/utils/forensics-dir
 * @coverage 取证根目录解析三态矩阵（install / fallback / dev）+ 入参守卫 + 缓存与 provider 重置
 * @dependencies fs / os / path（真实临时目录）、user-diag-path（回落链）
 *
 * 测试策略：vi.resetModules + 动态 import 实现用例间隔离（模块级缓存与两个 provider
 * 均随 resetModules 复位）；每个用例自行注册 forensics/documents provider 指向临时目录。
 * 关键判别事实（2026-11-17 探针实证）：Electron 41 下 `electron.exe <显式 app 目录>`
 * 的 app.isPackaged === true 且 process.defaultApp === true——defaultApp 才是权威
 * dev 信号，仅凭 isPackaged 判别会让 e2e launchBuiltApp 把取证写进 node_modules。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

type ForensicsModule = typeof import('./forensics-dir')
type UserDiagModule = typeof import('./user-diag-path')

let tmpRoot: string

/** 每用例取全新模块实例（缓存/provider 全复位），并注册 documents provider 指向临时目录 */
async function importFresh(
  env: { isPackaged: boolean; defaultApp: boolean; exePath: string } | null
): Promise<{ forensics: ForensicsModule; userDiag: UserDiagModule; docsDir: string }> {
  vi.resetModules()
  const docsDir = path.join(tmpRoot, `docs-${Math.random().toString(36).slice(2)}`)
  const forensics = (await import('./forensics-dir')) as ForensicsModule
  const userDiag = (await import('./user-diag-path')) as UserDiagModule
  userDiag.setDocumentsPathProvider(() => docsDir)
  if (env) {
    forensics.setForensicsEnvProvider(() => env)
  }
  return { forensics, userDiag, docsDir }
}

/** 构造不可写安装目录：exe 目录路径穿过一个普通文件（mkdir 抛 ENOTDIR） */
function makeBlockedExeDir(): string {
  const blocker = path.join(tmpRoot, `blocker-${Math.random().toString(36).slice(2)}.txt`)
  fs.writeFileSync(blocker, 'not a dir')
  return path.join(blocker, 'sub')
}

describe('forensics-dir - 取证根目录单一真相源', () => {
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-forensics-'))
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('F1【正常】打包态 + 安装目录可写 → install 源，目录已创建', async () => {
    const exeDir = path.join(tmpRoot, 'install-a')
    const { forensics } = await importFresh({
      isPackaged: true,
      defaultApp: false,
      exePath: path.join(exeDir, '喵星图.exe')
    })

    const root = forensics.getForensicsRoot()
    expect(root).toBe(path.join(exeDir, 'Diagnostics'))
    expect(forensics.getForensicsRootSource()).toBe('install')
    // 可写性探测应已建目录
    expect(fs.statSync(root).isDirectory()).toBe(true)
  })

  it('F2【异常】打包态 + 安装目录不可写（路径被文件阻断）→ 回落 Documents 候选链', async () => {
    const { forensics, docsDir } = await importFresh({
      isPackaged: true,
      defaultApp: false,
      exePath: path.join(makeBlockedExeDir(), 'app.exe')
    })

    const root = forensics.getForensicsRoot()
    expect(root).toBe(path.join(docsDir, '喵星图', 'Diagnostics'))
    expect(forensics.getForensicsRootSource()).toBe('fallback')
  })

  it('F3【边界】dev 形态（electron.exe + defaultApp=true，isPackaged 可能为 true）→ 回落链，不碰 exe 目录', async () => {
    // 2026-11-17 探针实证：electron.exe + 显式 app 目录下 isPackaged===true 且 defaultApp===true
    const exeDir = path.join(tmpRoot, 'node_modules-electron-dist')
    const { forensics, docsDir } = await importFresh({
      isPackaged: true,
      defaultApp: true,
      exePath: path.join(exeDir, 'electron.exe')
    })

    const root = forensics.getForensicsRoot()
    expect(root).toBe(path.join(docsDir, '喵星图', 'Diagnostics'))
    expect(root).not.toContain(exeDir)
    expect(forensics.getForensicsRootSource()).toBe('fallback')
    // 绝不在 exe 目录创建任何东西
    expect(fs.existsSync(exeDir)).toBe(false)
  })

  it('F4【边界】未注册 provider（单测/极早期）→ 回落链', async () => {
    const { forensics, docsDir } = await importFresh(null)
    expect(forensics.getForensicsRoot()).toBe(path.join(docsDir, '喵星图', 'Diagnostics'))
    expect(forensics.getForensicsRootSource()).toBe('fallback')
  })

  it('F5【异常】provider 抛错或返回 null / exePath 空串 → 回落链', async () => {
    vi.resetModules()
    const docsDir = path.join(tmpRoot, 'docs-x')
    const forensics = (await import('./forensics-dir')) as ForensicsModule
    const userDiag = (await import('./user-diag-path')) as UserDiagModule
    userDiag.setDocumentsPathProvider(() => docsDir)

    forensics.setForensicsEnvProvider(() => {
      throw new Error('provider boom')
    })
    expect(forensics.getForensicsRootSource()).toBe('fallback')

    forensics.setForensicsEnvProvider(() => null)
    expect(forensics.getForensicsRootSource()).toBe('fallback')

    forensics.setForensicsEnvProvider(() => ({
      isPackaged: true,
      defaultApp: false,
      exePath: ''
    }))
    expect(forensics.getForensicsRootSource()).toBe('fallback')
  })

  it('F6【正常】解析结果缓存：provider 只被调用一次', async () => {
    const exeDir = path.join(tmpRoot, 'install-cache')
    vi.resetModules()
    const forensics = (await import('./forensics-dir')) as ForensicsModule
    const userDiag = (await import('./user-diag-path')) as UserDiagModule
    userDiag.setDocumentsPathProvider(() => path.join(tmpRoot, 'docs-cache'))
    const provider = vi.fn(() => ({
      isPackaged: true,
      defaultApp: false,
      exePath: path.join(exeDir, 'app.exe')
    }))
    forensics.setForensicsEnvProvider(provider)

    forensics.getForensicsRoot()
    forensics.getForensicsRoot()
    forensics.getForensicsFilePath('heartbeat.json')
    forensics.getForensicsLogsDir()

    expect(provider).toHaveBeenCalledTimes(1)
  })

  it('F7【正常】provider 重置使缓存失效，重新解析', async () => {
    const exeDir = path.join(tmpRoot, 'install-reset')
    vi.resetModules()
    const forensics = (await import('./forensics-dir')) as ForensicsModule
    const userDiag = (await import('./user-diag-path')) as UserDiagModule
    const docsDir = path.join(tmpRoot, 'docs-reset')
    userDiag.setDocumentsPathProvider(() => docsDir)

    forensics.setForensicsEnvProvider(() => ({
      isPackaged: true,
      defaultApp: false,
      exePath: path.join(exeDir, 'app.exe')
    }))
    expect(forensics.getForensicsRootSource()).toBe('install')

    // 重置为 null：缓存失效 → 回落链
    forensics.setForensicsEnvProvider(null)
    expect(forensics.getForensicsRoot()).toBe(path.join(docsDir, '喵星图', 'Diagnostics'))
    expect(forensics.getForensicsRootSource()).toBe('fallback')
  })

  it('F8【正常】getForensicsFilePath：合法文件名 join 到根', async () => {
    const exeDir = path.join(tmpRoot, 'install-path')
    const { forensics } = await importFresh({
      isPackaged: true,
      defaultApp: false,
      exePath: path.join(exeDir, 'app.exe')
    })
    expect(forensics.getForensicsFilePath('heartbeat.json')).toBe(
      path.join(exeDir, 'Diagnostics', 'heartbeat.json')
    )
    expect(forensics.getForensicsLogsDir()).toBe(path.join(exeDir, 'Diagnostics', 'logs'))
  })

  it('F9【异常】getForensicsFilePath 非法入参一律 throw（空串/路径分隔符/..）', async () => {
    const { forensics } = await importFresh(null)
    for (const bad of ['', ' ', 'a/b', 'a\\b', '..', 'a..b/../c']) {
      expect(() => forensics.getForensicsFilePath(bad), `入参 "${bad}"`).toThrow()
    }
  })

  it('F10【边界】fallback 缓存后换 documents provider → 再解析落新 Documents 候选（缓存缝）', async () => {
    // R-a2 缓存缝：setDocumentsPathProvider 不通知本模块失效缓存（user-diag-path
    // 是零依赖叶子，无反向回调），fallback 态解析结果必须跟随 provider 漂移，
    // 否则早期注册前解析的 homedir 链结果被永久钉死，与写盘侧分裂。
    vi.resetModules()
    const forensics = (await import('./forensics-dir')) as ForensicsModule
    const userDiag = (await import('./user-diag-path')) as UserDiagModule
    const docsA = path.join(tmpRoot, 'docs-a')
    const docsB = path.join(tmpRoot, 'docs-b')
    userDiag.setDocumentsPathProvider(() => docsA)

    // 先解析一次：fallback 态缓存 docsA 链
    expect(forensics.getForensicsRoot()).toBe(path.join(docsA, '喵星图', 'Diagnostics'))
    expect(forensics.getForensicsRootSource()).toBe('fallback')

    // 换 provider（模拟 index.ts 注册时序晚于首次解析 / 测试重置缝）
    userDiag.setDocumentsPathProvider(() => docsB)
    expect(forensics.getForensicsRoot()).toBe(path.join(docsB, '喵星图', 'Diagnostics'))
    expect(forensics.getForensicsFilePath('heartbeat.json')).toBe(
      path.join(docsB, '喵星图', 'Diagnostics', 'heartbeat.json')
    )

    // 清空 provider 同样不得把旧缓存钉死（回落 homedir/tmpdir 链，不再含 docsB）
    userDiag.setDocumentsPathProvider(null)
    expect(forensics.getForensicsRoot()).not.toBe(path.join(docsB, '喵星图', 'Diagnostics'))
  })
})

describe('forensics-dir userData 根级历史证据同步迁移（审查修复轮 R-a3 接线）', () => {
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-forensics-'))
  })
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('u1. migrateLegacyUserDataRootSync：6 文件字节一致迁入取证根、源清、幂等、skipExisting 保护、同路径不动', async () => {
    const exeDir = path.join(tmpRoot, 'install-udsync')
    const { forensics } = await importFresh({
      isPackaged: true,
      defaultApp: false,
      exePath: path.join(exeDir, '喵星图.exe')
    })
    const root = forensics.getForensicsRoot()
    const userData = path.join(tmpRoot, 'userData')
    fs.mkdirSync(userData, { recursive: true })
    const names = [
      'gpu-fallback.json',
      'gpu-pref.json',
      'heartbeat.json',
      'last-exit.json',
      'boot-ok.marker',
      'second-instance-ack.json'
    ]
    for (const n of names) fs.writeFileSync(path.join(userData, n), `legacy-${n}`)
    fs.writeFileSync(path.join(userData, 'unrelated.txt'), 'keep')
    expect(typeof forensics.migrateLegacyUserDataRootSync, '缺少同步迁移导出').toBe('function')
    // 目标已有新鲜 gpu-fallback.json：skipExisting 保护，不被旧文件覆盖
    fs.writeFileSync(path.join(root, 'gpu-fallback.json'), 'fresh')
    forensics.migrateLegacyUserDataRootSync(userData)
    expect(fs.readFileSync(path.join(root, 'gpu-fallback.json'), 'utf8')).toBe('fresh')
    expect(fs.existsSync(path.join(userData, 'gpu-fallback.json'))).toBe(true)
    for (const n of names.slice(1)) {
      expect(fs.readFileSync(path.join(root, n), 'utf8')).toBe(`legacy-${n}`)
      expect(fs.existsSync(path.join(userData, n))).toBe(false)
    }
    expect(fs.existsSync(path.join(userData, 'unrelated.txt'))).toBe(true)
    // 幂等：二次调用不抛错、不重复搬
    forensics.migrateLegacyUserDataRootSync(userData)
    // 同路径（userData===root）绝不迁移/删源
    forensics.migrateLegacyUserDataRootSync(root)
    expect(fs.readFileSync(path.join(root, 'gpu-fallback.json'), 'utf8')).toBe('fresh')
    // 空串 fail-open
    forensics.migrateLegacyUserDataRootSync('')
  })
})
