package app.nikkisync.mobile.media;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;

import app.nikkisync.mobile.model.Models.AssetDetail;
import app.nikkisync.mobile.model.Models.AssetSummary;
import app.nikkisync.mobile.model.Models.MediaResource;
import app.nikkisync.mobile.net.NikkiSyncClient;
import app.nikkisync.mobile.util.Hex;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.DigestInputStream;
import java.security.MessageDigest;

import javax.net.ssl.HttpsURLConnection;

/** Android Motion Photo 1.0 writer for Infinity Nikki JPEG + MP4 motion bundles. */
public final class MotionPhotoSaver {
    private static final byte[] XMP_HEADER = "http://ns.adobe.com/xap/1.0/\0".getBytes(StandardCharsets.US_ASCII);

    public Uri save(Context context, NikkiSyncClient client, AssetSummary asset) throws Exception {
        AssetDetail detail = client.asset(asset.assetId());
        MediaResource still = detail.originalStill();
        MediaResource motion = detail.motionResource();
        if (still == null || motion == null) throw new IllegalStateException("LIVE 资源不完整");
        if (!("image/jpeg".equals(still.mimeType()) || "jpg".equalsIgnoreCase(still.fileExt()) || "jpeg".equalsIgnoreCase(still.fileExt()))) {
            throw new IllegalStateException("M3.0 当前仅支持 JPEG 实况封装");
        }
        if (!"video/mp4".equals(motion.mimeType())) throw new IllegalStateException("M3.0 当前仅支持 MP4 动态资源");

        File stillFile = File.createTempFile("nikkisync_still_", ".jpg", context.getCacheDir());
        File motionFile = File.createTempFile("nikkisync_motion_", ".mp4", context.getCacheDir());
        try {
            downloadVerified(client, asset.assetId(), still, stillFile);
            downloadVerified(client, asset.assetId(), motion, motionFile);
            long timestampUs = detail.presentationTimestampUs() == null
                    ? estimatePresentationTimestampUs(stillFile, motionFile)
                    : detail.presentationTimestampUs();
            byte[] xmp = xmpPacket(motionFile.length(), timestampUs);
            if (XMP_HEADER.length + xmp.length + 2 > 65535) throw new IllegalStateException("Motion Photo XMP 过大");

            ContentResolver resolver = context.getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.Images.Media.DISPLAY_NAME, motionFileName(still.fileName()));
            values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
            values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/NikkiSync");
            values.put(MediaStore.Images.Media.IS_PENDING, 1);
            Uri uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new IllegalStateException("系统相册创建 Motion Photo 失败");
            try {
                try (OutputStream raw = resolver.openOutputStream(uri, "w");
                     BufferedOutputStream output = raw == null ? null : new BufferedOutputStream(raw)) {
                    if (output == null) throw new IllegalStateException("系统相册无法写入 Motion Photo");
                    writeJpegWithMotionXmp(stillFile, xmp, output);
                    try (InputStream video = new BufferedInputStream(new FileInputStream(motionFile))) { copy(video, output); }
                    output.flush();
                }
                ContentValues ready = new ContentValues(); ready.put(MediaStore.Images.Media.IS_PENDING, 0); resolver.update(uri, ready, null, null);
                return uri;
            } catch (Exception error) {
                resolver.delete(uri, null, null); throw error;
            }
        } finally {
            //noinspection ResultOfMethodCallIgnored
            stillFile.delete();
            //noinspection ResultOfMethodCallIgnored
            motionFile.delete();
        }
    }

    static void downloadVerified(NikkiSyncClient client, String assetId, MediaResource resource, File target) throws Exception {
        HttpsURLConnection connection = client.resource(assetId, resource.resourceId());
        try {
            if (connection.getResponseCode() != 200) throw new IllegalStateException("资源请求失败：HTTP " + connection.getResponseCode());
            String expected = connection.getHeaderField("X-NikkiSync-SHA256");
            if (expected == null || !expected.matches("[0-9a-fA-F]{64}")) throw new SecurityException("PC 未返回有效资源 SHA-256");
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (InputStream raw = connection.getInputStream(); DigestInputStream input = new DigestInputStream(raw, digest);
                 OutputStream output = new BufferedOutputStream(new FileOutputStream(target))) { copy(input, output); }
            if (!Hex.lower(digest.digest()).equalsIgnoreCase(expected)) throw new SecurityException("资源 SHA-256 校验失败");
        } finally { connection.disconnect(); }
    }

    private static String motionFileName(String original) {
        String base = original == null ? "NikkiSync" : original.replaceFirst("(?i)\\.(jpe?g)$", "");
        if (!base.endsWith("MP")) base += "_MP";
        return base + ".jpg";
    }

    private static byte[] xmpPacket(long videoLength, long timestampUs) {
        String xml = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description rdf:about=\"\" " +
                "xmlns:Camera=\"http://ns.google.com/photos/1.0/camera/\" " +
                "xmlns:Container=\"http://ns.google.com/photos/1.0/container/\" " +
                "xmlns:Item=\"http://ns.google.com/photos/1.0/container/item/\" " +
                "Camera:MotionPhoto=\"1\" Camera:MotionPhotoVersion=\"1\" Camera:MotionPhotoPresentationTimestampUs=\"" + timestampUs + "\" " +
                "Camera:MicroVideo=\"1\" Camera:MicroVideoVersion=\"1\" Camera:MicroVideoOffset=\"" + videoLength + "\" Camera:MicroVideoPresentationTimestampUs=\"" + timestampUs + "\">" +
                "<Container:Directory><rdf:Seq>" +
                "<rdf:li rdf:parseType=\"Resource\"><Container:Item Item:Mime=\"image/jpeg\" Item:Semantic=\"Primary\"/></rdf:li>" +
                "<rdf:li rdf:parseType=\"Resource\"><Container:Item Item:Mime=\"video/mp4\" Item:Semantic=\"MotionPhoto\" Item:Length=\"" + videoLength + "\"/></rdf:li>" +
                "</rdf:Seq></Container:Directory></rdf:Description></rdf:RDF></x:xmpmeta>";
        return xml.getBytes(StandardCharsets.UTF_8);
    }

    private static long estimatePresentationTimestampUs(File stillFile, File motionFile) {
        Bitmap still = null;
        MediaMetadataRetriever retriever = new MediaMetadataRetriever();
        try {
            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inSampleSize = 16;
            still = BitmapFactory.decodeFile(stillFile.getAbsolutePath(), options);
            if (still == null) return 0L;
            Bitmap reference = Bitmap.createScaledBitmap(still, 64, 36, true);
            if (reference != still) still.recycle();
            still = reference;

            retriever.setDataSource(motionFile.getAbsolutePath());
            String durationValue = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
            long durationUs = durationValue == null ? 0L : Long.parseLong(durationValue) * 1000L;
            if (durationUs <= 0) return 0L;

            long coarseStep = 250_000L;
            long bestUs = 0L;
            double bestScore = Double.MAX_VALUE;
            for (long t = 0; t <= durationUs; t += coarseStep) {
                double score = frameScore(retriever, t, still);
                if (score < bestScore) { bestScore = score; bestUs = t; }
            }

            long fineStart = Math.max(0L, bestUs - coarseStep);
            long fineEnd = Math.min(durationUs, bestUs + coarseStep);
            for (long t = fineStart; t <= fineEnd; t += 50_000L) {
                double score = frameScore(retriever, t, still);
                if (score < bestScore) { bestScore = score; bestUs = t; }
            }
            return bestUs;
        } catch (Exception ignored) {
            return 0L;
        } finally {
            if (still != null && !still.isRecycled()) still.recycle();
            try { retriever.release(); } catch (Exception ignored) {}
        }
    }

    private static double frameScore(MediaMetadataRetriever retriever, long timeUs, Bitmap reference) {
        Bitmap frame = null;
        Bitmap scaled = null;
        try {
            frame = retriever.getScaledFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST, 64, 36);
            if (frame == null) return Double.MAX_VALUE;
            scaled = frame.getWidth() == 64 && frame.getHeight() == 36 ? frame : Bitmap.createScaledBitmap(frame, 64, 36, true);
            long sum = 0L;
            for (int y = 0; y < 36; y += 2) {
                for (int x = 0; x < 64; x += 2) {
                    int a = reference.getPixel(x, y), b = scaled.getPixel(x, y);
                    int ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
                    int br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
                    int dr = ar - br, dg = ag - bg, db = ab - bb;
                    sum += (long) dr * dr + (long) dg * dg + (long) db * db;
                }
            }
            return sum;
        } catch (Exception ignored) {
            return Double.MAX_VALUE;
        } finally {
            if (scaled != null && scaled != frame && !scaled.isRecycled()) scaled.recycle();
            if (frame != null && !frame.isRecycled()) frame.recycle();
        }
    }

    private static void writeJpegWithMotionXmp(File still, byte[] xmp, OutputStream output) throws Exception {
        try (BufferedInputStream input = new BufferedInputStream(new FileInputStream(still))) {
            int a = input.read(), b = input.read();
            if (a != 0xFF || b != 0xD8) throw new IllegalStateException("原始静态资源不是有效 JPEG");
            output.write(a); output.write(b); writeXmpSegment(output, xmp);
            while (true) {
                int ff = input.read(); if (ff < 0) return;
                if (ff != 0xFF) throw new IllegalStateException("JPEG marker 损坏");
                int marker; do { marker = input.read(); } while (marker == 0xFF);
                if (marker < 0) return;
                output.write(0xFF); output.write(marker);
                if (marker == 0xDA) { copy(input, output); return; }
                if (marker == 0xD9 || (marker >= 0xD0 && marker <= 0xD7) || marker == 0x01) continue;
                int hi = input.read(), lo = input.read(); if (hi < 0 || lo < 0) throw new IllegalStateException("JPEG segment 截断");
                int length = (hi << 8) | lo; if (length < 2) throw new IllegalStateException("JPEG segment 长度无效");
                byte[] payload = app.nikkisync.mobile.util.ByteStreams.readNBytes(input,length - 2); if (payload.length != length - 2) throw new IllegalStateException("JPEG segment 截断");
                if (marker == 0xE1 && startsWith(payload, XMP_HEADER)) continue; // Replace any old main XMP packet.
                output.write(hi); output.write(lo); output.write(payload);
            }
        }
    }

    private static void writeXmpSegment(OutputStream output, byte[] xmp) throws Exception {
        int length = 2 + XMP_HEADER.length + xmp.length;
        output.write(0xFF); output.write(0xE1); output.write((length >>> 8) & 0xFF); output.write(length & 0xFF); output.write(XMP_HEADER); output.write(xmp);
    }

    private static boolean startsWith(byte[] value, byte[] prefix) {
        if (value.length < prefix.length) return false;
        for (int i = 0; i < prefix.length; i++) if (value[i] != prefix[i]) return false;
        return true;
    }

    private static void copy(InputStream input, OutputStream output) throws Exception {
        byte[] buffer = new byte[128 * 1024]; int read;
        while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
    }
}
