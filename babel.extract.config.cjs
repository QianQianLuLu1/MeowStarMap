// 仅用于 i18n 字符串提取，不参与运行时构建
// 用法：npx babel --config-file ./babel.extract.config.cjs "src/renderer/**/*.{ts,tsx}" -q
module.exports = {
  presets: [
    ['@babel/preset-typescript', { isTSX: true, allExtensions: true }],
    ['@babel/preset-react', { runtime: 'automatic' }]
  ],
  plugins: [
    [
      'babel-plugin-i18next-extract',
      {
        // 输出目录：与现有 locale 文件路径一致
        locales: ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'ru', 'th', 'vi'],
        // 输出文件路径（相对项目根）
        outputPath: 'src/renderer/i18n/locales/{{locale}}.json',
        // key 分隔符（嵌套对象用 . 分隔）
        keySeparator: '.',
        nsSeparator: false,
        // 默认命名空间（与 index.ts init 一致：translation）
        defaultNS: 'translation',
        // 启用 useContextHint：组件名为 key 前缀
        useContextHint: true,
        // 不覆盖已有 key（保留人工命名的 key）
        jsonSpace: 2,
        // 提取范围
        unwrap: false,
        // 不提取已是 key 形式的字符串（避免重复提取）
        // 注：本配置仅作"硬编码发现清单"用，实际 locale key 由人工按命名规范写入
        skip: ['common.*', 'gallery.*', 'appShell.*', 'detail.*', 'editor.*']
      }
    ]
  ]
}
