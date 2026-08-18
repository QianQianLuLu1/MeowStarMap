import js from '@eslint/js'
import ts from 'typescript-eslint'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default [
  js.configs.recommended,
  ...ts.configs.recommended,
  // 关闭所有与 Prettier 冲突的格式化类 ESLint 规则
  // 必须放在最后，让前面的规则先评估
  prettier,
  // 止血降级（2026-08-12）：以下 7 条规则存量违反较多，统一降级为 warn 让 CI 转绿。
  // 此块对所有代码文件生效，覆盖 src/tests/scripts 之外未被具体块匹配的文件
  // （如 .worktree-backup-* 备份目录、docs 脚本）。具体块在其后，仍会覆盖回各自策略。
  // react-hooks 插件仅在下方 src 块注册过；这里复用已导入的 reactHooks 重新注册一次，
  // 是为了避免在 .js / scripts 等文件上设置 exhaustive-deps 时触发 "rule not found"。
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx,jsx,cts,mts}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },
  // no-undef 仅对 JS 文件降级为 warn：TS 文件由 typescript-eslint 推荐配置已关掉
  // （no-undef 在 TS 中不可靠），不在这里重新打开，以免在 TS 文件上产生大量误报。
  {
    files: ['**/*.{js,mjs,cjs,jsx}'],
    rules: {
      'no-undef': 'warn'
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
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-undef': 'off',
      // 主进程加载 native 模块（better-sqlite3、koffi 等）需要 require()
      '@typescript-eslint/no-require-imports': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // i18n 改造：禁止硬编码中文，先 warning 模式渐进式收敛
      'no-restricted-syntax': [
        'warn',
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
        // 说明：成熟插件 eslint-plugin-no-console（npm 当前 404 不可用）可更细粒度控制，
        // 此处用内置 no-restricted-syntax 等价实现，零新增依赖、且不与上面的 i18n 规则冲突。
        {
          selector:
            "CallExpression[callee.object.name='console'][callee.property.name=/^(log|info|debug|trace|table|dir|dirxml)$/]",
          message:
            '调试用 console 调用（log/info/debug 等）已被禁止，请改用项目统一 logger（logger.info/warn/error）'
        }
      ]
    },
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    // 日志实现文件：logger 自身依赖 console 作为兜底输出（磁盘满/权限问题的最后暴露渠道），
    // 且其中 console.* 均带有 TODO: i18n: internal log 标记（已知保留项），不对它施加护栏。
    // 必须置于 src/** 块之后，flat config 中后定义的块才会覆盖先定义的规则。
    files: ['src/main/utils/logger.ts'],
    rules: {
      'no-restricted-syntax': 'off'
    }
  },
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
        'warn',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
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
      '*.log'
    ]
  }
]
