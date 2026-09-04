/**
 * 服装名称查找表
 *
 * 数据来源：上游 nikki_albums 项目的语言文件
 * - assets/lang/infinity_nikki/cloth/zh-CN.json（7369 条服装名称）
 * - assets/lang/infinity_nikki/cloth_outfit/zh-CN.json（657 条套装名称）
 *
 * 通过 extract-cloth-names.js 脚本从上游项目提取，仅读取未修改源文件。
 */

import clothNamesData from '../assets/cloth-names.json'
import outfitNamesData from '../assets/outfit-names.json'

const clothNames = clothNamesData as Record<string, string>
const outfitNames = outfitNamesData as Record<string, string>

/** 根据服装 ID 获取名称，未找到返回 null */
export function getClothName(clothId: number | string): string | null {
  return clothNames[String(clothId)] ?? null
}

/** 根据套装 ID 获取名称，未找到返回 null */
export function getOutfitName(outfitId: number | string): string | null {
  return outfitNames[String(outfitId)] ?? null
}
