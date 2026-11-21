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
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;

/** Samsung Gallery compatible Motion Photo writer using MotionPhoto_Data + SEF trailer. */
public final class SamsungMotionPhotoSaver {
    private static final byte[] XMP_HEADER = "http://ns.adobe.com/xap/1.0/\0".getBytes(StandardCharsets.US_ASCII);
    private static final byte[] FIELD_NAME = "MotionPhoto_Data".getBytes(StandardCharsets.US_ASCII);

    public Uri save(Context context, NikkiSyncClient client, AssetSummary asset) throws Exception {
        AssetDetail detail = client.asset(asset.assetId());
        MediaResource still = detail.originalStill();
        MediaResource motion = detail.motionResource();
        if (still == null || motion == null) throw new IllegalStateException("Samsung LIVE 资源不完整");

        File jpg = File.createTempFile("nikkisync_samsung_", ".jpg", context.getCacheDir());
        File mp4 = File.createTempFile("nikkisync_samsung_", ".mp4", context.getCacheDir());
        try {
            MotionPhotoSaver.downloadVerified(client, asset.assetId(), still, jpg);
            MotionPhotoSaver.downloadVerified(client, asset.assetId(), motion, mp4);
            long presentationUs = detail.presentationTimestampUs() == null
                    ? MotionFrameMatcher.findPresentationTimestampUs(jpg, mp4)
                    : detail.presentationTimestampUs();
            byte[] primary = jpegWithXmp(jpg, xmpPacket(presentationUs));

            long fieldSizeLong = 2L + 2L + 4L + FIELD_NAME.length + mp4.length();
            if (fieldSizeLong > 0xffffffffL) throw new IllegalStateException("Samsung Motion Photo 视频过大");
            int fieldSize = (int) fieldSizeLong;

            ContentResolver resolver = context.getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.Images.Media.DISPLAY_NAME, fileName(still.fileName()));
            values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
            values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_DCIM + "/Camera");
            values.put(MediaStore.Images.Media.IS_PENDING, 1);
            Uri uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new IllegalStateException("Samsung 动态照片创建失败");
            try {
                try (OutputStream raw = resolver.openOutputStream(uri, "w"); BufferedOutputStream output = raw == null ? null : new BufferedOutputStream(raw)) {
                    if (output == null) throw new IllegalStateException("系统相册无法写入 Samsung 动态照片");
                    output.write(primary);
                    writeFieldHeader(output);
                    try (InputStream input = new BufferedInputStream(new FileInputStream(mp4))) { copy(input, output); }
                    output.write(sefIndex(fieldSize));
                    output.flush();
                }
                ContentValues ready = new ContentValues(); ready.put(MediaStore.Images.Media.IS_PENDING, 0); resolver.update(uri, ready, null, null);
                return uri;
            } catch (Exception error) {
                resolver.delete(uri, null, null); throw error;
            }
        } finally { jpg.delete(); mp4.delete(); }
    }

    private static String fileName(String original) {
        String base = original == null ? "NikkiSync" : original.replaceFirst("(?i)\\.(jpe?g)$", "");
        return "MV" + base + ".jpg";
    }

    private static byte[] xmpPacket(long timestampUs) {
        String xml = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description rdf:about=\"\" " +
                "xmlns:GCamera=\"http://ns.google.com/photos/1.0/camera/\" GCamera:MotionPhoto=\"1\" GCamera:MotionPhotoVersion=\"1\" " +
                "GCamera:MotionPhotoPresentationTimestampUs=\"" + timestampUs + "\"/></rdf:RDF></x:xmpmeta>";
        return xml.getBytes(StandardCharsets.UTF_8);
    }

    private static void writeFieldHeader(OutputStream output) throws Exception {
        output.write(0); output.write(0); output.write(0x30); output.write(0x0A);
        output.write(le32(FIELD_NAME.length)); output.write(FIELD_NAME);
    }

    private static byte[] sefIndex(int fieldSize) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try {
            out.write("SEFH".getBytes(StandardCharsets.US_ASCII));
            out.write(le32(106));
            out.write(le32(1));
            out.write(0); out.write(0); out.write(0x30); out.write(0x0A);
            out.write(le32(fieldSize));
            out.write(le32(fieldSize));
            out.write(le32(24));
            out.write("SEFT".getBytes(StandardCharsets.US_ASCII));
        } catch (Exception impossible) { throw new IllegalStateException(impossible); }
        return out.toByteArray();
    }

    private static byte[] le32(int value) { return ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(value).array(); }

    private static byte[] jpegWithXmp(File source, byte[] xmp) throws Exception {
        try (BufferedInputStream input = new BufferedInputStream(new FileInputStream(source)); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            int a = input.read(), b = input.read(); if (a != 0xFF || b != 0xD8) throw new IllegalStateException("原始静态资源不是有效 JPEG");
            output.write(a); output.write(b); writeXmp(output, xmp);
            while (true) {
                int ff = input.read(); if (ff < 0) break; if (ff != 0xFF) throw new IllegalStateException("JPEG marker 损坏");
                int marker; do { marker = input.read(); } while (marker == 0xFF); if (marker < 0) break; output.write(0xFF); output.write(marker);
                if (marker == 0xDA) { copy(input, output); break; }
                if (marker == 0xD9 || (marker >= 0xD0 && marker <= 0xD7) || marker == 0x01) continue;
                int hi = input.read(), lo = input.read(); int length = (hi << 8) | lo; byte[] p = app.nikkisync.mobile.util.ByteStreams.readNBytes(input,length - 2);
                if (marker == 0xE1 && startsWith(p, XMP_HEADER)) continue;
                output.write(hi); output.write(lo); output.write(p);
            }
            return output.toByteArray();
        }
    }
    private static void writeXmp(OutputStream output, byte[] xmp) throws Exception { int length = 2 + XMP_HEADER.length + xmp.length; output.write(0xFF); output.write(0xE1); output.write((length >>> 8) & 0xff); output.write(length & 0xff); output.write(XMP_HEADER); output.write(xmp); }
    private static boolean startsWith(byte[] value, byte[] prefix) { if (value.length < prefix.length) return false; for (int i = 0; i < prefix.length; i++) if (value[i] != prefix[i]) return false; return true; }
    private static void copy(InputStream input, OutputStream output) throws Exception { byte[] buffer = new byte[128 * 1024]; int read; while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read); }
}
