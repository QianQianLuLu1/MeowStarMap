/**
 * commitlint 配置
 * 基于 Conventional Commits 1.0.0 + 项目实际模块定制
 * 文档：https://commitlint.js.org/reference/rules.html
 * 提交规范：详见 .qoder/rules/project-conventions.md「提交校验流程」节与 .gitmessage 模板
 */

module.exports = {
  extends: ['@commitlint/config-conventional'],
  // 修复 Windows 下 commit-msg 钩子文件读取的换行符问题
  parserPreset: {
    parserOpts: {
      headerPattern: /^(\w*)(?:\(([^)]*)\))?!?: (.*)$/,
      headerCorrespondence: ['type', 'scope', 'subject']
    }
  },
  rules: {
    // === 类型（type）===
    // 必须使用以下类型之一，否则提交被拒绝
    'type-enum': [
      2,
      'always',
      [
        'feat', // 新功能
        'fix', // bug 修复
        'docs', // 文档变更（README、docs/、代码注释规范等）
        'style', // 代码格式（不影响功能：空格、分号、换行等）
        'refactor', // 重构（既不是新增功能，也不是修复 bug）
        'perf', // 性能优化
        'test', // 测试相关（新增、修改、删除测试）
        'build', // 构建系统或外部依赖变更（package.json、vite.config、electron-builder 等）
        'ci', // CI 配置（GitHub Actions 等）
        'chore', // 杂项（不修改 src 或测试的其他变更）
        'revert', // 回滚某个之前的 commit
        'i18n', // 国际化资源变更（locales/*.json）
        'release' // 版本发布相关
      ]
    ],
    'type-case': [2, 'always', 'lower-case'],
    'type-empty': [2, 'never'],
    'type-max-length': [2, 'always', 12],

    // === 作用域（scope）===
    // 推荐使用项目模块名，但不强制枚举（避免阻碍新模块提交）
    'scope-case': [2, 'always', 'lower-case'],
    'scope-empty': [0],
    'scope-max-length': [2, 'always', 24],

    // === 主标题（subject）===
    'subject-case': [0], // 允许中文，不强制大小写
    'subject-empty': [2, 'never'],
    'subject-full-stop': [2, 'never', '。'], // 主标题不能以中文句号结尾
    'subject-max-length': [2, 'always', 72], // Conventional Commits 推荐 ≤ 50，宽松到 72

    // === 头部（header）===
    'header-max-length': [2, 'always', 100], // type(scope): subject 总长度上限

    // === 正文（body）===
    'body-leading-blank': [1, 'always'], // body 前必须空一行
    'body-max-line-length': [1, 'always', 120], // 单行不超过 120 字符

    // === 脚注（footer）===
    'footer-leading-blank': [1, 'always'],
    'footer-max-line-length': [1, 'always', 120]
  }
}
