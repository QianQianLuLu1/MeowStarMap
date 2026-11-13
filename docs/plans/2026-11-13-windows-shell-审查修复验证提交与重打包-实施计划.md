# 2.5.7-beta Windows-Shell 批次审查修复、全量验证、提交与重打包实施计划

> 状态：**已获用户批准，逐节点执行中**。
> 路径前缀：`ROOT = D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe`；`UP = D:/Workbuddy 项目/WXNN YD - 副本/NikkiSync`。
> 本计划取代 `docs/plans/2026-11-13-nikkisync-windows-shell-full-align-实施计划.md` 中「禁止 git add / git commit / 禁止打包 / 禁跑 build、e2e:smoke」的上一轮会话约束（该约束仅限上一轮）；本轮用户明确要求审查修复后提交并重打包。
> 上游基准与产物层沿用上一轮：UP HEAD `a49764bbf98fcb26a84f2356b78d48c459d3da2e`（v1.0.40-public-beta.2），本轮不重做产物层。

---

## 0. 背景、审查范围与结论

### 0.1 范围

- HEAD = `5b0ec43`；上次打包锚点 `5ea9546`。已提交未打包 commit：`9b1ea80`（回收站孤儿页分页/错误文案/测试保真度）、`eda2464`（本地图标判据统一 + 打包闸门 + 产物门控）、`5b0ec43`（DEVELOPMENT.en 版本号同步）。
- 未提交改动：Windows-Shell 能力全量对齐批次（39 改 + 19 新文件），含 `src/main/app/shell/` 14 模块、6 个默认关闭 opt-in 能力、9 条新 IPC 通道 + 1 事件推送、yauzl 依赖、公钥 PEM 资产、12 语言包 18 新键。
- 现有 `release/` 产物（2026-11-13 14:03/14:04）比 43 个源文件旧，不含本批次功能 ⇒ e2e:smoke 必须在重打包后执行（用户已裁决）。

### 0.2 审查结论（主代理逐文件精读 + 两个探索代理取证）

合格项：G1/G2/G4/G5/G7 接线、诊断脱敏（sanitizeAggregate 剔除路径/UID/摘要）、RSA 验签 fail-closed、Zip-Slip 防护、原子激活回滚、测试质量（合成 3072-bit RSA 夹具 + 真实 store-method ZIP）、核心路径授权注释、i18n 键对齐、装载链 26 artifacts / 30 roots。

确认问题 F1–F9（本计划 §5 逐项修复）：

| 编号 | 问题                                                                                                       | 证据                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| F1   | 网络修复伪成功：开启开关后恒返回 `repaired`（生产从不枚举防火墙规则）                                      | `src/main/app/shell/shell-ipc.ts:84-89` + `network-conflict-repair.ts:58` |
| F2   | shell-status 观测失真：`localPhotoResolverActive` 硬编码 false、`trayActive` 读设置开关而非实际托盘        | `shell-ipc.ts:49-55` vs `src/shared/types/electron-api.ts` DTO 注释       |
| F3   | 热点按钮只关不开：UI 恒发 `confirm` 缺省 ⇒ requested=false                                                 | `src/renderer/pages/sync-gallery/SyncServicePage.tsx` SyncShellSection    |
| F4   | G3 安装根缓存只读不写：`game-install-root.txt` 全仓无写入点                                                | `runtime-facade.ts` readCachedInstallRoot；grep 确认                      |
| F5   | `decodeLocalPhotoRawTexts` 的 FileSystemError 未携带 cause（违反约定 §2）                                  | `src/main/services/decryption-service.ts` catch 块                        |
| F6   | 文档失真：AGENTS.md 三处「尚未纳入版本控制」括注、IPC_CONTRACT §8.x 失败码列与实现不符                     | `src/main/nikkisync/AGENTS.md:208/235/237`、`docs/IPC_CONTRACT.md` §8.x   |
| F7   | UI 直接渲染英文 status 码；ja/ko/fr/de/es/pt/ru/th/vi 9 包 18 键英文占位                                   | SyncServicePage `{status}`；locales 实测                                  |
| F8   | 下载器未逐跳重校验重定向（fetch 自动跟随）、无 ≤6 跳限制、arrayBuffer 整包缓冲后才查限量、206 未校范围起点 | `src/main/app/shell/https-download.ts`                                    |
| F9   | `applyIconDelta` 未校验 `update.json.files[]`（数量/path/sha256/size）                                     | `src/main/app/shell/icon-pack-update-client.ts:149-152`                   |

明确不修（记录在案）：签名 feed/程序更新/支持网关生产接线保持诚实桩（私钥/CNB 凭据/网关不在本仓，上轮用户裁决默认 OFF）；program-check 与 stage 同调、support-submit 未传 report 载荷属桩语义；xdelta3.exe gitignored 随包不入仓（`.gitignore:204`，与 DLL 同策略）；托盘开关运行期切换需重启生效（不加设置监听，最小化）；`9b1ea80` 的 CHANGELOG 既有条目无短哈希属历史行，保留不改。

### 0.3 F4 方向修正（上游证据，推翻任务书原方向）

上游 `GameDiscoveryReport`（UP `apps/pc-companion/src/game-directory-discovery.ts:13-23`）**不含安装根**（只有 found/source/checkedDirectories/registryHints/shortcutHints/driveRoots/windowsProbeFailed/searchLimited/elapsedMs），且回调在 installation 返回之前触发。上游真实回写判据在 UP `apps/pc-companion/src/windows-app.ts:221-224`（已逐字核实）：

```ts
const installRoot = runtime.scanner.getStatus().installation?.installRoot
if (installRoot) {
  try {
    writeFileSync(GAME_ROOT_CACHE_FILE, `${installRoot}\n`, 'utf8')
  } catch {
    /* best-effort startup cache */
  }
}
```

⇒ 本仓对齐实现 = 会话面 `cacheInstallRoot()` + manager 在 `scanner.start()` 成功后调一次（§5 F4）。

### 0.4 环境基线（实测）

- 当前会话 `node -v` = v26.3.0（满足 probe.test.ts ≥24 与上游构建要求，无需切 PATH）。
- 版本号在 package.json:3 / package-lock / README / DEVELOPMENT(.en) / ARCHITECTURE(.en) / CHANGELOG 节均已是 **2.5.7-beta** ⇒ 幂等确认，预计零改动。
- `npm install` 会剪掉 `node_modules/@nikkisync` 4 条 junction ⇒ 装后必须 `npm run link:nikkisync` 恢复并双确认。

---

## 1. 依赖声明

**本轮零新增依赖**。批次内已含 `yauzl ^3.4.0`（运行时，只读 ZIP）+ `@types/yauzl ^2.10.3`（dev），package.json / package-lock.json 已在工作区。`npm install` 仅幂等安装；装后核对 `git diff --stat package.json package-lock.json` 无批次外漂移。

非 npm 资产：`resources/nikkisync/pc/signing/update-public-key.pem`（634 B，SHA256 `c3faae9168387fbafc8e2f0bbb4965a49c0d952b7ea650cf5dbf4dffc5897197`，3072-bit RSA SPKI，仅公钥）随本批入仓；`resources/nikkisync/xdelta3.exe`（340992 B，SHA256 `732980d52f9220dc81817ccdd0c295eadce8a0048a24c2a771a73f791ac824e9`）gitignored 在盘，经既有 `extraResources` `*.exe` 随包，不入仓。

## 2. 启动与运行说明

```bash
cd "D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe"
node -v                      # v26.3.0
npm install                  # 幂等；会剪 junction
npm run link:nikkisync       # 恢复 4 条 junction
npm run link:nikkisync:check # 4 条 ok + check OK
npm run verify:nikkisync     # OK (blocking failures: 0)、26 artifacts / 30 roots、dangling=[]
```

逐修复节点：`npx vitest run <定向文件>`（红灯实测失败 → 最小修复 → 复跑绿）→ 必要时 `npm run typecheck`。
全量验证与打包命令表见 §6。开发启动 `npm run dev`（本轮不作 GUI 人工验收，GUI 判据标「未人工复核」）。

## 3. 错误处理

- F1：生产 dispatch 无防火墙枚举能力 ⇒ 诚实 `{status:'unavailable', reason}`，绝不伪成功；`runRepair` 纯函数语义保留供未来接线。
- F2：观测键缺省 false（无 facts / 老链接缺面），不伪造；`status()` 纯 getter 不引入重 IO。
- F4：缓存回写 best-effort——写失败 `options.onWarning` + manager `deps.log('warn')`，不中断启动；无安装根 no-op（不写空、不删旧缓存）。
- F5：`FileSystemError` 携带原始 cause（cause 不跨 IPC，`toJSON` 剥除，仅供主进程日志）；message 不含本机路径。
- F8：重定向 >6 跳 / 非白名单 / 降级 http / 缺 location ⇒ fail-closed 抛错；流式累计超限即抛 + `reader.cancel()`；206 范围起点不符 ⇒ `'Download range mismatch'`。
- F9：files 清单任一不符 ⇒ 整包拒绝（`'Invalid delta entry'`），先于任何写盘。
- 日志统一 `logger`/`runtimeLog`/`deps.log`，消息英文（中文硬编码护栏 error）；禁止 console.log。

## 4. 参数校验

- F2：`getShellStatus(settings, facts?)` facts 两键均 `?? false`；会话面 `localPhotoResolverActive?.()` 可选调用，缺面键不下发。
- F4：installRoot 必须非空字符串且 ≤4096 才写；读侧既有 trim + 4096 上限咬合；写入格式 `${installRoot}\n` 逐字对齐上游。
- F8：`DownloadOptions.expectedSize?` 可选；`parseContentRange(value, offset, expectedSize?)` 第三参改可选（全仓无其他消费方，已核实）；offset 必须非负整数；limit 必须正有限数。
- F9：`meta.files` 必须数组；`length === files.size - 2`；逐项 path 字符串、过 `isAllowedIconPath`、非 JSON 条目、Set 去重、在 files Map 中存在；sha256 64 hex 且等于实读哈希（toLowerCase 比对）；size 整数且等于实长。
- F7：status/event 码走封闭键集 + `defaultValue` 兜底原码（未知码不崩溃、不伪造翻译）。

## 5. 基础测试用例与逐任务三要素（TDD 红→绿）

通则：每项先写红灯测试并**实测失败**，再最小修复，再复跑绿；不得跳过/弱化/删除测试。正常/异常/边界三类覆盖如下。

### F1 网络修复伪成功

- 涉及文件：`src/main/app/shell/shell-ipc.ts`；测试 `src/main/app/shell/shell-capabilities.test.ts`。
- 输入/输出：`runShellAction('network-repair', {}, allOn)` → `{status:'unavailable', reason:string}`（前 `{status:'repaired',changed:0}`）。
- 红灯：`expect(await runShellAction('network-repair', {}, allOn, vi.fn())).toEqual({status:'unavailable', reason:expect.any(String)})`；边界：allOff 仍 `{status:'disabled'}` 保绿。
- 验收：`npx vitest run src/main/app/shell/shell-capabilities.test.ts` 0 failed。

### F5 FileSystemError cause

- 涉及文件：`src/main/services/decryption-service.ts`；测试 `src/main/services/decryption-service.test.ts`。
- 输入/输出：不存在文件 + 合法 uid/sha ⇒ reject FileSystemError 且 `cause.code==='ENOENT'`。
- 红灯：`rejects.toMatchObject({name:'FileSystemError', cause:expect.objectContaining({code:'ENOENT'})})`（前 cause undefined）。
- 验收：`npx vitest run src/main/services/decryption-service.test.ts` 0 failed。

### F2 shell-status 真实观测透传链

- 涉及文件：`src/main/app/shell/tray-lifecycle.ts`（增 `isTrayActive()`）、`src/main/nikkisync/runtime-facade.ts`（会话面 `localPhotoResolverActive: () => hasLocalPhotoResolver`）、`src/main/nikkisync/runtime-types.ts`（Session 可选 `localPhotoResolverActive?: () => boolean`；Status 可选 `localPhotoResolverActive?: boolean`）、`src/main/nikkisync/runtime-manager.ts`（status() session 分支透出）、`src/main/app/shell/shell-ipc.ts`（getShellStatus 加 facts 参）、`src/main/ipc/handlers/nikkisync-handler.ts`（传 facts）、`src/shared/types/electron-api.ts`（DTO 注释订正）。
- 红灯（4 处）：isTrayActive 随 syncTray/disposeTray 变化；`getShellStatus(allOff,{trayActive:true,localPhotoResolverActive:true})` 两键 true；`getShellStatus(allOn)` 无 facts ⇒ trayActive false；facade 夹具挂 localPhotoMetadata+decodeLocalPhotoRawTexts ⇒ `session.localPhotoResolverActive!()===true`、裸夹具 false；manager FakeSession 挂面 ⇒ status 透出、缺面键不存在；handler 桩 + 真实 syncTray ⇒ 通道两键 true。
- 验收：`npx vitest run src/main/app/shell/shell-capabilities.test.ts src/main/nikkisync/runtime-facade.test.ts src/main/nikkisync/runtime-manager.test.ts src/main/ipc/handlers/nikkisync-handler.test.ts && npm run typecheck` 全绿。

### F4 安装根缓存回写

- 涉及文件：`src/main/nikkisync/runtime-facade.ts`（fs import 补 writeFileSync；会话面 `cacheInstallRoot`，仅 gameRootCacheFile 给出时挂键）、`src/main/nikkisync/runtime-types.ts`（Session 可选 `cacheInstallRoot?: () => void`）、`src/main/nikkisync/runtime-manager.ts`（scanner.start() 成功支 recordStage('runtime-ready') 后 try/catch 调用）。
- 输入/输出：scannerStatus.installation.installRoot='C:/Games/InfinityNikki' ⇒ 文件内容 `'C:/Games/InfinityNikki\n'`；无 installation ⇒ 不写；目标为目录 ⇒ 不抛 + onWarning 一次。
- 红灯：facade 三例（前面 undefined）；manager 计数（start 成功 1 / degraded 0 / 抛错 warn 且 state 仍 running）。
- 验收：`npx vitest run src/main/nikkisync/runtime-facade.test.ts src/main/nikkisync/runtime-manager.test.ts && npm run typecheck`；链接态加跑 `runtime-facade.linked.test.ts` 无回归。

### F3 热点按钮交替请求

- 涉及文件：`src/renderer/pages/sync-gallery/SyncServicePage.tsx`；测试 `src/renderer/pages/sync-gallery/SyncServicePage.test.tsx`。
- 输入/输出：首点 `toggleHotspot({confirm:true})`；status==='toggled' 才翻转 hotspotOn；失败不翻转。
- 红灯：首点期望 `{confirm:true}`（前 `{}`）；成功后再点 `{confirm:false}`；失败形态连点两次均 `{confirm:true}`。
- 验收：`npx vitest run src/renderer/pages/sync-gallery/SyncServicePage.test.tsx` 0 failed。

### F7 status 本地化 + 9 包真译文

- 涉及文件：`SyncServicePage.tsx`（shellStatusText）、12 个 `src/renderer/i18n/locales/*.json`、`src/renderer/i18n/locales/sync-service-keys.test.ts`、`SyncServicePage.test.tsx`。
- 新键 14 个：`shell.status.{disabled,unavailable,confirmation-required,failed,submitted,invalid-receipt,toggled,unsupported-action,staged,error}` + `shell.event.{checking,downloading,staged,rolled-back}`。
- 红灯：LEAVES 扩容后 12 包等集必红；9 包 18 旧键逐键 `not.toBe(en 同键值)`（当前逐字相等）；页面点图标检查后 `findByText('功能不可用')` 且 `queryByText('unavailable')` null。
- 验收：`npx vitest run src/renderer/i18n/locales/sync-service-keys.test.ts src/renderer/pages/sync-gallery/SyncServicePage.test.tsx && npm run i18n:guard && npm run i18n:check` 全绿。

#### F7a 新键 14 个的 12 包值

status（键序 disabled/unavailable/confirmation-required/failed/submitted/invalid-receipt/toggled/unsupported-action/staged/error）：

- zh-CN：功能未启用/功能不可用/需要二次确认/操作失败/已提交/回执无效/已切换/不支持的操作/已暂存/发生错误
- zh-TW：功能未啟用/功能不可用/需要二次確認/操作失敗/已提交/回執無效/已切換/不支援的操作/已暫存/發生錯誤
- en：Disabled/Unavailable/Confirmation required/Failed/Submitted/Invalid receipt/Toggled/Unsupported action/Staged/Error
- ja：無効/利用不可/確認が必要/失敗/送信済み/無効な受領書/切り替え済み/非対応の操作/ステージ済み/エラー
- ko：비활성화됨/사용 불가/확인 필요/실패/제출됨/잘못된 영수증/전환됨/지원되지 않는 작업/스테이징됨/오류
- fr：Désactivé/Indisponible/Confirmation requise/Échec/Envoyé/Reçu invalide/Basculé/Action non prise en charge/Préparé/Erreur
- de：Deaktiviert/Nicht verfügbar/Bestätigung erforderlich/Fehlgeschlagen/Gesendet/Ungültiger Beleg/Umgeschaltet/Nicht unterstützte Aktion/Bereitgestellt/Fehler
- es：Desactivado/No disponible/Confirmación requerida/Fallido/Enviado/Recibo no válido/Alternado/acción no compatible/Preparado/Error
- pt：Desativado/Indisponível/Confirmação necessária/Falhou/Enviado/Recibo inválido/Alternado/Ação não suportada/Preparado/Erro
- ru：Отключено/Недоступно/Требуется подтверждение/Сбой/Отправлено/Недействительная квитанция/Переключено/Неподдерживаемое действие/Подготовлено/Ошибка
- th：ปิดใช้งาน/ไม่พร้อมใช้งาน/ต้องยืนยัน/ล้มเหลว/ส่งแล้ว/ใบรับไม่ถูกต้อง/สลับแล้ว/การกระทำที่ไม่รองรับ/เตรียมไว้แล้ว/ข้อผิดพลาด
- vi：Đã tắt/Không khả dụng/Cần xác nhận/Thất bại/Đã gửi/Biên nhận không hợp lệ/Đã chuyển/Hành động không được hỗ trợ/Đã chuẩn bị/Lỗi

event（键序 checking/downloading/staged/rolled-back）：

- zh-CN：正在检查…/正在下载…/已暂存/已回滚
- zh-TW：正在檢查…/正在下載…/已暫存/已回滾
- en：Checking…/Downloading…/Staged/Rolled back
- ja：確認中…/ダウンロード中…/ステージ済み/ロールバック済み
- ko：확인 중…/다운로드 중…/스테이징됨/롤백됨
- fr：Vérification…/Téléchargement…/Préparé/Restauré
- de：Prüfung läuft…/Download läuft…/Bereitgestellt/Zurückgerollt
- es：Comprobando…/Descargando…/Preparado/Revertido
- pt：Verificando…/Baixando…/Preparado/Revertido
- ru：Проверка…/Загрузка…/Подготовлено/Откачено
- th：กำลังตรวจสอบ…/กำลังดาวน์โหลด…/เตรียมไว้แล้ว/ย้อนกลับแล้ว
- vi：Đang kiểm tra…/Đang tải xuống…/Đã chuẩn bị/Đã khôi phục

#### F7b 9 包 18 旧键真译文（zh-CN/zh-TW/en 不动）

键序：title, description, icon.title, icon.check, icon.current, program.title, program.check, program.notes, support.title, support.submit, network.repair, network.hotspot, toggle.iconUpdate, toggle.programUpdate, toggle.tray, toggle.support, toggle.networkRepair, toggle.hotspot。其中 icon.title=toggle.iconUpdate、program.title=toggle.programUpdate、support.title=toggle.support、network.hotspot=toggle.hotspot、icon.check=program.check（同值复用）。

| 键                                   | ja                                                                                                 | ko                                                                                                          | fr                                                                                                   | de                                                                                                  | es                                                                                                         | pt                                                                                                  | ru                                                                                                    | th                                                                                                  | vi                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| title                                | Windows シェル機能                                                                                 | Windows 셸 기능                                                                                             | Fonctionnalités shell Windows                                                                        | Windows-Shell-Funktionen                                                                            | Funciones de shell de Windows                                                                              | Recursos de shell do Windows                                                                        | Возможности оболочки Windows                                                                          | ความสามารถเชลล์ Windows                                                                             | Tính năng shell Windows                                                                |
| description                          | 上游 PC 端シェル機能。デフォルトはすべてオフ。有効にする前に入手元が信頼できるか確認してください。 | 업스트림 PC 셸 기능입니다. 기본적으로 모두 꺼져 있으며, 활성화하기 전에 출처가 신뢰할 수 있는지 확인하세요. | Fonctionnalités shell PC amont. Toutes désactivées par défaut ; vérifiez la source avant activation. | Upstream-PC-Shell-Funktionen. Standardmäßig alle deaktiviert; vor dem Aktivieren die Quelle prüfen. | Funciones de shell de PC upstream. Todas desactivadas por defecto; verifica la fuente antes de activarlas. | Recursos de shell do PC upstream. Todos desativados por padrão; verifique a origem antes de ativar. | Возможности оболочки ПК из upstream. По умолчанию все выключены; перед включением проверьте источник. | ความสามารถเชลล์ PC จากต้นทาง ปิดทั้งหมดโดยค่าเริ่มต้น โปรดยืนยันแหล่งที่มาว่าเชื่อถือได้ก่อนเปิดใช้ | Tính năng shell PC từ upstream. Mặc định tắt tất cả; hãy xác minh nguồn trước khi bật. |
| icon.title / toggle.iconUpdate       | 署名付きアイコンパック差分                                                                         | 서명된 아이콘 팩 델타                                                                                       | Delta signé du pack d'icônes                                                                         | Signiertes Icon-Paket-Delta                                                                         | Delta firmado del paquete de iconos                                                                        | Delta assinado do pacote de ícones                                                                  | Подписанная дельта пакета значков                                                                     | ส่วนต่างแพ็กไอคอนที่ลงนาม                                                                           | Bản delta gói biểu tượng có chữ ký                                                     |
| icon.check / program.check           | 更新を確認                                                                                         | 업데이트 확인                                                                                               | Rechercher des mises à jour                                                                          | Nach Updates suchen                                                                                 | Buscar actualizaciones                                                                                     | Verificar atualizações                                                                              | Проверить обновления                                                                                  | ตรวจสอบการอัปเดต                                                                                    | Kiểm tra cập nhật                                                                      |
| icon.current                         | 現在のアイコンパック                                                                               | 현재 아이콘 팩                                                                                              | Pack d'icônes actuel                                                                                 | Aktuelles Icon-Paket                                                                                | Paquete de iconos actual                                                                                   | Pacote de ícones atual                                                                              | Текущий пакет значков                                                                                 | แพ็กไอคอนปัจจุบัน                                                                                   | Gói biểu tượng hiện tại                                                                |
| program.title / toggle.programUpdate | プログラム差分更新                                                                                 | 프로그램 차등 업데이트                                                                                      | Mise à jour différentielle du programme                                                              | Differenzielles Programm-Update                                                                     | Actualización diferencial del programa                                                                     | Atualização diferencial do programa                                                                 | Дифференциальное обновление программы                                                                 | การอัปเดตโปรแกรมแบบส่วนต่าง                                                                         | Cập nhật chương trình dạng delta                                                       |
| program.notes                        | リリースノート                                                                                     | 릴리스 노트                                                                                                 | Notes de version                                                                                     | Versionshinweise                                                                                    | Notas de la versión                                                                                        | Notas da versão                                                                                     | Примечания к выпуску                                                                                  | บันทึกประจำรุ่น                                                                                     | Ghi chú phát hành                                                                      |
| support.title / toggle.support       | 匿名診断                                                                                           | 익명 진단                                                                                                   | Diagnostics anonymes                                                                                 | Anonyme Diagnose                                                                                    | Diagnósticos anónimos                                                                                      | Diagnósticos anônimos                                                                               | Анонимная диагностика                                                                                 | การวินิจฉัยแบบไม่ระบุตัวตน                                                                          | Chẩn đoán ẩn danh                                                                      |
| support.submit                       | 診断を送信                                                                                         | 진단 제출                                                                                                   | Envoyer les diagnostics                                                                              | Diagnose senden                                                                                     | Enviar diagnósticos                                                                                        | Enviar diagnósticos                                                                                 | Отправить диагностику                                                                                 | ส่งข้อมูลการวินิจฉัย                                                                                | Gửi chẩn đoán                                                                          |
| network.repair                       | ネットワーク競合を修復                                                                             | 네트워크 충돌 복구                                                                                          | Réparer le conflit réseau                                                                            | Netzwerkkonflikt beheben                                                                            | Reparar conflicto de red                                                                                   | Reparar conflito de rede                                                                            | Устранить сетевой конфликт                                                                            | ซ่อมแซมความขัดแย้งเครือข่าย                                                                         | Sửa xung đột mạng                                                                      |
| network.hotspot / toggle.hotspot     | 一時ホットスポット                                                                                 | 임시 핫스팟                                                                                                 | Point d'accès temporaire                                                                             | Temporärer Hotspot                                                                                  | Punto de acceso temporal                                                                                   | Hotspot temporário                                                                                  | Временная точка доступа                                                                               | ฮอตสปอตชั่วคราว                                                                                     | Điểm phát sóng tạm thời                                                                |
| toggle.tray                          | システムトレイ                                                                                     | 시스템 트레이                                                                                               | Barre d'état système                                                                                 | Systemtray                                                                                          | Bandeja del sistema                                                                                        | Bandeja do sistema                                                                                  | Системный трей                                                                                        | ถาดระบบ                                                                                             | Khay hệ thống                                                                          |
| toggle.networkRepair                 | ネットワーク競合修復                                                                               | 네트워크 충돌 복구                                                                                          | Réparation des conflits réseau                                                                       | Netzwerkkonflikt-Reparatur                                                                          | Reparación de conflictos de red                                                                            | Reparação de conflitos de rede                                                                      | Устранение сетевых конфликтов                                                                         | การซ่อมแซมความขัดแย้งเครือข่าย                                                                      | Sửa xung đột mạng                                                                      |

### F8 https-download 加固

- 涉及文件：`src/main/app/shell/https-download.ts`；测试 `shell-capabilities.test.ts`。
- 改法：`redirect:'manual'` + 循环 ≤6 跳逐跳 `requireHttpsUrl`（相对跳转按当前 URL 解析）；offset>0 用 parseContentRange 校 206 起点；流式 getReader 累计限量 + finally cancel；DownloadOptions 增 expectedSize?。
- 红灯（注入 fetchImpl，正常/异常/边界）：302→白名单 200 resolve；302→evil.example / http 降级 ⇒ 'Invalid https URL'；恒 302 ⇒ 'Too many redirects'；有限流 256×64KiB + limit 1024 ⇒ 超限且 pull≤4/cancel 被调；offset=5 + `bytes 0-9/10` ⇒ 'Download range mismatch'；正常 206 `bytes 5-9/10` 保绿。
- 验收：`npx vitest run src/main/app/shell/shell-capabilities.test.ts && npm run typecheck`。

### F9 applyIconDelta files 清单校验

- 涉及文件：`src/main/app/shell/icon-pack-update-client.ts`；测试 `shell-capabilities.test.ts`（复用 makeZip）。
- 红灯：正常夹具（manifest+webp+update.json files 实算）resolve 保绿；`files:[]` / sha 篡改 / size 不符 / path '../evil.webp' / path 不存在条目 / files 非数组 ⇒ 修复前均 resolve 必红。
- 验收：`npx vitest run src/main/app/shell/shell-capabilities.test.ts` 0 failed。

### F6 文档订正

- 涉及文件：`src/main/nikkisync/AGENTS.md`（:208/:235/:237 三处括注）、`docs/IPC_CONTRACT.md`（§8.x 失败码列如实化）、`src/shared/types/electron-api.ts`（:1247 注释枚举）。
- 验收：`npm run docs:links` exit 0 + `npx vitest run scripts/__tests__/check-md-links.test.ts`（前提：两份计划 MD 已早暂存）。

## 6. 执行顺序与全量验证命令表

B-0 基线（node -v / git status / HEAD）→ B-1 本计划落档 + `git add` 两份计划 MD（仅暂存）→ B-2 npm install + junction 恢复三步 → B-3 逐修复 TDD（F1→F5→F2→F4→F3→F7→F8→F9→F6）→ B-4 定向大子集 → B-5 全量 12 项 → B-6 @core-change 原因行替换 → B-7 三次提交 → B-8 dist:win → B-9 e2e:smoke → B-10 读数 → B-11 回写提交。

| #   | 命令                                                               | 通过判据                                                         |
| --- | ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| 1   | `npm run build`                                                    | exit 0；dist/main/main/app/index.js + dist/main/preload.js 存在  |
| 2   | `npm test`                                                         | 0 failed；≥519 files / ≥8408 passed 只增不减；skip≈20 门控设计内 |
| 3   | `npm run typecheck`                                                | exit 0                                                           |
| 4   | `npm run typecheck:e2e`                                            | exit 0                                                           |
| 5   | `npm run test:ci-linux`                                            | 0 failed；posix 装置 linked skip 属预期，记录 skip 数            |
| 6   | `npm run lint`                                                     | exit 0 / 0 error                                                 |
| 7   | `npm run format:check`                                             | exit 0                                                           |
| 8   | `npm run i18n:guard`                                               | exit 0                                                           |
| 9   | `npm run i18n:check`                                               | 12 包 missing/extra 均 0                                         |
| 10  | `npm run verify`                                                   | 5 项全绿、core-gate ✓                                            |
| 11  | `npm run audit`                                                    | exit 0；离线失败如实记 not-run，不 --force                       |
| 12  | `npm run docs:links` + `verify:nikkisync` + `link:nikkisync:check` | 全绿 / blocking 0 / 4 ok                                         |
| 13  | `npm run dist:win`                                                 | exit 0；exe 时间戳刷新；latest.yml version=2.5.7-beta            |
| 14  | `npm run e2e:smoke`                                                | 21 passed / 0 failed（新 win-unpacked；需桌面会话）              |

提交切分：commit 1 `feat(nikkisync): Windows-Shell 能力全量对齐与审查修复收口`（全批次 + 修复 + PEM + 两份计划 MD）；commit 2 `docs(changelog): 补录 eda2464/5b0ec43 与 Windows-Shell 对齐批次条目`（新行只写短哈希，不写 docs/plans 路径；[Unreleased] 零条目）；commit 3 `docs(changelog): 回写 2.5.7-beta 重打包产物读数（<commit1 短哈希> 轮）`。版本 2.5.7-beta 幂等确认（预计零改动）。

## 7. 剩余风险 / 记录在案项

1. 签名私钥 / CNB 上传 / 支持网关服务端不在本仓：对应通道诚实 unavailable，本轮不做真实网络验签。
2. GUI 未人工复核：托盘、热点、SyncServicePage 新分区 12 语言仅代码级 / i18n 守卫 / 组件测试通过。
3. xdelta3.exe 与 74 MiB 图标资产 gitignored 在盘随包；新克隆需按上游流程重建。
4. 托盘开关运行期切换需重启生效（syncTray 仅 init 调用）。
5. e2e 需桌面会话解锁；不可用时如实记 not-run 并暂停，不在旧产物上冒名顶替。
6. npm install 剪 junction：B-2 三步恢复是硬前置，skip 数与基线比对防假绿。
7. pre-commit 会改写文件（eslint --fix / prettier --write）；钩子失败时提交未发生，修复后新建提交，绝不 --amend。
8. 回退纪律：提交前回归只回退该修复 hunk，严禁整批 reset --hard / checkout .；提交后新提交修正，不 force、不 push。

## 8. 验收记录（实测回写）

| 节点                    | 红灯（实测失败）                                                 | 绿灯（实测通过）                                                                               | 关键读数                                                                                                                                                                |
| ----------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B-1 落档                | —                                                                | plan-pin `11 passed`                                                                           | 两份计划 MD 早暂存；批次新文件早暂存后 docs:links 无死引用                                                                                                              |
| B-2 依赖                | —                                                                | install exit 0；4 junction ok；verify:nikkisync blocking 0                                     | 26 artifacts / 30 roots / 87 modules；lock 仅批次内 yauzl 加法                                                                                                          |
| F1                      | `1 failed`（返回 repaired 伪成功）                               | shell 套件 `23 passed`                                                                         | network-repair 开启恒 unavailable                                                                                                                                       |
| F5                      | `1 failed`（cause undefined）                                    | decryption 套件 `94 passed`                                                                    | ENOENT cause 携带；非法 uid 前置拒绝保绿                                                                                                                                |
| F2                      | `6 failed`（4 文件：shell 2 / facade 2 / manager 1 / handler 1） | 4 文件 `306 passed` + typecheck 0                                                              | isTrayActive + 会话观测面 + status 透传 + facts 接线                                                                                                                    |
| F4                      | `4 failed`（facade 2 / manager 2）                               | facade+manager+linked `194 passed` + typecheck 0                                               | 回写格式 `${installRoot}\n` 逐字对齐上游；degraded 不写；抛错只 warn                                                                                                    |
| F3                      | `2 failed`（恒发 {}）                                            | 页面套件 `77 passed`                                                                           | confirm 交替；toggled 才翻转；失败不翻转                                                                                                                                |
| F7                      | `10 failed`（9 包占位 + 1 页面原码）                             | keys+页面 `100 passed`；i18n:guard ✅；i18n:check ✅                                           | 14 新键 ×12 包；9 包 18 键真译文；4317 keys 对齐                                                                                                                        |
| F8                      | `6 failed`（重定向/限量/Range）                                  | shell 套件 `32 passed` + typecheck 0                                                           | ≤6 跳逐跳白名单；流式 pull≤4+cancel；206 起点校验                                                                                                                       |
| F9                      | `6 failed`（异常清单均放行）                                     | shell 套件 `39 passed` + typecheck 0                                                           | files 数量/path/sha256/size 整包校验，先于写盘                                                                                                                          |
| F6                      | —                                                                | docs:links ✅ 无死引用；check-md-links 契约绿                                                  | AGENTS 三处括注 / IPC_CONTRACT 失败码列 / DTO 注释订正                                                                                                                  |
| F10（全量验证额外发现） | ci-linux `1 failed`（旧库升级用例 `git -C` 收到装置假路径）      | 真宿主 linked 套件 `20 passed`；ci-linux 复跑 `518 passed \| 1 skipped`（519 files，0 failed） | eda2464 新增用例经 args 传上游根，而装置只翻译 `options.cwd`（tests/mocks/ci-linux-child-process.ts 设计）；改经 cwd 下传（与 -C 语义等价，断言逐字不动，非 skip/弱化） |
| B-4 子集                | —                                                                | `43 files / 944 passed`                                                                        | shell+nikkisync+decryption+handler+preload+sync-gallery+i18n+脚本守卫                                                                                                   |
| 版本确认                | —                                                                | 全承载位 2.5.7-beta，零改动                                                                    | package.json/lock×2/DEVELOPMENT×2/ARCHITECTURE×2/README 徽章（shields 转义 2.5.7--beta）；2.5.6 仅历史叙述残留                                                          |

（B-5 全量验证、提交、dist:win、e2e:smoke 与产物读数待回写。）
