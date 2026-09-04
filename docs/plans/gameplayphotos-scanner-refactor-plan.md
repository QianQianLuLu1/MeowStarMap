# 无限暖暖相册扫描器GamePlayPhotos适配改造实施方案

> 核心目标：将游戏内官方相册主扫描路径从`X6Game\ScreenShot`切换为`X6Game\Saved\GamePlayPhotos\`，实现多UID账号隔离、原生缩略图复用，ScreenShot路径独立归类为本地截图，不改动其他无关功能。

---

## 1. 依赖声明

- 全部复用项目既有依赖，**不引入任何新依赖**：
  - `better-sqlite3`：主进程数据库操作，复用现有迁移、查询逻辑
  - `tinyglobby`：目录遍历与签名搜索，复用现有mock测试能力
  - `vitest`：测试框架，复用既有mock + 真实in-memory db双模式
  - `zod`：参数校验，复用现有schema定义规范
- 参考开源项目RanAxro/nikki_albums的GamePlayPhotos目录规范，不自造业务规则。

---

## 2. 启动与运行说明

```powershell
# 1. 安装依赖（使用增量安装，禁止删除node_modules或npm ci）
cd "H:\<username>\Documents\WXNN XiangCe2"
npm install

# 2. 运行全部相关单测（scanner + database模块）
npx vitest run src/main/scanner src/main/database

# 3. 类型检查
npm run typecheck

# 4. 本地开发运行
npm run dev
```

- 首次启动会自动遍历所有磁盘，定位`InfinityNikki`安装目录，优先扫描`GamePlayPhotos`路径，自动完成UID目录识别、资源索引建立。
- 存量数据会自动通过新增的V6迁移脚本幂等修复，无需用户手动操作。

---

## 3. 改造子任务清单

### 子任务1 — 扫描路径优先级调整

- **修改文件**：`src/main/scanner/game-directory-discovery.ts`
- **输入**：现有安装树签名规则、媒体文件夹签名列表
- **输出**：
  1. 移除`ScreenShot`作为游戏相册主扫描路径的优先级
  2. 新增`GamePlayPhotos`路径为游戏相册最高优先级扫描根
  3. 保留`ScreenShot`路径作为本地截图扫描路径，标记为独立分类
- **验收标准**：`game-directory-discovery.test.ts`全部通过，新增用例验证`GamePlayPhotos`路径优先级高于`ScreenShot`

### 子任务2 — UID目录遍历与账号隔离逻辑

- **修改文件**：`src/main/scanner/worker-entry.ts`、`src/main/database/media-repository.ts`
- **输入**：`GamePlayPhotos`根目录路径
- **输出**：
  1. 自动遍历所有纯数字命名的UID子目录，支持动态数量、动态名称
  2. 每个UID下的资源建立独立索引，关联对应账号UID
  3. 数据库新增`gameplay_uid`字段，不同UID资源完全隔离
- **验收标准**：`worker-entry.test.ts`新增用例验证多UID并行扫描逻辑，不同UID资源查询结果无混同

### 子任务3 — 原生缩略图复用逻辑

- **修改文件**：`src/main/scanner/thumbnail-generator.ts`、`src/main/scanner/path-classifier.ts`
- **输入**：`GamePlayPhotos/{uid}/NikkiPhotos_HighQuality`与`NikkiPhotos_LowQuality`目录路径
- **输出**：
  1. 识别到GamePlayPhotos路径时，跳过缩略图生成逻辑
  2. 直接关联`NikkiPhotos_LowQuality`目录下的原生低清图作为缩略图
  3. ScreenShot路径保留原有缩略图生成逻辑不变
- **验收标准**：`thumbnail-generator.test.ts`新增用例验证GamePlayPhotos路径无新增缩略图文件生成，ScreenShot路径缩略图生成正常

### 子任务4 — ScreenShot路径独立归类逻辑

- **修改文件**：`src/main/scanner/path-classifier.ts`、`src/main/database/media-repository.ts`
- **输入**：`X6Game\ScreenShot`路径下的文件
- **输出**：
  1. 该路径下所有资源统一分类为`local_screenshot`，不关联任何游戏UID
  2. 前端展示独立归类为「本地截图」板块，与游戏相册完全隔离
- **验收标准**：`path-classifier.test.ts`新增用例验证ScreenShot路径返回`local_screenshot`分类，前端本地截图板块仅展示该路径资源

### 子任务5 — 存量数据V6迁移脚本

- **修改文件**：`src/main/scanner/repair-legacy-data-v6.ts`（新建）、`src/renderer/i18n/locales/zh-CN.json`（新增日志key）
- **输入**：现有数据库`media_files`表数据
- **输出**：
  1. 将原ScreenShot路径下归类为`game`的资源迁移为`local_screenshot`
  2. 自动识别GamePlayPhotos路径下的资源，补全`gameplay_uid`字段
  3. 幂等执行，通过`schema_migrations`表标记`repair_legacy_data_v6`
- **验收标准**：`repair-legacy-data-v6.test.ts`全部通过，覆盖幂等早退、迁移逻辑、异常容错场景

### 子任务6 — 修复链接入

- **修改文件**：`src/main/scanner/worker-entry.ts`
- **输入**：现有修复链逻辑
- **输出**：在V5迁移之后追加V6迁移逻辑，修复链执行顺序为V2→V3→V4→V5→V6
- **验收标准**：`npm run typecheck`通过，scanner模块测试全部通过

### 子任务7 — 全量验证

- **验收标准**：
  1. `npx vitest run src/main/scanner src/main/database` → 全部用例通过
  2. `npm run typecheck` → 无类型错误
  3. 本地运行`npm run dev`，扫描测试用GamePlayPhotos目录，验证账号隔离、缩略图复用逻辑正常

---

## 4. 错误处理规范

| 位置                          | 错误场景                       | 处理方式                                     |
| ----------------------------- | ------------------------------ | -------------------------------------------- |
| `repair-legacy-data-v6.ts`    | `schema_migrations`表不存在    | 捕获异常降级为每次执行，不影响主流程         |
| `repair-legacy-data-v6.ts`    | 主查询`all()`抛错（如db lock） | `log error`并返回`false`，中断修复链后续步骤 |
| `repair-legacy-data-v6.ts`    | 标记迁移`INSERT`抛错           | 仅`log warn`并返回`true`，下次重复执行幂等   |
| `game-directory-discovery.ts` | GamePlayPhotos路径不存在       | 跳过该路径，继续扫描其他目录，无报错         |
| `worker-entry.ts`             | UID目录非数字命名              | 自动跳过，不纳入扫描范围                     |
| `thumbnail-generator.ts`      | 原生低清图不存在               | 降级使用高清图生成缩略图，无报错             |

---

## 5. 参数校验规则

- `repairLegacyDataV6(db, log)`：`db`需为`better-sqlite3.Database`实例，`log`需为`(level, message, ...args) => void`函数，内部仅修改路径匹配的记录，不触碰其他数据
- `scanGamePlayPhotos(rootPath)`：`rootPath`需为有效目录路径，非目录或不存在时返回空数组
- `classifyPath(path)`：路径命中`GamePlayPhotos`时，必须检查子目录是否为纯数字UID，否则按默认规则分类
- 所有数据库操作必须使用参数化查询，禁止SQL拼接，防止注入风险

---

## 6. 基础测试用例

| 模块                       | 用例                                                                               | 期望结果                                             |
| -------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `game-directory-discovery` | 同时存在GamePlayPhotos和ScreenShot路径时，优先返回GamePlayPhotos作为游戏相册扫描根 | 返回路径包含`GamePlayPhotos`，优先级高于ScreenShot   |
| `game-directory-discovery` | GamePlayPhotos路径不存在时，正常扫描其他路径                                       | 无报错，返回其他有效扫描根                           |
| `worker-entry`             | 扫描含多个UID目录的GamePlayPhotos路径                                              | 每个UID资源独立索引，关联对应UID                     |
| `worker-entry`             | UID目录含非数字命名文件夹                                                          | 跳过非数字目录，不扫描                               |
| `thumbnail-generator`      | 处理GamePlayPhotos路径下的资源                                                     | 无新增缩略图文件，直接关联NikkiPhotos_LowQuality路径 |
| `thumbnail-generator`      | 处理ScreenShot路径下的资源                                                         | 正常生成缩略图，无异常                               |
| `path-classifier`          | 路径为`GamePlayPhotos/12345/NikkiPhotos_HighQuality/xxx.png`                       | 返回`game`分类，关联UID=12345                        |
| `path-classifier`          | 路径为`X6Game/ScreenShot/xxx.png`                                                  | 返回`local_screenshot`分类，无UID                    |
| `repair-legacy-data-v6`    | 迁移已应用，再次执行                                                               | 直接返回true，不查询media_files表                    |
| `repair-legacy-data-v6`    | 原ScreenShot路径下归类为game的资源                                                 | 迁移为`local_screenshot`分类                         |
| `repair-legacy-data-v6`    | 主流程数据库异常                                                                   | 返回false，log输出error                              |
| `media-repository`         | 查询游戏相册资源                                                                   | 仅返回GamePlayPhotos路径下的资源，不同UID完全隔离    |

---

## 7. 总验收标准

1. 扫描优先级：游戏相册分类仅展示GamePlayPhotos路径下资源，ScreenShot路径资源不在游戏相册展示
2. 账号隔离：不同UID目录下资源完全独立，查询、展示无混同
3. 缩略图逻辑：GamePlayPhotos路径无新增缩略图文件，直接复用原生低清图，ScreenShot路径缩略图生成逻辑不变
4. 所有相关单元测试全部通过，类型检查无错误
5. 存量数据自动迁移完成，无用户手动操作门槛
