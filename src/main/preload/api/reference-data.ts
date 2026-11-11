// @core-change: 新增 referenceData 命名空间（状态/手动刷新/瓦片/图片模板查询 + resolveImage 按需取图，阶段 1+4+5）
// 外部参考数据命名空间：对应主进程 handlers/reference-data-handler.ts 的 refdata:* 通道。
// 查询面 fail-soft：数据不可用时返回空数组（渲染层据此渲染降级态，无需错误分支）。
import { call } from '../ipc'
import type {
  NetworkImageTemplateInfo,
  ReferenceDataStatus,
  ReferenceImageResolveResult,
  WorldMapTileInfo
} from '../../../shared/types/electron-api'

/** electronAPI.referenceData：上游 nikki_albums 热更参考数据（v1.db 管道） */
export const referenceDataAPI = {
  /** 管道状态（available=false 时查询面返回空数组；lastError 为最近一次失败诊断） */
  getStatus: () => call<ReferenceDataStatus>('refdata:get-status'),
  /** 手动检查更新（绕过失败冷却；镜像取设置键 referenceData.manifestBaseUrl） */
  refresh: () => call<ReferenceDataStatus>('refdata:refresh'),
  /** 世界地图瓦片模板与坐标换算参数（供地图能力按 worldId 取用） */
  getWorldMapTiles: () => call<{ tiles: WorldMapTileInfo[] }>('refdata:get-world-map-tiles'),
  /** 各类图片的 CDN 地址模板（baseUrl.replaceAll(replace, 值) 得最终 URL） */
  getNetworkImageTemplates: () =>
    call<{ templates: NetworkImageTemplateInfo[] }>('refdata:get-network-image-templates'),
  /**
   * 按类别与取值解析一张参考图片，返回**本机缓存路径**（不是远端 URL）。
   *
   * 渲染层拿到 path 后拼 `media://file?path=<path>` 展示；主进程已完成授权核实、
   * 应用层缓存（约 7 天）、按主机区分的请求标识与退避，渲染进程永不直连 CDN。
   * 加速/镜像入口取设置键 `referenceData.imageMirrorBaseUrl`（用户自配，应用不内置节点）。
   *
   * fail-soft：不可用时返回 `{ path: null, status }` 而**不抛错**，渲染层回退占位。
   * 按需调用——一次一张，不预取、不批量。
   */
  resolveImage: (kind: NetworkImageTemplateInfo['kind'], id: number) =>
    call<ReferenceImageResolveResult>('refdata:resolve-image', kind, id)
}
