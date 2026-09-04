# 活动时间轴版本数据修正计划

> 状态：**已执行完成**（2026-08-19）。本文件为计划文档，同时记录实际落地结果。

## 1. 背景与目标

相册软件「视图 → 活动时间轴」依据每张图片拍摄时间（`created_at`），通过游戏版本时间表把照片归入对应《无限暖暖》版本分组展示。

经核查，原 `src/renderer/utils/game-events.ts` 中的 `GAME_VERSIONS` 数据**严重失实且部分虚构**：

- 缺失 1.2 花焰季等版本；
- 版本主题名大量编造（如 "1.1 新春特别版"、"1.3 初春版"、"2.0 二周年"、"2.2 更新版"）；
- 仅收录到 2.3，缺 2.4–2.8；
- `GAME_EVENTS` 仅 2 条且名称/描述不准确。

目标：用**联网多源交叉核实**的真实版本表（1.0 探索季 → 2.8 黄金尘，共 19 个版本）替换数据，使「活动时间轴」按真实版本正确分类照片。

## 2. 复用策略（优先复用，避免自写）

- 版本数据**无权威开源 npm 库**可引用；经检索 GitHub / npm 无成熟现成数据源。
- 项目已有成熟的 `game-events.ts` 数据层 + `EventTimelineView.tsx` 渲染管线，分组逻辑（`findVersionByDate` / `getTimelineNodes` / `groupFilesByNode`）正确可复用。
- 因此采用**数据替换**策略：仅替换常量数组，不改逻辑、不改 UI、不引入新依赖。

## 3. 依赖声明

| 类型       | 内容                             | 说明                        |
| ---------- | -------------------------------- | --------------------------- |
| 运行时依赖 | 无新增                           | 沿用现有 React / TypeScript |
| 测试依赖   | `vitest`（已在 devDependencies） | 现有项目测试框架，无需新增  |
| 外部数据源 | 无（硬编码核实后的静态表）       | 避免运行时联网，离线可用    |

> 不引入任何第三方版本数据源 SDK，避免额外维护与网络依赖。

## 4. 启动 / 验证说明

```bash
# 进入项目根目录
cd "d:/Nikki Gallery/WXNN XiangCe"

# 运行本次改动的单元测试
npx vitest run src/renderer/utils/game-events.test.ts --reporter=basic
```

预期输出：`Test Files 1 passed (1)` / `Tests 19 passed (19)`。

> 说明：本机存在 Safe-Delete 网关，禁止 `npm run dist:win`；本次仅改数据与单测，无需打包。UI 验证可在 `npm run dev` 后切换「视图 → 活动时间轴」观察分组。

## 5. 参数校验

| 校验点             | 位置                                | 行为                               |
| ------------------ | ----------------------------------- | ---------------------------------- |
| 空日期字符串       | `findVersionByDate('')`             | 返回 `null`（归 unknown 分组）     |
| 无效日期           | `findVersionByDate('invalid-date')` | `new Date` 解析为 NaN，返回 `null` |
| 早于 1.0 的日期    | `findVersionByDate('2024-01-01')`   | 返回 `null`（unknown）             |
| 晚于最新版本的日期 | `findVersionByDate('2026-12-31')`   | 返回最新版本 2.8                   |
| 正好等于版本上线日 | `findVersionByDate('2025-04-29')`   | 归属该版本（1.5）                  |

`GAME_VERSIONS` 必须按 `startDate` 升序（测试断言），否则分组边界错误。

## 6. 错误处理

- 数据层为纯静态表，无异常抛出路径；分组失败时（无匹配版本）由 `groupFilesByNode` 归入 `unknown` 节点（i18n key `gallery.eventTimeline.unknownPeriodName/Desc`），不影响渲染。
- 测试层断言覆盖"最新版本之后的日期返回最新版本"等边界，防止数据漏更导致新照片全部掉入 unknown。

## 7. 真实版本数据（已核实，多源交叉验证）

数据来源：官方维护公告、B站WIKI、17173、百度百科、3DM、官方论坛；最近核实 2026-08-19。

| 版本 | 主题名         | 上线日期   |
| ---- | -------------- | ---------- |
| 1.0  | 探索季         | 2024-12-05 |
| 1.1  | 流星季         | 2024-12-30 |
| 1.2  | 花焰季         | 2025-01-24 |
| 1.3  | 传说季         | 2025-02-26 |
| 1.4  | 妄想季         | 2025-03-26 |
| 1.5  | 泡泡季         | 2025-04-29 |
| 1.6  | 天真季         | 2025-06-13 |
| 1.7  | 蓝泪季         | 2025-07-08 |
| 1.8  | 丹青季         | 2025-07-30 |
| 1.9  | 音乐季         | 2025-09-02 |
| 2.0  | 祷声起诸大地   | 2025-11-26 |
| 2.1  | 若生命如诗     | 2026-01-07 |
| 2.2  | 九色万相生     | 2026-01-30 |
| 2.3  | 予我无冕之心   | 2026-03-03 |
| 2.4  | 嘘！森林不必听 | 2026-03-27 |
| 2.5  | 万灵的归途     | 2026-04-24 |
| 2.6  | 潮汐尽头的明天 | 2026-05-29 |
| 2.7  | 千星所向的旅途 | 2026-06-24 |
| 2.8  | 黄金尘         | 2026-07-17 |

`GAME_EVENTS` 收录可明确查证起止日期的限时活动（开服预热、1.2 贺岁集市、2.8 主线终章下）。

## 8. 子任务清单（每步先验证通过再进入下一步）

### 子任务 1：重写 `GAME_VERSIONS`

- **修改文件**：`src/renderer/utils/game-events.ts`
- **输入**：上表 19 个真实版本（version / name / startDate 升序）
- **输出**：新的 `GAME_VERSIONS` 常量
- **验收标准**：`read_lints` 无错误；数组按 startDate 升序；字段完整（version/name/startDate 必填）。

### 子任务 2：补全 `GAME_EVENTS`

- **修改文件**：`src/renderer/utils/game-events.ts`
- **输入**：3 条可查证活动及其起止日期
- **输出**：新的 `GAME_EVENTS` 常量
- **验收标准**：每条含 name/startDate/endDate（YYYY-MM-DD），格式校验测试通过。

### 子任务 3：更新单元测试

- **修改文件**：`src/renderer/utils/game-events.test.ts`
- **输入**：新版本表与预期归属
- **输出**：更新断言（最新版本=2.8、新增 1.1/1.2/2.0/2.8 等归属用例）
- **验收标准**：逻辑断言与数据一致，无硬编码旧版本名。

### 子任务 4：运行并自修单测

- **命令**：`npx vitest run src/renderer/utils/game-events.test.ts --reporter=basic`
- **验收标准**：**19 passed (19)**，0 失败。
- **结果**：✅ 已通过。

## 9. 基础测试用例（已实装）

- `GAME_VERSIONS` 按时间升序、必填字段完整；
- `GAME_EVENTS` 必填字段（含 endDate）完整；
- `findVersionByDate`：空串/无效日期/早于 1.0 → `null`；
- `findVersionByDate`：等于上线日归属该版本、区间内归属正确版本（1.0/1.1/1.2/1.5/2.0/2.8）；
- `findVersionByDate('2026-12-31')` → `2.8`（最新版本边界）；
- `getTimelineNodes`：合并节点数 = 版本数 + 活动数、升序、type/key 正确。

## 10. 影响范围与约束

- **仅改动**：`src/renderer/utils/game-events.ts`、`src/renderer/utils/game-events.test.ts`。
- **不动**：`EventTimelineView.tsx`、`uiStore`、`i18n`、其他视图与逻辑文件。
- 版本名为游戏专有名词，直显，不重构 i18n key。
