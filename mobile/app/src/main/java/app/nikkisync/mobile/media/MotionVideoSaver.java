package app.nikkisync.mobile.media;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.provider.MediaStore;
import app.nikkisync.mobile.media.live.LivePhotoRotation;
import app.nikkisync.mobile.media.live.QuarterTurn;
import app.nikkisync.mobile.model.Models.AssetSummary;
import app.nikkisync.mobile.model.Models.MediaResource;
import app.nikkisync.mobile.net.NikkiSyncClient;
import app.nikkisync.mobile.util.Hex;
import app.nikkisync.mobile.util.TaskProgress;
import java.io.*;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.Comparator;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.IntConsumer;
import javax.net.ssl.HttpsURLConnection;

/** Separate MP4 export following the captured preview angle; never registers a saved LIVE. */
@androidx.annotation.OptIn(markerClass=androidx.media3.common.util.UnstableApi.class)
public final class MotionVideoSaver {
    private MotionVideoSaver() {}
    @FunctionalInterface interface VideoTransform {
        File rotate(File input,int degrees,File job,AtomicBoolean cleanupSafe,IntConsumer progress) throws Exception;
    }
    public static Uri save(Context context,NikkiSyncClient client,AssetSummary asset,int clockwise,TaskProgress progress) throws Exception {
        int degrees=QuarterTurn.normalize(clockwise);
        progress.update("读取视频信息",0,0);
        MediaResource motion=client.asset(asset.assetId()).motionResource();
        if(motion==null)throw new IOException("这张照片没有动态视频");
        return saveDownload(context,motion,client.resource(asset.assetId(),motion.resourceId()),degrees,progress,
            (input,angle,job,safe,update)->LivePhotoRotation.rotateVideoOnly(context,input,angle,job,safe,update));
    }
    static Uri saveDownload(Context context,MediaResource motion,HttpsURLConnection connection,int clockwise,
                            TaskProgress progress,VideoTransform rotation) throws Exception {
        int degrees=QuarterTurn.normalize(clockwise);
        // Preserve the existing byte-for-byte download/readback path for an unrotated export.
        if(degrees==0)return OriginalVideoSaver.saveDownload(context.getContentResolver(),motion,connection,progress);
        File job=null;AtomicBoolean cleanupSafe=new AtomicBoolean(true);
        try {
            checkCancelled();
            if(!"video/mp4".equals(motion.mimeType())||motion.sizeBytes()<=0)throw new IOException("动态视频不是有效 MP4");
            if(connection.getResponseCode()!=200)throw new IOException("视频下载失败：HTTP "+connection.getResponseCode());
            String expected=connection.getHeaderField("X-NikkiSync-SHA256");
            if(expected==null||!expected.matches("[0-9a-fA-F]{64}"))throw new IOException("电脑未返回有效视频校验值");
            if(motion.sha256()!=null&&!motion.sha256().isEmpty()&&!expected.equalsIgnoreCase(motion.sha256()))
                throw new IOException("视频版本发生变化，请刷新后重试");
            job=Files.createTempDirectory(context.getCacheDir().toPath(),"nikkisync_video_").toFile();
            File input=new File(job,"source.mp4");
            MessageDigest hash=MessageDigest.getInstance("SHA-256");long received=0;int last=-1;byte[] buffer=new byte[128*1024];
            progress.update("下载视频",0,motion.sizeBytes());
            try(InputStream in=connection.getInputStream();OutputStream out=new BufferedOutputStream(Files.newOutputStream(input.toPath()))) {
                int n;while((n=in.read(buffer))!=-1){
                    checkCancelled();received+=n;if(received>motion.sizeBytes())throw new IOException("视频长度与电脑记录不一致");
                    hash.update(buffer,0,n);out.write(buffer,0,n);
                    int percent=(int)(received*100.0/motion.sizeBytes());
                    if(percent!=last){last=percent;progress.update("下载视频",received,motion.sizeBytes());}
                }
            }
            if(received!=motion.sizeBytes()||!expected.equalsIgnoreCase(Hex.lower(hash.digest())))throw new IOException("视频下载校验失败");
            checkCancelled();progress.update("旋转视频",0,0);
            File output=rotation.rotate(input,degrees,job,cleanupSafe,value->progress.update("旋转视频",value,100));
            if(!cleanupSafe.get())throw new IOException("视频编码器尚未停止，未发布到相册");
            if(output==null||output.equals(input)||!output.isFile()||output.length()==0)throw new IOException("未生成旋转后的视频");
            return publish(context.getContentResolver(),output,motion.fileName(),degrees,progress);
        } finally {
            connection.disconnect();
            if(job!=null&&cleanupSafe.get())try(var paths=Files.walk(job.toPath())) {
                for(var path:paths.sorted(Comparator.reverseOrder()).collect(java.util.stream.Collectors.toList()))try{Files.deleteIfExists(path);}catch(IOException ignored){}
            } catch(IOException ignored){}
        }
    }
    private static Uri publish(ContentResolver resolver,File file,String sourceName,int degrees,TaskProgress progress) throws Exception {
        Uri uri=null;
        try {
            checkCancelled();
            String stem=sourceName==null?"NikkiSync":sourceName.replaceAll("[/\\\\]","_").replaceFirst("(?i)\\.mp4$","");
            if(stem.length()>80)stem=stem.substring(0,80);
            ContentValues pending=new ContentValues();
            pending.put(MediaStore.MediaColumns.DISPLAY_NAME,stem+"_rotated_"+degrees+"_"+UUID.randomUUID().toString().substring(0,8)+".mp4");
            pending.put(MediaStore.MediaColumns.MIME_TYPE,"video/mp4");
            pending.put(MediaStore.MediaColumns.RELATIVE_PATH,"Movies/NikkiSync");
            pending.put(MediaStore.MediaColumns.IS_PENDING,1);
            uri=resolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI,pending);
            if(uri==null)throw new IOException("系统相册无法创建视频");
            MessageDigest hash=MessageDigest.getInstance("SHA-256");long size=file.length(),written=0;byte[] buffer=new byte[128*1024];int last=-1;
            progress.update("写入相册视频",0,size);
            try(InputStream in=Files.newInputStream(file.toPath());OutputStream out=resolver.openOutputStream(uri,"w")) {
                if(out==null)throw new IOException("系统相册无法写入视频");
                int n;while((n=in.read(buffer))!=-1){
                    checkCancelled();written+=n;hash.update(buffer,0,n);out.write(buffer,0,n);
                    int percent=(int)(written*100.0/size);if(percent!=last){last=percent;progress.update("写入相册视频",written,size);}
                }
            }
            if(written!=size)throw new IOException("旋转视频写入长度不一致");
            String expected=Hex.lower(hash.digest());hash.reset();long stored=0;
            progress.update("核对相册视频",0,size);
            try(InputStream in=resolver.openInputStream(uri)) {
                if(in==null)throw new IOException("系统相册无法读取视频");
                int n;while((n=in.read(buffer))!=-1){checkCancelled();stored+=n;hash.update(buffer,0,n);}
            }
            if(stored!=size||!expected.equals(Hex.lower(hash.digest())))throw new IOException("相册视频校验失败");
            checkCancelled();ContentValues ready=new ContentValues();ready.put(MediaStore.MediaColumns.IS_PENDING,0);
            if(resolver.update(uri,ready,null,null)!=1)throw new IOException("系统相册未完成视频保存");
            progress.update("保存完成",1,1);return uri;
        } catch(Exception error) {
            if(uri!=null)try{resolver.delete(uri,null,null);}catch(Exception cleanup){error.addSuppressed(cleanup);}
            throw error;
        }
    }
    private static void checkCancelled() throws InterruptedIOException {
        if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("视频保存已取消");
    }
}
