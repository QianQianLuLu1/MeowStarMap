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
  zoom: number
  rotation: number
  cameraYaw: number
  cameraPitch: number
  cameraLoc: { x: number; y: number; z: number } | null
  pose: number
  framedMoment: number
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

/** 摄影信息 */
export interface PhotographyInfo {
  edit: EditPhotoState
  date: { day: number } | null
  time: { hour: number; minute: number; second: number } | null
  location: LocationInfo | null
  weather: number | null
  /** 拍照模式 ID（顶层 NormalPhotoInfo.PhotoMode；旧照片缺失 → null；0=普通拍照 是真实值） */
  photoMode?: number | null
  /** 风力等级（顶层 NormalPhotoInfo.WindIntensity；缺失 → null；0=无风 是真实值） */
  windIntensity?: number | null
  /** 风向 ID（顶层 NormalPhotoInfo.WindDirection；缺失 → null；0=东 是真实值） */
  windDirection?: number | null
  photoWall: number[]
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
  giantState: boolean
  hidden: boolean
  loc: { x: number; y: number; z: number } | null
  rot: { yaw: number; pitch: number; roll: number } | null
  scale: { x: number; y: number; z: number } | null
}

/** 服装单品 */
export interface ClothParams {
  id: number
  clothType: number
  clothTypeName: string | null
  state: number
  species: number
}

/** 祝福闪光 */
export interface EurekaParams {
  id: number
  level: number
  color: number
  attachmentPoint: number
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

/** 解密结果 */
export interface GameParamsData {
  hasParams: boolean
  camera?: RichCameraParams
  photography?: PhotographyInfo
  nikki?: NikkiParams
  dressing?: DressingParams
  interactions?: InteractionParams
  /** 双人合照（联机）对方信息（顶层 MultiPlayerHandler；缺失 → null/缺省） */
  multiPlayer?: MultiPlayerInfo | null
  error?: string
  /** 文件本身不包含该参数（空态语义，区别于真实错误） */
  notContained?: boolean
}
