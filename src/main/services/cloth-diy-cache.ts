// @core-change: 新增搭配码网络结果磁盘缓存服务（阶段 3）
/**
 * 搭配码（clothDiy）网络解码结果磁盘缓存（阶段 3）
 *
 * - key：`sha256(codeStr.trim())` hex；value：原始 networkData 字符串（非结构化结果，
 *   解析逻辑更新后旧缓存仍可直接复用）
 * - 落盘：`<userData>/cloth-diy-cache/<sha256hex>.txt`，原子写复用 utils/atomic-file
 * - 无 TTL：同一码的网络内容视为不可变，容量增长由 decrypt:clearClothCache 手动清理兜底
 * - 永不阻塞主流程：读失败视为未命中、写失败 warn 后返回 false；仅 clear 的目录枚举
 *   失败向上抛（由 IPC 层统一转错误响应）
 */
import crypto from 'crypto'
import fsp from 'fs/promises'
import path from 'path'
import { app } from 'electron'
import { logger } from '../utils/logger'
import { writeFileAtomic } from '../utils/atomic-file'

/** userData 下的缓存目录名（与 thumbnails/logs/crashes 等缺省子目录同级） */
const CACHE_DIR_NAME = 'cloth-diy-cache'

/** 测试/DI seam：注入后优先生效；null 恢复缺省根 */
let injectedRoot: string | null = null

export function setClothDiyCacheRoot(root: string | null): void {
  injectedRoot = root
}

/** 解析缓存根；不可用（app 未就绪等）返回 null = 缓存禁用 */
function resolveCacheRoot(): string | null {
  if (injectedRoot) return injectedRoot
  try {
    return path.join(app.getPath('userData'), CACHE_DIR_NAME)
  } catch {
    return null
  }
}

/** 稳定缓存键：sha256(trim(codeStr)) hex（日志只取前缀，不打完整码） */
function cacheHash(codeStr: string): string {
  return crypto.createHash('sha256').update(codeStr.trim(), 'utf8').digest('hex')
}

/** 缓存文件名：sha256 hex + .txt（charset 受控，无路径穿越面） */
function cacheFileName(codeStr: string): string {
  return `${cacheHash(codeStr)}.txt`
}

/** 可预测缓存文件路径；根不可用时返回 null */
export function getClothDiyCachePath(codeStr: string): string | null {
  const root = resolveCacheRoot()
  if (!root) return null
  return path.join(root, cacheFileName(codeStr))
}

/**
 * 读取搭配码网络结果缓存。
 * 命中返回原始 networkData 字符串；未命中/不可读/空内容一律返回 undefined。
 */
export async function readClothDiyCache(codeStr: string): Promise<string | undefined> {
  const file = getClothDiyCachePath(codeStr)
  if (!file) return undefined
  try {
    const content = await fsp.readFile(file, 'utf8')
    if (content.length === 0) return undefined
    logger.debug(`[clothDiy] 搭配码缓存命中 hash=${cacheHash(codeStr).slice(0, 8)}，跳过网络解码`)
    return content
  } catch {
    // 未命中 / 权限 / 损坏：一律视为未命中，交还网络流程
    return undefined
  }
}

/**
 * 写入搭配码网络结果缓存（原子写）。任何失败仅 warn 并返回 false，不阻塞主流程。
 * @returns 是否写入成功
 */
export async function writeClothDiyCache(codeStr: string, networkData: string): Promise<boolean> {
  const file = getClothDiyCachePath(codeStr)
  if (!file || networkData.length === 0) return false
  const hash = cacheHash(codeStr)
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await writeFileAtomic(file, (tmpPath) => fsp.writeFile(tmpPath, networkData, 'utf8'))
    logger.debug(
      `[clothDiy] 搭配码缓存已写入 hash=${hash.slice(0, 8)} bytes=${Buffer.byteLength(networkData, 'utf8')}`
    )
    return true
  } catch (err) {
    logger.warn(`[clothDiy] 搭配码缓存写入失败（忽略，不阻塞主流程）hash=${hash.slice(0, 8)}`, err)
    return false
  }
}

/**
 * 清空搭配码缓存目录（decrypt:clearClothCache 消费）。
 * 目录不存在视为空；单文件删除失败跳过并 warn；目录枚举失败向上抛。
 */
export async function clearClothDiyCache(): Promise<{
  clearedCount: number
  clearedSize: number
}> {
  const root = resolveCacheRoot()
  if (!root) return { clearedCount: 0, clearedSize: 0 }
  let entries: string[]
  try {
    entries = await fsp.readdir(root)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { clearedCount: 0, clearedSize: 0 }
    }
    throw err
  }
  let clearedCount = 0
  let clearedSize = 0
  for (const name of entries) {
    const filePath = path.join(root, name)
    try {
      const stat = await fsp.stat(filePath)
      if (!stat.isFile()) continue
      await fsp.unlink(filePath)
      clearedCount += 1
      clearedSize += stat.size
    } catch (err) {
      logger.warn(`[clothDiy] 搭配码缓存清理单文件失败（跳过）: ${name}`, err)
    }
  }
  return { clearedCount, clearedSize }
}
