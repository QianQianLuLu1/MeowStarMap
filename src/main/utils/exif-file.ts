/**
 * exifr 低层读取封装（文件句柄安全）
 *
 * 为什么不用 `exifr.parse(filePath)`：
 * exifr 7 的 `Exifr.parse()` 只在成功路径调用 `file.close()`，解析中途抛错
 * （损坏/截断图片）时内部 FileHandle 不会被关闭。Node 26 起，GC 回收未关闭的
 * FileHandle 会升级为未捕获异常（ERR_INVALID_STATE），直接导致进程退出码非 0。
 * 因此统一走低层 `Exifr` 实例，在首次 I/O 前登记 FsReader，并在 finally 中显式关闭。
 */
import { Exifr, fileReaders } from 'exifr'

/** exifr 构造参数（其 d.ts 未导出 Options，用构造器参数推导） */
export type ExifrOptions = ConstructorParameters<typeof Exifr>[0]

interface CloseableReader {
  file?: CloseableFile
}

interface CloseableFile {
  close?: () => Promise<void> | void
}

interface ReaderInternals extends CloseableReader {
  options: ExifrOptions
}

interface FsReader extends CloseableFile {
  read: () => Promise<void>
}

type FsReaderConstructor = new (input: string, options: ExifrOptions) => FsReader

/**
 * 读取文件 EXIF/XMP 并保证释放内部文件句柄
 *
 * @param filePath 文件绝对路径
 * @param options 与 exifr.parse 同形的解析选项
 * @returns 解析结果；无数据时返回 null
 * @throws exifr 解析异常（错误语义与直接调用 exifr.parse 一致，交由调用方处理）
 */
export async function parseExifFile<T = Record<string, unknown>>(
  filePath: string,
  options?: ExifrOptions
): Promise<T | null> {
  const reader = new Exifr(options)
  const FsReader = fileReaders.get('fs') as FsReaderConstructor
  const file = new FsReader(filePath, (reader as unknown as ReaderInternals).options)
  ;(reader as unknown as ReaderInternals).file = file
  try {
    await file.read()
    return ((await reader.parse()) ?? null) as T | null
  } finally {
    await closeReaderFile(reader)
  }
}

/** 幂等关闭：成功路径 exifr 已发起关闭，此时为空操作 */
async function closeReaderFile(reader: Exifr): Promise<void> {
  const file = (reader as unknown as CloseableReader).file
  if (!file?.close) return
  try {
    await file.close()
  } catch {
    // 关闭失败不得覆盖主流程的解析结果/异常；句柄最迟随进程退出释放
  }
}
