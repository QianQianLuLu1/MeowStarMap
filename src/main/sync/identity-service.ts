import fs from 'node:fs'
import path from 'node:path'
import { createPublicKey, generateKeyPairSync, X509Certificate } from 'node:crypto'
import { createSelfSignedCertificate, normalizeFingerprint } from './cert-der'

/**
 * 同步身份服务 — TLS 自签证书与服务器 Ed25519 身份的本地持久化管理。
 *
 * - 存储位置：{userData}/sync/（不使用 NikkiSync 的 %LOCALAPPDATA%/NikkiSync，
 *   也不落上游的 SQLite app_settings；路径由装配方传入，阶段4 接 app.getPath('userData')）
 * - 文件：server.crt / server.key（RSA-2048 TLS 证书与 PKCS8 私钥）、
 *   server-ed25519.pub / server-ed25519.key（服务器身份密钥对，PairResponse 使用）
 * - 权限策略：私钥文件以 mode 0o600 写入（POSIX 生效；Windows 下 mode 不生效，
 *   但 userData 位于用户 Profile 内、ACL 天然限定当前用户，等同最小化语义）。
 *   密钥材料不进日志，对外只暴露 SHA-256 指纹（64 位小写 hex）
 * - 自愈策略（改进上游：上游解析失败会让启动崩溃）：读取/解析/公私钥配对校验
 *   失败时告警并重新生成覆盖——证书只在首次与损坏时生成，重建成本可接受
 * - 无 Electron 依赖：日志经可注入 logger（阶段4 装配时接 electron-log），
 *   便于纯 Node 单元测试
 */

export interface SyncLogger {
  info(message: string): void
  warn(message: string): void
}

export interface TlsIdentity {
  keyPem: string
  certPem: string
  /** SHA-256(证书 DER)，64 位小写 hex（QR 配对载荷与客户端钉扎格式） */
  fingerprintSha256: string
  createdAt: string
}

export interface ServerIdentityKeyPair {
  publicKeyPem: string
  privateKeyPem: string
}

export interface SyncIdentityServiceOptions {
  /** 持久化目录（如 {userData}/sync），不存在时自动创建 */
  directory: string
  logger?: SyncLogger
}

const TLS_CERT_FILE = 'server.crt'
const TLS_KEY_FILE = 'server.key'
const SERVER_PUB_FILE = 'server-ed25519.pub'
const SERVER_KEY_FILE = 'server-ed25519.key'

const COMMON_NAME = 'WXNN Photo Manager Local'
const SAN_DNS_NAME = 'wxnn.local'

/** POSIX 私钥权限；Windows 忽略 mode（userData 每用户 ACL 兜底，见文件头） */
const PRIVATE_KEY_FILE_MODE = 0o600

function writePrivateKeyFile(filePath: string, data: string): void {
  fs.writeFileSync(filePath, data, { encoding: 'utf8', mode: PRIVATE_KEY_FILE_MODE })
}

export class SyncIdentityService {
  private readonly rootDirectory: string
  private readonly logger: SyncLogger | undefined

  constructor(options: SyncIdentityServiceOptions) {
    this.rootDirectory = path.resolve(options.directory)
    this.logger = options.logger
  }

  /**
   * 目录内文件路径解析。文件名全部来自模块常量白名单，此处仍强制
   * 根目录边界校验（解析结果不得越出 rootDirectory，纵深防御）。
   */
  private resolveFilePath(fileName: string): string {
    const resolved = path.resolve(this.rootDirectory, fileName)
    if (resolved !== this.rootDirectory && !resolved.startsWith(this.rootDirectory + path.sep)) {
      throw new Error(`path escapes sync identity directory: ${fileName}`)
    }
    return resolved
  }

  // ============ TLS 自签证书 ============

  /** 获取或创建 TLS 身份；读取/校验失败时告警并重建（自愈） */
  getOrCreateTlsIdentity(): TlsIdentity {
    const certPath = this.resolveFilePath(TLS_CERT_FILE)
    const keyPath = this.resolveFilePath(TLS_KEY_FILE)
    const existing = this.readTlsIdentity(certPath, keyPath)
    if (existing) return existing
    const identity = this.generateTlsIdentity(certPath, keyPath)
    this.logger?.info(
      `[sync] self-signed TLS certificate generated (fingerprint ${identity.fingerprintSha256})`
    )
    return identity
  }

  /** 指纹查询（保证身份已就绪）；QR 配对载荷与诊断展示用 */
  getTlsFingerprintSha256(): string {
    return this.getOrCreateTlsIdentity().fingerprintSha256
  }

  private readTlsIdentity(certPath: string, keyPath: string): TlsIdentity | null {
    let keyPem: string
    let certPem: string
    try {
      keyPem = fs.readFileSync(keyPath, 'utf8')
      certPem = fs.readFileSync(certPath, 'utf8')
    } catch {
      return null // 首次使用（文件缺失）
    }
    try {
      const cert = new X509Certificate(certPem)
      const fingerprintSha256 = normalizeFingerprint(cert.fingerprint256)
      // 公私钥配对校验：防止单边覆盖/损坏造成 TLS 服务器无法启动
      const certSpki = cert.publicKey.export({ format: 'der', type: 'spki' })
      const keySpki = createPublicKey(keyPem).export({ format: 'der', type: 'spki' })
      if (!certSpki.equals(keySpki)) {
        throw new Error('certificate and private key do not match')
      }
      return {
        keyPem,
        certPem,
        fingerprintSha256,
        createdAt: fs.statSync(certPath).mtime.toISOString()
      }
    } catch (err) {
      // 日志用英文：与 database 仓储层先例一致，避免引入 i18n 依赖（本目录保持纯 Node）
      this.logger?.warn(
        `[sync] TLS identity files corrupted or mismatched, regenerating: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      return null
    }
  }

  private generateTlsIdentity(certPath: string, keyPath: string): TlsIdentity {
    const keys = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    })
    const certPem = createSelfSignedCertificate({
      privateKeyPem: keys.privateKey,
      publicSpkiDer: keys.publicKey,
      commonName: COMMON_NAME,
      sanDnsName: SAN_DNS_NAME
    })
    fs.mkdirSync(this.rootDirectory, { recursive: true })
    writePrivateKeyFile(keyPath, keys.privateKey)
    fs.writeFileSync(certPath, certPem, 'utf8')
    return {
      keyPem: keys.privateKey,
      certPem,
      fingerprintSha256: normalizeFingerprint(new X509Certificate(certPem).fingerprint256),
      createdAt: new Date().toISOString()
    }
  }

  // ============ 服务器 Ed25519 身份 ============

  /**
   * 获取或创建服务器身份密钥对（PairResponse.serverPublicKey；公私钥配对校验失败自愈）。
   * 注意：serverId/serverName 由 SyncMetadataRepository.ensureServerIdentity 管理（DB 侧），
   * 本方法只管密钥材料（文件侧）。
   */
  getOrCreateServerIdentity(): ServerIdentityKeyPair {
    const pubPath = this.resolveFilePath(SERVER_PUB_FILE)
    const keyPath = this.resolveFilePath(SERVER_KEY_FILE)
    const existing = this.readServerIdentity(pubPath, keyPath)
    if (existing) return existing
    const pair = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    })
    fs.mkdirSync(this.rootDirectory, { recursive: true })
    writePrivateKeyFile(keyPath, pair.privateKey)
    fs.writeFileSync(pubPath, pair.publicKey, 'utf8')
    this.logger?.info('[sync] server Ed25519 identity keypair generated')
    return { publicKeyPem: pair.publicKey, privateKeyPem: pair.privateKey }
  }

  private readServerIdentity(pubPath: string, keyPath: string): ServerIdentityKeyPair | null {
    let publicKeyPem: string
    let privateKeyPem: string
    try {
      publicKeyPem = fs.readFileSync(pubPath, 'utf8')
      privateKeyPem = fs.readFileSync(keyPath, 'utf8')
    } catch {
      return null // 首次使用（文件缺失）
    }
    try {
      const derived = createPublicKey(privateKeyPem).export({ format: 'der', type: 'spki' })
      const stored = createPublicKey(publicKeyPem).export({ format: 'der', type: 'spki' })
      if (!derived.equals(stored)) {
        throw new Error('public/private key mismatch')
      }
      return { publicKeyPem, privateKeyPem }
    } catch (err) {
      this.logger?.warn(
        `[sync] server identity files corrupted or mismatched, regenerating: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      return null
    }
  }
}
