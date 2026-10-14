import { describe, expect, it } from 'vitest'
import { ASSET_TYPES, RESOURCE_ROLES } from '../../shared/sync/protocol'
import type {
  AssetListResponse,
  AssetDetailResponse,
  AssetSummary,
  ChangesResponse,
  ClothingSearchResponse,
  MediaResource,
  ProfileStatsResponse,
  SuitSearchResponse
} from '../../shared/sync/protocol'
import type {
  NikkiSyncAssetDetailInfo,
  NikkiSyncAssetPageInfo,
  NikkiSyncChangesInfo,
  NikkiSyncClothingSearchInfo,
  NikkiSyncProfileStatsInfo,
  NikkiSyncResourcePathsInfo,
  NikkiSyncResourceRecordsInfo,
  NikkiSyncSuitSearchInfo
} from '../../shared/types/electron-api'

/**
 * 阶段 4（UI Bridge）契约同形守护。
 *
 * 目的：`electronAPI.nikkisync.*` 的返回快照必须**逐字等于** `src/shared/sync/protocol.ts`
 * 里那份协议契约（本仓唯一真相源），而不是 `unknown` 承接位。
 * 内嵌层零转换 ⇒ 一旦快照退化成 `unknown[]`，渲染层就只能靠 `as` 逃逸拿字段。
 * 本文件把这些形状钉成编译期断言：类型不符即 `tsc -b` 失败（红灯），无需运行时侥幸。
 *
 * 说明：`src/renderer/vite-env.d.ts` 因 `skipLibCheck: true` 不参与严格校验，
 * 因此同形守护必须落在真实 `.ts`（shared 契约 + 本用例），不能只写进 d.ts。
 */

/** 结构双指针判等：两侧类型完全互相可赋值且约束集一致才为 true。 */
type Exact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

function expectCompileTimeTrue<T extends true>(_marker?: T): void {
  void _marker
}

describe('nikkisync 桥接快照与协议 DTO 同形', () => {
  it('分页/详情/变更/搜索/统计的快照类型即协议 DTO（编译期）', () => {
    expectCompileTimeTrue<Exact<NikkiSyncAssetPageInfo, AssetListResponse>>()
    expectCompileTimeTrue<Exact<NikkiSyncAssetPageInfo['items'], AssetSummary[]>>()
    expectCompileTimeTrue<Exact<NikkiSyncAssetDetailInfo, AssetDetailResponse>>()
    expectCompileTimeTrue<Exact<NikkiSyncChangesInfo, ChangesResponse>>()
    expectCompileTimeTrue<Exact<NikkiSyncSuitSearchInfo, SuitSearchResponse>>()
    expectCompileTimeTrue<Exact<NikkiSyncClothingSearchInfo, ClothingSearchResponse>>()
    expectCompileTimeTrue<Exact<NikkiSyncProfileStatsInfo, ProfileStatsResponse>>()
    expectCompileTimeTrue<
      Exact<NikkiSyncResourceRecordsInfo, { byAsset: Record<string, MediaResource[]> }>
    >()
    expectCompileTimeTrue<
      Exact<NikkiSyncResourcePathsInfo, { byAsset: Record<string, Record<string, string>> }>
    >()
    expect(true).toBe(true)
  })

  it('图库分流所依赖的协议运行时常量齐备', () => {
    // view-model 的 file_type 分流与静图/视频选取按这两组字面量分支，缺一项即分流失真
    expect(ASSET_TYPES).toEqual(['photo', 'motion_photo', 'video', 'unknown'])
    expect(RESOURCE_ROLES).toContain('source_high_quality')
    expect(RESOURCE_ROLES).toContain('source_primary')
    expect(RESOURCE_ROLES).toContain('source_motion')
  })
})
