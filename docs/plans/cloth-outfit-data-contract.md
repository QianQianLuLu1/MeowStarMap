# 搭配码（cloth diy share code）数据契约

> 冻结日期：2026-10-31 · 基线：`meow-star-map 2.5.6-beta`（本仓 `main` @ `9d25c73`）
> 配套：[2026-10-31-cloth-outfit-data-contract-实施计划.md](2026-10-31-cloth-outfit-data-contract-实施计划.md)
> 真相源分层：本仓代码（file:line 已核）＞ 本文档实采样本（2026-10-31 DLL 实抓，7 个有效码 + 1 个无效码）＞ 上游 RanAxro/nikki_albums main 分支源码（`cloth_diy_params.rs` / `converter.rs` / `decrypt.rs` / `serde_nuan5_json/{de,ser,ext_type}.rs`）
> 状态：阶段 0 交付物。本文冻结后，阶段 1+ 的结构化解析、名称/图标映射、缓存实现**必须**以 §3/§4/§5 为准；发现与本文冲突的实采事实时，先改本文再改代码。

---

## 1. 背景与范围

搭配码底层解码管道已通：主进程经 utilityProcess 子进程调 `nuan5_decryption.dll` 的 `cloth_diy_decode_network` 联网拉取搭配数据，结果在 `ShareCodeDecoderDialog` 以原始字符串截断展示。三个缺口：networkData 裸 JSON 未结构化、服饰 ID 无中文名/图标映射、无结果缓存。本文冻结前两者的数据契约与第三者的方案选型：

- **在范围内**：networkData 的真实线上形态（含非标准语法）、解码结果信封、服饰 ID 拆解公式、数据源选型与降级链、既有类型契约不一致清单。
- **不在范围内**：UI 改动、第三方数据源的实际接入代码、缓存实现（均属阶段 1+）。

## 2. 管道逐跳类型链（现状，零 JSON.parse）

```
DLL cloth_diy_decode_network（koffi，ClothDiyDecryptionResult = { status: uint32_t, bytes: CBytes{data,len,cap} }）
  → src/main/decryption-worker/worker-entry.ts:147-151   readCBytesToUtf8：原始字节 → UTF-8 字符串（唯一变换点）
  → src/main/decryption-worker/worker-protocol.ts:37     NETWORK_DECODE_RESULT payload.networkData?: string
  → src/main/decryption-worker/bridge.ts:235-240         透传（8s 硬超时在主进程侧，bridge.ts:36）
  → src/main/services/decryption-service.ts:277-306      decodeNetworkGraceful（网络失败优雅降级，不置 success=false）
  → src/main/services/decryption-service.ts:1195-1247    decodeClothDiyShareCode → ClothDiyDecodeResult
  → src/main/ipc/handlers/decrypt-handler.ts:79-103      通道 decrypt:decodeClothDiy，zod 校验 z.string().min(1).max(1024*1024)，原样透传
  → src/main/preload/api/decrypt.ts                      call<T>() 解包 IpcResponse
  → src/renderer/components/common/ShareCodeDecoderDialog.tsx:226-233   String(d.networkData).slice(0, 500) 截断展示
```

### 2.1 解码结果信封（IPC `decrypt:decodeClothDiy` 的 `data`）

```ts
{
  ok: boolean                    // = result.success
  data?: {
    timestamp?: number           // 本地提取，13 位毫秒 epoch（见 §3.4），网络失败时仍返回
    uidBytes?: string            // Buffer → hex 字符串（decrypt-handler.ts:96）；玩家 UID，敏感，勿入日志/文档明文
    networkData?: string         // DLL 原始 UTF-8 文本，可能是非法标准 JSON（见 §3.2）
  }
  message?: string               // = result.error；网络失败时为错误文案，success 仍为 true
}
```

### 2.2 三类失败形态

| 形态        | 触发                                                                            | 表现                                                                                                   | 代码锚点                                                       |
| ----------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| 无效码      | DLL `cloth_diy_share_code_from_code_str` 返回 null（本地校验不过：格式/校验和） | `{ ok: false, message: <invalidClothDiyCode 文案> }`，无 data                                          | decryption-service.ts:1234-1236；worker-entry.ts 对应 status=8 |
| 网络失败    | DLL `cloth_diy_decode_network` status≠0（如 10=NetworkError）或桥超时           | **优雅降级**：`{ ok: true, data: { timestamp, uidBytes }, message: <网络错误文案> }`，networkData 缺省 | decryption-service.ts:277-306, 1239-1246                       |
| worker 异常 | 子进程 JS 异常（合成 status=-1）/ 崩溃 / 未就绪                                 | 同上优雅降级；桥自动重启 worker                                                                        | worker-entry.ts:55；bridge.ts 崩溃重启策略                     |

DLL status 码表（decryption-service.ts:91-105，与上游 `decrypt.rs` 一致）：`0=Success, 1=NullPointer, 2=DataLenIsNotAMultipleOf16, 3=DecodingBase64Failed, 4=FindNoStartFlag, 5=FindNoEndFlag, 6=Io, 7=IllegalUTF8, 8=InvalidClothDiyShareCode, 9=NotNumberString, 10=NetworkError, 11=InvalidHomeBuildShareCode, 12=DeserializationFailed`；worker 侧另有合成码 `-1`（JS 异常）。

## 3. networkData 真实线上形态（2026-10-31 DLL 实采）

### 3.1 顶层结构

```json
{
  "Content": {
    "Content": {
      "PoseId": 123,                    // 可选；7/7 样本均未出现
      "patternData": <IdMap>,           // IdMap 自定义语法，见 §3.2；4/7 样本出现、3/7 整体缺省
      "wearingClothes": [1023100090],   // 必需；10 位服饰 ID 数组（§5）
      "wearingDIYInfos": <三态>,        // 数组 | 单对象 | 空对象 {}；7 样本：6 数组 + 1 空对象
      "nsHiddenData": <IdMap>           // IdMap 自定义语法；7/7 样本均未出现
    }
  }
}
```

外层固定双层 `"Content"` 包裹（对应上游 `NetDIYCustomData.content.content`）。**没有** report/retcode/data 之类的官方接口包装——剥包/解密全部发生在闭源 DLL 内部。

### 3.2 关键：`patternData`/`nsHiddenData` 是自定义 IdMap 语法，不是标准 JSON

线上原文（样本 `7jvw7qaFL6S#` 节选）：

```
"patternData":[:1020600092:0,1021830003:0,1029300004:0,...]
```

**`JSON.parse` 对含此字段的样本必然抛错**（7 样本实测：含 patternData 的 4 个全部 FAIL，不含的 3 个全部 OK）。该语法与上游自写反序列化器 `serde_nuan5_json::de`（`ID_MAP_TOKEN="IdMap"`，ext_type.rs）逐字节对应，其序列化器（ser.rs `IdMapSerializer`）与之互为镜像。精确 BNF：

```ebnf
idmap  ::= "[:]"                     (* 空表，唯一合法空形式；"[]" 非法 *)
         | "[:" entry ("," entry)* "]"
entry  ::= key ":" value             (* 冒号两侧允许空白 *)
key    ::= 裸整数                     (* 不带引号的 i64 token *)
value  ::= 裸数字 token
```

规则要点（全部有上游源码佐证）：

- `[` 之后**必须紧跟** `:`（`[:` 连写），否则报 `ExpectedColonAtStart`；
- 禁止尾逗号；空表是 `[:]` 而非 `[]`；
- 键为裸整数（无引号）——标准 JSON 对象形态 `{"1020600092":0}` **不能**被该解析器接受；
- `deserialize_any` 层面对 `[:` 前缀有同样的分派，因此 IdMap 语法在整个载荷里都是保留形态。

实测取值：4 个样本的 `patternData` 值全为 `0`（覆盖全部 worn clothes 或其子集）；`nsHiddenData` 未实测到。

**阶段 1+ 解析策略（据此冻结）**：不能直接 `JSON.parse`。两条等价路线，实现时任选其一并配单测：

1. **预归一化**：用容错扫描器（按上述 BNF，而非宽松正则——值理论上可为负数/多位数）把 `[:k:v,...]` 改写为 `{"k":v,...}` 后再 `JSON.parse`；
2. **直解**：按 BNF 手写极小解析器，与归一化共享同一份测试样本。

### 3.3 `wearingDIYInfos` 三态与 `CoreData` 五变体

三态（上游 `AdaptiveArray<NikkiDIY>`，serde untagged，`as_vec` 归一语义：Array→自身、Item→单元素数组、Empty→空数组）：

| 形态         | 线上样子              | 实测                       |
| ------------ | --------------------- | -------------------------- |
| 数组         | `[{...}, {...}]`      | 6/7 样本                   |
| 单对象 Item  | `{...}`（无数组包裹） | 未实测到，上游声明支持     |
| 空对象 Empty | `{}`                  | 1/7 样本（`1aOKp3A5MdA#`） |

元素结构（键名大小写严格照抄）：`TargetGroupID`、`CoreData`、`FeatureTag`、`TargetClothID`。

`CoreData` 为 untagged 五选一，按字段集合判别：

| 变体                           | 字段                                                                                                                     | 实测                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Hair（头发染色）               | `TargetColor0?{R,G,B,A}`、`ColorGridID0`、`TargetColor1?{R,G,B,A}`、`ColorGridID1?`、`RoughnessOffset`、`HairColorMode?` | ✅ 实测：`ColorGridID1: -1` 哨兵值（非 null、非缺省），`TargetColor1` 缺省，`RoughnessOffset: -0.03/0`，`HairColorMode: 1` |
| General（通用染色）            | `R`、`G`、`B`、`A`、`ColorGridID`                                                                                        | ✅ 实测（最多的一种，单样本最多 45 条）                                                                                    |
| SpecialEffect（特效）          | `ColorGridID`、`CoverDIYColor`                                                                                           | ❌ 未实测，按上游结构声明收录                                                                                              |
| PatternCreation（织纹）        | `ReplaceTextureID`、`OverridePatternA?`                                                                                  | ❌ 未实测，按上游结构声明收录                                                                                              |
| PatternCreationExt（织纹扩展） | `TilingData`                                                                                                             | ❌ 未实测，按上游结构声明收录                                                                                              |

实测观察值域（仅记录、不臆断语义）：`FeatureTag ∈ {1, 3, 6}`（6 恒伴随 Hair 变体）；`TargetGroupID ∈ 1..8`；浮点颜色分量精度约 12 位有效数字（如 `0.18116399645805`）。

上游 converter 层的兜底约定（阶段 1+ 对齐用）：`patternData`/`nsHiddenData` 查不到即 None；`nsHiddenData` 值 `==1` 才视为 true；Hair 无 `TargetColor0` 时颜色兜底全 0；织纹 `tiling` 无配对 Ext 条目时兜底 `1.0`（配对键 = `cloth_id * 100 + target_group_id`）。

### 3.4 `timestamp` 与本地字段

- `timestamp`：13 位**毫秒** epoch，语义为码的生成时间。验证：`1L2rCD6dkNp#` ts=1747397529100 → 2025-05-16（B 站评论同日）；`14GLcevF0MG#` ts=1749393097900 → 2025-06-08（评论同日）。
- `uidBytes`：9 字节 ASCII 数字串（玩家 UID），FFI 层经 `cloth_diy_share_code_uid_bytes` 提取，IPC 层转 hex。**敏感字段，文档与日志只允许掩码形态**（本文样本均已掩码）。

### 3.5 样本总表

| 码             | 来源                            | 字节数 | timestamp     | wearingClothes | DIY 条数(形态)  | 特有字段                                                      |
| -------------- | ------------------------------- | ------ | ------------- | -------------- | --------------- | ------------------------------------------------------------- |
| `1aOKp3A5MdA#` | B 站 av114464066113457 评论     | 164    | 1746579376800 | 9              | 0（Empty `{}`） | 最简形态                                                      |
| `1L2rCD6dkNp#` | 同上                            | 1419   | 1747397529100 | 13             | 7（数组）       | Hair+General 混合                                             |
| `14GLcevF0MG#` | 同上（楼中楼）                  | 354    | 1749393097900 | 5              | 1（数组）       | —                                                             |
| `1de5BbRvrzF#` | 同上（染色码，去 emoji 清洗后） | 6637   | 1760512695300 | 15             | 38（数组）      | patternData                                                   |
| `1gp9GLOI0gm#` | 同上（染色码）                  | 3711   | 1764305063300 | 17             | 20（数组）      | patternData                                                   |
| `1gpWCV7QrFj#` | 同上（染色码）                  | 7693   | 1764315013100 | 16             | 45（数组）      | patternData                                                   |
| `7jvw7qaFL6S#` | Reddit r/InfinityNikki          | 652    | 1766622438600 | 14             | 1（数组）       | patternData；境外帖源码在 CN 网络下亦可解码，未观察到区服拦截 |
| `zzzz#`        | 构造                            | —      | —             | —              | —               | 无效码：from_code_str 返回 null                               |
| `00000000000#` | 构造                            | —      | —             | —              | —               | 无效码：同上（本地完整性校验拒绝）                            |

### 3.6 样本原文（脱敏后全量附录；uid 掩码为前 4 后 2）

**样本 1：最简形态（无 DIY、无 patternData，`wearingDIYInfos` 为空对象三态）**

```
# code: 1aOKp3A5MdA#    captured_at: 2026-10-31T05:36:15.836Z
timestamp: 1746579376800    uid_hex_masked: 3130...33 (len=18)    network_status: 0 (Success)
{"Content":{"Content":{"wearingDIYInfos":{},"wearingClothes":[1023100090,1023710101,1023730101,1022600062,1023860042,1023750101,1023500101,1020840183,1023900101]}}}
```

**样本 2：Hair + General 混合 DIY（注意 `ColorGridID1: -1` 哨兵值与 `TargetColor1` 缺省）**

```
# code: 1L2rCD6dkNp#    captured_at: 2026-10-31T05:36:16.630Z
timestamp: 1747397529100    uid_hex_masked: 3130...34 (len=18)    network_status: 0 (Success)
{"Content":{"Content":{"wearingDIYInfos":[{"TargetGroupID":1,"CoreData":{"B":0.18116399645805,"ColorGridID":17,"R":0.064802996814251,"A":1,"G":0.078186996281147},"FeatureTag":1,"TargetClothID":1020600181},{"TargetGroupID":2,"CoreData":{"B":0.18116399645805,"ColorGridID":17,"R":0.064802996814251,"A":1,"G":0.078186996281147},"FeatureTag":1,"TargetClothID":1020600181},{"TargetGroupID":1,"CoreData":{"B":0.18116399645805,"ColorGridID":17,"R":0.064802996814251,"A":1,"G":0.078186996281147},"FeatureTag":3,"TargetClothID":1020600181},{"TargetGroupID":1,"CoreData":{"B":0.31991198658943,"ColorGridID":129,"R":0.30816900730133,"A":1,"G":0.30431100726128},"FeatureTag":1,"TargetClothID":1022500178},{"TargetGroupID":2,"CoreData":{"B":0.38350799679756,"ColorGridID":41,"R":0.2870579957962,"A":1,"G":0.40419900417328},"FeatureTag":1,"TargetClothID":1022500178},{"TargetGroupID":2,"CoreData":{"B":0.11162699759007,"ColorGridID":142,"R":0.15736000239849,"A":1,"G":0.11625999957323},"FeatureTag":3,"TargetClothID":1022500178},{"TargetGroupID":1,"CoreData":{"TargetColor0":{"R":0.29613798856735,"B":0.086499996483326,"A":1,"G":0.15896099805832},"ColorGridID0":3,"RoughnessOffset":-0.03,"ColorGridID1":-1,"HairColorMode":1},"FeatureTag":6,"TargetClothID":1020100165}],"wearingClothes":[1020100165,1020710055,1021410007,1023730178,1020600181,1023960165,1020850126,1020300180,1022500178,1020810033,1020820223,1021840004,1021200003]}}}
```

**样本 3：含 IdMap 自定义语法 patternData（标准 JSON.parse 必失败）**

```
# code: 7jvw7qaFL6S#    captured_at: 2026-10-31T05:37:00.698Z
timestamp: 1766622438600    uid_hex_masked: 3630...35 (len=18)    network_status: 0 (Success)
{"Content":{"Content":{"patternData":[:1020600092:0,1021830003:0,1029300004:0,1020730037:0,1020710121:0,1021500022:0,1021820003:0,1021200004:0,1020100090:0,1021410026:0,1020850062:0,1021750003:0,1020810033:0,1020840033:0],"wearingClothes":[1020840033,1020100090,1020710121,1021410026,1020730037,1020600092,1029300004,1020850062,1021500022,1021200004,1020810033,1021820003,1021830003,1021750003],"wearingDIYInfos":[{"TargetGroupID":1,"CoreData":{"TargetColor0":{"R":0.89626902341843,"B":0.28662699460983,"A":1,"G":0.32294499874115},"ColorGridID0":55,"RoughnessOffset":0,"ColorGridID1":-1,"HairColorMode":1},"FeatureTag":6,"TargetClothID":1020100090}]}}}
```

**样本 4：无效码**

```
# code: zzzz#    captured_at: 2026-10-31T05:36:16.781Z
from_code_str: null（无效码，DLL 未构造对象；对应 status=8 InvalidClothDiyShareCode 的本地形态）
```

**样本 5：断网形态【代码推导、未实采】**

按 `decryption-service.ts:277-306`（decodeNetworkGraceful）与 `:1239-1246` 的代码路径推导：DLL 返回 status=10（NetworkError）→ 主进程桥返回网络错误文案 → 最终 IPC 结果为

```json
{
  "ok": true,
  "data": { "timestamp": 1746579376800, "uidBytes": "<hex>" },
  "message": "<网络解码失败文案（STATUS_MESSAGES[10] 或 networkUnavailable/networkTimeout）>"
}
```

即 `success=true` 与 `error` 并存、`networkData` 缺省。实采背景：本机实测 DLL 自带 DNS 查询（绕过 hosts），Windows 防火墙程序级出站拦截亦未能阻断（见 §7.3 环境注记），经用户裁决放弃真实断网采集。

## 4. TypeScript interface 草案（归一化后形状）

> 说明：interface 描述**按 §3.2 预归一化/直解之后**的形状；`patternData`/`nsHiddenData` 的线上原文是 IdMap 自定义语法，不是 JSON 对象。键名与线上严格一致（大小写混杂）。本节代码块已通过 `tsc --noEmit --strict` 验证（验证后临时文件即删，见实施计划 T3）。

```ts
/** networkData 归一化后顶层：固定双层 Content 包裹 */
export interface ClothDiyNetworkData {
  Content: ClothDiyContentWrapper
}
export interface ClothDiyContentWrapper {
  Content: ClothDiyContent
}

export interface ClothDiyContent {
  /** 可选；7/7 实采样本均缺省。上游 Option<i64> */
  PoseId?: number
  /** IdMap：线上为 [:k:v,...]（k=10位服饰ID，v=款型值，实测全 0）；整体可缺省 */
  patternData?: Record<string, number>
  /** 必需；10 位服饰 ID 数组（拆解公式见 §5） */
  wearingClothes: number[]
  /** 三态：数组 | 单对象 Item | 空对象 Empty（消费方统一为『数组』语义） */
  wearingDIYInfos: ClothDiyInfo[] | ClothDiyInfo | ClothDiyEmptyMap
  /** IdMap：k=服饰ID，v=0|1（上游约定 ==1 才视为 true）；整体可缺省 */
  nsHiddenData?: Record<string, number> | null
}

export interface ClothDiyEmptyMap {}

export interface ClothDiyInfo {
  TargetGroupID: number
  /** untagged 五选一，按字段集合判别 */
  CoreData:
    | ClothDiyHairCoreData
    | ClothDiyGeneralCoreData
    | ClothDiySpecialEffectCoreData
    | ClothDiyPatternCreationCoreData
    | ClothDiyPatternCreationExtCoreData
  FeatureTag: number
  /** = wearingClothes 中的某个 10 位 ID */
  TargetClothID: number
}

/** 实测：ColorGridID1 以 -1 为哨兵值（非 null）；TargetColor1 可缺省 */
export interface ClothDiyHairCoreData {
  TargetColor0?: ClothDiyRgbaColor
  ColorGridID0: number
  TargetColor1?: ClothDiyRgbaColor
  ColorGridID1?: number
  RoughnessOffset: number
  HairColorMode?: number
}

export interface ClothDiyGeneralCoreData {
  R: number
  G: number
  B: number
  A: number
  ColorGridID: number
}

export interface ClothDiySpecialEffectCoreData {
  ColorGridID: number
  CoverDIYColor: boolean
}

export interface ClothDiyPatternCreationCoreData {
  ReplaceTextureID: number
  OverridePatternA?: boolean
}

export interface ClothDiyPatternCreationExtCoreData {
  TilingData: number
}

export interface ClothDiyRgbaColor {
  R: number
  G: number
  B: number
  A: number
}
```

## 5. 服饰 ID 拆解公式（复用 `parseDressingParams`，勿另造）

来源：`src/main/services/decryption-service.ts:546-630`（文件头注释声明对齐上游 `cloth_parser.rs`，已逐行核对一致）。**十进制位段拆解，不是位掩码**：

```
ID（10 位十进制）= species(3位) + state(1位) + clothType(2位) + outfitFeature(4位)

outfitFeature = rawId % 10000                      // 0–9999
clothType     = Math.floor(rawId / 10000) % 100    // 0–99
state         = Math.floor(rawId / 1000000) % 10   // 0–9（0=原版 / 2-5=进化 / 9=特殊形态）
species       = Math.floor(rawId / 10000000) % 1000// 0–999
```

示例：`1020100001` → species=102、state=0、clothType=10、outfitFeature=1（对应本地 `cloth-names.json` 的「时光讯号」，gongeo.us 元数据 category=`twin_tails`）。

本地 `ClothParams`（`src/main/types/decryption.ts:160-171`）现只存 `id/clothType/clothTypeName/state/species`——**outfitFeature 拆出后未持久化（仅 debug 日志）**，搭配码面板需要套装映射时的补齐点：上游由 `get_outfit(outfit_feature, state)` 派生套装 ID，本地无此步。

祝福闪光（Eureka）ID（同文件 591-627 行，对齐上游 `eureka_parser.rs`，networkData 中不出现、照片参数解码路径使用）：

```
color           = rawId % 10
level           = Math.floor(rawId / 10) % 10
attachmentPoint = Math.floor(rawId / 100) % 10
outfit          = Math.floor(rawId / 1000)
```

## 6. 数据源选型结论（服饰 ID → 中文名 / 图标）

### 6.1 结论：主选 gongeo.us（暖暖共鸣录），本地 JSON 为离线底座

| 维度           | 结论                                                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 站点 / 仓库    | https://gongeo.us （中文版 `/zh`）；开源仓库 https://github.com/dastrokes/gongeo.us-nikki-tracker （master 分支，活跃维护，Crowdin 本地化）     |
| License / 版权 | 代码 MIT（Copyright (c) 2026 dastrokes）；游戏素材、名称、商标版权归叠纸/Infold，站方自述非官方工具——**引用式使用须署名并附版权声明，不可商用** |
| robots         | Cloudflare Content-Signal：`search=yes, ai-train=no, use=reference`，`Allow: /`；禁止 AI 训练用途                                               |
| 频率限制       | 未观测到（Cloudflare 缓存命中）；**无官方 SLA**，须按“随时可能改版”设计                                                                         |
| ID 兼容性      | 与游戏内 ID 同源：单品 10 位（= wearingClothes 元素 = 本地 cloth-names.json 键）、套装 5 位（已用 `1020100001` 双向核对）                       |

三个接入口（均可直接 GET，无需爬 SPA）：

1. **中文名映射（核心）**：仓库静态 JSON `app/locales/zh/{item,outfit,makeup,momo,eureka,prop}.json`，键形如 `item.1020100001.name` → `"时光讯号"`；item.json 约 9000+ 条，另有 de/en/es/fr/it/ja/ko/tw 全语种。
2. **目录 API（属性/类型）**：`GET https://data.gongeo.us/v1/items/{10位ID}` →
   ```json
   {
     "id": 1020100001,
     "props": [71, 544, 277, 70, 59],
     "description": "...英文描述...",
     "item_attributes": {
       "category": "twin_tails",
       "subcategory": "high_twin_tails",
       "metadata": { "bangs": "blunt_bangs", "texture": "straight", "hair_length": "long" }
     }
   }
   ```
   `GET /v1/outfits/{5位ID}` 同构。注意：API **不含中文名/图标/稀有度**；无列表端点（`/v1/items/list` 返回 400 `INVALID_ID`），只能按 ID 逐条取；无 openapi 文档。
3. **图标 CDN（核心缺口）**：单品 `https://cdn.gongeo.us/images/items/icons/{10位ID}.png`（实测 200，46945 字节）；套装 `https://cdn.gongeo.us/images/outfits/{5位ID}.png`；其余路径模式（源码定义）：妆容 `/images/items/makeups/{id}.png`、喵喵 `/images/momo/icons/{id}.png`、共鸣器 `/images/eurekas/{id}.png`。

### 6.2 降级链（冻结）

```
① 本地 JSON 底座（离线可用）
   src/renderer/assets/cloth-names.json（7369 条服装中文名）+ outfit-names.json（657 条套装名）
   经 src/renderer/utils/cloth-name-lookup.ts 的 getClothName()/getOutfitName() 消费
② gongeo.us CDN/API 补齐（联网时：图标 + 本地缺失的新版本条目）
③ 最终兜底：显示裸 ID + 「未知条目」态
```

### 6.3 失败模式与对策

| 失败            | 表现                  | 对策                                                                |
| --------------- | --------------------- | ------------------------------------------------------------------- |
| CDN 图标 404    | 未收录/新版本条目     | 兜底占位图；不重试风暴（负缓存）                                    |
| data API 400    | 传了列表调用或非法 ID | 仅按单 ID 调用；入参校验 10 位数字                                  |
| 站点改版/不可达 | 4xx/5xx/超时          | ①层底座保证功能不劣化；请求加超时与静默失败                         |
| 版权合规        | —                     | 署名 + 版权声明；不打包第三方素材进安装包，运行时按需拉取并本地缓存 |

### 6.4 备选（不推荐为主选的已核实原因）

- Fandom `infinity-nikki.fandom.com/zh/api.php`：MediaWiki 标准 API、内容 CC BY-SA；但中文名覆盖度未验证，且国内通常不可达。
- mailauki/infinity-nikki-tracker：数据在私有 Supabase，仓库无 LICENSE、无数据导出——需爬取他人应用，风险高于 gongeo.us。
- BWIKI（biligame）：全链路反爬（api.php 被 JS 挑战拦截），不可脚本化；nuan5.pro：SPA 无可复用数据端点。

## 7. 遗留事项与环境注记

### 7.1 既有类型契约不一致（阶段 1+ 修正，本阶段不动）

| 位置                                                                   | 不一致                     | 实际                                                                                  |
| ---------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------- |
| `src/shared/types/electron-api.ts:503`                                 | `networkData?: unknown`    | 运行时为 `string`（worker 全程 UTF-8 文本）；渲染层 `vite-env.d.ts:271` 已是 `string` |
| `src/shared/types/electron-api.ts:511`                                 | `server?: string`          | 主进程返回 `number`（decryption-service.ts:1301）、`vite-env.d.ts:277` 为 `number`    |
| `src/renderer/components/common/ShareCodeDecoderDialog.stories.tsx:81` | 示例值为 base64 形态字符串 | 真实 networkData 是 UTF-8 JSON 文本（含 IdMap 语法时非法标准 JSON），样例有误导性     |

### 7.2 缓存方案参考（阶段 1+ 实现时复用）

- 上游同功能缓存策略：按码把 networkData **原始字节**写 `<temp>/ClothDiyShareCode/<code>`，先读缓存未命中再联网（RanAxro/nikki_albums `decode.rs:228-258`、`code_parser.dart`）。
- 本仓可复用模式：缩略图磁盘缓存目录 + `cache-metadata.json` LRU 元数据（`src/main/app/startup-tasks.ts:516-517`、`src/main/utils/dir-manager.ts:20`、`cache:*` IPC 族）；进程内 Map-LRU（`src/main/app/media-protocol.ts:39,329-332`）。
- 注意：缓存键=码字符串；写盘内容应为原始字节（含 IdMap 语法），解析归一化放在读取之后。

### 7.3 采集环境注记（2026-10-31 实测）

- DLL 解码请求的官方域名（DNS 缓存抓取）：**`x6cn-clothdiydata.nuanpaper.com`**（叠纸 nuanpaper.com 域，CN 移动云 IP 段）。
- DLL **自带 DNS 解析**（修改 hosts 指向 127.0.0.1 不生效）；Windows 防火墙程序级出站拦截规则在本机亦未能阻断（netsh 命令均报成功）——成因未定（疑似本机第三方安全软件接管过滤或流量归属不在 node.exe），断网形态因此按代码推导记录（§3.6 样本 5）。
- 无效码在**本地即失败**（from_code_str 返回 null，不发起网络请求）；全零码同样被本地完整性校验拒绝，无法构造“本地通过、服务端拒绝”的样本。
- 区服观察：Reddit（境外玩家）发布的码在 CN 网络下解码成功，未观察到区服拦截；分享码有效性与游戏版本相关，B 站 2025-05～2026-05 的码在采集日均有效。

### 7.4 阶段 1+ 行动清单（依据本文冻结的契约）

1. 结构化解析：按 §3.2 BNF 实现预归一化/直解（二选一）+ §4 interface + zod schema；**必须**包含“含 patternData 样本”的解析单测（以本文样本 3 原文为 fixture）。
2. `ClothParams` 补存 `outfitFeature`（§5 指出的缺口），如需套装映射则实现上游 `get_outfit(feature, state)` 等价逻辑。
3. 修正 §7.1 三处类型不一致。
4. 名称映射复用 `cloth-name-lookup.ts`；图标按 §6.1 接入口 3 + 本地磁盘缓存（参考 §7.2 模式）；署名与版权声明进设置页关于区。
5. 网络结果缓存按 §7.2 策略落盘（键=码，值=原始字节）。
