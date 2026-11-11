// @core-change: 图片类别改由 shared 单一真相源 re-export，消除跨进程手写清单
/**
 * Nuan5Config protobuf schema（v1.db 解密产物的线格式定义）。
 *
 * 逐字段转写自上游 RanAxro/nikki_albums `rust/src/nuan5_database/model.rs`（MIT，
 * prost 派生 Message 的 tag 号即为线格式真相源；prost 的 map<int32, T> 编码为
 * 标准重复 MapEntry：key=字段1、value=字段2，protobufjs 原生兼容）。
 *
 * 以 schema 字符串内嵌而非独立 .proto 文件：esbuild 直接打包进主进程 bundle，
 * 免去 electron-builder 额外 resources 声明与运行时文件定位。
 *
 * 解码只消费 world / networkImage 两棵子树（本阶段查询面）；名称表等其余字段
 * 转写保留以完整钉住上游契约，供后续名称映射阶段直接使用。
 */
import protobuf from 'protobufjs'

export const NUAN5_CONFIG_PROTO = `
syntax = "proto3";
package nuan5;

// ===== 顶层（model.rs Nuan5Config） =====
message Nuan5Config {
  map<int32, Nuan5Light> light = 1;
  map<int32, Nuan5LightType> light_type = 2;
  map<int32, Nuan5Filter> filter = 3;
  map<int32, Nuan5FilterType> filter_type = 4;
  map<int32, Nuan5MomoPose> momo_pose = 5;
  map<int32, Nuan5ClothDyeArea> cloth_dye_area = 6;
  map<int32, Nuan5ClothDyePalette> cloth_dye_palette = 7;
  map<int32, Nuan5DiyColorSwatch> diy_color_swatch = 8;
  map<int32, Nuan5DiyPattern> diy_pattern = 9;
  map<int32, Nuan5Cloth> cloth = 11;
  map<int32, Nuan5ClothOutfit> cloth_outfit = 12;
  map<int32, Nuan5ClothProp> cloth_prop = 16;
  map<int32, Nuan5ClothTag> cloth_tag = 17;
  map<int32, Nuan5NikkiClothInfo> nikki_cloth_info = 18;
  map<int32, Nuan5NikkiPose> nikki_pose = 21;
  map<int32, Nuan5NikkiPoseType> nikki_pose_type = 22;
  map<int32, Nuan5World> world = 26;
  Nuan5Table table = 20000;
  Nuan5NetworkImage network_image = 20001;
}

message Nuan5Table {
  repeated int32 light_type = 1;
  repeated int32 filter_type = 2;
  repeated int32 momo_pose = 3;
}

// ===== 图片 CDN URL 模板（本阶段查询面之一） =====
message Nuan5NetworkImage {
  Nuan5NetworkImageItem light = 1;
  Nuan5NetworkImageItem filter = 2;
  Nuan5NetworkImageItem momo_pose = 3;
  Nuan5NetworkImageItem cloth = 4;
  Nuan5NetworkImageItem cloth_outfit = 5;
  Nuan5NetworkImageItem diy_pattern = 6;
  Nuan5NetworkImageItem cloth_type = 7;
  Nuan5NetworkImageItem cloth_prop = 9;
  Nuan5NetworkImageItem cloth_tag = 10;
  Nuan5NetworkImageItem nikki_pose = 11;
}

message Nuan5NetworkImageItem {
  string base_url = 1;
  string replace = 2;
}

// ===== 世界地图（本阶段查询面之二：瓦片模板 + 坐标换算参数） =====
message Nuan5World {
  Nuan5WorldMapTileInfo map_tile_info = 1;
}

message Nuan5WorldMapTileInfo {
  string url_template = 1;
  uint32 max_zoom = 2;
  uint32 min_zoom = 3;
  uint32 map_width_of_max_zoom = 4;
  uint32 map_height_of_max_zoom = 5;
  double original_point_x = 6;
  double original_point_y = 7;
  double px_pre_unit = 8;
}

// ===== 名称表条目（本阶段不解码使用，保留契约完整） =====
message Nuan5Light { string string_id = 1; string param_id = 2; }
message Nuan5LightType { repeated int32 light = 1; }
message Nuan5Filter { string string_id = 1; string param_id = 2; }
message Nuan5FilterType { repeated int32 filter = 1; }
message Nuan5MomoPose { string string_id = 1; }
message Nuan5ClothDyeArea {
  int32 max_color_area_num = 1;
  repeated int32 custom_area_order = 4;
  map<int32, Nuan5ClothSpecialPatternDyeArea> special_pattern = 5;
}
message Nuan5ClothSpecialPatternDyeArea {
  int32 max_color_area_num = 1;
  repeated int32 custom_area_order = 4;
}
message Nuan5ClothDyePalette {
  repeated int32 directly = 1;
  repeated int32 complete = 2;
  repeated int32 grow_up = 3;
  repeated int32 evolution_1 = 4;
  repeated int32 evolution_2 = 5;
}
message Nuan5DiyColorSwatch { repeated double rgba = 1; }
message Nuan5DiyPattern { bool has_alpha_channel = 3; }
message Nuan5Cloth { int32 cloth_type = 1; }
message Nuan5ClothOutfit { repeated int32 components = 1; }
message Nuan5ClothProp {}
message Nuan5ClothTag { repeated double rgba = 1; string background_id = 2; }
message Nuan5NikkiClothInfo {
  int32 pattern_num = 2;
  repeated int32 props = 3;
  int32 major_prop = 4;
  repeated int32 tags = 5;
}
message Nuan5NikkiPose {}
message Nuan5NikkiPoseType { repeated int32 nikki_pose = 1; }
`

/**
 * 本阶段查询面消费的网络图片类别（与 Nuan5NetworkImage 字段一一对应）。
 * 单一真相源在 shared/network-image-kinds.ts：此处仅 re-export，保持既有导入路径兼容。
 */
export { NETWORK_IMAGE_KINDS } from '../../../shared/network-image-kinds'
export type {
  NetworkImageTemplateKind,
  NetworkImageTemplateKind as NetworkImageKind
} from '../../../shared/network-image-kinds'
import type { NetworkImageTemplateKind as NetworkImageKind } from '../../../shared/network-image-kinds'

export interface Nuan5NetworkImageItem {
  baseUrl: string
  replace: string
}

export interface Nuan5WorldMapTileInfo {
  urlTemplate: string
  maxZoom: number
  minZoom: number
  mapWidthOfMaxZoom: number
  mapHeightOfMaxZoom: number
  originalPointX: number
  originalPointY: number
  pxPreUnit: number
}

/** 解码后的 Nuan5Config（只列出查询面消费的子树，其余字段经 camelCase 运行时名称可按需访问） */
export interface DecodedNuan5Config {
  world?: Record<string, { mapTileInfo?: Nuan5WorldMapTileInfo | null } | undefined> | undefined
  networkImage?:
    | (Partial<Record<NetworkImageKind, Nuan5NetworkImageItem | null>> & Record<string, unknown>)
    | undefined
}

let cachedType: protobuf.Type | null = null

/** 编译并缓存 Nuan5Config Type（模块级惰性，一次 parse 常驻） */
export function getNuan5ConfigType(): protobuf.Type {
  if (!cachedType) {
    const root = protobuf.parse(NUAN5_CONFIG_PROTO).root
    cachedType = root.lookupType('nuan5.Nuan5Config')
  }
  return cachedType
}

/**
 * v1.db 明文字节 → Nuan5Config。
 * @throws protobufjs 解码失败（结构损坏）时抛 Error，由调用方转结构化错误
 */
export function decodeNuan5Config(plaintext: Buffer): DecodedNuan5Config {
  return getNuan5ConfigType().decode(new Uint8Array(plaintext)) as unknown as DecodedNuan5Config
}
