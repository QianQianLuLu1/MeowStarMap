import { ipcMain, app } from 'electron'
import path from 'path'
import fs from 'fs'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, wrapHandlerNoArgs } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import { MediaRepository } from '../../database/media-repository'
import { logger } from '../../utils/logger'
import { t } from '../../i18n'

/**
 * 全文搜索索引供给域 IPC handler
 *
 * 覆盖：索引文档批量拉取 / 索引片段持久化到 userData / 索引片段读取。
 * exportIndex 采用原子写入（tmp → rename），Windows 下先 rm 再 rename。
 */
export function registerSearchIndexHandlers(ctx: HandlerContext): void {
  // 每次调用动态获取 Repository（db 可能在初始化/重连时变化）
  // 数据库写操作进程拆分：传入 workerBridge 与 dbPath，写方法走独立 utilityProcess
  const getRepo = (): MediaRepository => {
    const db = ctx.dbManager.getDatabase()
    if (!db) throw AppError.preconditionFailed(t('main.error.databaseNotInit'))
    return new MediaRepository(db, ctx.dbManager.getWorkerBridge(), ctx.dbManager.getDbPath())
  }

  // ============ 全文搜索（flexsearch 索引供给 + 持久化辅助） ============

  // search:buildDocs — 批量返回索引文档数据（启动重建 / 增量拉取）
  ipcMain.handle(
    'search:buildDocs',
    wrapHandler(
      ctx,
      z.tuple([
        z
          .object({
            since: z.string().max(64).optional(),
            limit: z.number().int().positive().max(10000).optional(),
            // 性能重构：afterId 游标取代 offset（id > ? 分块，避免全量重建 O(n²)）
            afterId: z.number().int().min(0).optional(),
            // 仅校验路径显式要求 total 时才一次性 COUNT，默认不触发全表扫描
            includeTotal: z.boolean().optional()
          })
          .optional()
      ]),
      async ([options]) => {
        const repo = getRepo()
        const limit = options?.limit ?? 5000
        const afterId = options?.afterId ?? 0
        // since（indexed_at 增量过滤）与 afterId（id 游标）可同时传入，组合安全依赖
        // media-repository.getSearchDocs 内部 ORDER BY id ASC（结果按 id 严格升序，游标取末返回行 id）。
        // 组合语义见 getSearchDocs JSDoc；切勿将排序改为时间列，否则增量同步会漏掉中间行。
        const { docs, hasMore } = repo.getSearchDocs(options?.since, limit, afterId)
        // returned 恒为本页条数（docs.length，零成本）；total 仅在显式 includeTotal 时做一次性全表 COUNT，
        // 否则为 undefined——故意不回退到 docs.length，从类型层面强制调用方显式请求全量总数。
        const total = options?.includeTotal ? repo.getSearchDocsCount(options?.since) : undefined
        return {
          docs,
          returned: docs.length,
          total,
          hasMore
        }
      }
    )
  )

  // search:exportIndex — 持久化索引片段到 userData（原子写入：tmp → rename）
  ipcMain.handle(
    'search:exportIndex',
    wrapHandler(
      ctx,
      z.tuple([
        z.object({
          segments: z
            .array(
              z.object({
                key: z.string().max(128),
                data: z.string().max(10 * 1024 * 1024) // 单片段 ≤ 10MB
              })
            )
            .max(50, t('main.searchIndex.validation.segmentsMax')),
          // R15：schema_hash 存入 .meta.json，导入时校验字段级变更
          schemaHash: z.string().max(512).optional()
        })
      ]),
      async ([options]) => {
        const indexDir = path.join(app.getPath('userData'), 'search-index')
        // 原子写入：临时目录使用 indexDir 的【兄弟目录】，避免后续 rm(indexDir) 把临时目录一同删除
        const tmpDir = path.join(app.getPath('userData'), 'search-index.tmp')
        await fs.promises.mkdir(indexDir, { recursive: true })
        await fs.promises.rm(tmpDir, { recursive: true, force: true })
        await fs.promises.mkdir(tmpDir, { recursive: true })
        // FIX(组13-1): mkdir(tmpDir) 之后的任一步失败都要清理临时目录——
        // 原实现只兜 rename 失败，写片段/元数据/删旧目录阶段抛错会残留 search-index.tmp
        try {
          for (const seg of options.segments) {
            // 文件名仅允许字母数字下划线，防止路径穿越
            const safeKey = seg.key.replace(/[^a-zA-Z0-9_]/g, '_')
            await fs.promises.writeFile(path.join(tmpDir, safeKey), seg.data, 'utf8')
          }
          // 写入元数据（导出时间戳 + schema_hash，供前端校验是否需要重建）
          await fs.promises.writeFile(
            path.join(tmpDir, '.meta.json'),
            JSON.stringify({
              exportedAt: new Date().toISOString(),
              segmentCount: options.segments.length,
              schemaHash: options.schemaHash || ''
            }),
            'utf8'
          )
          // 原子替换：先删旧目录再 rename 临时目录
          // 注：Windows 下 rename 不能覆盖非空目录，所以先 rm 再 rename；
          // 临时目录为兄弟目录，不受 rm(indexDir) 影响，rename 不再 ENOENT
          await fs.promises.rm(indexDir, { recursive: true, force: true })
          await fs.promises.rename(tmpDir, indexDir)
        } catch (err) {
          // 半写入保护：失败时清理残留临时目录，避免下次重建读到损坏片段
          await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
          throw AppError.internal(
            t('main.searchIndex.error.persistFailed'),
            err instanceof Error ? err.message : String(err)
          )
        }
        return { saved: true, path: indexDir }
      }
    )
  )

  // search:importIndex — 读取索引片段供渲染进程 import
  // 无参数：直接返回 userData/search-index/ 下所有非隐藏文件
  // 读取失败（目录不存在/损坏）返回空片段，触发前端全量重建
  ipcMain.handle(
    'search:importIndex',
    wrapHandlerNoArgs(ctx, async () => {
      const indexDir = path.join(app.getPath('userData'), 'search-index')
      const segments: Array<{ key: string; data: string }> = []
      let fileSize = 0
      let exportedAt = ''
      let schemaHash = ''
      try {
        const metaPath = path.join(indexDir, '.meta.json')
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8')) as {
            exportedAt?: string
            schemaHash?: string
          }
          exportedAt = meta.exportedAt || ''
          schemaHash = meta.schemaHash || ''
        }
        const entries = await fs.promises.readdir(indexDir)
        for (const entry of entries) {
          // 跳过 .meta.json 等隐藏文件
          if (entry.startsWith('.')) continue
          const fullPath = path.join(indexDir, entry)
          const data = await fs.promises.readFile(fullPath, 'utf8')
          segments.push({ key: entry, data })
          fileSize += data.length
        }
      } catch (err) {
        // 索引目录不存在或读取失败，返回空片段（触发前端重建）
        logger.warn(
          t('main.searchIndex.log.importReadFailed'),
          err instanceof Error ? err.message : err
        )
      }
      return { segments, fileSize, exportedAt, schemaHash }
    })
  )
}
