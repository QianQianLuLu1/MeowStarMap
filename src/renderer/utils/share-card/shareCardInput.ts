import { getClothName } from '../cloth-name-lookup'
import {
  VERSION_KEY,
  buildShareCardPayload,
  type ShareCardOutfitInput,
  type ShareCardPayload,
  type ShareCardRow
} from './shareCardModel'
import type { GameParamsData } from '../../types/decryption'

/**
 * 阶段 5 · B1：把本 App 的解密参数（`GameParamsData`）装配成分享图载荷。
 *
 * 上游小程序的 `channel.metadata` 只回 12 行（`playerMetadata` 甚至没从包里导出），
 * 本仓走本地解密链，能给出更多字段（镜头旋转 / 景深 / 高光 / 阴影 / 柔光范围）。
 * 这是**有意的超集**，不是分叉：超出的键走 `layoutShareCards` 里「12 项之外按输入顺序追加」
 * 那条既有分支（上游 `share-card.js:26`），几何规则一字未动。
 */

/** 规范键 → 从 GameParamsData 取原始值的表（顺序即追加顺序，必须稳定以便对拍与快照）。 */
const CAMERA_ACCESSORS: readonly (readonly [string, (data: GameParamsData) => unknown])[] = [
  ['focalLength', (d) => d.camera?.focalLength],
  ['aperture', (d) => d.camera?.apertureSection],
  ['vignette', (d) => d.camera?.vignetteIntensity],
  ['bloom', (d) => d.camera?.bloomIntensity],
  ['bloomRange', (d) => d.camera?.bloomThreshold],
  ['brightness', (d) => d.camera?.brightness],
  ['exposure', (d) => d.camera?.exposure],
  ['contrast', (d) => d.camera?.contrast],
  ['saturation', (d) => d.camera?.saturation],
  ['naturalSaturation', (d) => d.camera?.vibrance],
  ['highlights', (d) => d.camera?.highlights],
  ['shadows', (d) => d.camera?.shadows],
  // 12 项之外的追加键
  ['rotation', (d) => d.camera?.rotation],
  [
    'depthOfField',
    (d) => {
      if (d.camera?.portraitMode === undefined) return undefined
      return d.camera.portraitMode ? 1 : 0
    }
  ]
]

const EFFECT_ACCESSORS: readonly (readonly [string, (data: GameParamsData) => unknown])[] = [
  ['action', (d) => d.camera?.pose],
  ['lighting', (d) => d.camera?.light?.id],
  ['filter', (d) => d.camera?.filter?.id],
  ['location', (d) => d.photography?.location?.name]
]

/** 数值转字符串：布尔按游戏里的 0/1 口径，其余走 String；非有限数一律不产出该行。 */
function stringify(value: unknown): string | undefined {
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined
  if (typeof value === 'string') return value.trim() || undefined
  return undefined
}

export interface ShareCardInputOptions {
  /** 展示在副行的日期文案（上游由小程序查看器传入） */
  date?: string
  gameVersion?: string
  /** 单品图标当前一律拿不到（见 docs/plans §0.1），保留入参以便将来接字典 */
  outfits?: ShareCardOutfitInput[]
}

/** 纯函数：解密参数 → 分享图载荷。参数缺失时返回「全破折号」载荷而不是 null。 */
export function buildShareCardInput(
  data: GameParamsData | null | undefined,
  options: ShareCardInputOptions = {}
): ShareCardPayload {
  const rows: ShareCardRow[] = []
  if (options.gameVersion) rows.push({ key: VERSION_KEY, value: options.gameVersion })
  if (data?.camera) {
    for (const [key, read] of CAMERA_ACCESSORS) {
      const value = stringify(read(data))
      if (value !== undefined) rows.push({ key, value })
    }
  }
  // 效果区四行里三行读自 camera（pose/光源/滤镜）、只有地点读自 photography，
  // 门控必须把 camera 算进去，否则「只有 camera」的解密结果会静默丢掉整块效果区
  if (data?.dressing || data?.photography || data?.camera) {
    for (const [key, read] of EFFECT_ACCESSORS) {
      const value = read(data)
      const text = typeof value === 'string' ? value.trim() : stringify(value)
      if (text) rows.push({ key, value: text })
    }
  }
  const outfits: ShareCardOutfitInput[] =
    options.outfits ??
    (data?.dressing?.clothes ?? []).slice(0, 100).map((cloth) => ({
      key: String(cloth.id),
      // 本地字典解析得出就用名称，解析不出留空由 resolveOutfitName 判空，绝不伪造
      name: getClothName(cloth.id) ?? '',
      iconSource: 'item',
      hasIcon: false
    }))
  return buildShareCardPayload({ date: options.date ?? '', rows, outfits })
}
