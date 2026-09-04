# Storybook 使用指南

> 本项目的组件开发与文档工具链（Storybook 10，框架 `@storybook/react-vite`）。
> 文档规范见 `docs/组件文档规范.md`；本指南只讲"怎么跑、怎么用、出错怎么查"。

## 1. 启动开发模式

```powershell
npm run storybook
```

- 默认端口 **6006**，启动后浏览器访问 `http://localhost:6006`。
- 与 `npm run dev`（应用本体）互不干扰，可并行运行。
- 组件源码 / stories / i18n 语言包变更均支持热更新，保存即刷新。

## 2. 静态构建

```powershell
npm run build-storybook
```

- 产物输出到仓库根目录 `storybook-static/`，纯静态站点，可直接部署或归档分享。
- CI / 本地验收均以此命令零错误为准；`storybook-static` 不进入应用打包产物（见第 6 节）。

## 3. 工具栏：语言与主题切换

顶部工具栏提供两个全局开关（对应 `.storybook/preview.ts` 的 `globalTypes`）：

| 开关       | 默认值    | 实现                                                                                                                                                    |
| ---------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 语言（🌐） | `zh-CN`   | `.storybook/decorators/i18n.tsx` 静态装载全部 12 个语言包，切换即时生效（应用本体是动态分包，Storybook 不做分包）                                       |
| 主题（🖌）  | `default` | `.storybook/decorators/theme.tsx` 复用 `themeStore.applyTheme` 把主题类挂到 `document.documentElement`，与生产行为一致；不调用 `setTheme`，不触发持久化 |

切换后可直接在 Canvas / Docs 两种视图下核对组件观感；Docs 页（组件标题旁的 📄 图标）含自动生成的 Props 表格与全部 story 源码。

## 4. `window.electronAPI` 安全桩

`.storybook/preview.ts` 启动时经 `.storybook/mocks/electron-api.ts` 全局挂载双层 Proxy 桩：
任意 `window.electronAPI?.命名空间.方法()` 调用默认打印 `console.debug` 并 `resolve(undefined)`，
保证依赖 IPC 的组件在 Storybook 中可渲染、不抛错。

需要具体返回值展示有意义状态时，在 story 内覆盖（`beforeEach` 注解 + 清理还原），
详见 `docs/组件文档规范.md` 第 4 节。

## 5. 常见排错

| 症状                                     | 排查方向                                                                                                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 侧边栏看不到新 story                     | 文件名必须是 `*.stories.tsx` 且位于 `src/renderer/**` 或 `docs/storybook/**/*.mdx`（`.storybook/main.ts` 的 glob）；改完 glob 需重启                                    |
| 模块解析失败（`@/` `@main/` `@common/`） | 别名同步点有两处：`.storybook/main.ts` 的 `viteFinal` 与 `electron.vite.config.ts` 的 renderer 别名，二者必须保持同一语义；新增别名两处都要改                           |
| `import 'electron'` 相关报错             | 渲染层禁止真实 electron：别名已指向 `scripts/electron-browser-stub.js`，与 `electron.vite.config.ts` / `vite.preview.config.ts` 同源；勿在 stories 中直接引入主进程模块 |
| 页面白屏 / 报 `__PREVIEW__` 未定义       | `.storybook/main.ts` 已 `define: { __PREVIEW__: false }`，若被误删请补回                                                                                                |
| i18n 文案显示 key 本身                   | 检查对应语言包是否缺 key（`npm run i18n:check`）；Storybook 以 `zh-CN` 为回退语言                                                                                       |
| 依赖 IPC 的组件报错                      | 组件访问必须走可选链 `window.electronAPI?.xxx`；确认全局桩已生效（控制台有 `[storybook] electronAPI.*` debug 日志）                                                     |
| 主题切换不生效                           | 组件颜色必须来自 `var(--*)` 主题变量，不得写死十六进制色                                                                                                                |

## 6. 与测试流程的关系

- **stories 不进 vitest**：`*.stories.tsx` 是文档与预览资产，不参与 `npm run test` / `npm run test:renderer`，也不计入覆盖率。
- **不进覆盖率**：`vitest.config.ts` 的 coverage 统计范围不包含 stories。
- **不进应用产物**：`npm run build` / `npm run dist:win` 的打包产物与 `storybook-static` 完全隔离，互不影响。
- 组件行为正确性仍以同置 `*.test.tsx` 为准；stories 负责"可看"，测试负责"可对"，两者互补、不可互相替代。

## 7. 相关配置索引

| 文件                                                 | 职责                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| `.storybook/main.ts`                                 | stories glob、addons、autodocs 策略、Vite 别名与 `__PREVIEW__` |
| `.storybook/preview.ts`                              | 全局 args（locale / theme）、装饰器注册、electronAPI 桩挂载    |
| `.storybook/decorators/i18n.tsx`                     | i18next 独立实例 + 12 语言包                                   |
| `.storybook/decorators/theme.tsx`                    | 主题类切换（复用 `themeStore.applyTheme`）                     |
| `.storybook/mocks/electron-api.ts`                   | `window.electronAPI` 双层 Proxy 安全桩                         |
| `src/renderer/components/common/Spinner.stories.tsx` | story 编写样板                                                 |

## 8. CI 触发语义

`storybook` CI job（`.github/workflows/build.yml`）的触发与影响面：

- **触发条件**：仅两种——手动触发（`workflow_dispatch`，此时其余 job 被 if 守卫跳过，只跑文档站构建）
  与 tag push（`v*` 标签，随发布流水线一并运行）；普通分支 push 与 PR 不跑该 job。
- **失败影响**：该 job 不在任何既有 job 的 `needs` 链上，也不被其他 job 依赖，失败不阻断构建 / 发布链；
  但 tag push 时若文档站构建失败，该次 release workflow run 整体会显示为失败（仅状态呈现），
  安装包产物与 GitHub Release 发布链不受影响。
- **排查入口**：构建失败时优先本地复现 `npm run build-storybook`，常见原因见第 5 节排错表。
