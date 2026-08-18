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
  /** 原始参数字符串，用于复制 */
  rawParams: string
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
  /** 照片墙 ID 列表 */
  photoWall: number[]
  /** 拍摄任务列表 */
  tasks: TaskInfo[]
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
  /** 是否包含有效参数 */
  hasParams: boolean
  /** 错误信息 */
  error?: string
}
