// @layer main/services
// @module filebox-cipher
// @coverage 上游 aes-gcm-filebox 加密文件的认证解密（golden 差分判据）
//
// 加密侧 fixture 在本测试内独立实现（常量与派生逐字对齐上游 rust/src/nuan5_database/
// nuan5_database.rs，不 import 生产代码），使生产侧派生常量或算法漂移即测试红——
// 与 nuan5 原生库基线测试同款 golden 思路。
import { describe, it, expect } from 'vitest'
import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { decryptFilebox, FileboxDecryptError } from './filebox-cipher'

// ===== 加密侧 fixture（独立于生产实现，golden 差分判据） =====

/** 上游 nuan5_database.rs `const KEY` 的逐字副本（32 字节 ASCII，非 hex 解码） */
const UPSTREAM_IKM = Buffer.from('9C46C6BF431F5AFFF97A2002AEDFA8B7', 'utf8')
const UPSTREAM_INFO = Buffer.from('aes-gcm-filebox', 'utf8')

function deriveKeyForTest(salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', UPSTREAM_IKM, salt, UPSTREAM_INFO, 32))
}

/** 生成上游文件布局的合法密文：salt(16) + nonce(12) + 密文 + tag(16) */
function encryptFileboxForTest(
  plaintext: Buffer,
  opts?: { salt?: Buffer; nonce?: Buffer }
): Buffer {
  const salt = opts?.salt ?? randomBytes(16)
  const nonce = opts?.nonce ?? randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveKeyForTest(salt), nonce)
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([salt, nonce, ct, cipher.getAuthTag()])
}

describe('decryptFilebox', () => {
  it('合法密文 round-trip：解密结果与明文一致', () => {
    const plaintext = Buffer.from('hello nuan5 config')
    expect(decryptFilebox(encryptFileboxForTest(plaintext))).toEqual(plaintext)
  })

  it('随机 salt/nonce 的两份密文解出同一明文', () => {
    const plaintext = Buffer.from('same plaintext')
    expect(decryptFilebox(encryptFileboxForTest(plaintext))).toEqual(plaintext)
    expect(decryptFilebox(encryptFileboxForTest(plaintext))).toEqual(plaintext)
  })

  it('固定 salt+nonce 的确定性向量', () => {
    const salt = Buffer.alloc(16, 0xab)
    const nonce = Buffer.alloc(12, 0xcd)
    const plaintext = Buffer.from('deterministic vector')
    expect(decryptFilebox(encryptFileboxForTest(plaintext, { salt, nonce }))).toEqual(plaintext)
  })

  it('密文字节被篡改 → GCM 认证失败，抛明确错误', () => {
    const enc = encryptFileboxForTest(Buffer.from('tamper target'))
    enc[enc.length - 20] ^= 0xff // 翻转密文中间一字节（避开 tag 与头部）
    expect(() => decryptFilebox(enc)).toThrow(FileboxDecryptError)
    expect(() => decryptFilebox(enc)).toThrow(/完整性校验失败/)
  })

  it('tag 被篡改 → 认证失败', () => {
    const enc = encryptFileboxForTest(Buffer.from('tag tamper'))
    enc[enc.length - 1] ^= 0x01
    expect(() => decryptFilebox(enc)).toThrow(FileboxDecryptError)
  })

  it('salt 被篡改 → 派生密钥变化，认证失败', () => {
    const enc = encryptFileboxForTest(Buffer.from('salt tamper'))
    enc[0] ^= 0x01
    expect(() => decryptFilebox(enc)).toThrow(FileboxDecryptError)
  })

  it('短于最小长度（44B）→ 明确报错而非越界', () => {
    expect(() => decryptFilebox(Buffer.alloc(43, 0x01))).toThrow(FileboxDecryptError)
    expect(() => decryptFilebox(Buffer.alloc(43, 0x01))).toThrow(/过短/)
    expect(() => decryptFilebox(Buffer.alloc(0))).toThrow(FileboxDecryptError)
  })

  it('恰为 44 字节（空明文 + tag）→ 解出空 Buffer', () => {
    expect(decryptFilebox(encryptFileboxForTest(Buffer.alloc(0)))).toEqual(Buffer.alloc(0))
  })
})
