# NikkiGallery 插件开发 API 文档

> 版本：v1.0 ｜ 对应 NikkiGallery v2.3.0+（经核对在 v2.5.0 仍然有效）｜ 核心框架：[pluggable-electron](https://github.com/dutchigor/pluggable-electron) v1.0.0

本文档面向 NikkiGallery 插件开发者，描述插件包格式、生命周期、可用的 API 与扩展点。

---

## 目录

1. [快速开始](#1-快速开始)
2. [插件包格式](#2-插件包格式)
3. [插件生命周期](#3-插件生命周期)
4. [插件入口 API](#4-插件入口-api)
5. [扩展点 API](#5-扩展点-api)
6. [业务扩展点清单](#6-业务扩展点清单)
7. [能力桥 API（window.pluginAPI）](#7-能力桥-apiwindowpluginapi)
8. [插件管理 facade API（window.pluggableElectronIpc）](#8-插件管理-facade-apiwindowpluggableelectronipc)
9. [权限清单](#9-权限清单)
10. [安全与沙箱](#10-安全与沙箱)
11. [完整示例](#11-完整示例)
12. [调试与排障](#12-调试与排障)

---

## 1. 快速开始

### 1.1 最小插件示例

```
my-first-plugin/
├── package.json
└── index.js
```

`package.json`：

```json
{
  "name": "my-first-plugin",
  "version": "1.0.0",
  "main": "index.js",
  "type": "module",
  "activationPoints": ["init"],
  "nikkiGallery": {
    "engines": "^2.3.0",
    "permissions": [],
    "extensionPoints": ["watermark.template"]
  }
}
```

`index.js`：

```javascript
export function init(extensionPoints) {
  extensionPoints.register(
    'watermark.template',
    'my-first-plugin:hello',
    () => ({
      id: 'mfp-hello',
      name: 'Hello 插件水印',
      type: 'text',
      text: 'Hello from Plugin',
      color: '#FF69B4',
      opacity: 0.8,
      position: 'bottomRight',
      category: 'custom'
    }),
    50
  )
}

export function dispose() {
  // 可选：清理插件自身的定时器、监听器等资源
}
```

### 1.2 安装到 NikkiGallery

1. 在插件目录执行 `npm pack` 生成 `my-first-plugin-1.0.0.tgz`
2. 打开 NikkiGallery → 设置 → 插件管理 → 安装插件
3. 输入 `.tgz` 文件路径，确认安装
4. 启用插件后，水印面板将出现"Hello 插件水印"模板

---

## 2. 插件包格式

### 2.1 package.json 字段

| 字段               | 类型                       | 必填 | 说明                                                             |
| ------------------ | -------------------------- | ---- | ---------------------------------------------------------------- |
| `name`             | string                     | ✅   | npm 包名，必须唯一，建议前缀 `nikki-`                            |
| `version`          | string                     | ✅   | semver 版本号                                                    |
| `description`      | string                     | ❌   | 插件描述，显示在插件管理界面                                     |
| `author`           | string \| object           | ❌   | 作者信息                                                         |
| `license`          | string                     | ❌   | 开源协议                                                         |
| `main`             | string                     | ✅   | 入口文件相对路径，默认 `index.js`                                |
| `type`             | `"module"` \| `"commonjs"` | ❌   | 模块格式，渲染进程插件建议 `module`（ESM）                       |
| `activationPoints` | string[]                   | ✅   | pluggable-electron 原生字段，列出响应的激活点，通常为 `["init"]` |
| `nikkiGallery`     | object                     | ✅   | NikkiGallery 专用字段，见下表                                    |

### 2.2 nikkiGallery 字段

| 字段              | 类型                             | 必填 | 说明                                                       |
| ----------------- | -------------------------------- | ---- | ---------------------------------------------------------- |
| `engines`         | string                           | ✅   | 兼容的 NikkiGallery 版本范围（semver）                     |
| `permissions`     | string[]                         | ❌   | 申请的能力权限，缺省为 `[]`，见 [§9 权限清单](#9-权限清单) |
| `extensionPoints` | string[]                         | ❌   | 声明将注册的扩展点，用于权限审计                           |
| `i18n`            | string                           | ❌   | 国际化资源目录相对路径                                     |
| `type`            | `"renderer"` \| `"main-process"` | ❌   | 进程类型，默认 `renderer`                                  |

### 2.3 完整 package.json 示例

```json
{
  "name": "custom-watermark-template",
  "version": "1.0.0",
  "description": "NikkiGallery 自定义水印模板示例插件",
  "author": "NikkiGallery",
  "license": "MIT",
  "main": "index.js",
  "type": "module",
  "activationPoints": ["init"],
  "nikkiGallery": {
    "engines": "^2.3.0",
    "permissions": ["watermark:apply"],
    "extensionPoints": ["watermark.template"],
    "i18n": "./locales"
  }
}
```

### 2.4 推荐目录结构

```
my-plugin/
├── package.json
├── index.js              ← 入口，导出 init / dispose
├── templates/            ← 插件私有资源（图片、SVG 等）
│   └── festival.svg
├── locales/              ← 可选 i18n 资源
│   ├── zh-CN.json
│   └── en-US.json
└── README.md
```

---

## 3. 插件生命周期

### 3.1 状态机

```
                    ┌──────────┐
                    │ 未安装   │
                    └─────┬────┘
                          │ install
                          ▼
                    ┌──────────┐
        ┌───────────│ 已启用   │◄───────┐
        │           │ (active) │        │
        │ disable   └─────┬────┘        │ enable
        │                 │             │
        ▼                 │ uninstall   │
   ┌──────────┐           │             │
   │ 已禁用   │───────────┼─────────────┘
   │(inactive)│           │
   └──────────┘           ▼
                    ┌──────────┐
                    │ 已卸载   │
                    └──────────┘
```

### 3.2 生命周期事件

| 事件           | 触发时机                            | 插件可执行的钩子                               |
| -------------- | ----------------------------------- | ---------------------------------------------- |
| **install**    | 用户在插件管理界面安装插件          | `confirmInstall` 回调（主进程弹窗确认）        |
| **activate**   | 插件启用 / 应用启动时加载已激活插件 | `init(extensionPoints)` 函数被调用             |
| **deactivate** | 用户禁用插件                        | `dispose()` 函数被调用（可选）；扩展点自动清理 |
| **uninstall**  | 用户卸载插件                        | 插件目录被删除，注册表项移除                   |
| **update**     | 用户检查更新并确认                  | 重新安装新版本                                 |

### 3.3 init 函数

```javascript
/**
 * 插件激活入口
 * @param {object} extensionPoints pluggable-electron 扩展点 API
 */
export function init(extensionPoints) {
  // 在此注册扩展点响应
  extensionPoints.register('watermark.template', 'my-plugin:ext1', responder, priority)
}

/**
 * 插件停用清理（可选）
 * 扩展点的清理由 PluginRuntime 自动完成，此函数仅清理插件自身资源
 */
export function dispose() {
  // 清理定时器、事件监听器等
}
```

---

## 4. 插件入口 API

插件入口文件（由 `package.json.main` 指定，默认 `index.js`）需导出以下函数：

### 4.1 init(extensionPoints) — 必需

**参数**：

| 参数              | 类型   | 说明                                                                              |
| ----------------- | ------ | --------------------------------------------------------------------------------- |
| `extensionPoints` | object | pluggable-electron 扩展点 API，提供 `register` / `execute` / `unregisterAll` 方法 |

**调用时机**：

- 应用启动时，对所有已激活插件调用
- 用户启用插件时调用

**约定**：

- 注册的扩展名必须以 `'pluginName:'` 为前缀，便于停用时批量清理
- 单个插件 init 抛异常不会影响其他插件，但该插件会被标记为错误状态

### 4.2 dispose() — 可选

**调用时机**：

- 用户禁用插件时调用
- 应用退出时不调用（进程直接终止）

**注意**：

- 扩展点的清理由 PluginRuntime 自动完成（调用 `extensionPoints.unregisterAll(/^pluginName:/)`）
- 此函数仅需清理插件自身的资源（定时器、监听器、网络连接等）

---

## 5. 扩展点 API

`init` 函数接收的 `extensionPoints` 对象提供以下方法：

### 5.1 register(name, extensionName, responder, priority?)

注册一个扩展响应。

| 参数            | 类型              | 必填 | 说明                                                            |
| --------------- | ----------------- | ---- | --------------------------------------------------------------- |
| `name`          | string            | ✅   | 扩展点名，见 [§6 业务扩展点清单](#6-业务扩展点清单)             |
| `extensionName` | string            | ✅   | 扩展名，必须以 `'pluginName:'` 为前缀                           |
| `responder`     | function \| value | ✅   | 响应函数（接收 input 参数）或静态值                             |
| `priority`      | number            | ❌   | 优先级，数字越小越先执行（仅串行 `executeSerial` 有效），默认 0 |

**示例**：

```javascript
extensionPoints.register(
  'watermark.template',
  'my-plugin:signature',
  () => ({
    id: 'mp-signature',
    name: '签名水印',
    type: 'text',
    text: '© My Signature',
    color: '#FF69B4',
    opacity: 0.9,
    position: 'bottomRight',
    category: 'custom'
  }),
  20
)
```

### 5.2 execute(name, input?) — 消费方使用

执行扩展点的所有响应，返回响应数组（异步响应为 Promise）。

> 插件一般不调用此方法，主要由 NikkiGallery 内部组件消费扩展点。

### 5.3 unregisterAll(pattern)

批量清理匹配的扩展。

| 参数      | 类型   | 说明           |
| --------- | ------ | -------------- |
| `pattern` | RegExp | 扩展名匹配模式 |

**示例**：

```javascript
// 清理插件的所有扩展（PluginRuntime 自动调用）
extensionPoints.unregisterAll(/^my-plugin:/)
```

---

## 6. 业务扩展点清单

NikkiGallery 提供 6 个业务扩展点，插件可注册响应：

### 6.1 watermark.template — 水印模板

向水印面板注入自定义水印模板。

**响应结构**：

```typescript
{
  id: string                  // 模板唯一 ID（建议插件名前缀）
  name: string                // 模板显示名
  type: 'text' | 'image'      // 模板类型
  text?: string               // 文字内容（type=text 时必填）
  font?: string               // 字体（type=text 时可选）
  fontSize?: number           // 字号（type=text 时可选）
  color?: string              // 文字颜色（type=text 时可选）
  imagePath?: string          // 图片路径（type=image 时必填，绝对路径或 file:// URL）
  position?: string           // 位置：topLeft/topCenter/topRight/centerLeft/center/centerRight/bottomLeft/bottomCenter/bottomRight
  opacity?: number            // 不透明度 0-1
  scale?: number              // 缩放比例 0-1（仅图片水印）
  category: 'custom'          // 固定为 'custom'
}
```

**示例**：

```javascript
extensionPoints.register(
  'watermark.template',
  'my-plugin:signature',
  () => ({
    id: 'mp-signature',
    name: '签名水印',
    type: 'text',
    text: '© My Nikki Gallery',
    font: 'Microsoft YaHei',
    fontSize: 24,
    color: '#FF69B4',
    opacity: 0.9,
    position: 'bottomRight',
    category: 'custom'
  }),
  20
)
```

### 6.2 sidebar.item — 侧边栏项

向主侧边栏注入自定义导航项。

**响应结构**：

```typescript
{
  id: string                  // 项唯一 ID
  label: string               // 显示文本
  icon?: string               // 图标（SVG 字符串或图标名）
  view?: string               // 点击后切换到的视图标识
  order?: number              // 排序权重，数字越小越靠前
}
```

### 6.3 menu.context — 上下文菜单项

向右键菜单注入自定义菜单项。

**响应结构**：

```typescript
{
  id: string                  // 项唯一 ID
  label: string               // 显示文本
  visibleWhen?: (selectedCount: number, fileType?: string) => boolean
  action?: 'export' | 'delete' | 'custom'
}
```

### 6.4 editor.panel — 编辑面板

向编辑器注入自定义面板 tab。

**响应结构**：

```typescript
{
  id: string                  // 面板唯一 ID
  label: string               // tab 显示文本
  render?: (filePath: string) => React.ReactNode  // 面板渲染函数
}
```

> **注意**：`render` 字段在渲染进程消费时具体化为 `(filePath: string) => React.ReactNode`。

### 6.5 media.reader — 媒体读取器

扩展媒体文件读取能力（如支持新格式）。

### 6.6 media.writer — 媒体写入器

扩展媒体文件写入/导出能力（如支持新输出格式）。

---

## 7. 能力桥 API（window.pluginAPI）

能力桥通过受控 IPC 将主进程能力暴露给渲染进程插件。所有方法返回 `Promise`，调用前会校验插件是否声明了对应权限。

### 7.1 media — 媒体能力

**所需权限**：`media:read` / `media:write` / `media:delete`

```typescript
window.pluginAPI.media.read(filePath: string): Promise<Record<string, unknown> | null>
window.pluginAPI.media.list(filter?: {
  accountUid?: string
  albumType?: string
  limit?: number
  offset?: number
}): Promise<Array<Record<string, unknown>>>
window.pluginAPI.media.write(
  targetDir: string,
  data: ArrayBuffer | string,
  fileName: string
): Promise<string>
window.pluginAPI.media.delete(filePaths: string[]): Promise<{ deleted: number }>
```

### 7.2 db — 数据库能力（受限）

**所需权限**：`db:query`

```typescript
window.pluginAPI.db.query<T = unknown>(
  sql: string,            // 仅允许 SELECT 语句
  params?: unknown[]      // 参数化查询值
): Promise<T[]>
```

**约束**：

- 仅允许 `SELECT` 语句，其他 SQL（INSERT/UPDATE/DELETE/DDL）会被拒绝
- 表名必须在白名单内（媒体表、标签表等只读表）

### 7.3 fs — 文件系统能力（受 pathGuard 约束）

**所需权限**：`fs:read` / `fs:write`

```typescript
window.pluginAPI.fs.read(filePath: string): Promise<ArrayBuffer>
window.pluginAPI.fs.write(
  filePath: string,
  data: ArrayBuffer | string
): Promise<{ written: number }>
```

**约束**：

- 路径必须在 pathGuard 白名单内（用户媒体目录、导出目录、插件自身目录）
- 越权路径会被拒绝并抛出 `IpcError`

### 7.4 watermark — 水印能力

**所需权限**：`watermark:apply`

```typescript
window.pluginAPI.watermark.apply(
  config: unknown,          // 水印配置（结构由 WatermarkService 定义，插件层不感知具体类型）
  filePaths: string[],        // 待处理的文件路径列表
  targetDir: string           // 输出目录
): Promise<{
  success: boolean
  processed: number
  failed?: number
  message?: string
}>
```

### 7.5 task — 任务进度

**所需权限**：`task:progress`

```typescript
window.pluginAPI.task.progress(
  taskId: string,
  current: number,
  total: number,
  phase?: string
): Promise<{ reported: boolean }>
```

### 7.6 i18n — 国际化（同步）

**所需权限**：无（所有插件可用）

```typescript
window.pluginAPI.i18n.t(
  key: string,
  options?: Record<string, unknown>
): string
```

**说明**：

- 复用 NikkiGallery 渲染进程的 i18next 实例
- 插件可在 `package.json.nikkiGallery.i18n` 指定自己的 i18n 资源目录
- 未加载完成时返回原 key（不抛错）

---

## 8. 插件管理 facade API（window.pluggableElectronIpc）

由 pluggable-electron facade 自动暴露。**当前仅暴露两个只读查询方法**——插件管理界面（安装 / 卸载 / 更新 / 启停）统一走 `window.electronAPI.plugin`（见下），变更类操作已刻意不通过 facade 暴露（主进程侧对应的 pluggable 路由也已摘除）：

```typescript
interface PluggableElectronIpc {
  getActive(): Promise<unknown> // pluggable:getActivePlugins
  updatesAvailable(plugin: unknown[]): Promise<unknown> // pluggable:updatesAvailable
}
```

NikkiGallery 在此基础上封装了更高层的管理 API（`window.electronAPI.plugin`）：

```typescript
interface PluginManagementAPI {
  list(): Promise<PluginFullInfo[]>
  detail(name: string): Promise<PluginFullInfo>
  install(specifiers: string[]): Promise<PluginFullInfo[]>
  uninstall(name: string): Promise<PluginFullInfo[]>
  toggleActive(name: string, active: boolean): Promise<PluginFullInfo>
  checkUpdate(name: string): Promise<{ name: string; latestVersion: string | false }>
  update(name: string): Promise<{ name: string; success: boolean }>
  getPluginsPath(): Promise<string>
  reportError(name: string, errorMessage: string): Promise<{ success: boolean }>
}
```

---

## 9. 权限清单

| 权限标识          | 说明                                | 能力桥 IPC 通道                           |
| ----------------- | ----------------------------------- | ----------------------------------------- |
| `media:read`      | 读取媒体文件元数据与内容            | `plugin:media.read` / `plugin:media.list` |
| `media:write`     | 写入/导出媒体文件                   | `plugin:media.write`                      |
| `media:delete`    | 删除媒体文件（走回收站）            | `plugin:media.delete`                     |
| `db:query`        | 受限数据库查询（白名单表）          | `plugin:db.query`                         |
| `fs:read`         | pathGuard 白名单内文件读取          | `plugin:fs.read`                          |
| `fs:write`        | pathGuard 白名单内文件写入          | `plugin:fs.write`                         |
| `watermark:apply` | 应用水印（复用 WatermarkService）   | `plugin:watermark.apply`                  |
| `task:progress`   | 接入 TaskScheduler 上报进度         | `plugin:task.progress`                    |
| `ui:sidebar`      | 注册侧边栏项                        | 仅渲染进程，无需 IPC                      |
| `ui:menu`         | 注册上下文菜单项                    | 仅渲染进程                                |
| `ui:editor`       | 注册编辑面板 tab                    | 仅渲染进程                                |
| `ipc:register`    | 注册自定义 IPC 通道（仅主进程插件） | 主进程 ipcMain                            |

**权限校验流程**：

1. 插件调用 `window.pluginAPI.*` 时，IPC handler 通过 `event.senderFrame.url` 推断调用方插件名
2. 从插件 `package.json.nikkiGallery.permissions` 读取声明的权限清单
3. 校验请求的权限是否在清单内，不在则抛出 `IpcError(forbidden)`
4. 路径操作额外走 pathGuard 白名单校验

---

## 10. 安全与沙箱

### 10.1 沙箱分层模型

| 层级 | 机制                      | 说明                                                                                                                   |
| ---- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| L1   | Electron 渲染进程安全配置 | `contextIsolation: true` + `nodeIntegration: false` + `sandbox: true`                                                  |
| L2   | pluggable-electron facade | facade 仅暴露只读查询（getActive / updatesAvailable），管理变更走受控的 `electronAPI.plugin` IPC；渲染进程无 Node 权限 |
| L3   | NikkiGallery 权限声明     | 插件 package.json 声明 permissions（缺省为 `[]`），能力桥调用前校验                                                    |
| L4   | pathGuard 路径白名单      | 文件操作受限于白名单目录                                                                                               |

### 10.2 安全建议

- **仅安装可信来源的插件**：插件代码在渲染进程执行，恶意插件可能影响应用稳定性
- **最小权限原则**：只申请必要的权限
- **路径校验**：插件不应尝试访问用户媒体目录之外的路径
- **错误处理**：插件 init 抛异常会被捕获并标记为错误状态，不影响其他插件

### 10.3 IpcError 错误类

能力桥调用失败时抛出 `IpcError`：

```typescript
class IpcError extends Error {
  readonly code: string // 错误码，如 'FORBIDDEN' / 'NOT_FOUND' / 'IPC_MALFORMED_RESPONSE'
  readonly userMessage?: string // 用户可读的错误消息
  readonly details?: unknown // 错误详情
}

// 使用示例
try {
  await window.pluginAPI.media.read('/path/to/file')
} catch (err) {
  if (err instanceof window.IpcError) {
    console.error(`[${err.code}] ${err.message}`)
    if (err.code === 'FORBIDDEN') {
      // 权限不足
    }
  }
}
```

---

## 11. 完整示例

完整示例见 [`plugins-samples/custom-watermark-template/`](../plugins-samples/custom-watermark-template/)，包含：

- 3 个水印模板（节日纪念图片水印、个人签名文字水印、当日日期戳动态水印）
- 资源文件引用（`import.meta.url` 解析）
- i18n 资源目录
- 完整的 package.json 声明

### 11.1 资源路径解析

插件引用自身资源时，使用 `import.meta.url` 解析相对路径：

```javascript
// ✅ 正确：使用 import.meta.url
const imagePath = new URL('./templates/festival.svg', import.meta.url).pathname

// ❌ 错误：相对路径在打包后失效
const imagePath = './templates/festival.svg'
```

### 11.2 动态响应

扩展响应函数可在每次调用时动态生成内容：

```javascript
extensionPoints.register(
  'watermark.template',
  'my-plugin:datestamp',
  () => {
    const now = new Date()
    return {
      id: 'mp-date',
      name: '当日日期',
      type: 'text',
      text: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
      color: '#FFFFFF',
      opacity: 0.85,
      position: 'bottomLeft',
      category: 'custom'
    }
  },
  30
)
```

### 11.3 调用能力桥

```javascript
export function init(extensionPoints) {
  // 注册一个使用水印能力桥的扩展
  extensionPoints.register(
    'watermark.template',
    'my-plugin:batch-apply',
    async () => {
      try {
        const result = await window.pluginAPI.watermark.apply(
          { text: { content: '© Plugin', color: '#FF69B4', opacity: 80 }, position: 'bottomRight' },
          ['C:/path/to/file1.jpg', 'C:/path/to/file2.jpg'],
          'C:/output/dir'
        )
        console.info(`处理完成: ${result.processed}/${result.processed + (result.failed ?? 0)}`)
      } catch (err) {
        console.error('水印应用失败:', err)
      }
      return null
    },
    40
  )
}
```

---

## 12. 调试与排障

### 12.1 开发调试

1. **打包测试**：在插件目录执行 `npm pack`，用生成的 `.tgz` 安装到 NikkiGallery
2. **目录直装**：pluggable-electron 支持直接从目录安装，便于开发期调试
3. **DevTools**：应用菜单 → 查看 → 切换开发工具，查看插件 console 输出
4. **插件目录**：`%APPDATA%/wxnn-photo-manager/plugins/`（Windows），可直接查看插件文件

### 12.2 常见问题

| 问题                     | 原因                               | 解决方案                                                          |
| ------------------------ | ---------------------------------- | ----------------------------------------------------------------- |
| 插件 init 未执行         | `activationPoints` 未包含 `'init'` | 在 package.json 添加 `"activationPoints": ["init"]`               |
| 扩展点响应未显示         | 扩展名未以 `'pluginName:'` 为前缀  | 修改扩展名格式                                                    |
| 能力桥调用抛 `FORBIDDEN` | 插件未声明对应权限                 | 在 package.json 的 `nikkiGallery.permissions` 添加权限            |
| 资源路径错误             | 未使用 `import.meta.url`           | 改用 `new URL('./path', import.meta.url).pathname`                |
| 插件状态显示"错误"       | init 函数抛异常                    | 检查 DevTools console，修复异常                                   |
| 重启后插件状态丢失       | 注册表写入失败                     | 检查 `%APPDATA%/wxnn-photo-manager/plugins/.plugin-registry.json` |

### 12.3 日志位置

- 应用日志：`%APPDATA%/wxnn-photo-manager/logs/`
- 插件注册表：`%APPDATA%/wxnn-photo-manager/plugins/.plugin-registry.json`
- 插件文件：`%APPDATA%/wxnn-photo-manager/plugins/<plugin-name>/`

### 12.4 开发者检查清单

发布插件前，请检查：

- [ ] `package.json` 字段完整（name / version / main / activationPoints / nikkiGallery）
- [ ] `nikkiGallery.engines` 与目标 NikkiGallery 版本兼容
- [ ] `nikkiGallery.permissions` 仅声明必要权限（最小权限原则）
- [ ] 插件入口导出 `init(extensionPoints)` 函数
- [ ] 注册的扩展名以 `'pluginName:'` 为前缀
- [ ] 资源路径使用 `import.meta.url` 解析
- [ ] init 函数内的异常被捕获或上抛（上抛会被框架捕获，不影响其他插件）
- [ ] dispose 函数清理了插件自身的资源（定时器、监听器等）
- [ ] 通过 `npm pack` 打包测试安装流程
- [ ] 在 NikkiGallery 中启用/禁用/卸载流程均正常

---

## 附录：参考资源

- [pluggable-electron 官方文档](https://github.com/dutchigor/pluggable-electron)
- [示例插件源码](../plugins-samples/custom-watermark-template/)

> 早期的《NikkiGallery 插件系统设计文档》已从仓库移除（该文件从未入仓，无归档副本），设计要点已并入本文档。
