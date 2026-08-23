# i18n 存量白名单现状快照

生成时间：2026-08-23（全量清偿完成）
白名单文件总数：0
中文硬编码违规总数：0
已清零（建议移除）：**0** 个

## 终态说明

2026-08-22 建立的 legacy 白名单（43 个文件 / 464 处硬编码中文，见 `whitelist-baseline.json`）
已于 2026-08-23 **全部修复出清**：

- `eslint.config.js` 中的 legacy warn 白名单块已删除，全部 `src/**/*.{ts,tsx}` 源码
  直接受 `no-restricted-syntax` 的 **error 级硬阻断**约束
- 修复方式（按 `fix-sop.md` 三分类）：
  - UI 文案 → `t()` / `i18n.t()`（渲染层组件走 `useTranslation()`，主进程走 `@main/i18n`，
    worker/utilityProcess 走 `worker-safe` 纯查表 t）
  - 日志 → `logger.info/warn/error(t('main.<模块>.log.<key>'))`
  - 数据值 / DB 标识 / 游戏专有名词 / 跨进程消息匹配子串 → 行内或数据块级
    `eslint-disable no-restricted-syntax` 豁免（附注释说明原因）
- 新增 key 全部先写入 `zh-CN.json`，经 `npm run sync-i18n-keys` 同步到其余 11 个语言包
  （空串占位，与既有惯例一致），`npm run i18n:check` / `npm run i18n:guard` 校验对齐

## 历史基线（仅供追溯，勿再更新）

> 下列为 2026-08-22 的初始快照，保留用于对照；守卫基准见 `whitelist-baseline.json`。

| 模块                   | 文件数 | 违规数 |
| ---------------------- | -----: | -----: |
| renderer/preview       |      2 |     71 |
| main/services          |      9 |     70 |
| main/media-worker      |      3 |     52 |
| renderer/components    |      4 |     43 |
| shared                 |      1 |     35 |
| main/scanner           |      6 |     30 |
| renderer/utils         |      2 |     27 |
| main/thumbnail         |      2 |     23 |
| renderer/pages         |      3 |     21 |
| renderer/stores        |      2 |     19 |
| main/video-editor      |      2 |     16 |
| main/decryption-worker |      1 |     14 |
| main/utils             |      1 |     14 |
| main/database          |      1 |     10 |
| renderer/search        |      1 |      8 |
| renderer/plugins       |      1 |      5 |
| renderer/i18n          |      1 |      4 |
| renderer/styles        |      1 |      2 |
