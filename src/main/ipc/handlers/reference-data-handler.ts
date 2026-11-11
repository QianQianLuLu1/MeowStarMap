// @core-change: 新增外部图片总开关短路，关闭时 refdata:resolve-image 零网络返回 disabled

/**
 * 外部参考数据 IPC handler（总计划「拍摄参数扩展与地图定位」阶段 1 + 阶段 5）。
 *
 * 前四条通道无入参（最小校验面）；查询面 fail-soft——service 不可用时返回空数组、
 * 永不抛错；refresh 为手动触发（绕过失败冷却），镜像地址从设置键
 * `referenceData.manifestBaseUrl`（settings 域已做 URL + SSRF 校验）读出后转发给服务。
 *
 * 第五条 `refdata:resolve-image`（阶段 5）：按类别与取值解析一张 CDN 图片，返回可直接拼
 * `media://file?path=` 的**本机缓存路径**（不是远端 URL——渲染层永不直连 nikkialbums）。
 * 授权核实、应用层缓存、按主机区分的请求标识、退避与占位回退全部在
 * `services/reference-image-service.ts`；本层只做 zod 入参校验 + 图片镜像键转发。
 * 该通道同样 fail-soft：不可用时返回 `{ path: null, status }` 而非 IPC 错误，
 * 渲染层据 status 记日志、据 path 决定占位。
 */
import { ipcMain } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, wrapHandlerNoArgs, schemas } from '../validator'
import {
  checkForUpdate,
  getNetworkImageTemplates,
  getStatus,
  getWorldMapTiles
} from '../../services/reference-data-service'
import { resolveReferenceImage } from '../../services/reference-image-service'
import { NETWORK_IMAGE_KINDS } from '../../services/reference-data/nuan5-config-proto'
import type { ReferenceImageResolveResult } from '../../../shared/types/electron-api'

/** manifest 镜像站点设置键（白名单见 src/shared/settings-keys.ts） */
const MANIFEST_BASE_URL_KEY = 'referenceData.manifestBaseUrl'
/**
 * 图片加速/镜像入口设置键（阶段 5 新增，与 manifest 镜像键**分离**）。
 * 两者语义不同：前者覆盖热更 manifest 站点，后者只替换已授权图片资源的取图 host。
 * 应用不内置、不代建加速节点，值由用户自行填写；settings 域负责 URL + SSRF 校验。
 */
const IMAGE_MIRROR_BASE_URL_KEY = 'referenceData.imageMirrorBaseUrl'
/** 外部图片总开关（gongeo #218「保持可回滚」）：关闭时本通道零网络 */
const REMOTE_IMAGES_ENABLED_KEY = 'referenceData.remoteImagesEnabled'

/** 图片类别枚举：与 v1.db Nuan5NetworkImage 字段一一对应（10 类，含未授权类别——授权判定在服务层按主机做） */
const networkImageKindSchema = z.enum(NETWORK_IMAGE_KINDS)

export function registerReferenceDataHandlers(ctx: HandlerContext): void {
  ipcMain.handle(
    'refdata:get-status',
    wrapHandlerNoArgs(ctx, () => getStatus())
  )

  ipcMain.handle(
    'refdata:refresh',
    wrapHandlerNoArgs(ctx, async (innerCtx) => {
      const manifestBaseUrl = innerCtx.dbManager.getSetting(MANIFEST_BASE_URL_KEY, '')
      return checkForUpdate({ force: true, manifestBaseUrl })
    })
  )

  ipcMain.handle(
    'refdata:get-world-map-tiles',
    wrapHandlerNoArgs(ctx, () => ({ tiles: getWorldMapTiles() }))
  )

  ipcMain.handle(
    'refdata:get-network-image-templates',
    wrapHandlerNoArgs(ctx, () => ({ templates: getNetworkImageTemplates() }))
  )

  ipcMain.handle(
    'refdata:resolve-image',
    wrapHandler(
      ctx,
      z.tuple([networkImageKindSchema, schemas.positiveIntId]),
      async ([kind, id], innerCtx): Promise<ReferenceImageResolveResult> => {
        // 纵深防御：渲染层 flag 之外，主进程再独立短路一次（渲染层被绕过也不会发请求）。
        // 键缺省按默认开启（既有行为）；读到非 boolean 一律按安全默认关闭。
        const enabled = innerCtx.dbManager.getSetting(REMOTE_IMAGES_ENABLED_KEY, true)
        if (enabled !== true) return { path: null, status: 'disabled' }
        const mirrorBaseUrl = innerCtx.dbManager.getSetting(IMAGE_MIRROR_BASE_URL_KEY, '')
        return resolveReferenceImage(kind, id, { mirrorBaseUrl })
      }
    )
  )
}
