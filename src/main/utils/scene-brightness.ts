/**
 * F-O1：基于图像亮度直方图的场景时段分析
 * 使用 sharp 读取图像统计数据，根据平均亮度和色温推断时段
 */
import sharp from 'sharp'
import type { SceneTime } from '../../shared/scene-category'
import { runWithConcurrency } from './concurrency'
import { logger } from './logger'

/**
 * 分析图像的场景时段
 * - 使用 sharp.stats() 获取 RGB 三通道均值
 * - 平均亮度 < 60 → night（夜景）
 * - 平均亮度 > 180 → day（日景）
 * - 中等亮度 + R > B（偏暖）→ dawn（晨景）
 * - 中等亮度 + B > R（偏冷）→ dusk（暮景）
 * - 视频或分析失败 → unknown
 *
 * @param filePath 图像文件路径
 * @returns 场景时段分类
 */
export async function analyzeSceneBrightness(filePath: string): Promise<SceneTime> {
  try {
    // A10：fit 'inside' 保留完整图像信息；'cover' 会按短边裁剪丢失部分像素，亮度估算偏差
    const stats = await sharp(filePath).resize(100, 100, { fit: 'inside' }).stats()

    // stats.channels 顺序为 [R, G, B]
    const channels = stats.channels
    if (!channels || channels.length < 3) return 'unknown'

    const rMean = channels[0].mean
    const gMean = channels[1].mean
    const bMean = channels[2].mean

    // 计算平均亮度（BT.601 加权）
    const brightness = 0.299 * rMean + 0.587 * gMean + 0.114 * bMean

    // 色温差值：正值偏暖（R>B），负值偏冷（B>R）
    const warmColdDiff = rMean - bMean

    // 阈值（基于 0-255 范围）
    if (brightness < 60) {
      return 'night'
    }
    if (brightness > 180) {
      return 'day'
    }
    // 中等亮度：根据色温区分晨景/暮景
    if (warmColdDiff > 10) {
      return 'dawn'
    }
    if (warmColdDiff < -10) {
      return 'dusk'
    }
    // 中等亮度且色温中性：默认归为日景
    return 'day'
  } catch (error) {
    logger.warn(`[SceneBrightness] 分析失败 ${filePath}:`, error)
    return 'unknown'
  }
}

/**
 * 批量分析图像的场景时段（限制并发避免 I/O 压力）
 * @param filePaths 文件路径数组
 * @param concurrency 并发数（默认 4）
 * @returns 路径到时段的映射
 */
export async function analyzeSceneBrightnessBatch(
  filePaths: string[],
  concurrency = 4
): Promise<Map<string, SceneTime>> {
  const result = new Map<string, SceneTime>()

  const tasks = filePaths.map((filePath) => async () => {
    const sceneTime = await analyzeSceneBrightness(filePath)
    result.set(filePath, sceneTime)
  })

  await runWithConcurrency(tasks, concurrency)
  return result
}
