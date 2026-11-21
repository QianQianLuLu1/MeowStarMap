package app.nikkisync.mobile.media;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;

import app.nikkisync.mobile.model.Models.AssetDetail;
import app.nikkisync.mobile.model.Models.AssetSummary;
import app.nikkisync.mobile.model.Models.MediaResource;
import app.nikkisync.mobile.net.NikkiSyncClient;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;

/** Huawei/Honor Android-compatible moving-photo writer. */
public final class HuaweiMovingPhotoSaver {
    public Uri save(Context context, NikkiSyncClient client, AssetSummary asset) throws Exception {
        AssetDetail detail = client.asset(asset.assetId());
        MediaResource still = detail.originalStill();
        MediaResource motion = detail.motionResource();
        if (still == null || motion == null) throw new IllegalStateException("Huawei LIVE 资源不完整");
        if (!("image/jpeg".equals(still.mimeType()) || "jpg".equalsIgnoreCase(still.fileExt()) || "jpeg".equalsIgnoreCase(still.fileExt()))) {
            throw new IllegalStateException("Huawei Android 适配当前仅支持 JPEG 封面");
        }
        if (!"video/mp4".equals(motion.mimeType())) throw new IllegalStateException("Huawei Android 适配当前仅支持 MP4 动态资源");

        File jpg = File.createTempFile("nikkisync_huawei_", ".jpg", context.getCacheDir());
        File mp4 = File.createTempFile("nikkisync_huawei_", ".mp4", context.getCacheDir());
        try {
            MotionPhotoSaver.downloadVerified(client, asset.assetId(), still, jpg);
            MotionPhotoSaver.downloadVerified(client, asset.assetId(), motion, mp4);

            ContentResolver resolver = context.getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.Images.Media.DISPLAY_NAME, fileName(still.fileName()));
            values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
            values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_DCIM + "/Camera");
            values.put(MediaStore.Images.Media.IS_PENDING, 1);
            Uri uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new IllegalStateException("Huawei 动态照片创建失败");
            try {
                try (OutputStream raw = resolver.openOutputStream(uri, "w")) {
                    if (raw == null) throw new IllegalStateException("系统相册无法写入 Huawei 动态照片");
                    try (BufferedOutputStream output = new BufferedOutputStream(raw);
                         InputStream image = new BufferedInputStream(new FileInputStream(jpg));
                         InputStream video = new BufferedInputStream(new FileInputStream(mp4))) {
                        copy(image, output);
                        copy(video, output);
                        output.flush();
                    }
                }
                ContentValues ready = new ContentValues();
                ready.put(MediaStore.Images.Media.IS_PENDING, 0);
                resolver.update(uri, ready, null, null);
                return uri;
            } catch (Exception error) {
                resolver.delete(uri, null, null);
                throw error;
            }
        } finally {
            jpg.delete();
            mp4.delete();
        }
    }

    private static String fileName(String original) {
        String base = original == null ? "IMG_" + System.currentTimeMillis() : original.replaceFirst("(?i)\\.(jpe?g)$", "");
        return base + "_HUAWEI.jpg";
    }

    private static void copy(InputStream input, OutputStream output) throws Exception {
        byte[] buffer = new byte[128 * 1024]; int read;
        while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
    }
}
