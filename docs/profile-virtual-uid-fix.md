# 档案管理：虚拟 UID 显示不符 + 删除失败 修复总结

> 日期：2026-08-26
> 模块：设置 → 档案管理 → 档案列表

## 一、问题现象

- 档案列表显示大量与真实检测路径不符的 UID（疑似虚拟数据）。
- 点击删除时一律提示「删除失败」。

## 二、根因定位

1. **删除失败（决定性根因）**：`preload/ipc.ts` 的 `call` 在 IPC 成功时返回 `res.data`（即 `{deleted:true}`），失败时**抛出 IpcError**。
   但 `ProfileManageSection.handleDeleteProfile`（`profile-sections.tsx`）按 `res.success` 判断成功——而解包后的 data 没有 `success` 字段，故 `res.success` 永远 `undefined` → 永远进入 `else` 分支 → 永远显示「删除失败」。**无论后端是否成功，UI 都误报失败。**
2. **虚拟 UID（显示不符）**：扫描阶段 `autoRegisterUid(extractUidFromPath(fullPath))` 把路径中匹配的 6–12 位数字目录段注册进 `character_profiles`，部分数字段并非真实账号 UID（如时间戳/活动 ID/嵌套数字目录），形成无对应媒体文件的「虚拟档案」。

## 三、修复方案与改动文件

| 文件                                               | 改动                                                                                                                                                                                                                  |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/database/media-repository.ts`            | `ProfileRow` 增加 `hasMedia`；`listProfiles` 通过 `media_files.account_uid` 派生 `hasMedia`（区分真实/虚拟档案）。`deleteProfileAndReassign` 对不存在 UID 已幂等（UPDATE 0 行 + DELETE 0 行仍成功）。                 |
| `src/renderer/stores/mediaStore.ts`                | `CharacterProfile` 接口增加 `hasMedia`，随 `loadProfiles` 透传。                                                                                                                                                      |
| `src/renderer/pages/settings/profile-sections.tsx` | ① 删除逻辑改为 `try/catch` 捕获真实 IpcError，显示真实错误消息（修复「删除失败」误报）；② 列表项对 `hasMedia=false && uid!=='default'` 显示「无媒体（虚拟）」徽标；③ 新增「清理虚拟档案」按钮，一键删除全部虚拟档案。 |
| `src/renderer/i18n/locales/zh-CN.json`、`en.json`  | 新增 `settings.profile.virtualBadge` / `cleanupVirtual` / `cleanupVirtualConfirm` / `noVirtual` / `cleanupDone` / `cleanupPartial`。其余 11 语言按 `fallbackLng:'zh-CN'` 自动回退中文。                               |

## 四、未改动项（工程决策）

- **未收紧 `extractUidFromPath` 通用契约**。该正则 `/[\\/](\d{6,12})[\\/]/` 被解密降级路径（`decryption-service.ts:995`）、历史数据修复（`repair-legacy-data-v1.ts:146`）及 57 处断言「任意数字目录=UID」的既有 characterization tests 依赖。收紧会破坏解密降级、历史修复与大量测试，回归风险超出当前问题范围。
- 改用**列表层 `hasMedia` 区分 + 一键清理虚拟档案**从用户视角彻底解决「显示不符 + 无法删除」，且不触碰无关功能。

## 五、验证结果

- `npx vitest run` 相关套件：**311 passed**（media-repository 159 / media 74 / profile-handler 5 / path-classifier 73）。
- 新增基础测试：`listProfiles` 派生 `hasMedia`；`deleteProfileAndReassign` 对不存在 UID 幂等；`profile:list` 透传 `hasMedia`。
- `read_lints`：**0 errors**。
- `npx electron-vite build`：**成功**（dist/main + dist/renderer 均生成）。

## 六、后续可选（非本次范围）

如要彻底停止新增虚拟 UID，建议在 `worker-entry` 方案二 `autoRegisterUid` 调用处增加「UID 段须为 `GamePlayPhotos` 一级子目录」的轻量校验，而非修改 `extractUidFromPath` 通用契约。
