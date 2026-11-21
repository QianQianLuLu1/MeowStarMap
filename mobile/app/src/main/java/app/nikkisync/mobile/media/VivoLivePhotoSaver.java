package app.nikkisync.mobile.media;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import android.media.ExifInterface;

import app.nikkisync.mobile.model.Models.AssetDetail;
import app.nikkisync.mobile.model.Models.AssetSummary;
import app.nikkisync.mobile.model.Models.MediaResource;
import app.nikkisync.mobile.net.NikkiSyncClient;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Locale;

/** OriginOS vivo/iQOO live-photo pair writer. */
public final class VivoLivePhotoSaver {
    private static final byte[] USER_TYPE = "vivoMediaExtInfo".getBytes(StandardCharsets.US_ASCII);
    private static final byte[] TRAILER_MAGIC = hex("1b2a39485766758493a2b3");
    private static final SecureRandom RANDOM = new SecureRandom();

    public Uri save(Context context, NikkiSyncClient client, AssetSummary asset) throws Exception {
        AssetDetail detail = client.asset(asset.assetId());
        MediaResource still = detail.originalStill();
        MediaResource motion = detail.motionResource();
        if (still == null || motion == null) throw new IllegalStateException("vivo LIVE 资源不完整");

        File jpg = File.createTempFile("nikkisync_vivo_", ".jpg", context.getCacheDir());
        File mp4 = File.createTempFile("nikkisync_vivo_", ".mp4", context.getCacheDir());
        try {
            MotionPhotoSaver.downloadVerified(client, asset.assetId(), still, jpg);
            MotionPhotoSaver.downloadVerified(client, asset.assetId(), motion, mp4);
            long presentationUs = detail.presentationTimestampUs() == null
                    ? MotionFrameMatcher.findPresentationTimestampUs(jpg, mp4)
                    : detail.presentationTimestampUs();
            int imageTime = MotionFrameMatcher.frameIndex(mp4, presentationUs);
            String id = livePhotoId();
            String model = Build.MODEL == null || Build.MODEL.isBlank() ? "vivo" : Build.MODEL;

            ExifInterface exif = new ExifInterface(jpg);
            exif.setAttribute(ExifInterface.TAG_MAKE, "vivo");
            exif.setAttribute(ExifInterface.TAG_MODEL, model);
            exif.setAttribute(ExifInterface.TAG_USER_COMMENT, "module: live_photo;");
            exif.saveAttributes();
            append(jpg, payload(imageDocument(id, model)));
            append(mp4, uuidBox(payload(videoDocument(id, model, imageTime))));

            String stem = "IMG_" + System.currentTimeMillis();
            ContentResolver resolver = context.getContentResolver();
            Uri jpgUri = insert(resolver, MediaStore.Images.Media.EXTERNAL_CONTENT_URI, stem + ".jpg", "image/jpeg");
            Uri mp4Uri = insert(resolver, MediaStore.Video.Media.EXTERNAL_CONTENT_URI, stem + ".mp4", "video/mp4");
            if (jpgUri == null || mp4Uri == null) throw new IllegalStateException("OriginOS 动态照片创建失败");
            try {
                copyFile(resolver, jpgUri, jpg);
                copyFile(resolver, mp4Uri, mp4);
                publish(resolver, jpgUri);
                publish(resolver, mp4Uri);
                return jpgUri;
            } catch (Exception error) {
                resolver.delete(jpgUri, null, null);
                resolver.delete(mp4Uri, null, null);
                throw error;
            }
        } finally {
            jpg.delete();
            mp4.delete();
        }
    }

    private static JSONObject imageDocument(String id, String model) throws Exception {
        JSONObject j = new JSONObject();
        j.put("com.android.camera.joint.fullview.orientation", 0);
        j.put("com.android.camera.fisheye", -1);
        j.put("com.android.camera.takenmodel", model);
        j.put("com.android.camera.watermarkVersion", JSONObject.NULL);
        j.put("com.android.camera.camerafacing", "0");
        j.put("com.android.camera.moduleid", "live_photo");
        j.put("com.android.camera.livephoto", id);
        j.put("version", 2014);
        j.put("com.android.camera.joint.fullview", false);
        return j;
    }

    private static JSONObject videoDocument(String id, String model, int imageTime) throws Exception {
        JSONObject j = new JSONObject();
        j.put("com.android.camera.takenmodel", model);
        j.put("com.android.camera.camerafacing", "0");
        j.put("com.android.camera.imageTime", imageTime);
        j.put("com.android.camera.moduleid", "live_photo");
        j.put("com.android.camera.livephoto", id);
        j.put("version", 2014);
        j.put("com.android.camera.faceInfo", new JSONObject());
        return j;
    }

    private static byte[] payload(JSONObject document) {
        byte[] json = document.toString().getBytes(StandardCharsets.UTF_8);
        byte[] id = document.optString("com.android.camera.livephoto").getBytes(StandardCharsets.US_ASCII);
        byte[] marker = "cameralbum!".getBytes(StandardCharsets.US_ASCII);
        int footerLength = 4 + id.length + 4 + TRAILER_MAGIC.length;
        ByteBuffer b = ByteBuffer.allocate(4 + json.length + 4 + marker.length + 4 + id.length + 4 + TRAILER_MAGIC.length).order(ByteOrder.BIG_ENDIAN);
        b.put("vivo".getBytes(StandardCharsets.US_ASCII)).put(json).putInt(json.length).put(marker).putInt(footerLength).put(id);
        b.put(new byte[]{(byte) 0xff, (byte) 0xff, (byte) 0xff, (byte) 0xff}).put(TRAILER_MAGIC);
        return b.array();
    }

    private static byte[] uuidBox(byte[] payload) {
        ByteBuffer b = ByteBuffer.allocate(8 + USER_TYPE.length + payload.length).order(ByteOrder.BIG_ENDIAN);
        b.putInt(b.capacity()).put("uuid".getBytes(StandardCharsets.US_ASCII)).put(USER_TYPE).put(payload);
        return b.array();
    }

    private static String livePhotoId() {
        byte[] r = new byte[4]; RANDOM.nextBytes(r);
        String randomHex = String.format(Locale.ROOT, "%02x%02x%02x%02x", r[0] & 255, r[1] & 255, r[2] & 255, r[3] & 255).substring(0, 7);
        return String.format(Locale.ROOT, "%013d%s00000000", System.currentTimeMillis(), randomHex);
    }

    private static Uri insert(ContentResolver resolver, Uri collection, String name, String mime) {
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DCIM + "/Camera");
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        return resolver.insert(collection, values);
    }

    private static void publish(ContentResolver resolver, Uri uri) {
        ContentValues values = new ContentValues(); values.put(MediaStore.MediaColumns.IS_PENDING, 0); resolver.update(uri, values, null, null);
    }

    private static void copyFile(ContentResolver resolver, Uri uri, File file) throws Exception {
        try (InputStream input = new BufferedInputStream(new FileInputStream(file)); OutputStream raw = resolver.openOutputStream(uri, "w")) {
            if (raw == null) throw new IllegalStateException("系统相册无法写入 vivo 动态照片");
            try (OutputStream output = new BufferedOutputStream(raw)) { byte[] buffer = new byte[128 * 1024]; int read; while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read); }
        }
    }

    private static void append(File file, byte[] bytes) throws Exception { try (OutputStream output = new FileOutputStream(file, true)) { output.write(bytes); } }
    private static byte[] hex(String value) { byte[] result = new byte[value.length() / 2]; for (int i = 0; i < result.length; i++) result[i] = (byte) Integer.parseInt(value.substring(i * 2, i * 2 + 2), 16); return result; }
}
