package app.nikkisync.mobile.media;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import app.nikkisync.mobile.model.Models.AssetSummary;
import app.nikkisync.mobile.model.Models.MediaResource;
import app.nikkisync.mobile.net.NikkiSyncClient;
import app.nikkisync.mobile.util.Hex;
import app.nikkisync.mobile.util.TaskProgress;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.security.MessageDigest;
import javax.net.ssl.HttpsURLConnection;

/** A separate, byte-preserving MP4 save; never changes the LIVE export or its rotation. */
public final class OriginalVideoSaver {
    private OriginalVideoSaver() {}

    public static Uri save(Context context,NikkiSyncClient client,AssetSummary asset,TaskProgress progress) throws Exception {
        progress.update("读取原视频信息",0,0);
        MediaResource motion=client.asset(asset.assetId()).motionResource();
        if(motion==null)throw new IOException("这张照片没有原始动态视频");
        return saveDownload(context.getContentResolver(),motion,client.resource(asset.assetId(),motion.resourceId()),progress);
    }

    static Uri saveDownload(ContentResolver resolver,MediaResource motion,HttpsURLConnection connection,TaskProgress progress) throws Exception {
        Uri uri=null;
        try {
            if(!"video/mp4".equals(motion.mimeType())||motion.sizeBytes()<=0)throw new IOException("原视频资源不是有效 MP4");
            if(connection.getResponseCode()!=200)throw new IOException("原视频下载失败：HTTP "+connection.getResponseCode());
            String expected=connection.getHeaderField("X-NikkiSync-SHA256");
            if(expected==null||!expected.matches("[0-9a-fA-F]{64}"))throw new IOException("电脑未返回有效原视频校验值");
            if(motion.sha256()!=null&&!motion.sha256().isEmpty()&&!expected.equalsIgnoreCase(motion.sha256()))
                throw new IOException("原视频版本发生变化，请刷新后重试");
            String name=motion.fileName()==null?"NikkiSync_original.mp4":motion.fileName().replaceAll("[/\\\\]","_");
            if(!name.toLowerCase(java.util.Locale.ROOT).endsWith(".mp4"))name+=".mp4";
            ContentValues pending=new ContentValues();
            pending.put(MediaStore.MediaColumns.DISPLAY_NAME,name);
            pending.put(MediaStore.MediaColumns.MIME_TYPE,"video/mp4");
            pending.put(MediaStore.MediaColumns.RELATIVE_PATH,Environment.DIRECTORY_MOVIES+"/NikkiSync");
            pending.put(MediaStore.MediaColumns.IS_PENDING,1);
            uri=resolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI,pending);
            if(uri==null)throw new IOException("系统相册无法创建原视频");
            MessageDigest digest=MessageDigest.getInstance("SHA-256");
            long received=0;int lastPercent=-1;byte[] buffer=new byte[128*1024];
            progress.update("下载并保存原视频",0,motion.sizeBytes());
            try(InputStream input=connection.getInputStream();OutputStream output=resolver.openOutputStream(uri,"w")) {
                if(output==null)throw new IOException("系统相册无法写入原视频");
                int n;while((n=input.read(buffer))!=-1) {
                    checkCancelled();received+=n;
                    if(received>motion.sizeBytes())throw new IOException("原视频长度与电脑记录不一致");
                    digest.update(buffer,0,n);output.write(buffer,0,n);
                    int percent=(int)(received*100.0/motion.sizeBytes());
                    if(percent!=lastPercent){lastPercent=percent;progress.update("下载并保存原视频",received,motion.sizeBytes());}
                }
            }
            if(received!=motion.sizeBytes()||!expected.equalsIgnoreCase(Hex.lower(digest.digest())))
                throw new IOException("原视频校验失败，已取消保存");
            // Read back the actual stored file before publishing, not just the network buffer.
            progress.update("核对相册原视频",0,received);digest.reset();long stored=0;
            try(InputStream input=resolver.openInputStream(uri)) {
                if(input==null)throw new IOException("系统相册无法读取已写入的视频");
                int n;while((n=input.read(buffer))!=-1){checkCancelled();stored+=n;digest.update(buffer,0,n);}
            }
            if(stored!=received||!expected.equalsIgnoreCase(Hex.lower(digest.digest())))
                throw new IOException("相册写入的视频与原视频不一致，已取消保存");
            checkCancelled();ContentValues ready=new ContentValues();ready.put(MediaStore.MediaColumns.IS_PENDING,0);
            if(resolver.update(uri,ready,null,null)!=1)throw new IOException("系统相册未完成原视频保存");
            progress.update("保存完成",1,1);return uri;
        } catch(Exception error) {
            if(uri!=null)try{resolver.delete(uri,null,null);}catch(Exception cleanup){error.addSuppressed(cleanup);}
            throw error;
        } finally {connection.disconnect();}
    }
    private static void checkCancelled() throws InterruptedIOException {
        if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("原视频保存已取消");
    }
}
