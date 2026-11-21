package app.nikkisync.mobile.ui;

import app.nikkisync.mobile.model.Models.AssetSummary;
import app.nikkisync.mobile.storage.EditedVariantStore;
import app.nikkisync.mobile.storage.SavedPhotoStore;
import java.text.DateFormat;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.Date;
import org.json.JSONArray;
import org.json.JSONObject;

/** Short detail copy for players; IDs and raw metadata are intentionally not rendered here. */
public final class PlayerFacingDetails {
    private PlayerFacingDetails() {}

    public static String sourcePhoto(AssetSummary asset) {
        StringBuilder out = new StringBuilder();
        if (asset.isVideo()) out.append("视频");
        else if (asset.hasMotion()) out.append("LIVE 照片");
        String captured = date(asset.capturedAt());
        if (captured != null) {
            if (out.length() > 0) out.append("\n");
            out.append("拍摄时间：").append(captured);
        }
        if (asset.gameVersion() != null && !asset.gameVersion().isBlank()) {
            if (out.length() > 0) out.append("\n");
            out.append("游戏版本：").append(asset.gameVersion());
        }
        return out.toString();
    }

    public static String savedPhoto(SavedPhotoStore.Record record, boolean missing) {
        StringBuilder out = new StringBuilder();
        if (missing) out.append("文件不存在\n");
        out.append("保存时间：").append(date(record.savedAt()));
        String captured = date(record.capturedAt());
        if (captured != null) out.append("\n拍摄时间：").append(captured);
        if (record.gameVersion() != null && !record.gameVersion().isBlank()) {
            out.append("\n游戏版本：").append(record.gameVersion());
        }
        if (record.rotationDegrees() != 0) out.append("\n已旋转保存");
        return out.toString();
    }

    public static String editedPhoto(EditedVariantStore.Variant variant, boolean missing) {
        StringBuilder out = new StringBuilder();
        if (missing) out.append("文件不可访问\n");
        out.append("关联时间：").append(date(variant.linkedAt()));
        return out.toString();
    }

    public static String clothingName(String name, String internalId) {
        if (name == null || name.isBlank()) return "名称暂缺";
        String visible = name.trim();
        if (visible.equals(internalId) || visible.matches("服装\\s*[+＋#＃:：-]?\\s*\\d+")) return "名称暂缺";
        return visible;
    }

    /** Describe the observed result; do not present a list of unrelated guesses. */
    public static String metadataNotice(String metadataJson) {
        return metadataNotice(metadataJson, "", false);
    }

    private static String metadataNotice(String metadataJson, String sourceReason, boolean gameOriginal) {
        try {
            JSONObject metadata = metadataJson == null || metadataJson.isBlank() ? new JSONObject() : new JSONObject(metadataJson);
            JSONObject dressing = metadata.optJSONObject("dressing"), camera = metadata.optJSONObject("camera");
            JSONArray clothes = dressing == null ? null : dressing.optJSONArray("clothes");
            boolean hasClothes = false, hasCamera = false;
            if (clothes != null) for (int i = 0; i < clothes.length(); i++) {
                JSONObject item = clothes.optJSONObject(i);
                if (item != null && !item.isNull("id") && !item.optString("id", "").isBlank()) hasClothes = true;
            }
            if (camera != null) {
                var keys = camera.keys();
                while (keys.hasNext()) {String key = keys.next();if (!camera.isNull(key) && !camera.optString(key, "").isBlank()) hasCamera = true;}
            }
            if (hasClothes && hasCamera) return "";
            String missing = hasClothes ? "部分拍摄参数" : hasCamera ? "穿搭数据" : "穿搭和拍摄参数";
            JSONObject raw = metadata.optJSONObject("raw"), resolver = raw == null ? null : raw.optJSONObject("resolver");
            String status = resolver == null ? "" : resolver.optString("status", "");
            boolean embedded = raw != null && (raw.optBoolean("sourceParametersPresent", false)
                    || !raw.optString("nativeParamToken", "").isBlank() || !raw.optString("nativeParamPayload", "").isBlank());
            if (!"resolved".equals(status) && embedded && raw.has("sourceParametersComplete")) {
                if(!raw.optBoolean("sourceParametersComplete"))return "检测到参数标记，但当前能读取的原始数据不完整。请保留原图，并在电脑补充包含 UID 的游戏相册目录。";
                JSONObject identity=metadata.optJSONObject("identity");
                if(identity==null||identity.optString("uid", "").isBlank())return "检测到原始参数，但未识别到所属 UID。请在电脑添加保留 UID 文件夹的原游戏相册后重新扫描。";
            }
            if (!"resolved".equals(status) && (embedded || "failed".equals(status)))
                return "检测到游戏参数，但" + missing + "尚未解码成功。请在电脑端重新扫描并检查参数解析状态。";
            if ("resolved".equals(status) || hasClothes || hasCamera)
                return missing + "未能完整读取，当前仅展示已读取的信息。";
            if (!sourceReason.isEmpty()) return sourceReason;
            if (raw != null && raw.optBoolean("sourceParametersChecked", false) && !raw.optBoolean("sourceParametersPresent"))
                return gameOriginal
                        ? "这张游戏相机原图没有可用的穿搭和拍摄参数。"
                        : "这张照片没有可用的穿搭和拍摄参数。请使用游戏内相机原图。";
            if (gameOriginal) return "这张游戏相机原图的参数暂不可用，请在电脑重新扫描原图。";
            return "这张照片没有可显示的穿搭和拍摄参数。请使用游戏内相机原图。";
        } catch (Exception ignored) {
            return "照片参数暂不可用，请连接电脑重新同步。";
        }
    }

    public static String metadataNotice(String metadataJson, String sourcePath) {
        return metadataNotice(metadataJson, missingParameterReason(sourcePath, false),
                hasFolder(sourcePath, "GamePlayPhotos"));
    }

    /** Asset type and indexed source are available for both online and saved photo viewers. */
    public static String metadataNoticeForAsset(AssetSummary asset, String metadataJson) {
        return metadataNoticeForAsset(asset, metadataJson, false);
    }

    public static String metadataNoticeForAsset(AssetSummary asset, String metadataJson, boolean savedLive) {
        String folders = asset == null ? null : asset.sourceFolder();
        if ((folders == null || folders.isBlank()) && asset != null && asset.sourcePath() != null) {
            String path = asset.sourcePath().replace('\\', '/');
            int separator = path.lastIndexOf('/');
            if (separator >= 0) folders = path.substring(0, separator);
        }
        return metadataNotice(metadataJson, missingParameterReason(folders, savedLive || asset != null && asset.hasMotion()),
                hasFolder(folders, "GamePlayPhotos"));
    }

    private static String missingParameterReason(String folders, boolean live) {
        if (live) return "这张是 LIVE 照片，不带穿搭和拍摄参数。";
        if (hasFolder(folders, "贴图", "贴纸", "StickerPhoto", "StickerPhotos"))
            return "这张是贴图，不带穿搭和拍摄参数。";
        if (hasFolder(folders, "双人", "双人照片", "合照", "合影", "GroupPhoto", "GroupPhotos", "MultiPlayerPhoto", "MultiPlayerPhotos"))
            return "这张是双人合照，不带穿搭和拍摄参数。";
        if (hasFolder(folders, "Collage", "拼图"))
            return "这张是拼图，不带穿搭和拍摄参数。";
        if (hasFolder(folders, "EditorPhoto"))
            return "这张是编辑后导出的图片，不带穿搭和拍摄参数。";
        if (isScreenShotPath(folders))
            return "这张照片来自 ScreenShot 截图目录，不带穿搭和拍摄参数。请使用游戏内相机原图。";
        return "";
    }

    public static boolean isScreenShotPath(String sourcePath) {
        return hasFolder(sourcePath, "ScreenShot");
    }

    private static boolean hasFolder(String path, String... names) {
        if (path == null) return false;
        for (String segment : path.replace('\\', '/').split("/"))
            for (String name : names) if (name.equalsIgnoreCase(segment)) return true;
        return false;
    }

    private static String date(String capturedAt) {
        if (capturedAt == null || capturedAt.isBlank()) return null;
        try {
            return date(Instant.parse(capturedAt).toEpochMilli());
        } catch (Exception ignored) {
            try {
                long millis = LocalDateTime.parse(capturedAt.replace(' ', 'T'))
                        .atZone(ZoneId.systemDefault()).toInstant().toEpochMilli();
                return date(millis);
            } catch (Exception ignoredAgain) {
                return null;
            }
        }
    }

    private static String date(long millis) {
        return DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT)
                .format(new Date(millis));
    }
}
