/** 相册类型对应的解密参数类型 */
export enum MediaParamType {
  CameraParams = 'CameraParams',
  NikkiPhoto = 'NikkiPhoto',
  ClockInPhoto = 'ClockInPhoto',
  Collage = 'Collage',
  DIY = 'DIY'
}

/** 相册类型到 MediaParamType 的映射
 * 键同时支持英文目录名（路径推断）和中文显示标签（数据库 album_type）
 */
export const ALBUM_TYPE_MAP: Record<string, MediaParamType> = {
  // 英文目录名（路径推断用）
  ScreenShot: MediaParamType.CameraParams,
  screenshot: MediaParamType.CameraParams,
  NikkiPhotos_LowQuality: MediaParamType.NikkiPhoto,
  nikkiphotos_lowquality: MediaParamType.NikkiPhoto,
  NikkiPhotos_HighQuality: MediaParamType.NikkiPhoto,
  nikkiphotos_highquality: MediaParamType.NikkiPhoto,
  MagazinePhotos: MediaParamType.NikkiPhoto,
  magazinephotos: MediaParamType.NikkiPhoto,
  ClockInPhoto: MediaParamType.ClockInPhoto,
  clockinphoto: MediaParamType.ClockInPhoto,
  Collage: MediaParamType.Collage,
  collage: MediaParamType.Collage,
  CustomAvatar: MediaParamType.DIY,
  customavatar: MediaParamType.DIY,
  CustomCard: MediaParamType.DIY,
  customcard: MediaParamType.DIY,
  CustomHomeBoardPhoto: MediaParamType.DIY,
  customhomeboardphoto: MediaParamType.DIY,
  // 中文显示标签（匹配数据库 album_type）
  游戏截图: MediaParamType.CameraParams,
  低质量照片: MediaParamType.NikkiPhoto,
  高质量照片: MediaParamType.NikkiPhoto,
  杂志照: MediaParamType.NikkiPhoto,
  打卡照: MediaParamType.ClockInPhoto,
  拼图: MediaParamType.Collage,
  高质量拼图: MediaParamType.Collage,
  低质量拼图: MediaParamType.Collage,
  拼图照片: MediaParamType.Collage,
  自定义头像: MediaParamType.DIY,
  自定义名片: MediaParamType.DIY,
  主页照片: MediaParamType.DIY,
  主页模板: MediaParamType.DIY,
  植物染色: MediaParamType.DIY,
  DIY: MediaParamType.DIY,
  二维码: MediaParamType.DIY
}

/** 滤镜参数 */
export interface FilterParams {
  id: string
  strength: number
}

/** 光源参数 */
export interface LightParams {
  id: string
  strength: number
}

/** 相机参数 */
export interface CameraParams {
  focalLength: number
  apertureSection: number
  brightness: number
  exposure: number
  contrast: number
  saturation: number
  vibrance: number
  highlights: number
  shadows: number
  vignetteIntensity: number
  bloomIntensity: number
  bloomThreshold: number
  portraitMode: boolean
  filter?: FilterParams
  light?: LightParams
  /**
   * 相机参数结构版本（对齐上游 nuan5_structs/camera_params.rs 的 untagged V1/V2/V3）。
   * 判定依据是结构本身（元素个数 + 内部一致性），不是数组第 0 位的 version 字段；
   * 无法匹配任何已知版本结构时降级为 'unknown'（保留 base 字段与 rawParams）。
   */
  cameraVersion: CameraParamsVersion
  /**
   * 暖暖动作信息（来自 CameraParams 数组 V3 [40-42]；V1/V2 结构中不存在 → 缺省，
   * V3 空占位 → null）。与 pose（photo_info.pose_id 来源）为两个独立数据源，语义共存。
   */
  nikkiPoseInfo?: NikkiPoseInfo | null
  /**
   * 大喵动作参数（来自 CameraParams 数组 V2+ Disable 分支；Enable 隐藏态 → null，
   * V1/unknown → 缺省）。与 momoHidden（da_miao_info 来源）语义共存、互不干扰。
   */
  momoAction?: MomoActionParams | null
  /** 原始参数字符串，用于复制 */
  rawParams: string
}

/** 相机参数结构版本 */
export type CameraParamsVersion = 'v1' | 'v2' | 'v3' | 'unknown'

/** 暖暖动作信息（CameraParams 数组 V3 的 [40-42] 位） */
export interface NikkiPoseInfo {
  /** 暖暖动作 ID（数组 [40]） */
  poseId: number
  /** 动作进度 0–1（数组 [41]；空占位 "" → null，真实 0 保留） */
  playingPercent: number | null
  /** 是否处于待机动作（数组 [42]，1 → true） */
  inIdle: boolean
}

/** 大喵动作参数（CameraParams 数组 V2+ 且 momo 标志为 Disable 的 [32-39]/[43] 位） */
export interface MomoActionParams {
  /** 大喵动作 ID（数组 [32]） */
  poseId: number
  /** 大喵动作进度 0–1（数组 [43]，仅 V3 有此字段；V2 结构缺失 → null，不伪造 0） */
  poseTime: number | null
  /** 左右调整（数组 [33]，上游换算 ×400 后的厘米值） */
  horizontal: number
  /** 前后调整（数组 [34]，上游换算 ×400 后的厘米值） */
  distance: number
  /** 高度调整（数组 [35]，上游换算 ×400 后的厘米值） */
  height: number
  /** 旋转大喵（数组 [36]，上游换算 ×180 后的角度值） */
  rotateMomo: number
  /** 自动贴地（数组 [37]，1 → true） */
  autoGroundSnap: boolean
  /** 漂浮特效（数组 [38]，1 → true） */
  floatingEffect: boolean
  /** 暖暖合拍（数组 [39]，1 → true） */
  poseWithNikki: boolean
}

/** 大喵隐藏状态 */
export type MomoHiddenState = 'enabled' | 'disabled'

/** 富相机参数（继承 CameraParams，新增 photo_info 来源字段） */
export interface RichCameraParams extends CameraParams {
  /** 缩放倍数（由距离公式计算） */
  zoom: number
  /** 镜头旋转角度（来自 photo_info.camera_actor_rot_roll） */
  rotation: number
  /** 镜头 yaw 旋转（来自 photo_info.camera_actor_rot_yaw） */
  cameraYaw: number
  /** 镜头 pitch 旋转（来自 photo_info.camera_actor_rot_pitch） */
  cameraPitch: number
  /** 相机位置坐标（来自 photo_info.camera_actor_loc_x/y/z） */
  cameraLoc: { x: number; y: number; z: number } | null
  /** 动作场景 ID（来自 photo_info.pose_id） */
  pose: number
  /** 定格（来自 photo_info.framed_moment） */
  framedMoment: number
  /** 大喵隐藏状态 */
  momoHidden: MomoHiddenState | null
}

/** 编辑状态 */
export interface EditPhotoState {
  enabled: boolean
  hasSticker: boolean
  hasText: boolean
}

/** 拍摄地点信息 */
export interface LocationInfo {
  pos: { x: number; y: number; z: number }
  name: string | null
  /** 游戏世界 ID（SocialPhoto.TrackInfo.WorldID）；旧照片缺失时不写该键，保持既有 DTO 不变 */
  worldId?: number | null
}

/** 拍摄任务信息 */
export interface TaskInfo {
  type: 'puzzle' | 'risk' | 'interactive'
  tag: number
}

/** 摄影信息（时间/地点/天气/任务等） */
export interface PhotographyInfo {
  /** 图片是否编辑 */
  edit: EditPhotoState
  /** 拍摄日期（游戏内天数） */
  date: { day: number } | null
  /** 拍摄时间 */
  time: { hour: number; minute: number; second: number } | null
  /** 拍摄地点 */
  location: LocationInfo | null
  /** 天气类型 ID */
  weather: number | null
  /** 拍照模式 ID（顶层 NormalPhotoInfo.PhotoMode；旧照片缺失 → null；0=普通拍照 是真实值） */
  photoMode?: number | null
  /** 风力等级（顶层 NormalPhotoInfo.WindIntensity；缺失 → null；0=无风 是真实值） */
  windIntensity?: number | null
  /** 风向 ID（顶层 NormalPhotoInfo.WindDirection；缺失 → null；0=东 是真实值） */
  windDirection?: number | null
  /** 照片墙 ID 列表 */
  photoWall: number[]
  /** 拍摄任务列表 */
  tasks: TaskInfo[]
}

/** 双人合照（联机）对方信息（顶层 MultiPlayerHandler；缺失/单人照 → null）。
 * 上游 OptionValue 语义：poseId/posePlayingPercent 空串 "" 表示"存在但无值" → null */
export interface MultiPlayerInfo {
  /** 对方角色 ID（上游必填 i64；解析保留但 UI 不展示，对齐上游 v3.012.02 行为） */
  roleId: number | null
  /** 对方动作 ID（nikki_pose 命名空间；空串 → null） */
  poseId: number | null
  /** 对方动作进度（0–1；空串 → null；展示为 ceil(p*100)%） */
  posePlayingPercent: number | null
}

/** 暖暖信息 */
export interface NikkiParams {
  /** 巨大化是否开启 */
  giantState: boolean
  /** 暖暖是否隐藏 */
  hidden: boolean
  /** 暖暖位置 */
  loc: { x: number; y: number; z: number } | null
  /** 暖暖旋转 */
  rot: { yaw: number; pitch: number; roll: number } | null
  /** 暖暖缩放 */
  scale: { x: number; y: number; z: number } | null
}

/** 服饰 ID 拆解结果（十进制位段，非位掩码；对齐上游 cloth_parser.rs，公式冻结于 docs/plans/cloth-outfit-data-contract.md §5） */
export interface ClothIdParts {
  /** 款型（rawId % 10000，0–9999） */
  outfitFeature: number
  /** 部位类型（Math.floor(rawId / 10000) % 100，0–99） */
  clothType: number
  /** 状态（Math.floor(rawId / 1000000) % 10，0=原版/2-5=进化/9=特殊形态） */
  state: number
  /** 服装系列（Math.floor(rawId / 10000000) % 1000，0–999） */
  species: number
}

/** 服装单品 */
export interface ClothParams {
  /** 服装完整 ID */
  id: number
  /** 部位类型（从 ID 拆解: Math.floor(id / 10000) % 100） */
  clothType: number
  /** 部位名称（从 JSON 读取，可能为 null） */
  clothTypeName: string | null
  /** 状态（从 ID 拆解: Math.floor(id / 1000000) % 10，0=原版/2-5=进化/9=特殊形态） */
  state: number
  /** 服装系列（从 ID 拆解: Math.floor(id / 10000000) % 1000） */
  species: number
}

/** 祝福闪光 */
export interface EurekaParams {
  /** 祝福闪光完整 ID */
  id: number
  /** 等级（从 ID 拆解: Math.floor(id / 10) % 10） */
  level: number
  /** 颜色（从 ID 拆解: id % 10） */
  color: number
  /** 挂载点（从 ID 拆解: Math.floor(id / 100) % 10） */
  attachmentPoint: number
  /** 套装 ID（从 ID 拆解: Math.floor(id / 1000)） */
  outfit: number
}

/** 搭配信息 */
export interface DressingParams {
  clothes: ClothParams[]
  eureka: EurekaParams[]
}

/** 交互物/坐骑/载具参数 */
export interface ObjectParams {
  id: number | string
  loc: { x: number; y: number; z: number }
  rot: { yaw: number; pitch: number; roll: number }
  scale: { x: number; y: number; z: number }
}

/** 交互物信息 */
export interface InteractionParams {
  mount: ObjectParams | null
  carrier: ObjectParams | null
  interactions: ObjectParams[]
}

/** SocialPhoto JSON 内部解析用类型（P0-T1 确认后补充精确字段） */
export type SocialPhotoJSON = Record<string, unknown>

/** 解密结果 */
export interface DecryptionResult {
  camera?: RichCameraParams
  photography?: PhotographyInfo
  nikki?: NikkiParams
  dressing?: DressingParams
  interactions?: InteractionParams
  /** 双人合照（联机）对方信息（顶层 MultiPlayerHandler；缺失 → null/缺省） */
  multiPlayer?: MultiPlayerInfo | null
  /** 是否包含有效参数 */
  hasParams: boolean
  /** 错误信息 */
  error?: string
  /** 文件本身不包含该参数（空态语义，区别于真实错误） */
  notContained?: boolean
}

// ============================================================
// ClothDiy 搭配码 networkData 结构化（阶段 1）
// 归一化形状冻结于 docs/plans/cloth-outfit-data-contract.md §3/§4，键名与线上严格一致
// （patternData/nsHiddenData 线上原文为 [:k:v,...] 自定义语法，此处的 Record 形态
//  为「预归一化之后」的形状；DIY 字段本阶段仅声明，消费随后续阶段接入）
// ============================================================

/** networkData 归一化后顶层：固定双层 Content 包裹 */
export interface ClothDiyNetworkData {
  Content: ClothDiyContentWrapper
}
export interface ClothDiyContentWrapper {
  Content: ClothDiyContent
}

export interface ClothDiyContent {
  /** 可选；7/7 实采样本均缺省。上游 Option<i64> */
  PoseId?: number
  /** IdMap：线上为 [:k:v,...]（k=10位服饰ID，v=款型值，实测全 0）；整体可缺省 */
  patternData?: Record<string, number>
  /** 必需；10 位服饰 ID 数组（拆解公式见契约 §5） */
  wearingClothes: number[]
  /** 三态：数组 | 单对象 Item | 空对象 Empty（消费方统一为『数组』语义） */
  wearingDIYInfos: ClothDiyInfo[] | ClothDiyInfo | ClothDiyEmptyMap
  /** IdMap：k=服饰ID，v=0|1（上游约定 ==1 才视为 true）；整体可缺省 */
  nsHiddenData?: Record<string, number> | null
}

/** wearingDIYInfos 空对象三态（Empty）；用类型别名避免空 interface */
export type ClothDiyEmptyMap = Record<string, never>

export interface ClothDiyInfo {
  TargetGroupID: number
  /** untagged 五选一，按字段集合判别 */
  CoreData:
    | ClothDiyHairCoreData
    | ClothDiyGeneralCoreData
    | ClothDiySpecialEffectCoreData
    | ClothDiyPatternCreationCoreData
    | ClothDiyPatternCreationExtCoreData
  FeatureTag: number
  /** = wearingClothes 中的某个 10 位 ID */
  TargetClothID: number
}

/** 实测：ColorGridID1 以 -1 为哨兵值（非 null）；TargetColor1 可缺省 */
export interface ClothDiyHairCoreData {
  TargetColor0?: ClothDiyRgbaColor
  ColorGridID0: number
  TargetColor1?: ClothDiyRgbaColor
  ColorGridID1?: number
  RoughnessOffset: number
  HairColorMode?: number
}

export interface ClothDiyGeneralCoreData {
  R: number
  G: number
  B: number
  A: number
  ColorGridID: number
}

export interface ClothDiySpecialEffectCoreData {
  ColorGridID: number
  CoverDIYColor: boolean
}

export interface ClothDiyPatternCreationCoreData {
  ReplaceTextureID: number
  OverridePatternA?: boolean
}

export interface ClothDiyPatternCreationExtCoreData {
  TilingData: number
}

export interface ClothDiyRgbaColor {
  R: number
  G: number
  B: number
  A: number
}

/** 搭配码 structured 单件服饰（wearingClothes 投影，含共享纯函数拆解字段） */
export interface ClothDiyStructuredCloth {
  /** 服装完整 ID */
  id: number
  /** 部位类型（decomposeClothId） */
  clothType: number
  /** 状态（decomposeClothId） */
  state: number
  /** 服装系列（decomposeClothId） */
  species: number
  /** 款型（decomposeClothId；照片路径 ClothParams 暂未持久化该字段，见契约 §5/§7.4.2） */
  outfitFeature: number
}

/** 搭配码 structured 解析结果（IPC decrypt:decodeClothDiy data.structured；阶段 1 投影） */
export interface ClothDiyStructuredOutfit {
  /** 动作 ID；缺省/0/负数/非整数/字符串时省略 */
  poseId?: number
  /** 身着服饰列表（wearingClothes 投影，保持原顺序，ID ≤ 0 或非有限数跳过） */
  clothes: ClothDiyStructuredCloth[]
}
