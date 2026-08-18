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
  photoWall: number[]
  tasks: TaskInfo[]
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
  error?: string
}
