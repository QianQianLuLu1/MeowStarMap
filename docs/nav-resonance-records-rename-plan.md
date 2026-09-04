# 计划：侧边栏第四板块 `nav.resonanceRecords` 命名修复为「共鸣录」

## 0. 问题定位（已完成的现状调查）

- 侧边栏导航项定义于 `src/renderer/components/layout/Sidebar.tsx:33-43`，第 4 项为
  `{ id: 'resonance-records', labelKey: 'nav.resonanceRecords', icon: <IconMessage /> }`
  （顺序：图库 / 截图 / 收藏 / **共鸣记录位** / 缓存 / 分类 / 重复文件 / 回收站 / 设置）。
- `src/renderer/components/layout/AppShell.tsx:117` 状态栏同样引用 `t('nav.resonanceRecords')`。
- **根因**：全部 12 个语言包中 `nav.resonanceRecords` 键缺失（提交 `05a180d` 把翻译放在了
  `appShell.viewStatus.resonanceRecords` 下，未同步到 `nav` 段）。i18next 对缺失 key 的默认
  行为是原样返回 key 字符串，因此界面当前显示的是原始文本 `nav.resonanceRecords`。
- **修复策略（复用优先）**：在 12 个语言包的 `nav` 段补上 `resonanceRecords` 键，值直接复用
  同文件中已存在的 `appShell.viewStatus.resonanceRecords` 现成翻译（zh-CN 为「共鸣录」），
  不自造任何文案，不改任何组件代码、不新增依赖。
- 现有工具链 `npm run i18n:check` 仅校验 12 文件 key 对齐（各文件同样缺失故一直未报），
  `i18n:guard` 亦未覆盖此场景，故需补一个数据级单测防回归。

## 1. 依赖声明

| 依赖           | 说明                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| Node.js ≥ 18   | 仓库现有要求（electron-vite / tsx 均依赖），本任务编辑脚本用 Node 内置 `fs`，零新增                       |
| 无新增 npm 包  | 不安装任何依赖；复用 i18next 现有解析、vitest、tsx、prettier、eslint 现有工具链                           |
| 语言包文件 ×12 | `src/renderer/i18n/locales/{zh-CN,zh-TW,en,ja,ko,fr,de,es,pt,ru,th,vi}.json`（结构 key 对齐，各 3594 键） |

## 2. 启动说明

```bash
# 依赖已就绪（node_modules 已存在）；若全新环境先执行
npm install

# 开发模式启动（Electron 桌面窗口，用于 T4 人工/截图验收）
npm run dev

# 本任务用到的验证命令
npx vitest run src/renderer/i18n/locales/nav-resonance-records.test.ts   # T2 新增单测
npm run i18n:check        # 12 文件 key 对齐校验（仓库自带）
npm run typecheck         # tsc -b
npx prettier --check "src/renderer/i18n/locales/*.json"
npx eslint src/renderer/i18n/locales/nav-resonance-records.test.ts
```

## 3. 子任务

### T1 数据修复：12 个语言包补齐 `nav.resonanceRecords`

- **修改文件**：`src/renderer/i18n/locales/` 下全部 12 个 `*.json`（每个文件仅在 `nav` 段
  `recycleBin` 行后插入 1 行，其余内容零改动）。
- **输入**：各文件自身 `appShell.viewStatus.resonanceRecords` 的现值（即复用的翻译源）。
- **输出**：各文件 `nav.resonanceRecords` 键存在且值与同文件 `appShell.viewStatus.resonanceRecords`
  一致。预期值：zh-CN=共鸣录、zh-TW=共鳴錄、en=Resonance、ja=共鳴録、ko=공명록、
  fr=Résonance、de=Resonanz、es=Resonancia、pt=Ressonância、ru=Резонанс、
  th=บันทึกเรโซแนนซ์、vi=Cộng Hưởng。
- **参数校验（写入前）**：编辑脚本在内存中完成"读取 → 定位 nav 段 → 取复用值"；
  若某文件 `appShell.viewStatus.resonanceRecords` 缺失或为空字符串，或 nav 段定位失败，
  立即中止且不写任何文件，打印失败清单。
- **错误处理**：插入后先在内存中 `JSON.parse` 回读并断言（键存在、值非空、12 文件键总数
  从 3594 → 3595），全部断言通过才落盘；任一失败则该文件不写入并报错退出（非 0 退出码）。
  脚本为一次性 `node -e` 内联执行，不新增仓库脚本文件。
- **验收标准**：
  1. 校验脚本输出 12/12 文件断言通过，退出码 0；
  2. `npm run i18n:check` 通过（12 文件 3595 键对齐）；
  3. `git diff --stat` 显示仅 12 个 locale JSON 各 +1 行，无其他文件改动。

### T2 基础测试用例：防回归数据级单测

- **新增文件**：`src/renderer/i18n/locales/nav-resonance-records.test.ts`
  （vitest include 规则 `./src/**/*.test.ts` 自动收录，无需改配置）。
- **输入**：12 个 locale JSON 模块导入。
- **输出**：三条断言组——
  1. 全部 12 语言包均有非空 `nav.resonanceRecords`；
  2. `zh-CN` 的 `nav.resonanceRecords === '共鸣录'`（本次需求的强约束）;
  3. 每个语言的 `nav.resonanceRecords` 与该文件 `appShell.viewStatus.resonanceRecords` 一致（复用不变式，防止后续两处漂移）。
- **错误处理**：断言失败时 vitest 报出具体语言文件名与实际值，退出码非 0。
- **验收标准**：`npx vitest run src/renderer/i18n/locales/nav-resonance-records.test.ts`
  全部通过（12 文件 × 断言组），无 skip。

### T3 回归验证（每项通过后才进入 T4）

- **修改文件**：无（纯验证步骤）。
- **验收标准**（全部退出码 0）：
  1. `npx vitest run src/renderer/i18n/locales/nav-resonance-records.test.ts`；
  2. `npm run i18n:check`；
  3. `npm run typecheck`；
  4. `npx prettier --check "src/renderer/i18n/locales/*.json"`；
  5. `npx eslint src/renderer/i18n/locales/nav-resonance-records.test.ts`。

### T4 启动验收

- **修改文件**：无。
- **输入**：`npm run dev` 启动的 Electron 应用窗口。
- **输出/验收标准**：侧边栏自上而下第 4 项显示「共鸣录」（不再是 `nav.resonanceRecords`
  原始 key）；选中该项后底部状态栏右侧同样显示「共鸣录」；其余 8 个导航项文案不变；
  界面无 console 报错弹窗。

## 4. 影响范围与不改动项

- 只新增 1 个 i18n 键（×12 文件）+ 1 个测试文件；**不改** `Sidebar.tsx`、`AppShell.tsx`
  及任何组件/主进程代码——`appShell.viewStatus.resonanceRecords`、`resonance.*` 段等既有
  键一律不动，避免波及共鸣记录页与状态栏其他文案。
- 英文等其他语言的侧边栏文案随复用值显示对应翻译（如 English=Resonance），属同一缺失键
  的直接修复范围。

## 5. 验证纪律

- 每个子任务只做一次审查/运行验证，验证项如上文明确列出；无严重缺陷即通过并推进，
  不对同一产出反复追加验证轮次。
