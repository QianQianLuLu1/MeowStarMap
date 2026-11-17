/**
 * @layer L3
 * @module src/main/app/forensics-migrate
 * @coverage unifyForensicsDirs：历史取证文件归集迁移 + logDir/crashDir 强制统一接线
 * @dependencies 真实 fs + os.tmpdir；forensics/user-diag provider 注入模拟 install/回退态
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'

let mockUserData = ''

vi.mock('electron', () => ({
  app: { setPath: vi.fn(), getPath: vi.fn(() => mockUserData) }
}))

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  setLogDirectory: vi.fn(),
  initLogger: vi.fn()
}))

vi.mock('../../i18n', () => ({ t: (key: string) => key }))

import { app } from 'electron'
import { setLogDirectory } from '../../utils/logger'
import { getCrashDirectory } from '../../services/crash-service'
import {
  setForensicsEnvProvider,
  getForensicsRoot,
  getForensicsLogsDir
} from '../../utils/forensics-dir'
import { setDocumentsPathProvider } from '../../utils/user-diag-path'
import { unifyForensicsDirs, migrateLegacyUserDataRoot } from '../forensics-migrate'

describe('unifyForensicsDirs', () => {
  let tmpBase: string
  let userData: string
  let installDir: string
  let documentsDir: string
  let legacyRoot: string
  let settings: Record<string, unknown>
  let ctx: {
    dbManager: {
      getSetting: ReturnType<typeof vi.fn>
      setSetting: ReturnType<typeof vi.fn>
    }
  }

  const write = async (p: string, content: string): Promise<void> => {
    await fsp.mkdir(path.dirname(p), { recursive: true })
    await fsp.writeFile(p, content)
  }

  beforeEach(async () => {
    tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'wxnn-forensics-migrate-'))
    userData = path.join(tmpBase, 'userData')
    mockUserData = userData
    installDir = path.join(tmpBase, 'install')
    documentsDir = path.join(tmpBase, 'documents')
    legacyRoot = path.join(documentsDir, '喵星图', 'Diagnostics')
    await fsp.mkdir(userData, { recursive: true })
    await fsp.mkdir(installDir, { recursive: true })
    // install 态：取证根 = installDir\Diagnostics
    setForensicsEnvProvider(() => ({
      isPackaged: true,
      defaultApp: false,
      exePath: path.join(installDir, 'app.exe')
    }))
    setDocumentsPathProvider(() => documentsDir)

    settings = {}
    ctx = {
      dbManager: {
        getSetting: vi.fn((key: string, def: unknown) => (key in settings ? settings[key] : def)),
        setSetting: vi.fn((key: string, value: unknown) => {
          settings[key] = value
        })
      }
    }

    // 历史分散残留
    await write(path.join(userData, 'logs', 'main-2026-11-14.log'), 'old-main')
    await write(path.join(userData, 'logs', 'faults-2026-11-14.jsonl'), '{"old":1}')
    await write(path.join(userData, 'crashes', 'old.dmp'), 'old-dmp')
    await write(path.join(userData, 'scan-log.jsonl'), '{"scan":1}')
    await write(path.join(userData, 'nikkisync', 'scan-status.json'), '{"ok":true}')
    await write(path.join(userData, 'nikkisync', 'nikkisync.db'), 'DB-MUST-NOT-MOVE')
    await write(path.join(legacyRoot, 'diag.log'), 'legacy-diag')
    await write(path.join(legacyRoot, 'chromium-debug.log'), 'legacy-chromium')
    await write(path.join(legacyRoot, 'gpu-fallback.json'), '{"level":1}')
    await write(path.join(legacyRoot, 'late.dmp'), 'late-dmp')
    await write(path.join(legacyRoot, 'logs', 'main-2026-11-13.log'), 'legacy-main')
    // 本次启动已写的新鲜证据（不得被旧文件覆盖）
    await write(path.join(getForensicsRoot(), 'heartbeat.json'), '{"fresh":true}')
    await write(path.join(legacyRoot, 'heartbeat.json'), '{"stale":true}')
  })

  afterEach(async () => {
    setForensicsEnvProvider(null)
    setDocumentsPathProvider(null)
    await fsp.rm(tmpBase, { recursive: true, force: true })
  })

  it('历史日志/故障/scan-log 归集到取证 logs 子目录', async () => {
    await unifyForensicsDirs(ctx as never)
    const logs = getForensicsLogsDir()
    expect(fs.readFileSync(path.join(logs, 'main-2026-11-14.log'), 'utf8')).toBe('old-main')
    expect(fs.existsSync(path.join(logs, 'faults-2026-11-14.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(logs, 'scan-log.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(logs, 'main-2026-11-13.log'))).toBe(true)
    expect(fs.existsSync(path.join(userData, 'logs', 'main-2026-11-14.log'))).toBe(false)
    expect(fs.existsSync(path.join(userData, 'scan-log.jsonl'))).toBe(false)
  })

  it('崩溃 dump（userData 与旧 Documents 根）归集到取证根', async () => {
    await unifyForensicsDirs(ctx as never)
    const root = getForensicsRoot()
    expect(fs.existsSync(path.join(root, 'old.dmp'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'late.dmp'))).toBe(true)
    expect(fs.existsSync(path.join(userData, 'crashes', 'old.dmp'))).toBe(false)
  })

  it('旧 Documents 根的取证文件白名单迁入，新鲜同名证据不被覆盖', async () => {
    await unifyForensicsDirs(ctx as never)
    const root = getForensicsRoot()
    expect(fs.readFileSync(path.join(root, 'diag.log'), 'utf8')).toBe('legacy-diag')
    expect(fs.existsSync(path.join(root, 'chromium-debug.log'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'gpu-fallback.json'))).toBe(true)
    // 新鲜 heartbeat 保留，旧根同名文件不覆盖它
    expect(fs.readFileSync(path.join(root, 'heartbeat.json'), 'utf8')).toBe('{"fresh":true}')
  })

  it('NikkiSync 仅迁 5 个诊断文件，nikkisync.db 绝不迁移', async () => {
    await unifyForensicsDirs(ctx as never)
    expect(fs.existsSync(path.join(getForensicsRoot(), 'nikkisync', 'scan-status.json'))).toBe(true)
    expect(fs.existsSync(path.join(userData, 'nikkisync', 'nikkisync.db'))).toBe(true)
    expect(fs.existsSync(path.join(getForensicsRoot(), 'nikkisync', 'nikkisync.db'))).toBe(false)
  })

  it('历史自定义 logDir/crashDir 作为迁移源，迁移后清键', async () => {
    const customLogs = path.join(tmpBase, 'custom-logs')
    const customCrashes = path.join(tmpBase, 'custom-crashes')
    await write(path.join(customLogs, 'main-2026-11-10.log'), 'custom-main')
    await write(path.join(customCrashes, 'custom.dmp'), 'custom-dmp')
    settings.logDir = customLogs
    settings.crashDir = customCrashes

    await unifyForensicsDirs(ctx as never)

    expect(fs.existsSync(path.join(getForensicsLogsDir(), 'main-2026-11-10.log'))).toBe(true)
    expect(fs.existsSync(path.join(getForensicsRoot(), 'custom.dmp'))).toBe(true)
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith('logDir', '')
    expect(ctx.dbManager.setSetting).toHaveBeenCalledWith('crashDir', '')
  })

  it('接线：setLogDirectory / crashDumps / setCrashDirectory 全部指向取证目录', async () => {
    await unifyForensicsDirs(ctx as never)
    expect(setLogDirectory).toHaveBeenCalledWith(getForensicsLogsDir())
    expect(app.setPath).toHaveBeenCalledWith('crashDumps', getForensicsRoot())
    expect(getCrashDirectory()).toBe(getForensicsRoot())
  })

  it('幂等：二次运行 moved=0 且不抛错', async () => {
    await unifyForensicsDirs(ctx as never)
    await expect(unifyForensicsDirs(ctx as never)).resolves.toBeUndefined()
    expect(fs.existsSync(path.join(getForensicsLogsDir(), 'main-2026-11-14.log'))).toBe(true)
  })

  it('回退态（取证根==旧 Documents 根）：源=目标跳过，不自我迁移', async () => {
    setForensicsEnvProvider(() => ({
      isPackaged: true,
      defaultApp: true,
      exePath: path.join(installDir, 'app.exe')
    }))
    await expect(unifyForensicsDirs(ctx as never)).resolves.toBeUndefined()
    // 旧根即统一根：文件原地保留
    expect(fs.readFileSync(path.join(legacyRoot, 'diag.log'), 'utf8')).toBe('legacy-diag')
    expect(setLogDirectory).toHaveBeenCalledWith(path.join(legacyRoot, 'logs'))
  })

  it('源目录全部缺席时不抛错，接线仍生效', async () => {
    await fsp.rm(userData, { recursive: true, force: true })
    await fsp.rm(legacyRoot, { recursive: true, force: true })
    await expect(unifyForensicsDirs(ctx as never)).resolves.toBeUndefined()
    expect(setLogDirectory).toHaveBeenCalledWith(getForensicsLogsDir())
  })

  // ---------- R-a1 陈旧心跳根切换毒化（2026-11-18 审查修复轮） ----------
  //
  // install 态迁移时旧 Documents 的陈旧 heartbeat/last-exit 被 skipExisting 跳过后
  // 永久保留；日后安装目录 ACL 变化回落 fallback 态（根==legacyRoot），模块加载期
  // recordBootLevel 读到陈旧死亡证据 → 误判 native → GPU 阶梯白升档。
  // 死亡证据是瞬态取证文件（非用户数据），新根新鲜心跳在位时必须清掉旧根副本。

  /** 形状合法的陈旧心跳（parseHeartbeat 可解析，分类侧才会消费它） */
  const STALE_HEARTBEAT = JSON.stringify({
    bootId: 'old-boot',
    pid: 999999999,
    startedAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-10T00:05:00.000Z',
    stage: 'scan'
  })
  const STALE_LAST_EXIT = JSON.stringify({
    bootId: 'old-boot',
    code: 0,
    stage: 'quit',
    time: '2026-11-10T00:06:00.000Z',
    journal: [],
    uptime: 300
  })
  const FRESH_LAST_EXIT = JSON.stringify({
    bootId: 'fresh-boot',
    code: 0,
    stage: 'quit',
    time: '2026-11-17T00:06:00.000Z',
    journal: [],
    uptime: 60
  })

  it('R-a1：install 态新根新鲜心跳在位 → 旧根陈旧 heartbeat/last-exit 清除', async () => {
    await write(path.join(legacyRoot, 'heartbeat.json'), STALE_HEARTBEAT)
    await write(path.join(legacyRoot, 'last-exit.json'), STALE_LAST_EXIT)
    // 新根已有新鲜 last-exit → skipExisting 会保留旧根副本（正是毒化残留的来源）
    await write(path.join(getForensicsRoot(), 'last-exit.json'), FRESH_LAST_EXIT)

    await unifyForensicsDirs(ctx as never)

    expect(fs.existsSync(path.join(legacyRoot, 'heartbeat.json'))).toBe(false)
    expect(fs.existsSync(path.join(legacyRoot, 'last-exit.json'))).toBe(false)
    // 新根新鲜证据不受影响
    expect(fs.readFileSync(path.join(getForensicsRoot(), 'heartbeat.json'), 'utf8')).toBe(
      '{"fresh":true}'
    )
    expect(fs.readFileSync(path.join(getForensicsRoot(), 'last-exit.json'), 'utf8')).toBe(
      FRESH_LAST_EXIT
    )
  })

  it('R-a1 边界：同路径（fallback 态根==旧根）绝不删死亡证据', async () => {
    setForensicsEnvProvider(() => ({
      isPackaged: true,
      defaultApp: true,
      exePath: path.join(installDir, 'app.exe')
    }))
    await write(path.join(legacyRoot, 'heartbeat.json'), STALE_HEARTBEAT)
    await write(path.join(legacyRoot, 'last-exit.json'), STALE_LAST_EXIT)

    await unifyForensicsDirs(ctx as never)

    // 根==旧根：文件即统一根本体的证据，原地保留
    expect(fs.readFileSync(path.join(legacyRoot, 'heartbeat.json'), 'utf8')).toBe(STALE_HEARTBEAT)
    expect(fs.readFileSync(path.join(legacyRoot, 'last-exit.json'), 'utf8')).toBe(STALE_LAST_EXIT)
  })

  it('R-a1 边界：新根无新鲜心跳 → 不清旧根（陈旧心跳按白名单迁入，等待覆写自愈）', async () => {
    await fsp.rm(path.join(getForensicsRoot(), 'heartbeat.json'))
    await write(path.join(legacyRoot, 'heartbeat.json'), STALE_HEARTBEAT)
    await write(path.join(legacyRoot, 'last-exit.json'), STALE_LAST_EXIT)
    await write(path.join(getForensicsRoot(), 'last-exit.json'), FRESH_LAST_EXIT)

    await unifyForensicsDirs(ctx as never)

    // 旧根 last-exit 被 skipExisting 跳过 → 必须保留（本次启动未写新鲜心跳，无权清证据）
    expect(fs.existsSync(path.join(legacyRoot, 'last-exit.json'))).toBe(true)
    // 旧心跳迁入新根（可接受行为：后续新鲜心跳覆写自愈）
    expect(fs.readFileSync(path.join(getForensicsRoot(), 'heartbeat.json'), 'utf8')).toBe(
      STALE_HEARTBEAT
    )
  })

  it('R-a1 分类侧：清残留后切 fallback，getPreviousExitEvidence 判 none（不再误判 native）', async () => {
    await write(path.join(legacyRoot, 'heartbeat.json'), STALE_HEARTBEAT)
    // 旧根无 last-exit（beforeEach 未写）：陈旧心跳 + last-exit 缺失 = native 误判形态
    await unifyForensicsDirs(ctx as never)

    // 模拟日后 ACL 变化回落：根==legacyRoot
    setForensicsEnvProvider(() => ({
      isPackaged: true,
      defaultApp: true,
      exePath: path.join(installDir, 'app.exe')
    }))
    const { getPreviousExitEvidence } = await import('../exit-forensics')
    expect(getPreviousExitEvidence({ isAlive: () => false }).kind).toBe('none')
  })

  // ---------- R-a2 测试缺口补覆盖（非缺陷修复，直接绿） ----------
  // 钉住可接受行为：新根无心跳时旧心跳迁入，分类暂态由后续新鲜心跳覆写自愈。
  it('R-a2 覆盖：新根无心跳 → 旧心跳迁入新根', async () => {
    await fsp.rm(path.join(getForensicsRoot(), 'heartbeat.json'))

    await unifyForensicsDirs(ctx as never)

    expect(fs.readFileSync(path.join(getForensicsRoot(), 'heartbeat.json'), 'utf8')).toBe(
      '{"stale":true}'
    )
    expect(fs.existsSync(path.join(legacyRoot, 'heartbeat.json'))).toBe(false)
  })

  // ---------- R-a3 userData 根级 6 文件迁移（升级首启丢 GPU 档位/用户偏好） ----------
  //
  // 历史版本把 gpu-fallback.json / gpu-pref.json / heartbeat.json / last-exit.json /
  // boot-ok.marker / second-instance-ack.json 写在 userData 根级；白名单迁移源仅
  // legacyRoot（Documents），这 6 个文件永不迁移 → 升级首启 recordBootLevel 读不到
  // 档位、用户显式关闭硬件加速的偏好被静默架空。本函数供 index.ts 在 recordBootLevel
  // 之前接线（userData 路径经入参注入，零 electron）。
  describe('migrateLegacyUserDataRoot', () => {
    const ROOT_FILE_NAMES = [
      'gpu-fallback.json',
      'gpu-pref.json',
      'heartbeat.json',
      'last-exit.json',
      'boot-ok.marker',
      'second-instance-ack.json'
    ] as const

    it('userData 根级 6 文件迁入取证根，内容字节一致、源被清（rename 语义）', async () => {
      const contents: Record<string, string> = {
        'gpu-fallback.json': '{"compatLevel":2,"failCount":3,"fallbackActive":true}',
        'gpu-pref.json': '{"hardwareAcceleration":false}',
        'heartbeat.json': STALE_HEARTBEAT,
        'last-exit.json': STALE_LAST_EXIT,
        'boot-ok.marker': 'ok',
        'second-instance-ack.json': '{"pid":1234,"at":"2026-11-10T00:00:00.000Z"}'
      }
      for (const name of ROOT_FILE_NAMES) {
        await write(path.join(userData, name), contents[name])
      }
      // 移走 beforeEach 写的新根新鲜 heartbeat，让 6 文件全部走迁入路径
      await fsp.rm(path.join(getForensicsRoot(), 'heartbeat.json'))

      await migrateLegacyUserDataRoot(userData)

      for (const name of ROOT_FILE_NAMES) {
        expect(fs.readFileSync(path.join(getForensicsRoot(), name), 'utf8')).toBe(contents[name])
        expect(fs.existsSync(path.join(userData, name))).toBe(false)
      }
    })

    it('幂等：重复调用不抛错、目标内容不变', async () => {
      await write(path.join(userData, 'gpu-pref.json'), '{"hardwareAcceleration":false}')
      await migrateLegacyUserDataRoot(userData)
      await expect(migrateLegacyUserDataRoot(userData)).resolves.toBeUndefined()
      expect(fs.readFileSync(path.join(getForensicsRoot(), 'gpu-pref.json'), 'utf8')).toBe(
        '{"hardwareAcceleration":false}'
      )
    })

    it('skipExisting：目标已有新鲜文件时不覆盖、源保留', async () => {
      await write(path.join(userData, 'gpu-pref.json'), '{"hardwareAcceleration":false}')
      await write(path.join(getForensicsRoot(), 'gpu-pref.json'), '{"hardwareAcceleration":true}')

      await migrateLegacyUserDataRoot(userData)

      expect(fs.readFileSync(path.join(getForensicsRoot(), 'gpu-pref.json'), 'utf8')).toBe(
        '{"hardwareAcceleration":true}'
      )
      expect(fs.existsSync(path.join(userData, 'gpu-pref.json'))).toBe(true)
    })

    it('白名单外文件绝不迁移（userData 根级其他文件不受影响）', async () => {
      await write(path.join(userData, 'Preferences'), '{"browser":1}')
      await write(path.join(userData, 'Local State'), '{"os_crypt":1}')

      await migrateLegacyUserDataRoot(userData)

      expect(fs.existsSync(path.join(userData, 'Preferences'))).toBe(true)
      expect(fs.existsSync(path.join(userData, 'Local State'))).toBe(true)
      expect(fs.existsSync(path.join(getForensicsRoot(), 'Preferences'))).toBe(false)
      expect(fs.existsSync(path.join(getForensicsRoot(), 'Local State'))).toBe(false)
    })

    it('fail-open：userData 目录缺席 / 入参为空串时不抛错', async () => {
      await expect(
        migrateLegacyUserDataRoot(path.join(tmpBase, 'no-such-userdata'))
      ).resolves.toBeUndefined()
      await expect(migrateLegacyUserDataRoot('')).resolves.toBeUndefined()
    })
  })
})
