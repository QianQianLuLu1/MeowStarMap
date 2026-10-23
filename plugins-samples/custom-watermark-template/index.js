/**
 * custom-watermark-template 插件入口
 *
 * 在 init 函数中向 watermark.template 扩展点注册 3 个示例水印模板：
 *   1. 节日纪念水印（图片水印）
 *   2. 个人签名水印（文字水印）
 *   3. 当日日期戳（动态文字水印）
 *
 * 插件 API 详见 docs/PLUGIN_API.md
 *
 * @param {object} extensionPoints pluggable-electron 扩展点 API
 *   - register(name, extensionName, responder, priority?)
 *   - execute(name, input?)
 *   - unregisterAll(pattern: RegExp)
 */

// 插件名常量，用作扩展命名空间前缀，停用时由 PluginRuntime 批量清理
const PLUGIN_NAME = 'custom-watermark'

/**
 * 插件激活入口
 *
 * pluggable-electron 在触发 'init' 激活点时调用此函数，
 * 传入 extensionPoints 对象供插件注册扩展。
 *
 * 注意：注册的扩展名必须以 'pluginName:' 为前缀，
 * 以便停用时通过 extensionPoints.unregisterAll(/^pluginName:/) 批量清理。
 */
export function init(extensionPoints) {
  if (!extensionPoints || typeof extensionPoints.register !== 'function') {
    console.error(`[${PLUGIN_NAME}] extensionPoints.register 不可用，初始化失败`)
    return
  }

  // ① 注册"节日纪念"图片水印模板
  // 使用 import.meta.url 解析插件相对资源路径，保证打包后路径仍正确
  extensionPoints.register(
    'watermark.template',
    `${PLUGIN_NAME}:festival`,
    () => ({
      id: 'cwt-festival',
      name: '节日纪念水印',
      type: 'image',
      // 资源路径解析：通过 import.meta.url 获取插件入口所在目录，
      // 再拼接 templates/festival.svg
      imagePath: new URL('./templates/festival.svg', import.meta.url).pathname,
      position: 'bottomRight',
      opacity: 0.8,
      scale: 0.25,
      category: 'custom'
    }),
    10
  )

  // ② 注册"个人签名"文字水印模板
  extensionPoints.register(
    'watermark.template',
    `${PLUGIN_NAME}:signature`,
    () => ({
      id: 'cwt-signature',
      name: '个人签名水印',
      type: 'text',
      text: '© Meow Star Map',
      font: 'Microsoft YaHei',
      fontSize: 24,
      color: '#FF69B4',
      opacity: 0.9,
      position: 'bottomRight',
      category: 'custom'
    }),
    20
  )

  // ③ 注册"当日日期戳"动态文字水印模板
  // 每次扩展点被消费时实时生成日期字符串
  extensionPoints.register(
    'watermark.template',
    `${PLUGIN_NAME}:datestamp`,
    () => {
      const now = new Date()
      const yyyy = now.getFullYear()
      const mm = String(now.getMonth() + 1).padStart(2, '0')
      const dd = String(now.getDate()).padStart(2, '0')
      return {
        id: 'cwt-datestamp',
        name: '当日日期戳',
        type: 'text',
        text: `${yyyy}-${mm}-${dd}`,
        font: 'Consolas',
        fontSize: 18,
        color: '#FFFFFF',
        opacity: 0.85,
        position: 'bottomLeft',
        category: 'custom'
      }
    },
    30
  )

  console.info(`[${PLUGIN_NAME}] 已注册 3 个水印模板扩展`)
}

/**
 * 插件停用清理（可选）
 *
 * PluginRuntime 在停用插件时会自动调用
 * extensionPoints.unregisterAll(/^custom-watermark:/) 清理所有扩展，
 * 因此此函数仅需清理插件自身的资源（定时器、监听器等）。
 *
 * 本示例插件无额外资源，留空即可。
 */
export function dispose() {
  console.info(`[${PLUGIN_NAME}] 已停用，扩展由 PluginRuntime 统一清理`)
}
