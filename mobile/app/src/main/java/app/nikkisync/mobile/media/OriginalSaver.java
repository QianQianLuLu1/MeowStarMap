package app.nikkisync.mobile.media;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.media.ExifInterface;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;

import app.nikkisync.mobile.model.Models.AssetDetail;
import app.nikkisync.mobile.model.Models.AssetSummary;
import app.nikkisync.mobile.model.Models.MediaResource;
import app.nikkisync.mobile.net.NikkiSyncClient;

import java.io.InputStream;
import java.io.OutputStream;
import java.security.DigestInputStream;
import java.security.MessageDigest;

import app.nikkisync.mobile.util.Hex;
import app.nikkisync.mobile.util.TaskProgress;

import javax.net.ssl.HttpsURLConnection;

public final class OriginalSaver {
    public Uri save(Context context, NikkiSyncClient client, AssetSummary asset) throws Exception {
        return save(context, client, asset, 0);
    }

    /**
     * Save an ordinary still while preserving the downloaded JPEG bytes. A non-zero
     * rotation is written as EXIF orientation only after the signed download has passed
     * SHA-256 verification, so NikkiSync does not recompress or degrade the source image.
     */
    public Uri save(Context context, NikkiSyncClient client, AssetSummary asset, int rotationDegrees) throws Exception {
        return save(context,client,asset,rotationDegrees,TaskProgress.NONE);
    }
    public Uri save(Context context,NikkiSyncClient client,AssetSummary asset,int rotationDegrees,TaskProgress progress) throws Exception {
        progress.update("读取照片信息",0,0);
        int normalizedRotation = normalizeRotation(rotationDegrees);
        AssetDetail detail = client.asset(asset.assetId());
        MediaResource original = detail.originalStill();
        if (original == null) throw new IllegalStateException("这张照片没有可保存的原始静态资源");
        if (normalizedRotation != 0 && !isJpeg(original.mimeType())) {
            throw new IllegalStateException("当前仅支持 JPEG 普通照片旋转保存");
        }

        boolean attachExif = context.getSharedPreferences("nikkisync.export", Context.MODE_PRIVATE).getBoolean("writeExif", true);
        boolean exported = isJpeg(original.mimeType()) && (attachExif || normalizedRotation != 0);
        var watermark=new app.nikkisync.mobile.storage.ExportWatermarkStore(context);
        String cameraName=attachExif?watermark.exifCameraName(detail.metadataJson()):null;
        HttpsURLConnection connection = exported ? client.exportStill(asset.assetId(), original.resourceId(), attachExif, normalizedRotation,cameraName)
                : client.resource(asset.assetId(), original.resourceId());
        int status = connection.getResponseCode();
        if (status != 200) { connection.disconnect(); throw new IllegalStateException(exported ? "照片导出失败，请确认电脑已更新 NikkiSync：HTTP " + status : "原图请求失败：HTTP " + status); }
        if (exported && (!Integer.toString(normalizedRotation).equals(connection.getHeaderField("X-NikkiSync-Rotation"))
                || !(attachExif ? "1" : "0").equals(connection.getHeaderField("X-NikkiSync-Exif"))
                || !"jpeg-exif-v1".equals(connection.getHeaderField("X-NikkiSync-Export")))) {
            connection.disconnect(); throw new SecurityException("电脑返回的照片导出选项不一致");
        }
        String expectedHash = connection.getHeaderField("X-NikkiSync-SHA256");
        if (expectedHash == null || !expectedHash.matches("[0-9a-fA-F]{64}")) {
            connection.disconnect();
            throw new SecurityException("PC 未返回有效原图 SHA-256");
        }

        ContentResolver resolver = context.getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, original.fileName());
        values.put(MediaStore.Images.Media.MIME_TYPE, original.mimeType());
        values.put(MediaStore.Images.Media.RELATIVE_PATH, GallerySavePolicy.stillPath());
        values.put(MediaStore.Images.Media.IS_PENDING, 1);
        Uri uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new IllegalStateException("系统相册创建文件失败");

        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long length=connection.getContentLengthLong();long completed=0;int last=-1;
            progress.update("下载并写入原图",0,length);
            try (InputStream raw = connection.getInputStream();
                 DigestInputStream input = new DigestInputStream(raw, digest);
                 OutputStream output = resolver.openOutputStream(uri, "w")) {
                if (output == null) throw new IllegalStateException("系统相册无法写入文件");
                byte[] buffer = new byte[128 * 1024]; int read;
                while ((read = input.read(buffer)) >= 0) {
                    if(Thread.currentThread().isInterrupted())throw new java.io.InterruptedIOException("保存已取消");
                    output.write(buffer, 0, read);completed+=read;
                    int percent=length>0?(int)Math.min(100,completed*100.0/length):-1;
                    if(percent!=last){last=percent;progress.update("下载并写入原图",completed,length);}
                }
                output.flush();
            }
            String actualHash = Hex.lower(digest.digest());
            progress.update("校验原图并完成保存",0,0);
            if (!actualHash.equalsIgnoreCase(expectedHash)) {
                throw new SecurityException("原图 SHA-256 校验失败，已取消保存");
            }
            if (!exported && normalizedRotation != 0) applyExifRotation(resolver, uri, normalizedRotation);
            if(attachExif&&isJpeg(original.mimeType())){
                var localMetadata=PhotoExif.metadata(context,detail.metadataJson(),asset.capturedAt(),asset.gameVersion());
                // A newer PC can supply a verified future title before this phone's catalog is updated.
                if(!localMetadata.has("versionName")&&exported){
                    try(var fd=resolver.openFileDescriptor(uri,"r")){
                        if(fd!=null){
                            var pcExif=new androidx.exifinterface.media.ExifInterface(fd.getFileDescriptor());
                            String description=pcExif.getAttribute(androidx.exifinterface.media.ExifInterface.TAG_IMAGE_DESCRIPTION);
                            String prefix="Infinity Nikki virtual photography; game parameters: ";
                            if(description!=null&&description.startsWith(prefix)){
                                var pcMetadata=new org.json.JSONObject(description.substring(prefix.length()));
                                String title=pcMetadata.optString("versionName","");
                                if(localMetadata.optString("version","").equals(pcMetadata.optString("version",""))
                                    &&title.matches("[A-Za-z0-9][A-Za-z0-9 '\\-:,]{0,119}"))localMetadata.put("versionName",title);
                            }
                        }
                    }
                }
                PhotoExif.write(context,uri,localMetadata);
            }
            long savedAt=System.currentTimeMillis();
            GallerySavePolicy.prepareStill(resolver,uri,original.mimeType(),savedAt);
            ContentValues ready = new ContentValues();
            GallerySavePolicy.addDate(ready,savedAt);
            ready.put(MediaStore.Images.Media.IS_PENDING, 0);
            if(resolver.update(uri, ready, null, null)!=1)throw new java.io.IOException("系统相册未完成照片发布");
            progress.update("保存完成",1,1);
            return uri;
        } catch (Exception error) {
            resolver.delete(uri, null, null);
            throw error;
        } finally {
            connection.disconnect();
        }
    }

    private static boolean isJpeg(String mimeType) {
        return "image/jpeg".equalsIgnoreCase(mimeType) || "image/jpg".equalsIgnoreCase(mimeType);
    }

    private static int normalizeRotation(int rotationDegrees) {
        int normalized = ((rotationDegrees % 360) + 360) % 360;
        if (normalized != 0 && normalized != 90 && normalized != 180 && normalized != 270) {
            throw new IllegalArgumentException("照片旋转角度必须为 0/90/180/270");
        }
        return normalized;
    }

    private static void applyExifRotation(ContentResolver resolver, Uri uri, int rotationDegrees) throws Exception {
        int orientation = switch (rotationDegrees) {
            case 90 -> ExifInterface.ORIENTATION_ROTATE_90;
            case 180 -> ExifInterface.ORIENTATION_ROTATE_180;
            case 270 -> ExifInterface.ORIENTATION_ROTATE_270;
            default -> ExifInterface.ORIENTATION_NORMAL;
        };
        try (ParcelFileDescriptor descriptor = resolver.openFileDescriptor(uri, "rw")) {
            if (descriptor == null) throw new IllegalStateException("系统相册无法更新照片方向");
            ExifInterface exif = new ExifInterface(descriptor.getFileDescriptor());
            exif.setAttribute(ExifInterface.TAG_ORIENTATION, Integer.toString(orientation));
            exif.saveAttributes();
        }
    }
}
