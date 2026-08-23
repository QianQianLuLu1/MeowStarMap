import js from '@eslint/js'
import ts from 'typescript-eslint'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

// i18n 护栏选择器：禁止硬编码中文（JSX 文本 / 字符串字面量）+ 禁用调试噪声 console 调用。
// severity 由各配置块决定：src 普通源码 error 硬阻断；存量技术债文件 warn 渐进收敛。
const i18nGuardSelectors = [
  {
    selector: 'JSXText[value=/[\\u4e00-\\u9fa5]/]',
    message: 'JSX 文本节点禁止硬编码中文，请使用 t("key") 包裹'
  },
  {
    selector: 'Literal[value=/[\\u4e00-\\u9fa5]/]',
    message: '字符串字面量禁止硬编码中文，请使用 t("key")'
  },
  // 护栏：精确拦截"调试噪声" console.log/info/debug/trace/table/dir，
  // 但放行 console.warn / console.error（关键提示与错误处理，符合"允许 warn/error"诉求）。
  {
    selector:
      "CallExpression[callee.object.name='console'][callee.property.name=/^(log|info|debug|trace|table|dir|dirxml)$/]",
    message:
      '调试用 console 调用（log/info/debug 等）已被禁止，请改用项目统一 logger（logger.info/warn/error）'
  }
]

export default [
  js.configs.recommended,
  ...ts.configs.recommended,
  // 关闭所有与 Prettier 冲突的格式化类 ESLint 规则
  // 必须放在最后，让前面的规则先评估
  prettier,
  // 2026-08-22：恢复 2026-08-12 止血降级的 7 条规则为 error，存量违规已全部清偿，
  // 提交与 CI 阶段再次硬性阻断技术债引入。
  // 此块对所有代码文件生效，覆盖 src/tests/scripts 之外未被具体块匹配的文件
  // （如 .worktree-backup-* 备份目录、docs 脚本）。具体块在其后，仍会覆盖回各自策略。
  // react-hooks 插件仅在下方 src 块注册过；这里复用已导入的 reactHooks 重新注册一次，
  // 是为了避免在 .js / scripts 等文件上设置 exhaustive-deps 时触发 "rule not found"。
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx,jsx,cts,mts}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/no-require-imports': 'error',
      '@typescript-eslint/no-unsafe-function-type': 'error',
      'react-hooks/exhaustive-deps': 'error'
    }
  },
  // no-undef 仅对 JS 文件生效：TS 文件由 typescript-eslint 推荐配置已关掉
  // （no-undef 在 TS 中不可靠），不在这里重新打开，以免在 TS 文件上产生大量误报。
  {
    files: ['**/*.{js,mjs,cjs,jsx}'],
    rules: {
      'no-undef': 'error'
    }
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: ts.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true }
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2020
      }
    },
    plugins: {
      '@typescript-eslint': ts.plugin,
      react,
      'react-hooks': reactHooks
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/no-unsafe-function-type': 'error',
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-undef': 'off',
      // 主进程加载 native 模块（better-sqlite3、koffi 等）需要 require()
      '@typescript-eslint/no-require-imports': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      // i18n 改造完成（2026-08-22）：中文硬编码检测升级为 error 硬阻断。
      // 存量技术债文件在下方 legacy 白名单块中降级为 warn 渐进收敛，修复一个删一个；
      // 测试文件在下方 tests 块整体豁免（断言/fixture 合法包含中文）。
      'no-restricted-syntax': ['error', ...i18nGuardSelectors]
    },
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    // 日志实现文件：logger 自身依赖 console 作为兜底输出（磁盘满/权限问题的最后暴露渠道），
    // 其中的中文 console.* 文案为有意保留项（i18n 不可用时日志仍需可读，且 logger 初始化早于 i18n），
    // 不对它施加 i18n 护栏。必须置于 src/** 块之后，flat config 中后定义的块才会覆盖先定义的规则。
    files: ['src/main/utils/logger.ts'],
    rules: {
      'no-restricted-syntax': 'off'
    }
  },
  {
    // 测试文件豁免：断言与 fixture 合法包含中文（主进程测试使用真实 zh-CN 语言包做断言），
    // 对测试关闭中文/console 检测。必须置于 src/** 块之后。
    files: ['src/**/*.{test,spec}.{ts,tsx}', 'src/**/__tests__/**'],
    rules: {
      'no-restricted-syntax': 'off'
    }
  },
  // ============ i18n 存量技术债白名单（已全量清偿，2026-08-23） ============
  // 白名单原有的 43 个文件（464 处硬编码中文，2026-08-22 基线）已全部修复出清：
  // UI 文案改 t()、日志走 logger + t()、数据值/DB 标识加 eslint-disable 豁免。
  // 全量源码现直接受上方 error 硬阻断约束，新增文件一律不得 reintroduce 白名单。
  {
    files: ['scripts/**/*.{ts,js,cjs}', '*.config.{ts,js,cjs}'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2020
      }
    }
  },
  {
    files: ['tests/**/*.{ts,tsx}'],
    languageOptions: {
      parser: ts.parser,
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2020
      }
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-undef': 'off'
    }
  },
  {
    ignores: [
      'dist/**',
      'build-output/**',
      'release/**',
      'backup/**',
      'plugins-samples/**',
      'node_modules/**',
      'node20/**',
      'preview.html',
      'src/renderer/dist/**',
      'tools/**',
      'project-issues-fix-guide/**',
      'wxnn-photo-manager/**',
      // 本地 AI agent 工作区（不入仓，其中的临时脚本不参与本仓库 lint）
      '.workbuddy/**',
      // 本地备份目录与测试覆盖率产物（不入仓，不参与 lint）
      '_safe_backup_20260821/**',
      'coverage/**',
      '*.log'
    ]
  }
]
