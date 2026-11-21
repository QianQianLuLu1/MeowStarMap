package app.nikkisync.mobile.media.live;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.media.ExifInterface;
import android.net.Uri;
import android.os.Build;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;
import androidx.media3.common.util.UnstableApi;
import app.nikkisync.mobile.model.Models.AssetDetail;
import app.nikkisync.mobile.model.Models.AssetSummary;
import app.nikkisync.mobile.model.Models.MediaResource;
import app.nikkisync.mobile.net.NikkiSyncClient;
import app.nikkisync.mobile.media.GallerySavePolicy;
import app.nikkisync.mobile.util.Hex;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.StandardOpenOption;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.net.ssl.HttpsURLConnection;

/** The only new Live export entry: verified inputs -> paired rotation -> container -> validation -> publication. */
@UnstableApi
public final class LivePhotoExporter {
    @FunctionalInterface public interface Progress { void onProgress(String stage,int percent); }
    public record Result(Uri primaryUri,List<Uri> companionUris,String profileId,String label,int rotationDegrees,
                         long presentationUs,String timestampSource,double matchError){
        public Result{companionUris=List.copyOf(companionUris);}
        public String savedFormat(){return label+(rotationDegrees==0?"":" · 图像/视频已旋转 "+rotationDegrees+"°")+" · 相册播放待确认";}
    }
    private static final SecureRandom RANDOM=new SecureRandom();
    private LivePhotoExporter(){}

    public static Result save(Context context,NikkiSyncClient client,AssetSummary asset,int clockwise,
                              LivePhotoProfile profile,Progress progress)throws Exception{
        if(Looper.myLooper()==Looper.getMainLooper())throw new IllegalStateException("Live 导出必须在后台执行器调用");
        return LiveExportGuard.run(()->saveExclusive(context,client,asset,clockwise,profile,progress));
    }
    private static Result saveExclusive(Context context,NikkiSyncClient client,AssetSummary asset,int clockwise,
                                        LivePhotoProfile profile,Progress progress)throws Exception{
        int degrees=QuarterTurn.normalize(clockwise);AtomicBoolean cleanupSafe=new AtomicBoolean(true);
        File job=Files.createTempDirectory(context.getCacheDir().toPath(),"nikkisync_live_").toFile();
        try{
            AssetDetail detail=client.asset(asset.assetId());MediaResource image=detail.originalStill(),motion=detail.motionResource();
            if(image==null||motion==null)throw new IOException("Live 静态图/视频配对资源不完整");
            if(!("image/jpeg".equals(image.mimeType())||"jpg".equalsIgnoreCase(image.fileExt())||"jpeg".equalsIgnoreCase(image.fileExt())))throw new IOException("当前 Live 封装仅支持 JPEG 封面");
            if(!"video/mp4".equals(motion.mimeType()))throw new IOException("当前 Live 封装仅支持 MP4 动态资源");
            File jpg=new File(job,"source.jpg"),mp4=new File(job,"source.mp4");
            progress.onProgress("下载并校验 Live 原始资源",0);download(client,asset.assetId(),image,jpg);download(client,asset.assetId(),motion,mp4);
            // Bound the JPEG buffer copies too; zero-degree exports never silently downsample.
            Runtime runtime=Runtime.getRuntime();long available=runtime.maxMemory()-(runtime.totalMemory()-runtime.freeMemory());
            if(jpg.length()*4+32L*1024*1024>available)throw new IOException("当前内存不足以无损重封装大图，未降低画质");
            VideoFacts sourceFacts=VideoFacts.read(mp4);
            progress.onProgress(degrees==0?"保留原始画面":"同步旋转封面和视频",0);
            LivePhotoRotation.Output rotated=LivePhotoRotation.rotate(context,jpg,mp4,degrees,job,cleanupSafe,
                value->progress.onProgress("旋转 Live 视频",value));
            Long preferred=detail.presentationTimestampUs();
            if(degrees!=0 && preferred!=null && preferred>=0){
                preferred=preferred-sourceFacts.sampleTimesUs().get(0)+rotated.videoFacts().sampleTimesUs().get(0);
            }
            CoverFrameMatcher.Match cover=CoverFrameMatcher.find(rotated.image(),rotated.video(),rotated.videoFacts(),preferred);
            long savedAt=System.currentTimeMillis();
            File galleryImage=GallerySavePolicy.prepareLiveImage(rotated.image(),job,savedAt);
            File vendorImage=vendorImage(profile,galleryImage,job);
            String pairId=String.format(Locale.ROOT,"%013d%07x00000000",System.currentTimeMillis(),RANDOM.nextInt(1<<28));
            MotionContainer.Options options=new MotionContainer.Options(cover.presentationUs(),cover.sampleIndex(),
                rotated.videoFacts().sampleTimesUs().size(),rotated.videoFacts().durationUs(),pairId,Build.MODEL);
            progress.onProgress("封装并校验 Live 容器",0);
            MotionContainer.Product product=MotionContainer.write(profile,vendorImage,rotated.video(),job,options);
            MotionContainerVerifier.verify(profile,product,rotated.video(),options);
            if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("Live 导出已取消");
            progress.onProgress("写入系统相册",0);
            List<Uri> resources=publish(context.getContentResolver(),profile,asset.assetId(),product,savedAt);
            return new Result(resources.get(0),resources.subList(1,resources.size()),profile.id,profile.label,degrees,
                cover.presentationUs(),cover.source(),cover.error());
        }finally{
            if(cleanupSafe.get()){
                try(var paths=Files.walk(job.toPath())){for(var p:paths.sorted(Comparator.reverseOrder()).collect(java.util.stream.Collectors.toList()))try{Files.deleteIfExists(p);}catch(IOException ignored){}}
                catch(IOException ignored){}
            }
        }
    }
    private static void download(NikkiSyncClient client,String assetId,MediaResource resource,File target)throws Exception{
        HttpsURLConnection connection=client.resource(assetId,resource.resourceId());
        try{
            if(connection.getResponseCode()!=200)throw new IOException("Live 资源请求失败：HTTP "+connection.getResponseCode());
            String expected=connection.getHeaderField("X-NikkiSync-SHA256");
            if(expected==null||!expected.matches("[0-9a-fA-F]{64}"))throw new IOException("PC 未返回有效 Live 资源校验值");
            MessageDigest digest=MessageDigest.getInstance("SHA-256");
            try(InputStream in=new DigestInputStream(connection.getInputStream(),digest);OutputStream out=new BufferedOutputStream(Files.newOutputStream(target.toPath(),StandardOpenOption.CREATE_NEW))){
                byte[] buffer=new byte[128*1024];int n;while((n=in.read(buffer))!=-1){if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("Live 下载已取消");out.write(buffer,0,n);}
            }
            if(!Hex.lower(digest.digest()).equalsIgnoreCase(expected))throw new IOException("Live 原始资源 SHA-256 不匹配");
        }finally{connection.disconnect();}
    }
    private static File vendorImage(LivePhotoProfile profile,File source,File job)throws IOException{
        if(profile!=LivePhotoProfile.OPLUS&&profile!=LivePhotoProfile.VIVO_LEGACY_PAIR&&profile!=LivePhotoProfile.VIVO_SINGLE_XMP)return source;
        File copy=new File(job,"vendor.jpg");Files.copy(source.toPath(),copy.toPath());ExifInterface exif=new ExifInterface(copy);
        if(profile==LivePhotoProfile.OPLUS)exif.setAttribute(ExifInterface.TAG_USER_COMMENT,"Oplus_8388608");
        else if(profile==LivePhotoProfile.VIVO_LEGACY_PAIR){
            exif.setAttribute(ExifInterface.TAG_MAKE,"vivo");exif.setAttribute(ExifInterface.TAG_MODEL,Build.MODEL);
            exif.setAttribute(ExifInterface.TAG_USER_COMMENT,"module: live_photo;");
        }else{
            // Deliberately minimal candidate: do not invent weather, hardware capture or HDR state.
            exif.setAttribute(ExifInterface.TAG_USER_COMMENT,"multi-frame: 1;\nispap:1;\nmodule: photo;");
        }
        exif.saveAttributes();return copy;
    }
    static List<Uri> publish(ContentResolver resolver,LivePhotoProfile profile,String assetId,MotionContainer.Product product)throws IOException{
        return publish(resolver,profile,assetId,product,System.currentTimeMillis());
    }
    private static List<Uri> publish(ContentResolver resolver,LivePhotoProfile profile,String assetId,MotionContainer.Product product,long savedAt)throws IOException{
        List<File> files=new ArrayList<>();files.add(product.primary());files.addAll(product.companions());List<Uri> created=new ArrayList<>();
        String safe=assetId==null?"photo":assetId.replaceAll("[^A-Za-z0-9_-]","_");if(safe.length()>48)safe=safe.substring(0,48);
        String stem=(profile.paired?"IMG_":"NikkiSync_")+safe+"_"+UUID.randomUUID().toString().substring(0,8);
        String path=GallerySavePolicy.livePath(profile);
        try{
            for(int i=0;i<files.size();i++){
                if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("Live 发布已取消");
                boolean video=i>0;ContentValues values=new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME,stem+(profile.paired?"": "_MP")+(video?".mp4":".jpg"));
                values.put(MediaStore.MediaColumns.MIME_TYPE,video?"video/mp4":"image/jpeg");
                values.put(MediaStore.MediaColumns.RELATIVE_PATH,path);values.put(MediaStore.MediaColumns.IS_PENDING,1);
                GallerySavePolicy.addDate(values,savedAt);
                Uri uri=resolver.insert(video?MediaStore.Video.Media.EXTERNAL_CONTENT_URI:MediaStore.Images.Media.EXTERNAL_CONTENT_URI,values);
                if(uri==null)throw new IOException("系统相册创建 Live 资源失败");created.add(uri); // Includes the first insert if the second one fails.
                try(OutputStream out=resolver.openOutputStream(uri,"w")){if(out==null)throw new IOException("系统相册无法写入 Live");MotionContainer.copy(files.get(i),out);}
                try(ParcelFileDescriptor fd=resolver.openFileDescriptor(uri,"r")){if(fd==null||fd.getStatSize()!=files.get(i).length())throw new IOException("系统相册 Live 写入长度不一致");}
            }
            // Companion first, primary last; still not a cross-collection transaction.
            for(int i=created.size()-1;i>=0;i--){ContentValues ready=new ContentValues();ready.put(MediaStore.MediaColumns.IS_PENDING,0);
                GallerySavePolicy.addDate(ready,savedAt);
                if(resolver.update(created.get(i),ready,null,null)!=1)throw new IOException("系统相册未完成 Live 发布");}
            return List.copyOf(created);
        }catch(Exception|OutOfMemoryError failure){
            IOException error=failure instanceof OutOfMemoryError memory?LiveExportGuard.memoryFailure(memory):
                failure instanceof IOException io?io:new IOException("Live 发布失败，已尝试撤销本次创建的媒体",failure);
            for(Uri uri:created)try{resolver.delete(uri,null,null);}catch(Exception cleanup){error.addSuppressed(cleanup);}
            throw error;
        }
    }
}
