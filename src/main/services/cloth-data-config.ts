// @core-change: 新增服饰数据源配置（阶段 2）

/**
 * 服饰数据源配置（搭配码面板阶段 2）
 *
 * 数据源为第三方 gongeo.us（选型结论与接入口实测见 docs/plans/cloth-outfit-data-contract.md §6）：
 * - 中文名：GitHub 仓库静态 locale JSON（接入口 1，一次性全量拉取后内存查表）
 * - 目录 API：按 ID 逐条 GET（接入口 2，无列表端点）
 * - 图标：CDN URL 由 ID 直接构造（接入口 3，本服务不下载图片字节）
 *
 * URL 一律集中在本文件，业务代码不得散落硬编码；测试经 cloth-data-service 的
 * setClothDataConfig 注入覆盖。
 */
export interface ClothDataConfig {
  /** 目录 API 基址（含版本段），拼接规则：{base}/{items|outfits}/{id} */
  dataApiBase: string
  /** 图标 CDN 基址（不含文件路径），拼接规则：{base}/items/icons/{id}.png 或 {base}/outfits/{id}.png */
  cdnBase: string
  /** locale JSON 索引基址，拼接规则：{base}/{locale}/{item|outfit}.json */
  nameIndexBase: string
  /** 中文名语言（阶段 2 固定 zh，机制上可扩展跟随应用语言） */
  locale: string
  /**
   * 出站 host 白名单（精确匹配，小写）。
   * 白名单本身即排除 localhost/环回/私网；assertSafeRemoteUrl 另有显式拒绝兜底（防配置误填）。
   */
  allowedHosts: string[]
  /** 单请求超时毫秒（任务要求 3-5 秒量级） */
  timeoutMs: number
  /** data API 批量并发上限（对无 SLA 的第三方保持克制） */
  batchConcurrency: number
  /** 进程内 LRU 结果缓存最大条目数（正/负缓存共用一个缓存） */
  cacheMaxEntries: number
  /** name map 拉取失败后的重试冷却毫秒（避免离线时每次查询重复拉大文件） */
  nameMapRetryCooldownMs: number
  /** 单响应体大小上限（字节），防御改版后的异常大响应 */
  maxResponseBytes: number
}

export const DEFAULT_CLOTH_DATA_CONFIG: ClothDataConfig = {
  dataApiBase: 'https://data.gongeo.us/v1',
  cdnBase: 'https://cdn.gongeo.us/images',
  nameIndexBase:
    'https://raw.githubusercontent.com/dastrokes/gongeo.us-nikki-tracker/master/app/locales',
  locale: 'zh',
  allowedHosts: ['data.gongeo.us', 'cdn.gongeo.us', 'raw.githubusercontent.com'],
  timeoutMs: 4000,
  batchConcurrency: 4,
  cacheMaxEntries: 500,
  nameMapRetryCooldownMs: 5 * 60 * 1000,
  maxResponseBytes: 10 * 1024 * 1024
}
