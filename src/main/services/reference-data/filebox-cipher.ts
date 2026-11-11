// @core-change: 新增上游 aes-gcm-filebox 认证解密（参考数据管道 v1.db 专用）
/**
 * 上游 "aes-gcm-filebox" 加密文件的认证解密。
 *
 * 算法逐字对齐上游 RanAxro/nikki_albums `rust/src/nuan5_database/nuan5_database.rs`
 * （MIT，署名见总计划 §2）：文件布局 salt(16B)+nonce(12B)+密文+GCM tag(16B)，
 * 密钥 = HKDF-SHA256(32B ASCII 常量, salt, info="aes-gcm-filebox", L=32)。
 *
 * 用 Node 原生 crypto 而非 nuan5_decryption.dll：该 DLL 只覆盖照片参数解密，
 * 参考数据文件的 GCM 解密在上游是独立于 DLL 的 Rust 实现；此处同为纯算法，
 * `final()` 的 tag 校验即数据完整性兜底（篡改一字节必失败）。
 */
import { createDecipheriv, hkdfSync } from 'node:crypto'

/** 上游 `const KEY`：32 字节 ASCII 字符串（注意是逐字节原文，不是 hex 解码） */
const UPSTREAM_IKM = Buffer.from('9C46C6BF431F5AFFF97A2002AEDFA8B7', 'utf8')
const UPSTREAM_INFO = Buffer.from('aes-gcm-filebox', 'utf8')
const SALT_LEN = 16
const NONCE_LEN = 12
/** salt + nonce + 空明文的 GCM tag，最小合法长度 */
const MIN_FILE_LEN = SALT_LEN + NONCE_LEN + 16

export class FileboxDecryptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FileboxDecryptError'
  }
}

/**
 * 解密 aes-gcm-filebox 布局的文件字节。
 * @throws FileboxDecryptError 长度不足最小布局，或 GCM 完整性校验失败（数据损坏/被篡改）
 */
export function decryptFilebox(data: Buffer): Buffer {
  if (data.length < MIN_FILE_LEN) {
    throw new FileboxDecryptError(
      `加密文件过短（${data.length}B < ${MIN_FILE_LEN}B），非合法 aes-gcm-filebox 布局`
    )
  }

  const salt = data.subarray(0, SALT_LEN)
  const nonce = data.subarray(SALT_LEN, SALT_LEN + NONCE_LEN)
  const ciphertext = data.subarray(SALT_LEN + NONCE_LEN)
  // GCM tag 固定为末尾 16B（Node 的 setAuthTag 需要单独传入；上游 Rust crate 自动切分）
  const tag = ciphertext.subarray(ciphertext.length - 16)
  const body = ciphertext.subarray(0, ciphertext.length - 16)

  const key = Buffer.from(hkdfSync('sha256', UPSTREAM_IKM, salt, UPSTREAM_INFO, 32))
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    // final() 抛错 = GCM tag 校验失败：密钥不匹配或数据被损坏/篡改
    throw new FileboxDecryptError(`完整性校验失败：数据损坏或被篡改（GCM tag 不符）`)
  }
}
