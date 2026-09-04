/**
 * worker/utilityProcess 安全的 zh-CN 固定查表翻译。
 *
 * 背景：`@main/i18n` 依赖 electron app（utilityProcess 内不可用），worker 入口
 * 与被 worker 共享的工具模块（如 file-utils）不能导入它。worker 不跟随主进程
 * 语言切换，固定 zh-CN 与原硬编码中文行为完全一致；key 仍集中管理于
 * locales/zh-CN.json，文案调整无需改 worker 代码。
 *
 * 使用方式：
 *   import { t } from '../i18n/worker-safe'
 *   throw new Error(t('main.fileUtils.error.invalidDataUrl'))
 */
import zhCN from '../../renderer/i18n/locales/zh-CN.json'

/**
 * 同步查表翻译（仅 zh-CN）
 * @param key i18n key，如 'main.disk.error.insufficient'
 * @param params 插值参数，占位符语法 {{name}}，与主进程 i18n 一致
 * @returns 翻译后的字符串；key 缺失时返回 key 本身（与主进程 t() 行为一致，便于诊断）
 */
export function t(key: string, params?: Record<string, unknown>): string {
  const parts = key.split('.')
  let current: unknown = zhCN
  for (const part of parts) {
    if (current && typeof current === 'object' && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part]
    } else {
      return key
    }
  }
  let text = typeof current === 'string' ? current : key
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.split(`{{${name}}}`).join(String(value))
    }
  }
  return text
}
