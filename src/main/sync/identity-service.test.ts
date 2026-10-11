import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, createPublicKey, generateKeyPairSync, X509Certificate } from 'node:crypto'

/**
 * SyncIdentityService 单元测试 —— TLS 自签证书生成 / 持久化 / 指纹 / 损坏自愈。
 *
 * 用 fs.mkdtemp 临时目录走真实文件系统（文件持久化与权限语义是本服务的核心职责，
 * 不适合 FakeDb/内存桩）。编号对应 docs/sync-integration/03-auth-pairing-plan.md §10（T4）。
 */

import { SyncIdentityService } from './identity-service'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function makeDirectory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxnn-sync-identity-'))
  tempDirs.push(dir)
  return dir
}

function normalizeFingerprint(fingerprint: string): string {
  return fingerprint.replaceAll(':', '').toLowerCase()
}

// ============================================================================
// TLS 证书：生成 / 持久化 / 指纹
// ============================================================================

describe('SyncIdentityService.getOrCreateTlsIdentity', () => {
  it('首次调用生成证书与私钥并持久化到用户数据子目录', () => {
    const dir = makeDirectory()
    const service = new SyncIdentityService({ directory: dir })
    const identity = service.getOrCreateTlsIdentity()

    expect(fs.existsSync(path.join(dir, 'server.crt'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'server.key'))).toBe(true)
    expect(identity.certPem).toBe(fs.readFileSync(path.join(dir, 'server.crt'), 'utf8'))
    expect(identity.keyPem).toBe(fs.readFileSync(path.join(dir, 'server.key'), 'utf8'))
    expect(identity.keyPem).toContain('BEGIN PRIVATE KEY') // PKCS8
    expect(identity.certPem).toContain('BEGIN CERTIFICATE')
    expect(identity.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(identity.createdAt).toBeTruthy()
  })

  it('证书字段符合互操作约定（CN / SAN / 自签）', () => {
    const dir = makeDirectory()
    const service = new SyncIdentityService({ directory: dir })
    const identity = service.getOrCreateTlsIdentity()
    const cert = new X509Certificate(identity.certPem)
    expect(cert.subject).toContain('WXNN Photo Manager Local')
    expect(cert.subjectAltName).toContain('wxnn.local')
    expect(cert.verify(cert.publicKey)).toBe(true) // 自签名成立
  })

  it('重复调用与跨实例重载返回同一证书与指纹（持久化语义）', () => {
    const dir = makeDirectory()
    const first = new SyncIdentityService({ directory: dir }).getOrCreateTlsIdentity()
    const again = new SyncIdentityService({ directory: dir }).getOrCreateTlsIdentity()
    expect(again.certPem).toBe(first.certPem)
    expect(again.keyPem).toBe(first.keyPem)
    expect(again.fingerprintSha256).toBe(first.fingerprintSha256)
  })

  it('指纹等于 X509Certificate.fingerprint256 归一化值，也等于 sha256(证书 DER)', () => {
    const dir = makeDirectory()
    const identity = new SyncIdentityService({ directory: dir }).getOrCreateTlsIdentity()
    const cert = new X509Certificate(identity.certPem)
    expect(identity.fingerprintSha256).toBe(normalizeFingerprint(cert.fingerprint256))
    expect(identity.fingerprintSha256).toBe(createHash('sha256').update(cert.raw).digest('hex'))
  })

  it('证书文件损坏时自愈：告警并重建有效证书', () => {
    const dir = makeDirectory()
    const warnings: string[] = []
    const service = new SyncIdentityService({
      directory: dir,
      logger: { info: () => {}, warn: (message: string) => warnings.push(message) }
    })
    const original = service.getOrCreateTlsIdentity()
    fs.writeFileSync(path.join(dir, 'server.crt'), 'not a pem at all', 'utf8')

    const recovered = service.getOrCreateTlsIdentity()
    expect(warnings.length).toBeGreaterThan(0)
    expect(() => new X509Certificate(recovered.certPem)).not.toThrow()
    expect(recovered.certPem).not.toBe(original.certPem)
    expect(recovered.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(recovered.fingerprintSha256).not.toBe(original.fingerprintSha256)
    // 重载后自洽
    expect(new SyncIdentityService({ directory: dir }).getOrCreateTlsIdentity().certPem).toBe(
      recovered.certPem
    )
  })

  it('证书与私钥不匹配时自愈（换钥重签）', () => {
    const dir = makeDirectory()
    const service = new SyncIdentityService({ directory: dir })
    const original = service.getOrCreateTlsIdentity()
    // 用另一把 RSA 私钥覆盖 server.key，制造 cert/key 失配
    const alien = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'der' }
    })
    fs.writeFileSync(path.join(dir, 'server.key'), String(alien.privateKey), 'utf8')

    const recovered = service.getOrCreateTlsIdentity()
    expect(recovered.certPem).not.toBe(original.certPem)
    const cert = new X509Certificate(recovered.certPem)
    expect(
      cert.publicKey
        .export({ format: 'der', type: 'spki' })
        .equals(createPublicKey(recovered.keyPem).export({ format: 'der', type: 'spki' }))
    ).toBe(true)
  })

  it.skipIf(process.platform === 'win32')(
    '私钥文件权限最小化（POSIX 0600；Windows 继承 userData 每用户 ACL）',
    () => {
      const dir = makeDirectory()
      new SyncIdentityService({ directory: dir }).getOrCreateTlsIdentity()
      const keyMode = fs.statSync(path.join(dir, 'server.key')).mode & 0o777
      expect(keyMode).toBe(0o600)
    }
  )
})

// ============================================================================
// 服务器 Ed25519 身份（PairResponse.serverPublicKey）
// ============================================================================

describe('SyncIdentityService.getOrCreateServerIdentity', () => {
  it('首次生成 Ed25519 密钥对并持久化', () => {
    const dir = makeDirectory()
    const service = new SyncIdentityService({ directory: dir })
    const identity = service.getOrCreateServerIdentity()

    expect(fs.existsSync(path.join(dir, 'server-ed25519.pub'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'server-ed25519.key'))).toBe(true)
    expect(identity.publicKeyPem).toContain('BEGIN PUBLIC KEY')
    expect(identity.privateKeyPem).toContain('BEGIN PRIVATE KEY')
    expect(() => createPublicKey(identity.publicKeyPem)).not.toThrow()
    expect(() => createPublicKey(identity.privateKeyPem)).not.toThrow()
  })

  it('跨实例重载返回同一密钥对（持久化语义）', () => {
    const dir = makeDirectory()
    const first = new SyncIdentityService({ directory: dir }).getOrCreateServerIdentity()
    const again = new SyncIdentityService({ directory: dir }).getOrCreateServerIdentity()
    expect(again.publicKeyPem).toBe(first.publicKeyPem)
    expect(again.privateKeyPem).toBe(first.privateKeyPem)
  })

  it('公钥文件与私钥匹配（私钥导出公钥 == 公钥文件）', () => {
    const dir = makeDirectory()
    const identity = new SyncIdentityService({ directory: dir }).getOrCreateServerIdentity()
    const derived = createPublicKey(identity.privateKeyPem).export({ format: 'der', type: 'spki' })
    const stored = createPublicKey(identity.publicKeyPem).export({ format: 'der', type: 'spki' })
    expect(derived.equals(stored)).toBe(true)
  })

  it('公钥文件损坏时自愈重建', () => {
    const dir = makeDirectory()
    const warnings: string[] = []
    const service = new SyncIdentityService({
      directory: dir,
      logger: { info: () => {}, warn: (message: string) => warnings.push(message) }
    })
    const original = service.getOrCreateServerIdentity()
    fs.writeFileSync(path.join(dir, 'server-ed25519.pub'), 'garbage', 'utf8')

    const recovered = service.getOrCreateServerIdentity()
    expect(warnings.length).toBeGreaterThan(0)
    expect(recovered.publicKeyPem).not.toBe(original.publicKeyPem)
    expect(() => createPublicKey(recovered.publicKeyPem)).not.toThrow()
  })

  it.skipIf(process.platform === 'win32')('Ed25519 私钥文件权限 0600', () => {
    const dir = makeDirectory()
    new SyncIdentityService({ directory: dir }).getOrCreateServerIdentity()
    expect(fs.statSync(path.join(dir, 'server-ed25519.key')).mode & 0o777).toBe(0o600)
  })
})

// ============================================================================
// 指纹查询
// ============================================================================

describe('SyncIdentityService.getTlsFingerprintSha256', () => {
  it('返回与 getOrCreateTlsIdentity 一致的指纹（64 位小写 hex）', () => {
    const dir = makeDirectory()
    const service = new SyncIdentityService({ directory: dir })
    const identity = service.getOrCreateTlsIdentity()
    expect(service.getTlsFingerprintSha256()).toBe(identity.fingerprintSha256)
    expect(service.getTlsFingerprintSha256()).toMatch(/^[0-9a-f]{64}$/)
  })
})
