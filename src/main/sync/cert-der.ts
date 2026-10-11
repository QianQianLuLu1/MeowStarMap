import { createSign, randomBytes } from 'node:crypto'

/**
 * 极简 X.509 v3 自签证书 DER 构造（纯函数，零第三方依赖）。
 *
 * Node 内置 crypto 不提供证书签发 API，本模块以最小 DER 编码器手写自签证书，
 * 结构与上游 LocalTlsIdentityService 的互操作约定逐字一致：
 * - sha256WithRSAEncryption（OID 1.2.840.113549.1.1.11）
 * - Issuer == Subject（CN），Name 为 SET OF（0x31）包裹 AttributeTypeAndValue
 * - 有效期 [now − 24h, now + 10y]（UTCTime），16 随机字节序列号
 * - 扩展：basicConstraints（空 SEQUENCE，RFC 5280 cA 默认 false——客户端钉扎
 *   leaf 证书指纹且跳过主机名校验，不要求 CA 位）+ SAN dNSName
 *
 * 行为已经 scratch 脚本实测：产物可被 `new X509Certificate(pem)` 解析、
 * 自签名 verify 通过、fingerprint256 == sha256(DER)（见 03 计划 §13）。
 */

// ============================================================================
// DER 基元
// ============================================================================

function lengthBytes(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  const bytes: number[] = []
  let value = length
  while (value > 0) {
    bytes.unshift(value & 0xff)
    value >>>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function der(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), lengthBytes(content.length), content])
}

function seq(...items: Buffer[]): Buffer {
  return der(0x30, Buffer.concat(items))
}

/** RDN 容器：SET OF AttributeTypeAndValue（0x31） */
function set(...items: Buffer[]): Buffer {
  return der(0x31, Buffer.concat(items))
}

function nullValue(): Buffer {
  return der(0x05, Buffer.alloc(0))
}

function utf8(value: string): Buffer {
  return der(0x0c, Buffer.from(value, 'utf8'))
}

function octet(value: Buffer): Buffer {
  return der(0x04, value)
}

function bitString(value: Buffer): Buffer {
  return der(0x03, Buffer.concat([Buffer.from([0]), value]))
}

/** X.509 context-specific explicit 标签（[0]/[3] 等） */
function explicit(tag: number, value: Buffer): Buffer {
  return der(0xa0 + tag, value)
}

/** 非负整数（DER 最小长度编码，必要时补 0x00 符号位） */
function integer(value: Buffer | number): Buffer {
  let data =
    typeof value === 'number'
      ? (() => {
          const out: number[] = []
          let n = value
          do {
            out.unshift(n & 0xff)
            n >>>= 8
          } while (n > 0)
          return Buffer.from(out)
        })()
      : Buffer.from(value)
  while (data.length > 1 && data[0] === 0) data = data.subarray(1)
  if ((data[0] ?? 0) & 0x80) data = Buffer.concat([Buffer.from([0]), data])
  return der(0x02, data)
}

/** 点分 OID → DER 对象标识符 */
function oid(value: string): Buffer {
  const parts = value.split('.').map(Number)
  const body: number[] = [parts[0]! * 40 + parts[1]!]
  for (const part of parts.slice(2)) {
    const encoded = [part & 0x7f]
    let n = Math.floor(part / 128)
    while (n > 0) {
      encoded.unshift(0x80 | (n & 0x7f))
      n = Math.floor(n / 128)
    }
    body.push(...encoded)
  }
  return der(0x06, Buffer.from(body))
}

function utcTime(date: Date): Buffer {
  const pad = (n: number) => String(n).padStart(2, '0')
  const value = `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  return der(0x17, Buffer.from(value, 'ascii'))
}

function pem(label: string, data: Buffer): string {
  const base64 =
    data
      .toString('base64')
      .match(/.{1,64}/g)
      ?.join('\n') ?? ''
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`
}

// ============================================================================
// 证书结构
// ============================================================================

const OID_SHA256_RSA = '1.2.840.113549.1.1.11' // sha256WithRSAEncryption
const OID_COMMON_NAME = '2.5.4.3'
const OID_BASIC_CONSTRAINTS = '2.5.29.19'
const OID_SUBJECT_ALT_NAME = '2.5.29.17'
const VALIDITY_NOT_BEFORE_MS = 24 * 60 * 60_000 // 回拨 24h 容时钟偏移
const VALIDITY_NOT_AFTER_MS = 10 * 365 * 24 * 60 * 60_000 // 10 年

function algorithmIdentifier(): Buffer {
  return seq(oid(OID_SHA256_RSA), nullValue())
}

/** Name ::= SEQUENCE OF RelativeDistinguishedName；RDN ::= SET OF AttributeTypeAndValue */
function name(commonName: string): Buffer {
  return seq(set(seq(oid(OID_COMMON_NAME), utf8(commonName))))
}

function extension(id: string, value: Buffer): Buffer {
  return seq(oid(id), octet(value))
}

export interface SelfSignedCertificateInput {
  /** PKCS8 PEM 私钥（签名用） */
  privateKeyPem: string
  /** SPKI DER 公钥（SubjectPublicKeyInfo，与私钥同对） */
  publicSpkiDer: Buffer
  commonName: string
  sanDnsName: string
}

/** 生成自签 X.509 v3 证书 PEM（RSA-SHA256；Issuer == Subject） */
export function createSelfSignedCertificate(input: SelfSignedCertificateInput): string {
  const notBefore = new Date(Date.now() - VALIDITY_NOT_BEFORE_MS)
  const notAfter = new Date(Date.now() + VALIDITY_NOT_AFTER_MS)
  const subject = name(input.commonName)
  // basicConstraints：空 SEQUENCE（cA 默认 false）；SAN：dNSName（context tag 0x82）
  const extensions = seq(
    extension(OID_BASIC_CONSTRAINTS, seq()),
    extension(OID_SUBJECT_ALT_NAME, seq(der(0x82, Buffer.from(input.sanDnsName, 'ascii'))))
  )
  const tbsCertificate = seq(
    explicit(0, integer(2)), // version v3
    integer(randomBytes(16)), // serialNumber
    algorithmIdentifier(),
    subject, // issuer（自签 == subject）
    seq(utcTime(notBefore), utcTime(notAfter)),
    subject, // subject
    Buffer.from(input.publicSpkiDer), // subjectPublicKeyInfo（已是 DER）
    explicit(3, extensions)
  )
  const signer = createSign('RSA-SHA256')
  signer.update(tbsCertificate)
  signer.end()
  const certificate = seq(
    tbsCertificate,
    algorithmIdentifier(),
    bitString(signer.sign(input.privateKeyPem))
  )
  return pem('CERTIFICATE', certificate)
}

/** X509Certificate.fingerprint256（冒号分隔大写 hex）→ 64 位小写 hex（协议 wire 格式） */
export function normalizeFingerprint(fingerprint: string): string {
  // 不用 replaceAll：src/main 的 tsc lib 目标低于 ES2021
  return fingerprint.replace(/:/g, '').toLowerCase()
}
