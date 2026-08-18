import fsp from 'fs/promises'
import path from 'path'
import { shell, dialog } from 'electron'
import sharp from 'sharp'
import exifr from 'exifr'
import type { ExportOptions, ExifData, ExportFileMetadata } from '../types/file'
// C-3：统一文件工具函数与媒体常量；C-G2：moveFile 替代 fs-extra.move
import { pathExists, getUniqueFilePath, parseDataUrlToBuffer, moveFile } from '../utils/file-utils'
import { assertFileWritePath, pathGuard } from '../ipc/validator'
import { isAppError } from '../../shared/errors/app-error'
import { isImageExt, MEDIA_EXTENSIONS, isVideoExt } from '../utils/media-constants'
import { assertDiskSpace } from '../utils/disk'
import { t } from '../i18n'
import { logger } from '../utils/logger'

// P1-02：导出命名规则变量替换
// 支持变量：{date} {album_type} {uid} {original_name} {sequence}
// date 格式 YYYYMMDD；sequence 3 位补零；其余变量缺失时回退到 original_name
function resolveNamingPattern(
  pattern: string,
  originalName: string,
  meta: ExportFileMetadata | undefined,
  sequence: number
): string {
  const date = new Date()
  const dateStr = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
  const seqStr = String(sequence).padStart(3, '0')
  const albumType = meta?.album_type || 'other'
  const uid = meta?.account_uid || 'default'
  // 安全化：去掉路径分隔符，避免子目录注入
  const safe = (s: string) => s.replace(/[\\/]/g, '_')
  return pattern
    .replace(/\{date\}/g, dateStr)
    .replace(/\{album_type\}/g, safe(albumType))
    .replace(/\{uid\}/g, safe(uid))
    .replace(/\{original_name\}/g, safe(originalName))
    .replace(/\{sequence\}/g, seqStr)
}

export class FileService {
  async moveToRecycleBin(filePaths: string[]): Promise<{ success: boolean; message: string }> {
    try {
      for (const filePath of filePaths) {
        await shell.trashItem(filePath)
      }
      return {
        success: true,
        message: t('main.file.message.movedToRecycleBin', { count: filePaths.length })
      }
    } catch (error) {
      return {
        success: false,
        message: t('main.file.message.deleteFailed', {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }

  // F-G3：格式化文件操作错误，将 Windows EBUSY/EPERM 映射为友好提示
  private formatFileError(error: unknown, action: string): string {
    const err = error as NodeJS.ErrnoException
    if (err?.code === 'EBUSY') {
      return t('main.file.error.busy', { action })
    }
    if (err?.code === 'EPERM' || err?.code === 'EACCES') {
      return t('main.file.error.permission', { action })
    }
    return t('main.file.error.generic', {
      action,
      error: error instanceof Error ? error.message : String(error)
    })
  }

  async copyFiles(
    sourcePaths: string[],
    targetDir: string
  ): Promise<{
    success: boolean
    message: string
    actualPaths?: string[]
    // R3：copy 产生新文件，不入库由扫描器扫到时自动入库；这里仅返回 mapping 供前端/日志使用
    copied?: { sourcePath: string; targetPath: string }[]
  }> {
    try {
      await fsp.mkdir(targetDir, { recursive: true })

      // F-G2：预估所需空间（源文件总大小）
      let totalSize = 0
      for (const sourcePath of sourcePaths) {
        try {
          const stat = await fsp.stat(sourcePath)
          totalSize += stat.size
        } catch {
          // 源文件 stat 失败时跳过
        }
      }
      if (totalSize > 0) await assertDiskSpace(targetDir, totalSize)

      // P1-C2：冲突时使用 getUniqueFilePath 自动重命名，并返回实际路径供前端撤销使用
      const actualPaths: string[] = []
      const copied: { sourcePath: string; targetPath: string }[] = []
      for (const sourcePath of sourcePaths) {
        const ext = path.extname(sourcePath)
        const baseName = path.basename(sourcePath, ext)
        const targetPath = await getUniqueFilePath(targetDir, baseName, ext)
        await fsp.copyFile(sourcePath, targetPath)
        actualPaths.push(targetPath)
        copied.push({ sourcePath, targetPath })
      }

      return {
        success: true,
        message: t('main.file.message.copied', { count: sourcePaths.length }),
        actualPaths,
        copied
      }
    } catch (error) {
      return {
        success: false,
        message: this.formatFileError(error, t('main.file.action.copy'))
      }
    }
  }

  async moveFiles(
    sourcePaths: string[],
    targetDir: string
  ): Promise<{
    success: boolean
    message: string
    actualPaths?: string[]
    // R3：返回 oldPath→newPath mapping，供 handler 同步 media_files.file_path/file_name
    renamed?: { oldPath: string; newPath: string; newFileName: string }[]
  }> {
    try {
      await fsp.mkdir(targetDir, { recursive: true })

      // F-G2：预估所需空间（跨卷移动需要复制）
      let totalSize = 0
      for (const sourcePath of sourcePaths) {
        try {
          const stat = await fsp.stat(sourcePath)
          totalSize += stat.size
        } catch {
          // 源文件 stat 失败时跳过
        }
      }
      if (totalSize > 0) await assertDiskSpace(targetDir, totalSize)

      // P1-C2：冲突时使用 getUniqueFilePath 自动重命名，并返回实际路径供前端撤销使用
      const actualPaths: string[] = []
      const renamed: { oldPath: string; newPath: string; newFileName: string }[] = []
      // FIX(组14-1): 单项移动失败终止循环，但已成功移动项的映射必须随失败结果回传——
      // handler 据此同步 DB；否则失败点之前已物理移动的文件在库中仍指向旧路径
      // （图库表现为破图/missing），且旧路径已不存在，用户重试也必然失败
      let firstFailure: unknown = null
      for (const sourcePath of sourcePaths) {
        const ext = path.extname(sourcePath)
        const baseName = path.basename(sourcePath, ext)
        try {
          const targetPath = await getUniqueFilePath(targetDir, baseName, ext)
          await moveFile(sourcePath, targetPath)
          actualPaths.push(targetPath)
          renamed.push({
            oldPath: sourcePath,
            newPath: targetPath,
            newFileName: path.basename(targetPath)
          })
        } catch (err) {
          firstFailure = err
          break
        }
      }
      if (firstFailure !== null) {
        return {
          success: false,
          message: this.formatFileError(firstFailure, t('main.file.action.move')),
          actualPaths,
          renamed
        }
      }

      return {
        success: true,
        message: t('main.file.message.moved', { count: sourcePaths.length }),
        actualPaths,
        renamed
      }
    } catch (error) {
      return {
        success: false,
        message: this.formatFileError(error, t('main.file.action.move'))
      }
    }
  }

  async renameFile(
    oldPath: string,
    newName: string
  ): Promise<{
    success: boolean
    message: string
    // R3：返回 oldPath→newPath mapping，供 handler 同步 media_files.file_path/file_name
    renamed?: { oldPath: string; newPath: string; newFileName: string }[]
  }> {
    try {
      // 防止路径遍历：文件名不得包含路径分隔符和上级目录引用
      const invalidChars = /[<>:"\\|?*/]/
      if (invalidChars.test(newName)) {
        throw new Error(t('main.file.error.invalidChars'))
      }
      // 额外检查：禁止纯点号名称和包含 .. 的路径遍历尝试
      const trimmedName = newName.trim()
      if (trimmedName === '.' || trimmedName === '..' || trimmedName.includes('..')) {
        throw new Error(t('main.file.error.pathReference'))
      }
      // 使用 path.basename 确保最终文件名不含路径
      const safeName = path.basename(trimmedName)
      if (safeName !== trimmedName) {
        throw new Error(t('main.file.error.invalidSeparator'))
      }

      const dir = path.dirname(oldPath)
      const ext = path.extname(oldPath)
      const newPath = path.join(dir, safeName + ext)

      if (await pathExists(newPath)) {
        throw new Error(t('main.file.error.targetExists'))
      }

      await moveFile(oldPath, newPath)
      return {
        success: true,
        message: t('main.file.message.renameSuccess'),
        renamed: [{ oldPath, newPath, newFileName: path.basename(newPath) }]
      }
    } catch (error) {
      return {
        success: false,
        message: this.formatFileError(error, t('main.file.action.rename'))
      }
    }
  }

  /**
   * T12：批量重命名——按操作列表依次重命名，冲突时自动追加 _1/_2
   * 返回每条操作的详细结果，供调用方更新数据库与 UI
   */
  async batchRename(operations: { oldPath: string; newName: string }[]): Promise<{
    success: boolean
    renamed: { oldPath: string; newPath: string; newFileName: string }[]
    failed: { oldPath: string; message: string }[]
    message: string
  }> {
    const renamed: { oldPath: string; newPath: string; newFileName: string }[] = []
    const failed: { oldPath: string; message: string }[] = []
    // T12：同一批次内已使用的新路径集合，避免批次内冲突
    const usedNewPaths = new Set<string>()

    for (const op of operations) {
      try {
        const invalidChars = /[<>:"\\|?*/]/
        if (invalidChars.test(op.newName)) {
          throw new Error(t('main.file.error.invalidChars'))
        }
        const trimmedName = op.newName.trim()
        if (
          !trimmedName ||
          trimmedName === '.' ||
          trimmedName === '..' ||
          trimmedName.includes('..')
        ) {
          throw new Error(t('main.file.error.invalidName'))
        }
        const safeName = path.basename(trimmedName)
        if (safeName !== trimmedName) {
          throw new Error(t('main.file.error.invalidSeparator'))
        }

        const dir = path.dirname(op.oldPath)
        const ext = path.extname(op.oldPath)
        // T12：冲突处理——目标已存在或批次内已占用时，追加 _N
        let candidate = path.join(dir, safeName + ext)
        let counter = 1
        while ((await pathExists(candidate)) || usedNewPaths.has(candidate)) {
          candidate = path.join(dir, `${safeName}_${counter}${ext}`)
          counter++
        }
        await moveFile(op.oldPath, candidate)
        usedNewPaths.add(candidate)
        renamed.push({
          oldPath: op.oldPath,
          newPath: candidate,
          newFileName: path.basename(candidate)
        })
      } catch (error) {
        failed.push({
          oldPath: op.oldPath,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }

    return {
      success: failed.length === 0,
      renamed,
      failed,
      message:
        failed.length === 0
          ? t('main.file.message.batchRenameAllSuccess', { count: renamed.length })
          : t('main.file.message.batchRenamePartial', {
              success: renamed.length,
              failed: failed.length
            })
    }
  }

  async exportFiles(
    filePaths: string[],
    targetDir: string,
    options: ExportOptions = {},
    // P1-02：每个源文件对应的元数据（用于命名规则变量替换）
    metadataMap?: Map<string, ExportFileMetadata>
  ): Promise<{ success: boolean; message: string }> {
    try {
      await fsp.mkdir(targetDir, { recursive: true })

      // F-G2：预估所需空间（源文件总大小）
      let totalSize = 0
      for (const sourcePath of filePaths) {
        try {
          const stat = await fsp.stat(sourcePath)
          totalSize += stat.size
        } catch {
          // 源文件 stat 失败时跳过
        }
      }
      if (totalSize > 0) await assertDiskSpace(targetDir, totalSize)

      const { format = 'original', quality = 90, namingPattern } = options

      let seq = 0
      for (const sourcePath of filePaths) {
        seq++
        const ext = path.extname(sourcePath).toLowerCase()
        const baseName = path.basename(sourcePath, ext)
        const targetFormat = format === 'original' ? ext.replace('.', '') : format
        const targetExt = targetFormat === 'jpeg' ? 'jpg' : targetFormat

        // P1-02：若配置了命名规则，解析变量生成新文件名
        let finalBaseName = baseName
        if (namingPattern && namingPattern.trim()) {
          const meta = metadataMap?.get(sourcePath)
          finalBaseName = resolveNamingPattern(namingPattern.trim(), baseName, meta, seq)
        }

        // C-3：统一唯一路径生成（取代内联 do-while 冲突自增循环）
        const targetPath = await getUniqueFilePath(targetDir, finalBaseName, `.${targetExt}`)

        if (isImageExt(ext) && format !== 'original') {
          let pipeline = sharp(sourcePath)
          switch (format) {
            case 'jpg':
            case 'jpeg':
              pipeline = pipeline.jpeg({ quality, progressive: true, mozjpeg: true })
              break
            case 'png':
              pipeline = pipeline.png({ quality, progressive: true })
              break
            case 'webp':
              pipeline = pipeline.webp({ quality })
              break
          }
          await pipeline.toFile(targetPath)
        } else {
          await fsp.copyFile(sourcePath, targetPath)
        }
      }

      return {
        success: true,
        message: t('main.file.message.exported', { count: filePaths.length })
      }
    } catch (error) {
      return {
        success: false,
        message: this.formatFileError(error, t('main.file.action.export'))
      }
    }
  }

  async saveAs(
    filePath: string,
    targetDir: string,
    newName?: string
  ): Promise<{ success: boolean; message: string; newPath?: string }> {
    try {
      await fsp.mkdir(targetDir, { recursive: true })
      const ext = path.extname(filePath)
      const baseName = newName || path.basename(filePath, ext)
      // C-3：统一唯一路径生成
      const targetPath = await getUniqueFilePath(targetDir, baseName, ext)

      await fsp.copyFile(filePath, targetPath)
      return { success: true, message: t('main.file.message.saveAsSuccess'), newPath: targetPath }
    } catch (error) {
      return {
        success: false,
        message: t('main.file.message.saveAsFailed', {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }

  async deletePermanent(filePaths: string[]): Promise<{ success: boolean; message: string }> {
    // C-S3 修复：原实现 catch 块空吞错且外层总返回 success:true，文件删除失败时用户无感知。
    // 现区分"文件不存在"（ENOENT，合法忽略）与其他错误（EACCES/EBUSY 等，必须如实反馈）。
    const failed: string[] = []
    let deleted = 0
    for (const filePath of filePaths) {
      try {
        await fsp.unlink(filePath)
        deleted++
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') {
          // 文件不存在视为已删除，不计入失败
          deleted++
        } else {
          failed.push(`${filePath}: ${(err as Error).message}`)
        }
      }
    }
    if (failed.length > 0) {
      return {
        success: false,
        message: t('main.file.message.deletePermanentPartial', {
          success: deleted,
          total: filePaths.length,
          failed: failed.join('; ')
        })
      }
    }
    return { success: true, message: t('main.file.message.deletedPermanent', { count: deleted }) }
  }

  async getExif(filePath: string): Promise<ExifData> {
    try {
      const exif = await exifr.parse(filePath, {
        ifd0: { translateValues: false, reviveValues: true },
        exif: { translateValues: false, reviveValues: true },
        gps: { translateValues: false, reviveValues: true }
      })
      if (!exif) return {}

      return {
        camera: exif.Make && exif.Model ? `${exif.Make} ${exif.Model}` : exif.Model,
        lens: exif.LensModel,
        aperture: exif.FNumber ? `f/${exif.FNumber}` : undefined,
        shutter: exif.ExposureTime
          ? exif.ExposureTime < 1
            ? `1/${Math.round(1 / exif.ExposureTime)}`
            : `${exif.ExposureTime}s`
          : undefined,
        iso: exif.ISO || exif.PhotographicSensitivity,
        focalLength: exif.FocalLength ? `${exif.FocalLength}mm` : undefined,
        gps:
          exif.latitude && exif.longitude
            ? { latitude: exif.latitude, longitude: exif.longitude }
            : undefined,
        dateTaken: exif.DateTimeOriginal ? exif.DateTimeOriginal.toISOString() : undefined,
        width: exif.ExifImageWidth || exif.ImageWidth,
        height: exif.ExifImageHeight || exif.ImageLength
      }
    } catch (error) {
      logger.error('[Exif] 读取失败:', error) // TODO: i18n: internal log
      return {}
    }
  }

  async saveDataUrl(
    dataUrl: string,
    options: { directory?: string; fileName?: string; format?: string; quality?: number } = {}
  ): Promise<{ success: boolean; message: string; filePath?: string }> {
    try {
      // C-3：统一 DataURL 解析（取代内联 split + Buffer.from，无校验）
      const { buffer } = parseDataUrlToBuffer(dataUrl)

      // 安全限制：防止写入超大文件耗尽磁盘
      const MAX_DATA_URL_SIZE = 100 * 1024 * 1024 // 100MB
      if (buffer.length > MAX_DATA_URL_SIZE) {
        throw new Error(
          t('main.file.error.fileTooLarge', { size: buffer.length, limit: MAX_DATA_URL_SIZE })
        )
      }

      let targetDir = options.directory
      if (!targetDir) {
        const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
        if (result.canceled) throw new Error(t('main.file.error.noOutputDir'))
        targetDir = result.filePaths[0]
        // 用户在原生对话框里亲自选的目录视为授权，登记白名单后下方校验才不会误拒
        pathGuard.register(targetDir)
      }

      const format = options.format || 'jpg'
      const ext = format === 'jpeg' ? 'jpg' : format
      const defaultName = options.fileName || `编辑图片_${Date.now()}` // TODO: i18n: default filename
      // C-3：统一唯一路径生成
      const targetPath = await getUniqueFilePath(targetDir, defaultName, `.${ext}`)

      // 纵深防御：目录与文件名拼接后再校验一次最终落盘路径，
      // 避免调用方漏校验或拼接环节被绕过时直接裸写磁盘
      assertFileWritePath(targetPath)

      await fsp.writeFile(targetPath, buffer)
      return { success: true, message: t('main.file.message.saveSuccess'), filePath: targetPath }
    } catch (error) {
      // 路径拦截等 AppError 必须向上抛给 IPC 层，不能降级成 success:false 被静默吞掉
      if (isAppError(error)) throw error
      return {
        success: false,
        message: t('main.file.message.saveFailed', {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }

  // T14：预览待导入文件——递归扫描源目录，返回所有支持的媒体文件元信息
  // 仅读取元信息不复制，用于向导第二步展示
  async previewImport(sourceDir: string): Promise<{
    success: boolean
    files: Array<{
      sourcePath: string
      fileName: string
      size: number
      mtime: string
      ext: string
      isVideo: boolean
    }>
    message?: string
  }> {
    try {
      const stat = await fsp.stat(sourceDir)
      if (!stat.isDirectory()) {
        return { success: false, files: [], message: t('main.file.message.notDirectory') }
      }
    } catch {
      return { success: false, files: [], message: t('main.file.message.cannotAccessDir') }
    }

    const files: Array<{
      sourcePath: string
      fileName: string
      size: number
      mtime: string
      ext: string
      isVideo: boolean
    }> = []
    // 递归收集媒体文件
    const walk = async (dir: string) => {
      const entries = await fsp.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(fullPath)
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase()
          if (!MEDIA_EXTENSIONS.has(ext)) continue
          try {
            const s = await fsp.stat(fullPath)
            files.push({
              sourcePath: fullPath,
              fileName: entry.name,
              size: s.size,
              mtime: s.mtime.toISOString(),
              ext,
              isVideo: isVideoExt(ext)
            })
          } catch {
            // stat 失败跳过
          }
        }
      }
    }
    await walk(sourceDir)

    // 按文件名排序，确保序号命名稳定
    files.sort((a, b) => a.fileName.localeCompare(b.fileName, 'zh-CN'))
    return { success: true, files }
  }

  // T14：批量导入文件——按命名规则和分类策略复制到目标目录
  // 进度通过 onProgress 回调上报（current/total）
  async importFiles(
    sourcePaths: string[],
    targetBaseDir: string,
    options: {
      namingRule: 'keep' | 'date' | 'seq'
      categorize: 'flat' | 'byDate' | 'byMonth'
      conflictStrategy: 'skip' | 'rename' | 'overwrite'
      seqStart?: number
    },
    onProgress?: (current: number, total: number) => void
  ): Promise<{
    success: boolean
    imported: Array<{ sourcePath: string; targetPath: string }>
    failed: Array<{ sourcePath: string; message: string }>
    skipped: Array<{ sourcePath: string; reason: string }>
    message: string
  }> {
    const { namingRule, categorize, conflictStrategy, seqStart = 1 } = options
    const imported: Array<{ sourcePath: string; targetPath: string }> = []
    const failed: Array<{ sourcePath: string; message: string }> = []
    const skipped: Array<{ sourcePath: string; reason: string }> = []
    const total = sourcePaths.length

    // 预读所有源文件 stat（按 mtime 升序，确保 date/seq 命名稳定）
    const stats: Array<{ sourcePath: string; fileName: string; mtime: Date; size: number }> = []
    for (const sp of sourcePaths) {
      try {
        const s = await fsp.stat(sp)
        stats.push({ sourcePath: sp, fileName: path.basename(sp), mtime: s.mtime, size: s.size })
      } catch (err) {
        failed.push({ sourcePath: sp, message: err instanceof Error ? err.message : String(err) })
      }
    }
    stats.sort((a, b) => a.mtime.getTime() - b.mtime.getTime())

    await fsp.mkdir(targetBaseDir, { recursive: true })
    // 磁盘空间预估
    const totalSize = stats.reduce((sum, s) => sum + s.size, 0)
    if (totalSize > 0) {
      try {
        await assertDiskSpace(targetBaseDir, totalSize)
      } catch (err) {
        return {
          success: false,
          imported: [],
          failed: stats.map((s) => ({
            sourcePath: s.sourcePath,
            message: err instanceof Error ? err.message : String(err)
          })),
          skipped: [],
          message: t('main.file.message.insufficientDiskSpace')
        }
      }
    }

    // 用于批次内冲突检测（同目标路径）
    const usedTargetPaths = new Set<string>()
    let seq = seqStart

    for (let i = 0; i < stats.length; i++) {
      const { sourcePath, fileName, mtime } = stats[i]
      try {
        // 1. 计算目标子目录（按分类策略）
        let subDir = ''
        if (categorize === 'byDate') {
          const pad = (n: number) => String(n).padStart(2, '0')
          subDir = `${mtime.getFullYear()}-${pad(mtime.getMonth() + 1)}-${pad(mtime.getDate())}`
        } else if (categorize === 'byMonth') {
          const pad = (n: number) => String(n).padStart(2, '0')
          subDir = `${mtime.getFullYear()}-${pad(mtime.getMonth() + 1)}`
        }
        const targetDir = subDir ? path.join(targetBaseDir, subDir) : targetBaseDir
        await fsp.mkdir(targetDir, { recursive: true })

        // 2. 计算目标文件名（按命名规则）
        const ext = path.extname(fileName)
        const baseName = path.basename(fileName, ext)
        let newFileName: string
        if (namingRule === 'keep') {
          newFileName = fileName
        } else if (namingRule === 'date') {
          const pad = (n: number) => String(n).padStart(2, '0')
          newFileName = `${mtime.getFullYear()}${pad(mtime.getMonth() + 1)}${pad(mtime.getDate())}_${pad(mtime.getHours())}${pad(mtime.getMinutes())}${pad(mtime.getSeconds())}${ext}`
        } else {
          // seq
          newFileName = `${String(seq).padStart(4, '0')}${ext}`
        }

        let targetPath = path.join(targetDir, newFileName)

        // 3. 冲突处理
        const exists = await pathExists(targetPath)
        if (exists || usedTargetPaths.has(targetPath.toLowerCase())) {
          if (conflictStrategy === 'skip') {
            skipped.push({ sourcePath, reason: t('main.file.message.targetExists') })
            onProgress?.(i + 1, total)
            continue
          }
          if (conflictStrategy === 'rename') {
            targetPath = await getUniqueFilePath(targetDir, path.basename(newFileName, ext), ext)
          }
          // overwrite 直接覆盖，无需处理
        }
        usedTargetPaths.add(targetPath.toLowerCase())

        // 4. 复制文件
        await fsp.copyFile(sourcePath, targetPath)
        imported.push({ sourcePath, targetPath })
        if (namingRule === 'seq') seq++
      } catch (err) {
        failed.push({ sourcePath, message: err instanceof Error ? err.message : String(err) })
      }
      onProgress?.(i + 1, total)
    }

    return {
      success: failed.length === 0,
      imported,
      failed,
      skipped,
      message: t('main.file.message.importComplete', {
        success: imported.length,
        skipped: skipped.length,
        failed: failed.length
      })
    }
  }
}
