/**
 * 文件系统工具函数
 *
 * 解决 C-G1/C-O1：原先 file-service.ts、video-service.ts、watermark-service.ts
 * 中重复 15 处「设标志位 access 检查」模板与 6 处「冲突文件名自增 do-while」循环，
 * 以及 index.ts 与 file-service.ts 各自实现 parseDataUrlToBuffer（实现不一致，
 * 后者无正则校验、不提取 MIME）。
 *
 * 本模块提供统一工具函数，所有文件存在检查、唯一路径生成、DataURL 解析均应引用此处。
 */

import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import crypto from 'crypto'

/**
 * 检查文件/目录是否存在（异步）
 *
 * 取代原先 15 处「let exists = false; try { await fsp.access(p, F_OK); exists = true } catch { exists = false }」模板。
 *
 * @param filePath 文件或目录路径
 * @param mode access 模式，默认 F_OK（仅检查存在性）
 * @returns 存在返回 true，不存在或权限不足返回 false
 */
export async function pathExists(
  filePath: string,
  mode: number = fs.constants.F_OK
): Promise<boolean> {
  try {
    await fsp.access(filePath, mode)
    return true
  } catch {
    return false
  }
}

/**
 * 生成不冲突的唯一文件路径
 *
 * 取代原先 6 处「do { targetPath = path.join(dir, `${baseName}_${counter}.${ext}`); access... } while (exists)」循环。
 *
 * 若初始路径不存在，直接返回；若已存在，按 `${baseName}_${counter}${extWithDot}` 自增直到找到不冲突的路径。
 *
 * @param dir 目标目录
 * @param baseName 文件名（不含扩展名）
 * @param extWithDot 扩展名（含点号，如 '.jpg'；无扩展名传空字符串）
 * @param nameFormatter 可选的自定义命名函数，用于覆盖默认的 `${baseName}_${counter}` 模板
 *   - 接收 counter（从 1 开始），返回完整文件名（不含扩展名）
 *   - 不传时使用默认 `${baseName}_${counter}`
 * @returns 不冲突的完整文件路径
 */
export async function getUniqueFilePath(
  dir: string,
  baseName: string,
  extWithDot: string,
  nameFormatter?: (counter: number) => string
): Promise<string> {
  const initialPath = path.join(dir, `${baseName}${extWithDot}`)
  if (!(await pathExists(initialPath))) {
    return initialPath
  }

  let counter = 1
  // 安全上限：避免极端情况下死循环
  while (counter < 100000) {
    const name = nameFormatter ? nameFormatter(counter) : `${baseName}_${counter}`
    const candidate = path.join(dir, `${name}${extWithDot}`)
    if (!(await pathExists(candidate))) {
      return candidate
    }
    counter++
  }
  // 理论上不会到达，返回带超大 counter 的路径由调用方处理写入失败
  return path.join(dir, `${baseName}_${Date.now()}${extWithDot}`)
}

/**
 * 解析 DataURL 为 Buffer 与 MIME 类型
 *
 * 取代 index.ts 中的同名函数与 file-service.ts 中的简化版（无校验、不提取 MIME）。
 *
 * @param dataUrl 形如 `data:image/jpeg;base64,/9j/4AAQ...` 的 DataURL
 * @returns `{ buffer, mimeType }`
 * @throws 若 DataURL 格式无效
 */
export function parseDataUrlToBuffer(dataUrl: string): { buffer: Buffer; mimeType: string } {
  const match = dataUrl.match(/^data:([\w./-]+);base64,(.+)$/)
  if (!match) throw new Error('无效的 DataURL')
  return { buffer: Buffer.from(match[2], 'base64'), mimeType: match[1] }
}

/**
 * 将 Buffer 编码为 DataURL
 *
 * 取代 watermark-service.ts 中的内联 `buffer.toString('base64')` + 字符串拼接。
 *
 * @param buffer 二进制数据
 * @param mimeType MIME 类型，如 'image/png'
 * @returns 形如 `data:image/png;base64,...` 的 DataURL
 */
export function bufferToDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString('base64')}`
}

/**
 * 计算文件完整内容的 sha256 hash（用于重复文件检测）
 *
 * F-S10：与 thumbnail/generator.ts 中的 getFileHash（仅前 1MB，用于缓存键）不同，
 * 重复检测需要完整内容 hash 以确保检测准确性——两个文件前 1MB 相同但后续不同
 * 不应被判为重复。
 *
 * 采用流式读取（createReadStream）避免一次性将大文件载入内存；
 * 单次默认 highWaterMark 64KB，内存占用恒定。
 *
 * @param filePath 文件绝对路径
 * @returns 64 字符的 sha256 hex 字符串
 * @throws 文件不存在或不可读时抛出异常
 */
export async function calculateFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    let errored = false
    const cleanup = () => {
      stream.removeAllListeners()
    }
    stream.on('data', (chunk: Buffer | string) => {
      hash.update(chunk as Buffer)
    })
    stream.on('end', () => {
      if (errored) return
      cleanup()
      resolve(hash.digest('hex'))
    })
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (errored) return
      errored = true
      cleanup()
      // 销毁流避免资源泄漏
      stream.destroy()
      reject(err)
    })
  })
}

/**
 * 移动文件（C-G2：替代 fs-extra.move）
 *
 * 策略：
 * 1. 优先 fsp.rename —— 同盘符原子操作，最快
 * 2. 跨设备（EXDEV）时回退到 copyFile + unlink，保证跨盘符移动可用
 * 3. 其他错误直接抛出，由调用方处理
 *
 * 注意：本函数不覆盖已存在目标（与原 fse.move { overwrite: false } 语义一致）。
 * 调用方应先通过 pathExists 检查目标不存在，Windows 下 rename 遇到已存在目标会抛 EEXIST。
 *
 * @param source 源文件路径
 * @param destination 目标文件路径
 * @throws 源不存在、目标已存在、跨设备且复制失败等错误
 */
export async function moveFile(source: string, destination: string): Promise<void> {
  try {
    await fsp.rename(source, destination)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // EXDEV: 跨设备链接，rename 不支持，回退到复制+删除
    if (code === 'EXDEV') {
      await fsp.copyFile(source, destination)
      await fsp.unlink(source)
      return
    }
    throw err
  }
}
