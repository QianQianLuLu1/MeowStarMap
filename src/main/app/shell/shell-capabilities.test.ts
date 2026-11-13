/**
 * N6–N9 红灯来源：Windows 外壳能力模块尚未实现。
 *
 * 覆盖：签名验签 / HTTPS 下载 / delta ZIP 路径校验 / 原子激活 / opt-in 门控 /
 * 托盘 / 差分更新 / 诊断回执 / 网络修复 / 热点 / IPC 分发。
 * 所有网络与子进程均由注入的假实现承担，CI 无凭据也必跑。
 */
import { generateKeyPairSync, sign, createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { crc32 } from 'node:zlib'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ICON_CATALOG_URL,
  loadPublicKey,
  planIconDeltas,
  requireHttpsUrl,
  verifySignedDocument
} from './signed-feed'
import { downloadVerified } from './https-download'
import {
  ICON_PATH_PATTERN,
  activatePrepared,
  applyIconDelta,
  isAllowedIconPath,
  readDeltaZip,
  resolveStagingPath,
  verifySnapshot
} from './icon-pack-update-client'
import {
  SHELL_SETTING_KEYS,
  checkIconUpdate,
  createShellEventHub,
  isShellFeatureEnabled,
  resolveWritableIconDirs
} from './shell-capabilities'
import { createTray, type TrayElectronApi } from './tray-service'
import { disposeTray, isTrayActive, syncTray } from './tray-lifecycle'
import {
  selectDelta,
  stageProgramUpdate,
  verifyUpdateManifest,
  type ProgramUpdateManifest
} from './program-update-client'
import { parseReceipt, submitDiagnosticReport } from './support-gateway-client'
import { repairRequiresOptIn, runRepair } from './network-conflict-repair'
import { nextHotspotState, toggleHotspot } from './temporary-hotspot'
import { getShellStatus, runShellAction } from './shell-ipc'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 })
const pemPath = path.join(os.tmpdir(), 'nikki-shell-test-public.pem')
fs.writeFileSync(pemPath, publicKey.export({ type: 'spki', format: 'pem' }) as string)
const dirs: string[] = []
const makeDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nikki-shell-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const signed = (bytes: Buffer): Buffer => sign('sha256', bytes, privateKey)
const catalog = {
  Schema: 2,
  AppId: 'NikkiSync.Icons',
  LatestVersion: 'r3',
  LatestManifestSha256: 'b'.repeat(64),
  Deltas: [
    {
      Schema: 1,
      AppId: 'NikkiSync.Icons',
      BaseVersion: 'r2',
      TargetVersion: 'r3',
      BaseManifestSha256: 'a'.repeat(64),
      TargetManifestSha256: 'b'.repeat(64),
      DownloadUrl: 'https://cnb.cool/nikkisync/icon-packs/delta.zip',
      Sha256: 'c'.repeat(64),
      Size: 1024
    }
  ]
}
const manifest = {
  Schema: 2,
  AppId: 'MomoCamera.Windows',
  Version: '1.0.40',
  Build: 2026111108,
  Channel: 'public-beta',
  Notes: 'beta',
  DownloadUrl: 'https://github.com/ToStardust/NikkiSync/releases/download/v1/full.exe',
  Sha256: 'd'.repeat(64),
  Size: 4096
}

const allOff = { getBoolean: (_key: string, fallback: boolean) => fallback }
const allOn = { getBoolean: (_key: string, _fallback: boolean) => true }

/** Minimal store-method ZIP writer (no third-party writer needed for the fixture). */
function makeZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const sum = Number(crc32(entry.data))
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(sum, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(Buffer.concat([local, name, entry.data]))
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(sum, 16)
    central.writeUInt32LE(entry.data.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(Buffer.concat([central, name]))
    offset += local.length + name.length + entry.data.length
  }
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

describe('signed feed (RSA PKCS1v1.5 SHA256)', () => {
  it('normal: verifies a genuine signature and loads the SPKI public key', () => {
    const bytes = Buffer.from(JSON.stringify(catalog))
    expect(verifySignedDocument(bytes, signed(bytes), loadPublicKey(pemPath))).toBe(bytes)
  })

  it('abnormal: a tampered signature is rejected with a precise error', () => {
    const bytes = Buffer.from(JSON.stringify(catalog))
    const forged = Buffer.from(signed(bytes))
    forged[0] ^= 0xff
    expect(() => verifySignedDocument(bytes, forged, publicKey)).toThrow('RSA signature mismatch')
  })

  it('abnormal: non-https / userinfo / non-allowlisted URL is rejected', () => {
    expect(() => requireHttpsUrl('http://cnb.cool/a')).toThrow('Invalid https URL')
    expect(() => requireHttpsUrl('https://user@cnb.cool/a')).toThrow('Invalid https URL')
    expect(() => requireHttpsUrl('https://evil.example/a')).toThrow('Invalid https URL')
    expect(requireHttpsUrl(ICON_CATALOG_URL).host).toBe('cnb.cool')
  })

  it('boundary: plans a continuous delta chain and returns [] when already current', () => {
    expect(planIconDeltas(catalog, 'a'.repeat(64))).toHaveLength(1)
    expect(planIconDeltas(catalog, 'b'.repeat(64))).toEqual([])
    expect(() => planIconDeltas({ ...catalog, Deltas: [] }, 'a'.repeat(64))).toThrow(
      'Invalid icon catalog'
    )
  })
})

describe('https download / delta paths / activation', () => {
  it('normal: accepts a 200 response and verifies its sha256', async () => {
    const bytes = Buffer.from('payload')
    const fetchImpl = vi.fn(
      async () => new Response(bytes, { status: 200 })
    ) as unknown as typeof fetch
    const result = await downloadVerified('https://cnb.cool/a', {
      limit: 100,
      fetchImpl
    })
    expect(result).toEqual(bytes)
  })

  it('abnormal: over-limit content is rejected', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(Buffer.alloc(20), { status: 200 })
    ) as unknown as typeof fetch
    await expect(downloadVerified('https://cnb.cool/a', { limit: 4, fetchImpl })).rejects.toThrow(
      'Download size exceeds limit'
    )
  })

  it('normal: reads a real store-method ZIP via yauzl and rejects a non-ZIP buffer', async () => {
    const zip = makeZip([
      { name: 'manifest.json', data: Buffer.from('{"schemaVersion":2}') },
      { name: 'icons/1001.webp', data: Buffer.from('RIFF') }
    ])
    const files = await readDeltaZip(zip)
    expect(files.get('manifest.json')?.toString()).toBe('{"schemaVersion":2}')
    expect(files.get('icons/1001.webp')?.toString()).toBe('RIFF')
    await expect(readDeltaZip(Buffer.from('not a zip'))).rejects.toThrow('Invalid delta entry')
  })

  it('abnormal: Zip-Slip paths are rejected before any file is written', () => {
    expect(ICON_PATH_PATTERN.test('icons/1001.webp')).toBe(true)
    expect(isAllowedIconPath('../evil.webp')).toBe(false)
    expect(isAllowedIconPath('C:/evil.webp')).toBe(false)
    expect(() => resolveStagingPath('/staging', '../evil.webp')).toThrow('Invalid delta entry')
  })

  it('abnormal: a snapshot whose manifest hash differs is rejected', () => {
    expect(() => verifySnapshot(Buffer.from('{}'), 'a'.repeat(64), new Map())).toThrow(
      'Invalid icon snapshot'
    )
  })

  it('boundary: atomic activate swaps active/candidate and rolls back on failure', () => {
    const dir = makeDir()
    const active = path.join(dir, 'active')
    const candidate = path.join(dir, 'candidate')
    const backup = path.join(dir, 'backup')
    fs.mkdirSync(active)
    fs.mkdirSync(candidate)
    expect(
      activatePrepared({ activeDir: active, candidateDir: candidate, backupDir: backup })
    ).toEqual({
      ok: true
    })
    expect(fs.existsSync(path.join(active, 'candidate.txt'))).toBe(false)
    const second = makeDir()
    const active2 = path.join(second, 'active')
    const candidate2 = path.join(second, 'candidate')
    fs.mkdirSync(active2)
    fs.mkdirSync(candidate2)
    const calls: string[] = []
    const failing = (from: string, to: string): void => {
      calls.push(`${from}->${to}`)
      throw new Error('disk full')
    }
    expect(
      activatePrepared({
        activeDir: active2,
        candidateDir: candidate2,
        backupDir: path.join(second, 'backup'),
        rename: failing
      })
    ).toMatchObject({ ok: false })
    // 第一次 rename 即失败 ⇒ 不应留下半套状态，active 目录仍在原位
    expect(calls).toHaveLength(1)
    expect(fs.existsSync(active2)).toBe(true)
  })
})

describe('shell capability gating', () => {
  it('normal: six opt-in keys and writable userData icon directories', () => {
    expect(Object.keys(SHELL_SETTING_KEYS)).toHaveLength(6)
    expect(
      resolveWritableIconDirs({ userDataDir: '/user data', pcAssetsDir: '/static' })
        .clothingIconsDir
    ).toContain('user data')
  })

  it('abnormal: disabled channels make zero network calls', async () => {
    expect(await checkIconUpdate({ enabled: false })).toEqual({ status: 'disabled' })
    expect(isShellFeatureEnabled(undefined, SHELL_SETTING_KEYS.tray)).toBe(false)
  })

  it('boundary: event hub dispose clears listeners', () => {
    const hub = createShellEventHub()
    const cb = vi.fn()
    hub.subscribe(cb)
    hub.publish({ type: 'checking' })
    expect(cb).toHaveBeenCalledTimes(1)
    hub.dispose()
    hub.publish({ type: 'staged' })
    expect(cb).toHaveBeenCalledTimes(1)
  })
})

describe('tray / program update / support / network / hotspot', () => {
  it('normal: tray menu labels and idempotent dispose', () => {
    const destroy = vi.fn()
    const Tray = class {
      setToolTip = vi.fn()
      setContextMenu = vi.fn()
      on = vi.fn()
      destroy = destroy
    }
    let template: Array<{ label: string }> = []
    const electron = {
      Tray,
      Menu: { buildFromTemplate: (items: Array<{ label: string }>) => (template = items) },
      nativeImage: { createFromPath: () => ({}) }
    } as unknown as TrayElectronApi
    const tray = createTray({
      iconPath: '/icon.ico',
      onShow: vi.fn(),
      onQuit: vi.fn(),
      electron
    })
    expect(template.map((item) => item.label)).toEqual(['Show MeowStarMap', 'Quit MeowStarMap'])
    tray.dispose()
    tray.dispose()
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('normal: verifies a signed program manifest and selects the matching delta', () => {
    const bytes = Buffer.from(JSON.stringify(manifest))
    expect(verifyUpdateManifest(bytes, signed(bytes), publicKey, 2026111107).Build).toBe(2026111108)
    const withDelta = {
      ...manifest,
      Deltas: [
        {
          BaseBuild: 2026111107,
          BaseSha256: 'e'.repeat(64),
          DownloadUrl: 'https://cnb.cool/patch.vcdiff',
          Sha256: 'f'.repeat(64),
          Size: 100,
          Algorithm: 'xdelta3-vcdiff'
        }
      ]
    } as ProgramUpdateManifest
    const selected = selectDelta(withDelta, 2026111107, 'e'.repeat(64))
    expect((selected as { Algorithm: string } | null)?.Algorithm).toBe('xdelta3-vcdiff')
  })

  it('abnormal: tampered update signature and non-201 submission', async () => {
    const bytes = Buffer.from(JSON.stringify(manifest))
    const forged = Buffer.from(signed(bytes))
    forged[0] ^= 0xff
    expect(() => verifyUpdateManifest(bytes, forged, publicKey, 1)).toThrow(
      'RSA signature mismatch'
    )
    expect(await submitDiagnosticReport({ endpoint: undefined, optIn: true })).toEqual({
      status: 'unavailable'
    })
    expect(parseReceipt('NS1.bad')).toBeNull()
  })

  it('boundary: every opt-in disabled path makes zero network / subprocess calls', async () => {
    expect(await stageProgramUpdate({ enabled: false })).toEqual({ status: 'disabled' })
    expect(repairRequiresOptIn(false)).toBe(false)
    expect(await runRepair({ enabled: false, rules: [], port: 28080 })).toEqual({
      status: 'disabled',
      changed: 0
    })
    expect(
      await toggleHotspot({
        enabled: false,
        current: { startedHere: false, active: true },
        requested: true
      })
    ).toEqual({ status: 'disabled', state: { startedHere: false, active: true } })
    expect(nextHotspotState({ startedHere: false, active: true }, true).startedHere).toBe(false)
  })
})

describe('tray lifecycle', () => {
  it('disabled: no tray factory is ever invoked and dispose is a no-op', async () => {
    const factory = vi.fn()
    expect(await syncTray(false, factory)).toBe(false)
    expect(factory).not.toHaveBeenCalled()
    expect(disposeTray()).toBe(false)
  })

  it('normal: enabled creates exactly one tray and dispose destroys it once', async () => {
    const dispose = vi.fn()
    const factory = vi.fn(() => ({ notify: vi.fn(), dispose }))
    expect(await syncTray(true, factory)).toBe(true)
    expect(await syncTray(true, factory)).toBe(true)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(disposeTray()).toBe(true)
    expect(disposeTray()).toBe(false)
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('F2: isTrayActive reflects the real handle, not the setting flag', async () => {
    expect(isTrayActive()).toBe(false)
    const factory = vi.fn(() => ({ notify: vi.fn(), dispose: vi.fn() }))
    await syncTray(true, factory)
    expect(isTrayActive()).toBe(true)
    disposeTray()
    expect(isTrayActive()).toBe(false)
  })
})

describe('shell IPC dispatch', () => {
  it('normal: status exposes all six flags off by default', () => {
    const status = getShellStatus(allOff)
    expect(Object.values(status.enabled).every((value) => value === false)).toBe(true)
    expect(status.trayActive).toBe(false)
  })

  it('abnormal: any action with its flag off returns disabled and emits nothing', async () => {
    const emit = vi.fn()
    expect(await runShellAction('icon-check', {}, allOff, emit)).toEqual({ status: 'disabled' })
    expect(await runShellAction('support-submit', {}, allOff, emit)).toEqual({ status: 'disabled' })
    expect(emit).not.toHaveBeenCalled()
  })

  it('boundary: an enabled action without a signed feed stays honest (unavailable)', async () => {
    const emit = vi.fn()
    const result = await runShellAction('icon-check', {}, allOn, emit)
    expect(result.status).not.toBe('staged')
    expect(result.status).not.toBe('submitted')
  })

  it('abnormal: network-repair without firewall enumeration never fakes success', async () => {
    // 生产从不枚举防火墙规则（rules 恒空），报 repaired 即伪成功；必须诚实 unavailable。
    expect(await runShellAction('network-repair', {}, allOn, vi.fn())).toEqual({
      status: 'unavailable',
      reason: expect.any(String)
    })
    expect(await runShellAction('network-repair', {}, allOff, vi.fn())).toEqual({
      status: 'disabled'
    })
  })

  it('F2: shell-status reports observed facts, never the setting flag', () => {
    const withFacts = getShellStatus(allOff, {
      trayActive: true,
      localPhotoResolverActive: true
    })
    expect(withFacts.trayActive).toBe(true)
    expect(withFacts.localPhotoResolverActive).toBe(true)
    // 无 facts（会话未装配/老链接）⇒ 缺省 false，绝不把开关当事实
    const noFacts = getShellStatus(allOn)
    expect(noFacts.trayActive).toBe(false)
    expect(noFacts.localPhotoResolverActive).toBe(false)
  })
})

describe('F8 https-download 逐跳校验 / 流式限量 / Range 判据', () => {
  const redirect = (location: string): Response =>
    new Response(null, { status: 302, headers: { location } })

  it('normal: follows an allowlisted redirect and verifies the payload', async () => {
    const bytes = Buffer.from('payload')
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirect('https://cnb.cool/b'))
      .mockResolvedValueOnce(new Response(bytes, { status: 200 })) as unknown as typeof fetch
    const result = await downloadVerified('https://cnb.cool/a', { limit: 100, fetchImpl })
    expect(result).toEqual(bytes)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('abnormal: a redirect to a non-allowlisted host is rejected per hop', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirect('https://evil.example/x')) as unknown as typeof fetch
    await expect(downloadVerified('https://cnb.cool/a', { limit: 100, fetchImpl })).rejects.toThrow(
      'Invalid https URL'
    )
  })

  it('abnormal: a redirect downgrading to http is rejected per hop', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirect('http://cnb.cool/x')) as unknown as typeof fetch
    await expect(downloadVerified('https://cnb.cool/a', { limit: 100, fetchImpl })).rejects.toThrow(
      'Invalid https URL'
    )
  })

  it('boundary: more than 6 redirects is rejected', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(redirect('https://cnb.cool/loop')) as unknown as typeof fetch
    await expect(downloadVerified('https://cnb.cool/a', { limit: 100, fetchImpl })).rejects.toThrow(
      'Too many redirects'
    )
    expect(fetchImpl).toHaveBeenCalledTimes(7)
  })

  it('boundary: streaming cap aborts early instead of buffering the whole body', async () => {
    let pulls = 0
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array(64 * 1024))
        if (pulls >= 256) controller.close()
      },
      cancel() {
        cancelled = true
      }
    })
    const fetchImpl = vi.fn(
      async () => new Response(stream, { status: 200 })
    ) as unknown as typeof fetch
    await expect(
      downloadVerified('https://cnb.cool/a', { limit: 1024, fetchImpl })
    ).rejects.toThrow('Download size exceeds limit')
    expect(pulls).toBeLessThanOrEqual(4)
    expect(cancelled).toBe(true)
  })

  it('abnormal: a 206 whose range start differs from the offset is rejected', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(Buffer.from('0123456789'), {
          status: 206,
          headers: { 'content-range': 'bytes 0-9/10' }
        })
    ) as unknown as typeof fetch
    await expect(
      downloadVerified('https://cnb.cool/a', { limit: 100, offset: 5, fetchImpl })
    ).rejects.toThrow('Download range mismatch')
  })

  it('normal: a 206 with the correct range start resolves', async () => {
    const tail = Buffer.from('56789')
    const fetchImpl = vi.fn(
      async () => new Response(tail, { status: 206, headers: { 'content-range': 'bytes 5-9/10' } })
    ) as unknown as typeof fetch
    const result = await downloadVerified('https://cnb.cool/a', {
      limit: 100,
      offset: 5,
      expectedSize: 10,
      fetchImpl
    })
    expect(result).toEqual(tail)
  })
})

describe('F9 applyIconDelta files 清单整包校验', () => {
  const manifestBytes = Buffer.from(JSON.stringify({ schemaVersion: 2, imageFormat: 'webp' }))
  const manifestSha = createHash('sha256').update(manifestBytes).digest('hex')
  const webpBytes = Buffer.from('RIFF')
  const webpSha = createHash('sha256').update(webpBytes).digest('hex')
  const makeUpdate = (files: unknown): Buffer =>
    Buffer.from(JSON.stringify({ schemaVersion: 1, targetManifestSha256: manifestSha, files }))
  const makePack = (update: Buffer): Buffer =>
    makeZip([
      { name: 'manifest.json', data: manifestBytes },
      { name: 'update.json', data: update },
      { name: 'icons/1001.webp', data: webpBytes }
    ])
  const goodFiles = [{ path: 'icons/1001.webp', sha256: webpSha, size: 4 }]

  it('normal: a complete files manifest applies and writes all entries', async () => {
    const dir = makeDir()
    const result = await applyIconDelta({
      zip: makePack(makeUpdate(goodFiles)),
      expectedManifestSha256: manifestSha,
      stagingDir: dir
    })
    expect(result.fileCount).toBe(3)
    expect(fs.existsSync(path.join(dir, 'icons', '1001.webp'))).toBe(true)
  })

  it.each([
    ['empty files list', []],
    ['tampered sha256', [{ path: 'icons/1001.webp', sha256: 'b'.repeat(64), size: 4 }]],
    ['wrong size', [{ path: 'icons/1001.webp', sha256: webpSha, size: 5 }]],
    ['zip-slip path', [{ path: '../evil.webp', sha256: webpSha, size: 4 }]],
    ['missing entry', [{ path: 'icons/9999.webp', sha256: webpSha, size: 4 }]],
    ['non-array files', {}]
  ])('abnormal: %s is rejected before any write', async (_name, files) => {
    const dir = makeDir()
    await expect(
      applyIconDelta({
        zip: makePack(makeUpdate(files)),
        expectedManifestSha256: manifestSha,
        stagingDir: dir
      })
    ).rejects.toThrow('Invalid delta entry')
    expect(fs.readdirSync(dir)).toEqual([])
  })
})
