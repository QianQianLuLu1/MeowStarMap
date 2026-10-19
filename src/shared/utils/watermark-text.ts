/**
 * 水印文字占位符展开（主/渲染共用）
 *
 * `src/shared/**` 约束：不引入 Node / Electron 依赖，只用 `Date`。
 *
 * 为什么要抽到这里：同一套 `{date}`/`{time}` 语义此前分散在渲染层 canvas
 * （`src/renderer/utils/imageProcessor.ts` 的 `formatWatermarkText`）与主进程批量导出
 * （`src/main/services/watermark-service.ts` 完全不展开）两处，后者把 `{date}` 原样写成
 * 字面量，用户在编辑器预览看到日期、导出图里却是一串花括号。禁止再出现第三份副本。
 */

/** `{date}` → `YYYY.MM.DD`，`{time}` → `HH:mm`；大小写不敏感，其余内容原样返回 */
export function formatWatermarkText(content: string, now: Date = new Date()): string {
  const dateStr = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  return content.replace(/\{date\}/gi, dateStr).replace(/\{time\}/gi, timeStr)
}
