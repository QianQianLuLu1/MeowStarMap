# 共鸣录静态数据裁剪报告（T0 产物 + 卡池缩略图）

- 日期：2026-08-29
- 生成脚本：`scripts/generate-resonance-static-data.ts`、`scripts/generate-resonance-names.ts`、`scripts/copy-resonance-thumbnails.ts`
- 数据来源：gongeo.us-nikki-tracker（dastrokes，MIT License，已获授权）master 分支只读克隆
- 产物位置：`src/renderer/data/resonance/`（生成格式，已加入 `.prettierignore`）
- 快照元数据：`snapshot-meta.json`（gameVersion 2.9.1，catalog generatedAt 2026-08-28，percentile generatedAt 2026-03-15，latestBannerId 73）

## 1. 体积实测

| 产物                       | 来源（源仓库路径）                | 裁剪规则                                             | 实测体积                           |
| -------------------------- | --------------------------------- | ---------------------------------------------------- | ---------------------------------- |
| banners.json               | data/banners.ts（21KB）           | 原样转 JSON，73 卡池（常驻池 runs.end 快照为生成日） | 14,690 B                           |
| outfits.json               | data/outfits/（105 个 TS 合并）   | outfitId → items[] 单文件                            | 13,646 B                           |
| catalog/items.json         | public/catalog/items.json         | 逐字节原样                                           | 188,139 B                          |
| catalog/outfits.json       | public/catalog/outfits.json       | 逐字节原样                                           | 11,489 B                           |
| catalog/makeups.json       | public/catalog/makeups.json       | 逐字节原样                                           | 11,753 B                           |
| catalog/makeupItems.json   | public/catalog/makeupItems.json   | 逐字节原样                                           | 6,053 B                            |
| catalog/makeupOutfits.json | public/catalog/makeupOutfits.json | 逐字节原样                                           | 4,161 B                            |
| catalog/momo.json          | public/catalog/momo.json          | 逐字节原样                                           | 2,899 B                            |
| catalog/momoOutfits.json   | public/catalog/momoOutfits.json   | 逐字节原样                                           | 1,450 B                            |
| catalog/eurekas.json       | public/catalog/eurekas.json       | 逐字节原样                                           | 10,246 B                           |
| catalog/props.json         | public/catalog/props.json         | 逐字节原样                                           | 4,689 B                            |
| catalog/palettes.json      | public/catalog/palettes.json      | 逐字节原样（衣橱「共鸣色」颜色映射所需）             | 144,009 B                          |
| percentile.json            | data/percentile.json              | 原样                                                 | 1,690 B                            |
| snapshot-meta.json         | 生成脚本产出                      | 来源/许可/生成时间/游戏版本                          | 873 B                              |
| names/（12 语言）          | app/locales/ 提取                 | 仅保留产物数据中出现的实体 id                        | 合计 3,849,474 B                   |
| thumbnails/（73 张 PNG）   | public/images/banners/thumbnails/ | 逐字节拷贝 + 生成 index.ts 静态索引                  | 2.83 MB                            |
| **合计**                   |                                   |                                                      | **≈ 7.1 MB**（其中缩略图 2.83 MB） |

## 2. 字段取舍

- **names 包**：每语言含 `banner / outfit / item / makeup / momo / prop / eureka` 七段 id→名称映射 + meta；仅保留产物数据集中出现的实体 id（生成脚本执行期过滤），不携带源站完整词条。宿主 12 语言中 ru/th/vi 源无翻译 → 生成期复制英文包并标记 `isFallback`（加载器与 UI 据此回退英文，生成脚本与 meta 记 TODO）。
- **catalog 11 片**：保留压缩元组格式（`{v:1, t?, s?, r}` 或裸行），运行时由移植的 `catalogCompactFormat.ts` 解码器展开；**剔除 sketches**（85KB，地图宝箱坐标，四项功能不需要）。palettes 起初计划剔除，因衣橱「共鸣色（eureka color）」展示需要颜色映射且体积可控（144KB），纳入。
- **banners/outfits**：原字段全保留（保底/统计计算依赖 outfit4StarId/outfit5StarId/bannerType/runs）。
- **卡池缩略图**：仅取 `public/images/banners/thumbnails/`（73 张，39.7KB/张均值的整倍小图）；**禁用 `public/images/banners/` 原图（51MB，716KB/张）**；物品/套装立绘源仓库本就没有（运行时走游戏 CDN，不受 MIT 覆盖），衣橱维持纯文字模式。

## 3. 打包与运行时说明

- banners/outfits/thumbnails 索引静态 import 打进主 bundle；catalog/names/percentile/meta 动态 import 独立 chunk，按需懒加载（与宿主 i18n locale 同款机制）。
- 缩略图经生成索引 `thumbnails/index.ts`（静态 import ×73）取得打包内相对资源 URL（`base:'./'`），非外链、断网可用；未打包进 bundle 的调用方（当前为接入前的树摇状态）不受影响。
- 全部加载器带损坏/缺失降级：null（隐藏区块）/ 回退英文包 / 空包显示 itemId，绝不抛出到 UI 层。
- 数据更新：重新克隆源仓库 → 依序重跑三个生成脚本 → 提交产物；脚本幂等可重跑。

## 4. TODO

- ru/th/vi 名称包待源项目提供翻译后由生成脚本重新提取（当前回退英文，UI 可用）。
