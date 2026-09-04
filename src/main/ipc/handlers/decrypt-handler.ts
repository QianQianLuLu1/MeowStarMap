import { ipcMain } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, schemas } from '../validator'
import { assertMediaReadPath } from '../media-read-guard'
import { logger } from '../../utils/logger'
import { t } from '../../i18n'

/**
 * decrypt 域 IPC handler：游戏参数 / 相机参数 / 染色分享码 / 家园建造分享码 解密。
 */
export function registerDecryptHandlers(ctx: HandlerContext): void {
  // ---- decrypt 域 ----
  // 游戏参数解密
  ipcMain.handle(
    'decrypt:decodeFile',
    wrapHandler(
      ctx,
      z.tuple([
        schemas.filePath,
        z
          .string()
          .min(1, t('main.decrypt.validation.albumTypeRequired'))
          .max(32, t('main.decrypt.validation.albumTypeMaxLength')),
        z.string().min(1).max(64).optional()
      ]),
      async ([filePath, albumType, uid]) => {
        // 双层校验口径（复用共享 assertMediaReadPath）：与 media:// 图库显示授权统一，
        // 命中已索引媒体白名单则放行；未命中回退 assertFileReadPath（PathGuard）兜底。
        assertMediaReadPath(ctx, filePath)
        const { decodeFileParams } = await import('../../services/decryption-service')

        // 当 uid 缺失或为 'default' 时，尝试从角色档案表获取有效 UID
        let effectiveUid = uid
        let candidateUids: string[] | undefined
        if (!effectiveUid || effectiveUid === 'default') {
          effectiveUid = resolveUidFromProfiles(ctx)
          // 单档案时直接使用；多档案或无档案时收集所有候选 UID 供 service 遍历
          if (!effectiveUid) {
            candidateUids = getAllKnownUids(ctx)
          }
        }

        // P0-A3：decodeFileParams 已改为 async（mutex 串行化 + 异步文件读取）
        const result = await decodeFileParams(filePath, albumType, effectiveUid, candidateUids)
        return {
          ok: !result.error,
          data: result,
          message: result.error
        }
      }
    )
  )

  // Group 2: 相机参数加密（将 JSON 加密为密文）
  ipcMain.handle(
    'decrypt:encodeCameraParams',
    wrapHandler(
      ctx,
      z.tuple([
        z
          .string()
          .min(1, t('main.decrypt.validation.jsonTextRequired'))
          .max(1024 * 1024, t('main.decrypt.validation.jsonTextMaxLength'))
      ]),
      async ([jsonText]) => {
        const { encodeCameraParams } = await import('../../services/decryption-service')
        const result = await encodeCameraParams(jsonText)
        return {
          ok: result.success,
          data: result.data ? result.data.toString('base64') : undefined,
          message: result.error
        }
      }
    )
  )

  // Group 3: 染色分享码解码
  ipcMain.handle(
    'decrypt:decodeClothDiy',
    wrapHandler(
      ctx,
      z.tuple([
        z
          .string()
          .min(1, t('main.decrypt.validation.codeStrRequired'))
          .max(1024 * 1024, t('main.decrypt.validation.codeStrMaxLength'))
      ]),
      async ([codeStr]) => {
        const { decodeClothDiyShareCode } = await import('../../services/decryption-service')
        const result = await decodeClothDiyShareCode(codeStr)
        return {
          ok: result.success,
          data: {
            timestamp: result.timestamp,
            uidBytes: result.uidBytes ? result.uidBytes.toString('hex') : undefined,
            networkData: result.networkData
          },
          message: result.error
        }
      }
    )
  )

  // Group 4: 家园建造分享码解码
  ipcMain.handle(
    'decrypt:decodeHomeBuild',
    wrapHandler(
      ctx,
      z.tuple([
        z
          .string()
          .min(1, t('main.decrypt.validation.codeStrRequired'))
          .max(1024 * 1024, t('main.decrypt.validation.codeStrMaxLength'))
      ]),
      async ([codeStr]) => {
        const { decodeHomeBuildShareCode } = await import('../../services/decryption-service')
        const result = await decodeHomeBuildShareCode(codeStr)
        return {
          ok: result.success,
          data: {
            server: result.server,
            networkData: result.networkData
          },
          message: result.error
        }
      }
    )
  )
}

/**
 * 从 character_profiles 表查询可用 UID。
 * 仅当非默认档案恰好 1 个时返回其 UID（单一账号场景，自动选择安全）；
 * 0 个或多个时返回 undefined，由现有错误提示引导用户处理。
 */
function resolveUidFromProfiles(ctx: HandlerContext): string | undefined {
  try {
    const db = ctx.dbManager.getDatabase()
    if (!db) return undefined

    const rows = db
      .prepare(
        `SELECT uid FROM character_profiles
         WHERE uid != 'default'
         ORDER BY created_at ASC`
      )
      .all() as Array<{ uid: string }>

    return rows.length === 1 ? rows[0].uid : undefined
  } catch (err) {
    // 数据库查询失败不阻塞解密流程，返回 undefined 让 service 走原有错误路径
    logger.warn(t('main.decrypt.log.resolveUidFailed'), err)
    return undefined
  }
}

/**
 * 获取所有已知 UID，合并角色档案表和媒体文件表的 UID 来源。
 * 当用户未手动添加角色档案时，从已扫描的媒体文件中收集 UID 作为候选，
 * 提高解密成功率。
 */
function getAllKnownUids(ctx: HandlerContext): string[] {
  const uidSet = new Set<string>()

  try {
    const db = ctx.dbManager.getDatabase()
    if (!db) return []

    // 来源 1：character_profiles 表（用户手动添加的档案）
    const profileRows = db
      .prepare(
        `SELECT uid FROM character_profiles
         WHERE uid != 'default'
         ORDER BY created_at ASC`
      )
      .all() as Array<{ uid: string }>
    for (const row of profileRows) uidSet.add(row.uid)

    // 来源 2：media_files 表（扫描时从路径提取的 UID）
    // 仅当角色档案表没有候选时才查询，避免不必要的全表扫描
    if (uidSet.size === 0) {
      const mediaRows = db
        .prepare(
          `SELECT DISTINCT account_uid FROM media_files
           WHERE account_uid IS NOT NULL
             AND account_uid != 'default'`
        )
        .all() as Array<{ account_uid: string }>
      for (const row of mediaRows) uidSet.add(row.account_uid)
    }
  } catch (err) {
    // 数据库查询失败不阻塞解密流程，返回空列表让 service 走原有错误路径
    logger.warn(t('main.decrypt.log.getKnownUidsFailed'), err)
  }

  return Array.from(uidSet)
}
