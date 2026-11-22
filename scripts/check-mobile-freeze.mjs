#!/usr/bin/env node
// 移植 Android 端（mobile/）协议冻结守护网。
// 每条断言 = 冻结项在移植源码中的精确原文（file + 正则），漂移即非零退出。
// 冻结清单与锚点出处：docs/plans/2026-11-21-安卓端移植进桌面仓库-实施计划.md 第四节。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// [说明, 相对 mobile/ 的文件路径, 正则或字面子串, 期望('present'|'absent')]
const CHECKS = [
  // ── 包名与 namespace（仅 applicationId 允许分离，namespace 冻结）──
  ['gradle namespace 冻结', 'app/build.gradle.kts', /namespace\s*=\s*"app\.nikkisync\.mobile"/, 'present'],
  ['gradle settings 工程名', 'settings.gradle.kts', /rootProject\.name/, 'present'],
  ['Manifest deep link scheme/host', 'app/src/main/AndroidManifest.xml', '<data android:scheme="nikki-sync" android:host="pair" />', 'present'],
  ['FileProvider authority 模板（随 applicationId 自适应）', 'app/src/main/AndroidManifest.xml', '${applicationId}.updates', 'present'],

  // ── 配对 deep link ──
  ['PairingUri scheme/host 校验', 'app/src/main/java/app/nikkisync/mobile/protocol/PairingUri.java', '!"nikki-sync".equals(uri.getScheme()) || !"pair".equals(uri.getHost())', 'present'],
  ['PairingUri NS1| 紧凑格式', 'app/src/main/java/app/nikkisync/mobile/protocol/PairingUri.java', '"NS1|"', 'present'],
  ['MainActivity deep link 入口前缀', 'app/src/main/java/app/nikkisync/mobile/MainActivity.java', 'raw.startsWith("nikki-sync://pair?")', 'present'],

  // ── 设备发现 ──
  ['NSD 服务类型（含尾点）', 'app/src/main/java/app/nikkisync/mobile/net/NsdDiscovery.java', 'SERVICE_TYPE="_nikkisync._tcp."', 'present'],
  ['NSD 服务类型兼容形态', 'app/src/main/java/app/nikkisync/mobile/net/NsdDiscovery.java', '"_nikkisync._tcp"', 'present'],
  ['mDNS 多播锁名', 'app/src/main/java/app/nikkisync/mobile/net/NsdDiscovery.java', 'createMulticastLock("nikkisync-mdns")', 'present'],

  // ── WebSocket ──
  ['WS 升级请求行 /ws/v1', 'app/src/main/java/app/nikkisync/mobile/net/RealtimeWebSocket.java', 'GET /ws/v1 HTTP/1.1', 'present'],
  ['WS 鉴权路径 /ws/v1', 'app/src/main/java/app/nikkisync/mobile/net/RealtimeWebSocket.java', '"/ws/v1"', 'present'],

  // ── REST 路由（NikkiSyncClient）──
  ['POST /v1/pair', 'app/src/main/java/app/nikkisync/mobile/net/NikkiSyncClient.java', '"POST", "/v1/pair"', 'present'],
  ['GET /v1/assets?limit=', 'app/src/main/java/app/nikkisync/mobile/net/NikkiSyncClient.java', '"/v1/assets?limit="', 'present'],
  ['GET /v1/assets/{id}', 'app/src/main/java/app/nikkisync/mobile/net/NikkiSyncClient.java', '"/v1/assets/"+encode(assetId)', 'present'],
  ['PATCH …/metadata', 'app/src/main/java/app/nikkisync/mobile/net/NikkiSyncClient.java', '"/metadata"', 'present'],
  ['POST /v1/organizer/sync', 'app/src/main/java/app/nikkisync/mobile/net/NikkiSyncClient.java', '"/v1/organizer/sync"', 'present'],
  ['GET /v1/search/suits?q=', 'app/src/main/java/app/nikkisync/mobile/net/NikkiSyncClient.java', '"/v1/search/suits?q="', 'present'],
  ['GET /v1/search/clothing?q=', 'app/src/main/java/app/nikkisync/mobile/net/NikkiSyncClient.java', '"/v1/search/clothing?q="', 'present'],
  ['GET /v1/profile/stats', 'app/src/main/java/app/nikkisync/mobile/net/NikkiSyncClient.java', '"/v1/profile/stats"', 'present'],
  ['GET /v1/changes?after=', 'app/src/main/java/app/nikkisync/mobile/net/NikkiSyncClient.java', '"/v1/changes?after="', 'present'],
  ['资源路由 /resources/', 'app/src/main/java/app/nikkisync/mobile/net/NikkiSyncClient.java', '"/resources/"', 'present'],
  ['效果缩略图路由 /effects/', 'app/src/main/java/app/nikkisync/mobile/net/NikkiSyncClient.java', '"/effects/"', 'present'],
  ['服装缩略图路由 /clothing/', 'app/src/main/java/app/nikkisync/mobile/net/NikkiSyncClient.java', '"/clothing/"', 'present'],

  // ── 灵感库与支持路由 ──
  ['GET /v1/inspiration?limit=20', 'app/src/main/java/app/nikkisync/mobile/inspiration/InspirationSyncClient.java', '"/v1/inspiration?limit=20"', 'present'],
  ['GET /v1/inspiration/images/', 'app/src/main/java/app/nikkisync/mobile/inspiration/InspirationSyncClient.java', '"/v1/inspiration/images/"', 'present'],
  ['POST /v1/inspiration', 'app/src/main/java/app/nikkisync/mobile/inspiration/InspirationSyncClient.java', '"POST","/v1/inspiration"', 'present'],
  ['POST /v1/reports', 'app/src/main/java/app/nikkisync/mobile/support/SupportClient.java', '"/v1/reports"', 'present'],
  ['POST /v1/replies', 'app/src/main/java/app/nikkisync/mobile/support/SupportClient.java', '"/v1/replies"', 'present'],

  // ── 鉴权头（Ed25519 签名协议面）──
  ['鉴权头 Device-Id', 'app/src/main/java/app/nikkisync/mobile/net/SignedHttpClient.java', 'X-NikkiSync-Device-Id', 'present'],
  ['鉴权头 Timestamp', 'app/src/main/java/app/nikkisync/mobile/net/SignedHttpClient.java', 'X-NikkiSync-Timestamp', 'present'],
  ['鉴权头 Nonce', 'app/src/main/java/app/nikkisync/mobile/net/SignedHttpClient.java', 'X-NikkiSync-Nonce', 'present'],
  ['鉴权头 Signature', 'app/src/main/java/app/nikkisync/mobile/net/SignedHttpClient.java', 'X-NikkiSync-Signature', 'present'],

  // ── EXIF 相机与描述（三端协议互验串）──
  ['EXIF Model/Software 常量 CAMERA', 'app/src/main/java/app/nikkisync/mobile/media/PhotoExif.java', 'CAMERA="MomoCamera"', 'present'],
  ['EXIF LensModel 常量 LENS', 'app/src/main/java/app/nikkisync/mobile/media/PhotoExif.java', 'LENS="InfinityNikki"', 'present'],
  ['EXIF Make 置空', 'app/src/main/java/app/nikkisync/mobile/media/PhotoExif.java', 'TAG_MAKE,null', 'present'],
  ['EXIF Software=MomoCamera', 'app/src/main/java/app/nikkisync/mobile/media/PhotoExif.java', 'TAG_SOFTWARE,"MomoCamera"', 'present'],
  ['EXIF 描述前缀（桌面导出互验）', 'app/src/main/java/app/nikkisync/mobile/media/PhotoExif.java', 'TAG_IMAGE_DESCRIPTION,"Infinity Nikki virtual photography; game parameters: "', 'present'],
  ['修图落盘目录 MomoCamera/Edited', 'app/src/main/java/app/nikkisync/mobile/media/EditedPhotoExif.java', 'DIRECTORY_PICTURES+"/MomoCamera/Edited"', 'present'],

  // ── 相册落盘目录 ──
  ['静态/实况落盘 OEM 策略', 'app/src/main/java/app/nikkisync/mobile/media/GallerySavePolicy.java', '"DCIM/Camera":"Pictures/NikkiSync"', 'present'],
  ['原视频落盘 Movies/NikkiSync', 'app/src/main/java/app/nikkisync/mobile/media/OriginalVideoSaver.java', 'Environment.DIRECTORY_MOVIES+"/NikkiSync"', 'present'],
  ['旋转视频落盘 Movies/NikkiSync', 'app/src/main/java/app/nikkisync/mobile/media/MotionVideoSaver.java', '"Movies/NikkiSync"', 'present'],

  // ── 本地键名与数据库名 ──
  ['配对存储 nikkisync.server', 'app/src/main/java/app/nikkisync/mobile/storage/ServerStore.java', '"nikkisync.server"', 'present'],
  ['设备身份 nikkisync.identity', 'app/src/main/java/app/nikkisync/mobile/security/DeviceIdentity.java', '"nikkisync.identity"', 'present'],
  ['设备私钥键 ed25519.private.pkcs8', 'app/src/main/java/app/nikkisync/mobile/security/DeviceIdentity.java', '"ed25519.private.pkcs8"', 'present'],
  ['加密包裹 nikkisync.secure', 'app/src/main/java/app/nikkisync/mobile/security/SecureBlobStore.java', '"nikkisync.secure"', 'present'],
  ['AndroidKeyStore 包裹别名', 'app/src/main/java/app/nikkisync/mobile/security/SecureBlobStore.java', '"nikkisync.device.wrap.v1"', 'present'],
  ['隐私同意 momo.privacy', 'app/src/main/java/app/nikkisync/mobile/privacy/PrivacyConsentStore.java', '"momo.privacy"', 'present'],
  ['导出水印相机名 MomoCamera', 'app/src/main/java/app/nikkisync/mobile/storage/ExportWatermarkStore.java', '"MomoCamera"', 'present'],
  ['DB nikkisync-inspiration.db', 'app/src/main/java/app/nikkisync/mobile/inspiration/InspirationStore.java', '"nikkisync-inspiration.db"', 'present'],
  ['DB nikkisync-organizer.db', 'app/src/main/java/app/nikkisync/mobile/storage/OrganizerStore.java', '"nikkisync-organizer.db"', 'present'],
  ['DB nikkisync-detail-cache.db', 'app/src/main/java/app/nikkisync/mobile/storage/AssetDetailCache.java', '"nikkisync-detail-cache.db"', 'present'],
  ['DB nikkisync-favorites.db', 'app/src/main/java/app/nikkisync/mobile/storage/FavoritePhotoStore.java', '"nikkisync-favorites.db"', 'present'],
  ['DB nikkisync-edited-variants.db', 'app/src/main/java/app/nikkisync/mobile/storage/EditedVariantStore.java', '"nikkisync-edited-variants.db"', 'present'],
  ['DB nikkisync-saved-metadata.db', 'app/src/main/java/app/nikkisync/mobile/storage/SavedMetadataSnapshotStore.java', '"nikkisync-saved-metadata.db"', 'present'],
  ['DB nikkisync-saved-sources.db', 'app/src/main/java/app/nikkisync/mobile/storage/SavedSourceStore.java', '"nikkisync-saved-sources.db"', 'present'],

  // ── 红线（移植产物不得出现）──
  ['红线：不得引用上游仓库级游戏美术目录', 'app/src/main', 'photo-filter-icons', 'absent'],

  // ── 喵星图身份（S3 起冻结；仅 applicationId/版本/文案面，namespace 冻结见顶部）──
  ['applicationId = com.qianlu.meowstarmap', 'app/build.gradle.kts', 'applicationId = "com.qianlu.meowstarmap"', 'present'],
  ['versionCode 68（对齐桌面 2.5.7 递增）', 'app/build.gradle.kts', 'versionCode = 68', 'present'],
  ['versionName 2.5.7（与桌面包同版）', 'app/build.gradle.kts', 'versionName = "2.5.7"', 'present'],
  ['meowSelfUpdate 属性（默认 false）', 'app/build.gradle.kts', 'providers.gradleProperty("meowSelfUpdate").orElse("false")', 'present'],
  ['BuildConfig.SELF_UPDATE 注入', 'app/build.gradle.kts', 'buildConfigField("boolean", "SELF_UPDATE", selfUpdate)', 'present'],
  ['法务文档源已改接 mobile/legal', 'app/build.gradle.kts', 'resolve("legal")', 'present'],
  ['验签公钥源已改接 mobile/signing', 'app/build.gradle.kts', 'resolve("signing/update-public-key.pem")', 'present'],
  ['APK 产物名 MeowStarMap-Android.apk', 'app/build.gradle.kts', '"MeowStarMap-Android.apk"', 'present'],
  ['APK 输出目录已改接仓库根 release/', 'app/build.gradle.kts', 'resolve("../release")', 'present'],
  ['Manifest 应用名 喵星图', 'app/src/main/AndroidManifest.xml', 'android:label="喵星图"', 'present'],
  ['旧应用名大喵相机助手清零', 'app/src/main', '大喵相机助手', 'absent'],
  ['上游百度网盘分发渠道清零', 'app/src/main', 'pan.baidu.com', 'absent'],
  ['上游 issues 反馈链接清零', 'app/src/main', 'ToStardust/NikkiSync/issues', 'absent'],
  ['上游 releases 链接清零', 'app/src/main', 'ToStardust/NikkiSync/releases', 'absent'],
  ['出树引用①：上游 store-submission 路径清零', 'app/build.gradle.kts', '../../docs/store-submission', 'absent'],
  ['出树引用②：上游 windows-shell 公钥路径清零', 'app/build.gradle.kts', '../windows-shell/Assets', 'absent'],
  ['出树引用③：上游 release 输出路径清零', 'app/build.gradle.kts', '../../release/NikkiSync', 'absent'],
  ['widget 旧名暖暖相册清零', 'app/src/main/res/values/photo_album_widget.xml', '暖暖相册', 'absent'],
  ['widget 引导语指向喵星图', 'app/src/main/res/values/photo_album_widget.xml', '打开喵星图\\n完成首次设置', 'present'],

  // ── 2026-11-22 更名收尾：用户可见「NikkiSync」字样清零（暖暖系文案经裁定保留；类名/协议标识不受影响）──
  ['旧名残留：记录移除按钮', 'app/src/main/java/app/nikkisync/mobile/MainActivity.java', '仅移除 NikkiSync 记录', 'absent'],
  ['新文案：记录移除按钮', 'app/src/main/java/app/nikkisync/mobile/MainActivity.java', '仅移除喵星图记录', 'present'],
  ['旧名残留：已保存移除说明', 'app/src/main/java/app/nikkisync/mobile/MainActivity.java', '只会从 NikkiSync 的', 'absent'],
  ['新文案：已保存移除说明', 'app/src/main/java/app/nikkisync/mobile/MainActivity.java', '只会从喵星图的', 'present'],
  ['旧名残留：修图关联解除说明', 'app/src/main/java/app/nikkisync/mobile/MainActivity.java', '只会移除 NikkiSync 内的关联', 'absent'],
  ['新文案：修图关联解除说明', 'app/src/main/java/app/nikkisync/mobile/MainActivity.java', '只会移除喵星图内的关联', 'present'],
  ['旧名残留：扫码非配对码提示', 'app/src/main/java/app/nikkisync/mobile/PairQrScannerActivity.java', '这不是 NikkiSync 配对二维码', 'absent'],
  ['新文案：扫码非配对码提示', 'app/src/main/java/app/nikkisync/mobile/PairQrScannerActivity.java', '这不是喵星图配对二维码', 'present'],
  ['旧名残留：相机权限提示', 'app/src/main/java/app/nikkisync/mobile/PairQrScannerActivity.java', '打开 NikkiSync 的相机权限', 'absent'],
  ['新文案：相机权限提示', 'app/src/main/java/app/nikkisync/mobile/PairQrScannerActivity.java', '打开喵星图的相机权限', 'present'],
  ['旧名残留：导出失败提示', 'app/src/main/java/app/nikkisync/mobile/media/OriginalSaver.java', '已更新 NikkiSync', 'absent'],
  ['新文案：导出失败提示', 'app/src/main/java/app/nikkisync/mobile/media/OriginalSaver.java', '已更新喵星图', 'present'],
  ['旧名残留：配对链接错误', 'app/src/main/java/app/nikkisync/mobile/protocol/PairingUri.java', '这不是 NikkiSync 配对链接', 'absent'],
  ['新文案：配对链接错误', 'app/src/main/java/app/nikkisync/mobile/protocol/PairingUri.java', '这不是喵星图配对链接', 'present'],
  ['旧名残留：兜底配对名（ServerStore）', 'app/src/main/java/app/nikkisync/mobile/storage/ServerStore.java', '"NikkiSync PC"', 'absent'],
  ['新文案：兜底配对名与桌面端一致（ServerStore）', 'app/src/main/java/app/nikkisync/mobile/storage/ServerStore.java', '"Meow Star Map"', 'present'],
  ['旧名残留：兜底配对名（NikkiSyncClient）', 'app/src/main/java/app/nikkisync/mobile/net/NikkiSyncClient.java', '"NikkiSync PC"', 'absent'],
  ['新文案：兜底配对名与桌面端一致（NikkiSyncClient）', 'app/src/main/java/app/nikkisync/mobile/net/NikkiSyncClient.java', '"Meow Star Map"', 'present'],
  ['旧名残留：默认水印显示名（大喵相机）', 'app/src/main/java/app/nikkisync/mobile/storage/ExportWatermarkStore.java', '大喵相机', 'absent'],
  ['新文案：默认水印显示名喵星图', 'app/src/main/java/app/nikkisync/mobile/storage/ExportWatermarkStore.java', 'new Branding("喵星图","MomoCamera")', 'present'],

  // ── 2026-11-22 签名构建缺陷：release 前置检查报错文案必须指向真实的环境变量机制 ──
  ['红线：签名报错不得引用不存在的脚本', 'app/build.gradle.kts', 'build-official-android.ps1', 'absent'],
  ['签名环境变量 STORE_FILE 在位', 'app/build.gradle.kts', 'MOMO_RELEASE_STORE_FILE', 'present'],
  ['签名环境变量 STORE_PASSWORD 在位', 'app/build.gradle.kts', 'MOMO_RELEASE_STORE_PASSWORD', 'present'],
  ['签名环境变量 KEY_ALIAS 在位', 'app/build.gradle.kts', 'MOMO_RELEASE_KEY_ALIAS', 'present']
];

let failed = 0;
const cache = new Map();

function readTarget(rel) {
  if (cache.has(rel)) return cache.get(rel);
  const abs = resolve(repoRoot, 'mobile', rel);
  const stat = statSync(abs);
  if (stat.isDirectory()) {
    // 目录目标：递归收集其下全部文本文件（用于 absent 红线扫描）
    const walk = (dir) =>
      readdirSync(dir).flatMap((name) => {
        const child = resolve(dir, name);
        return statSync(child).isDirectory() ? walk(child) : [child];
      });
    cache.set(rel, { isDir: true, files: walk(abs).map((file) => ({ file, text: readFileSync(file, 'utf8') })) });
  } else {
    cache.set(rel, { isDir: false, text: readFileSync(abs, 'utf8') });
  }
  return cache.get(rel);
}

function matches(target, pattern) {
  const hit = (text) => (typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text));
  return target.isDir ? target.files.some(({ text }) => hit(text)) : hit(target.text);
}

for (const [label, rel, pattern, expect] of CHECKS) {
  let target;
  try {
    target = readTarget(rel);
  } catch {
    console.error(`✗ ${label} — 文件缺失: mobile/${rel}`);
    failed++;
    continue;
  }
  if (expect === 'present' && target.isDir) {
    console.error(`✗ ${label} — 配置错误：present 断言不支持目录目标 [mobile/${rel}]`);
    failed++;
    continue;
  }
  const matched = matches(target, pattern);
  const ok = expect === 'present' ? matched : !matched;
  if (ok) {
    console.log(`✓ ${label}  [mobile/${rel}]`);
  } else {
    console.error(`✗ ${label} — 期望${expect === 'present' ? '存在' : '不存在'}: ${String(pattern)}  [mobile/${rel}]`);
    failed++;
  }
}

if (failed > 0) {
  console.error(`\nMOBILE FREEZE: ${CHECKS.length - failed}/${CHECKS.length} 绿，${failed} 红 —— 冻结项漂移，禁止继续（不得改预期值迁就代码）`);
  process.exit(1);
}
console.log(`\nMOBILE FREEZE: ${CHECKS.length}/${CHECKS.length} 全绿`);
