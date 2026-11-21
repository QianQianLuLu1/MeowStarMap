package app.nikkisync.mobile.media;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.media.ExifInterface;
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

/** ColorOS / OxygenOS / realme UI O-Live single-file writer. */
public final class OppoLivePhotoSaver {
    private static final byte[] XMP_HEADER = "http://ns.adobe.com/xap/1.0/\0".getBytes(StandardCharsets.US_ASCII);

    public Uri save(Context context, NikkiSyncClient client, AssetSummary asset) throws Exception {
        AssetDetail detail = client.asset(asset.assetId());
        MediaResource still = detail.originalStill();
        MediaResource motion = detail.motionResource();
        if (still == null || motion == null) throw new IllegalStateException("OPPO LIVE 资源不完整");

        File jpg = File.createTempFile("nikkisync_oppo_", ".jpg", context.getCacheDir());
        File mp4 = File.createTempFile("nikkisync_oppo_", ".mp4", context.getCacheDir());
        try {
            MotionPhotoSaver.downloadVerified(client, asset.assetId(), still, jpg);
            MotionPhotoSaver.downloadVerified(client, asset.assetId(), motion, mp4);
            long presentationUs = detail.presentationTimestampUs() == null
                    ? MotionFrameMatcher.findPresentationTimestampUs(jpg, mp4)
                    : detail.presentationTimestampUs();

            ExifInterface exif = new ExifInterface(jpg);
            exif.setAttribute(ExifInterface.TAG_USER_COMMENT, "Oplus_8388608");
            exif.saveAttributes();

            byte[] primary = jpegWithVendorSegments(jpg, xmpPacket(mp4.length(), presentationUs), mpfSegment(jpg.length()));
            ContentResolver resolver = context.getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.Images.Media.DISPLAY_NAME, fileName(still.fileName()));
            values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
            values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_DCIM + "/Camera");
            values.put(MediaStore.Images.Media.IS_PENDING, 1);
            Uri uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new IllegalStateException("ColorOS 动态照片创建失败");
            try {
                try (OutputStream raw = resolver.openOutputStream(uri, "w"); BufferedOutputStream output = raw == null ? null : new BufferedOutputStream(raw)) {
                    if (output == null) throw new IllegalStateException("系统相册无法写入 OPPO 动态照片");
                    output.write(primary);
                    try (InputStream input = new BufferedInputStream(new FileInputStream(mp4))) { copy(input, output); }
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
        return base + "_OLIVE.jpg";
    }

    private static byte[] xmpPacket(long videoLength, long timestampUs) {
        String xml = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description rdf:about=\"\" " +
                "xmlns:GCamera=\"http://ns.google.com/photos/1.0/camera/\" xmlns:Container=\"http://ns.google.com/photos/1.0/container/\" xmlns:Item=\"http://ns.google.com/photos/1.0/container/item/\" " +
                "xmlns:OpCamera=\"http://ns.oplus.com/photos/1.0/camera/\" GCamera:MotionPhoto=\"1\" GCamera:MotionPhotoVersion=\"1\" " +
                "GCamera:MotionPhotoPresentationTimestampUs=\"" + timestampUs + "\" OpCamera:MotionPhotoOwner=\"oplus\" OpCamera:OLivePhotoVersion=\"2\" " +
                "OpCamera:MotionPhotoFeatureFlag=\"1\" OpCamera:VideoLength=\"" + videoLength + "\"><Container:Directory><rdf:Seq>" +
                "<rdf:li rdf:parseType=\"Resource\"><Container:Item Item:Mime=\"image/jpeg\" Item:Semantic=\"Primary\"/></rdf:li>" +
                "<rdf:li rdf:parseType=\"Resource\"><Container:Item Item:Mime=\"video/mp4\" Item:Semantic=\"MotionPhoto\" Item:Length=\"" + videoLength + "\"/></rdf:li>" +
                "</rdf:Seq></Container:Directory></rdf:Description></rdf:RDF></x:xmpmeta>";
        return xml.getBytes(StandardCharsets.UTF_8);
    }

    private static byte[] mpfSegment(long jpegLength) throws Exception {
        ByteArrayOutputStream payload = new ByteArrayOutputStream(); payload.write("MPF\0".getBytes(StandardCharsets.US_ASCII));
        ByteBuffer tiff = ByteBuffer.allocate(66).order(ByteOrder.LITTLE_ENDIAN);
        tiff.put((byte) 'I').put((byte) 'I').putShort((short) 42).putInt(8).putShort((short) 3);
        putIfd(tiff, 0xB000, 7, 4, 0x30313030); putIfd(tiff, 0xB001, 4, 1, 1); putIfd(tiff, 0xB002, 7, 16, 50); tiff.putInt(0);
        tiff.putInt(0x00030000).putInt((int) Math.min(Integer.MAX_VALUE, jpegLength)).putInt(0).putShort((short) 0).putShort((short) 0);
        payload.write(tiff.array()); byte[] p = payload.toByteArray(); ByteArrayOutputStream segment = new ByteArrayOutputStream();
        segment.write(0xFF); segment.write(0xE2); int length = p.length + 2; segment.write((length >>> 8) & 0xff); segment.write(length & 0xff); segment.write(p); return segment.toByteArray();
    }
    private static void putIfd(ByteBuffer b, int tag, int type, int count, int valueOrOffset) { b.putShort((short) tag).putShort((short) type).putInt(count).putInt(valueOrOffset); }

    private static byte[] jpegWithVendorSegments(File source, byte[] xmp, byte[] mpf) throws Exception {
        try (BufferedInputStream input = new BufferedInputStream(new FileInputStream(source)); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            int a = input.read(), b = input.read(); if (a != 0xFF || b != 0xD8) throw new IllegalStateException("原始静态资源不是有效 JPEG");
            output.write(a); output.write(b); writeXmp(output, xmp); output.write(mpf);
            while (true) {
                int ff = input.read(); if (ff < 0) break; if (ff != 0xFF) throw new IllegalStateException("JPEG marker 损坏");
                int marker; do { marker = input.read(); } while (marker == 0xFF); if (marker < 0) break; output.write(0xFF); output.write(marker);
                if (marker == 0xDA) { copy(input, output); break; }
                if (marker == 0xD9 || (marker >= 0xD0 && marker <= 0xD7) || marker == 0x01) continue;
                int hi = input.read(), lo = input.read(); int length = (hi << 8) | lo; byte[] p = app.nikkisync.mobile.util.ByteStreams.readNBytes(input,length - 2);
                if (marker == 0xE1 && startsWith(p, XMP_HEADER)) continue;
                if (marker == 0xE2 && p.length >= 4 && p[0] == 'M' && p[1] == 'P' && p[2] == 'F' && p[3] == 0) continue;
                output.write(hi); output.write(lo); output.write(p);
            }
            return output.toByteArray();
        }
    }
    private static void writeXmp(OutputStream output, byte[] xmp) throws Exception { int length = 2 + XMP_HEADER.length + xmp.length; output.write(0xFF); output.write(0xE1); output.write((length >>> 8) & 0xff); output.write(length & 0xff); output.write(XMP_HEADER); output.write(xmp); }
    private static boolean startsWith(byte[] value, byte[] prefix) { if (value.length < prefix.length) return false; for (int i = 0; i < prefix.length; i++) if (value[i] != prefix[i]) return false; return true; }
    private static void copy(InputStream input, OutputStream output) throws Exception { byte[] buffer = new byte[128 * 1024]; int read; while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read); }
}
