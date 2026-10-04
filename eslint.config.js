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
  // .cjs 是 CommonJS 文件，require() 是其唯一合法导入方式
  // （electron-builder 钩子 scripts/after-pack-vc-runtime.cjs 必须使用 CJS）。
  {
    files: ['**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
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
  // ============ 渲染进程专属约定护栏（docs/CODING_CONVENTIONS.md §1-§4） ============
  // 在 src/** 块之后覆盖 no-restricted-syntax，同时保留 i18n 护栏并追加以下禁令：
  //   §1 禁止渲染层 import('electron') / import ... from 'electron'
  //   §2 禁止 throw new Error（应使用 AppError 家族）
  //   §3 禁止 JSX 中硬编码 #xxxxxx 色值（应使用 CSS 变量 / Tailwind token）
  //   §4 禁止 class extends React.Component（必须使用函数式组件 + Hooks）
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    rules: {
      // §1 语义级拦截：禁止渲染层导入 electron 模块（静态 import 与动态 import() 均拦截）
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                '渲染层禁止直接 import electron，请通过 window.electronAPI（preload 桥）访问主进程能力'
            }
          ]
        }
      ],
      'no-restricted-syntax': [
        'error',
        // —— 复用 i18n 护栏（中文硬编码 + console 调试噪声）——
        ...i18nGuardSelectors,
        // §1 禁止渲染层导入 electron（一律经 preload 桥）
        {
          selector: "ImportDeclaration[source.value='electron']",
          message:
            '渲染层禁止直接 import electron，请通过 window.electronAPI（preload 桥）访问主进程能力'
        },
        {
          selector: "ImportExpression[source.value='electron']",
          message:
            '渲染层禁止动态 import("electron")，请通过 window.electronAPI（preload 桥）访问主进程能力'
        },
        // §2 禁止 throw new Error（应使用 AppError 家族，见 src/shared/errors/app-error.ts）
        {
          selector: 'ThrowStatement > NewExpression[callee.name="Error"]',
          message:
            '禁止 throw new Error()，请使用 src/shared/errors/app-error.ts 中的 AppError 家族（ValidationError / NotFoundError / PermissionError 等）'
        },
        // §3 禁止 JSX 属性中硬编码 #xxxxxx 色值（应使用 CSS 变量 / Tailwind token）
        {
          selector: 'JSXAttribute > Literal[value=/^#[0-9a-fA-F]{3,8}$/]',
          message:
            '禁止在 JSX 中硬编码十六进制色值，请使用 CSS 变量（var(--*)）或 Tailwind 语义 token（如 text-primary / bg-accent）'
        },
        // §3-a 禁止 style 属性对象中硬编码色值（如 style={{ color: '#f00' }}）
        {
          selector:
            'JSXAttribute[name.name="style"] JSXExpressionContainer > ObjectExpression Property > Literal[value=/^#[0-9a-fA-F]{3,8}$/]',
          message:
            '禁止在 style 内联对象中硬编码十六进制色值，请使用 CSS 变量（如 style={{ color: "var(--text-primary)" }}）'
        },
        // §3-b 禁止色值常量对象中硬编码色值（如 const COLORS = { danger: '#ff0000' }）
        {
          selector:
            'VariableDeclarator[id.name=/^(COLOR|COLORS|Color|Colors|THEME|THEMES|Theme|Themes|PALETTE|PALETTES|Palette|Palettes)$/][init.type="ObjectExpression"] Literal[value=/^#[0-9a-fA-F]{3,8}$/]',
          message:
            '禁止在色值常量对象中硬编码十六进制色值，请使用 CSS 变量（var(--*)）或 Tailwind 语义 token'
        },
        // §4 禁止 class 组件（必须使用函数式组件 + Hooks）
        {
          selector:
            'ClassDeclaration[superClass.object.name="React"][superClass.property.name="Component"]',
          message: '禁止 class 组件，请使用 React 函数式组件 + Hooks（React.FC 或裸函数）'
        },
        {
          selector:
            'ClassExpression[superClass.object.name="React"][superClass.property.name="Component"]',
          message: '禁止 class 组件，请使用 React 函数式组件 + Hooks（React.FC 或裸函数）'
        }
      ]
    }
  },
  // ============ Preload 桥装配层约定护栏（docs/CODING_CONVENTIONS.md §1） ============
  // 禁止在 preload 子模块中裸调 ipcRenderer.invoke（一律经 ipc.ts 的 call<T>() 解包）；
  // 禁止绕过 exposeIfTrusted 直接调 contextBridge.exposeInMainWorld（跳过 origin 门禁）。
  // ipc.ts 是中央 IPC 基础层，合法使用 ipcRenderer.invoke，通过 ignores 豁免。
  {
    files: ['src/main/preload/**/*.ts'],
    ignores: ['src/main/preload/ipc.ts', 'src/main/preload/__tests__/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...i18nGuardSelectors,
        // §1 禁止裸调 ipcRenderer.invoke（一律经 ipc.ts 的 call<T>() 解包）
        {
          selector: "MemberExpression[object.name='ipcRenderer'][property.name='invoke']",
          message:
            'preload 子模块禁止裸调 ipcRenderer.invoke，请统一使用 src/main/preload/ipc.ts 的 call<T>() 函数'
        },
        // §1 禁止绕过 exposeIfTrusted 直接暴露全局（跳过非授信文档 origin 门禁）
        {
          selector:
            "CallExpression[callee.object.name='contextBridge'][callee.property.name='exposeInMainWorld']",
          message:
            'preload 子模块禁止直接调用 contextBridge.exposeInMainWorld，请统一通过 preload.ts 的 exposeIfTrusted() 暴露（确保 origin 门禁生效）'
        }
      ]
    }
  },
  // ============ 核心路径保护（preload API 命名空间） ============
  // 两层闸门（详见 AGENTS.md「核心路径保护」）：
  //   ① local/core-path-guard 为静态格式护栏：@core-change 授权注释存在与否不强制，
  //     存在时校验「至多一条、原因非空、不得为批量占位文案」；
  //   ② 授权判定由提交面闸门（scripts/core-path-gate.ts，接入 .husky/pre-commit 与
  //     npm run verify）对本次 diff 判定：实质改动必须同批新增含真实原因的授权注释。
  {
    files: ['src/main/preload/api/**/*.ts'],
    ignores: ['src/main/preload/api/**/*.test.ts'],
    rules: {
      'local/core-path-guard': 'error'
    }
  },
  // ============ 主进程 handler / service 约定护栏（docs/CODING_CONVENTIONS.md §2） ============
  // 禁止 throw new Error()，引导使用 AppError 家族（DatabaseError / ValidationError 等）。
  // 与 renderer 块同理，需复用 i18n 护栏（flat config 后块覆盖前块的 no-restricted-syntax）。
  // 测试文件在下方 tests/__tests__ 块豁免（断言 fixture 合法使用原生 Error）。
  {
    files: ['src/main/ipc/handlers/**/*.ts', 'src/main/services/**/*.ts'],
    ignores: ['src/main/ipc/handlers/_*.ts', 'src/main/ipc/handlers/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...i18nGuardSelectors,
        {
          selector: 'ThrowStatement > NewExpression[callee.name="Error"]',
          message:
            '禁止 throw new Error()，请使用 src/shared/errors/app-error.ts 中的 AppError 家族（DatabaseError / ValidationError / NotFoundError / PermissionError / FileSystemError / InternalError）'
        }
      ],
      'local/core-path-guard': 'error'
    }
  },
  // ============ 核心路径保护（共享错误定义） ============
  // 两层闸门口径同 preload/api 块：本规则做注释格式护栏（存在不强制），
  // 授权判定由提交面闸门 scripts/core-path-gate.ts 对本次 diff 执行。
  // 这些文件定义了跨进程统一错误基类与错误码，任何变更都影响全局错误处理契约。
  {
    files: ['src/shared/errors/**/*.ts'],
    ignores: ['src/shared/errors/**/*.test.ts'],
    rules: {
      'local/core-path-guard': 'error'
    }
  },
  // ============ 主进程 IPC handler 约定护栏（docs/CODING_CONVENTIONS.md §1） ============
  // 自定义规则：ipcMain.handle 的第二个参数必须为 wrapHandler / wrapHandlerNoArgs / wrapHandlerRaw 调用，
  // 禁止裸注册（绕过参数校验与统一响应包装）。
  // no-restricted-syntax 无法表达"第二参数必须是某函数调用"的条件逻辑，故使用自定义规则。
  {
    plugins: {
      local: {
        meta: { name: 'local', version: '0.0.0' },
        rules: {
          'ipc-handler-wrap': {
            meta: {
              type: 'problem',
              docs: {
                description:
                  'IPC handler 必须使用 wrapHandler / wrapHandlerNoArgs / wrapHandlerRaw 包装，禁止裸调 ipcMain.handle'
              }
            },
            create(context) {
              const WRAP_NAMES = new Set(['wrapHandler', 'wrapHandlerNoArgs', 'wrapHandlerRaw'])
              return {
                CallExpression(node) {
                  const callee = node.callee
                  if (
                    callee.type !== 'MemberExpression' ||
                    callee.object.type !== 'Identifier' ||
                    callee.object.name !== 'ipcMain' ||
                    callee.property.type !== 'Identifier' ||
                    callee.property.name !== 'handle'
                  ) {
                    return
                  }
                  if (node.arguments.length < 2) return
                  const handlerArg = node.arguments[1]
                  if (
                    handlerArg.type === 'CallExpression' &&
                    handlerArg.callee.type === 'Identifier' &&
                    WRAP_NAMES.has(handlerArg.callee.name)
                  ) {
                    return
                  }
                  context.report({
                    node: handlerArg,
                    message:
                      'ipcMain.handle 的 handler 必须使用 wrapHandler / wrapHandlerNoArgs / wrapHandlerRaw 包装（来自 src/main/ipc/validator.ts），禁止裸调异步函数'
                  })
                }
              }
            }
          },
          // 核心路径保护（静态格式护栏）：@core-change 授权注释存在与否不强制（授权与否由
          // 提交面闸门 scripts/core-path-gate.ts 对本次 diff 判定，见 AGENTS.md「核心路径保护」）；
          // 一旦存在，则校验格式：至多一条（顶部 5 行内）、原因非空、不得为批量占位文案。
          'core-path-guard': {
            meta: {
              type: 'problem',
              docs: {
                description:
                  '核心路径 @core-change 授权注释格式护栏：至多一条、原因非空、不得为批量占位文案（存在与否不强制，授权判定见 AGENTS.md「核心路径保护」）'
              }
            },
            create(context) {
              return {
                Program(node) {
                  const authComments = (node.comments || []).filter(
                    (c) =>
                      c.type === 'Line' && c.loc.start.line <= 5 && /@core-change:/.test(c.value)
                  )
                  if (authComments.length === 0) return
                  if (authComments.length > 1) {
                    context.report({
                      node,
                      loc: authComments[1].loc,
                      message:
                        '核心路径授权注释至多保留一条（顶部 5 行内），请合并为本次变更的唯一原因（见 AGENTS.md「核心路径保护」）'
                    })
                    return
                  }
                  const reason = authComments[0].value.replace(/^.*@core-change:\s*/, '').trim()
                  if (reason === '') {
                    context.report({
                      node,
                      loc: authComments[0].loc,
                      message:
                        '@core-change 授权注释缺少变更原因：请写明本次真实变更原因（见 AGENTS.md「核心路径保护」）'
                    })
                    return
                  }
                  if (reason === '核心路径保护规则初始化') {
                    context.report({
                      node,
                      loc: authComments[0].loc,
                      message:
                        '@core-change 原因不得使用批量初始化占位文案，请替换为本次真实变更原因（见 AGENTS.md「核心路径保护」）'
                    })
                  }
                }
              }
            }
          }
        }
      }
    }
  },
  {
    files: ['src/main/ipc/handlers/*.ts'],
    ignores: ['src/main/ipc/handlers/_*.ts', 'src/main/ipc/handlers/*.test.ts'],
    rules: {
      'local/ipc-handler-wrap': 'error'
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
    // 原生模块加载预检：在 i18n 初始化之前运行，必须能在 i18n 不可用时弹出可读的中文错误提示，
    // 否则会重现“原生模块加载失败 → t() 二次抛错 → 无弹窗”的静默崩溃。与 logger.ts 同款豁免。
    files: ['src/main/app/native-load-guard.ts'],
    rules: {
      'no-restricted-syntax': 'off'
    }
  },
  {
    // 启动期环境检测：在 i18n 初始化之前运行（app.whenReady 内、加载 Application 之前），
    // 检测 userData 可写性与安装路径特殊字符，必须能在 i18n 不可用时弹出可读的中文双语引导，
    // 否则会重现“权限/路径问题 → t() 二次抛错 → 静默失败”。与 native-load-guard.ts 同款豁免。
    files: ['src/main/app/startup-environment.ts'],
    rules: {
      'no-restricted-syntax': 'off'
    }
  },
  {
    // 启动最早期致命处理：在 i18n 初始化之前即可运行，必须能在 i18n 不可用时弹出可读的中文双语错误提示，
    // 否则会重现“启动早期崩溃 → t() 二次抛错 → 无弹窗”的静默崩溃。与 native-load-guard.ts 同款豁免。
    files: ['src/main/utils/early-crash-guard.ts'],
    rules: {
      'no-restricted-syntax': 'off'
    }
  },
  {
    // 测试文件豁免：断言与 fixture 合法包含中文（主进程测试使用真实 zh-CN 语言包做断言），
    // 对测试关闭中文/console 检测。必须置于 src/** 块之后。
    // Storybook stories 同款豁免：示例文案/文档描述允许中文，与 *.test.* 同等待遇。
    files: ['src/**/*.{test,spec}.{ts,tsx}', 'src/**/__tests__/**', 'src/**/*.stories.tsx'],
    rules: {
      'no-restricted-syntax': 'off',
      // 核心路径保护规则在测试文件中豁免（测试 fixture 不需要授权注释）
      'local/core-path-guard': 'off'
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
      // Storybook 静态构建产物（不入仓，不参与 lint）
      '**/storybook-static/**',
      '*.log',
      // 本地工具缓存目录（.gitignore 已忽略，CI 干净环境不存在；加入避免本地 lint 误报，
      // 保持本地 `npm run lint` 与 CI 行为一致）
      '.cache/**',
      '.qoder/**'
    ]
  }
]
