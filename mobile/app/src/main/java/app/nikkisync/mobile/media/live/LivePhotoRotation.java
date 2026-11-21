package app.nikkisync.mobile.media.live;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.net.Uri;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.util.Size;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.effect.MatrixTransformation;
import androidx.media3.effect.ScaleAndRotateTransformation;
import androidx.media3.transformer.Composition;
import androidx.media3.transformer.DefaultEncoderFactory;
import androidx.media3.transformer.EditedMediaItem;
import androidx.media3.transformer.Effects;
import androidx.media3.transformer.ExportException;
import androidx.media3.transformer.ExportResult;
import androidx.media3.transformer.ProgressHolder;
import androidx.media3.transformer.TransformationRequest;
import androidx.media3.transformer.Transformer;
import java.io.File;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.StandardOpenOption;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.IntConsumer;

/** Physical, paired-media rotation. Worker-thread API; Transformer stays on its own application Looper. */
@UnstableApi
public final class LivePhotoRotation {
    public record Output(File image,File video,VideoFacts videoFacts){}
    private LivePhotoRotation(){}

    /** Standalone MP4 uses the same physical rotation and track validation as LIVE, without downloading a cover. */
    public static File rotateVideoOnly(Context context,File video,int clockwise,File directory,
                                      AtomicBoolean cleanupSafe,IntConsumer progress)throws IOException{
        int degrees=QuarterTurn.normalize(clockwise);
        if(degrees==0)return video;
        if(Looper.myLooper()==Looper.getMainLooper())throw new IllegalStateException("视频旋转不能阻塞 UI 线程");
        VideoFacts before=VideoFacts.read(video);
        if(before.hdr())throw new IOException("HDR/BT.2020 视频暂不执行旋转，避免降低色彩质量");
        RotationVideoSupport.requireSupported(before,degrees);
        File output=new File(directory,"rotated.mp4");
        rotateVideo(context,video,output,degrees,cleanupSafe,progress);
        before.verifyRotated(VideoFacts.read(output),degrees);
        return output;
    }

    public static Output rotate(Context context,File image,File video,int clockwise,File directory,
                                AtomicBoolean cleanupSafe,IntConsumer progress)throws IOException{
        int degrees=QuarterTurn.normalize(clockwise);VideoFacts before=VideoFacts.read(video);
        if(degrees==0)return new Output(image,video,before); // No re-encode or metadata rewrite.
        if(Looper.myLooper()==Looper.getMainLooper())throw new IllegalStateException("Live 旋转不能阻塞 UI 线程");
        if(before.hdr())throw new IOException("HDR/BT.2020 Live 暂不执行旋转，避免静默变为 SDR");
        RotationVideoSupport.requireSupported(before,degrees);
        File rotatedImage=new File(directory,"rotated.jpg"),rotatedVideo=new File(directory,"rotated.mp4");
        rotateJpeg(image,rotatedImage,degrees);
        rotateVideo(context,video,rotatedVideo,degrees,cleanupSafe,progress);
        VideoFacts after=VideoFacts.read(rotatedVideo);before.verifyRotated(after,degrees);
        return new Output(rotatedImage,rotatedVideo,after);
    }

    static void rotateJpeg(File input,File output,int clockwise)throws IOException{
        Bitmap rotated=null;
        try{
            if(!LosslessJpegRotation.tryRotate(input,output,clockwise)){
                Runtime runtime=Runtime.getRuntime();long available=runtime.maxMemory()-(runtime.totalMemory()-runtime.freeMemory());
                rotated=TiledJpegRotation.decode(input,clockwise,available);
                try(OutputStream out=Files.newOutputStream(output.toPath(),StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE)){
                    if(!rotated.compress(Bitmap.CompressFormat.JPEG,100,out))throw new IOException("Live 封面 JPEG 编码失败");
                }
            }
            BitmapFactory.Options bounds=new BitmapFactory.Options();bounds.inJustDecodeBounds=true;BitmapFactory.decodeFile(output.getAbsolutePath(),bounds);
            if(bounds.outWidth<=0||bounds.outHeight<=0)throw new IOException("Live 旋转封面尺寸校验失败");
            ExifInterface old=new ExifInterface(input),fresh=new ExifInterface(output);
            for(String tag:new String[]{ExifInterface.TAG_DATETIME,ExifInterface.TAG_DATETIME_ORIGINAL,ExifInterface.TAG_DATETIME_DIGITIZED,
                ExifInterface.TAG_MAKE,ExifInterface.TAG_MODEL,ExifInterface.TAG_IMAGE_DESCRIPTION,ExifInterface.TAG_ARTIST,
                ExifInterface.TAG_COPYRIGHT,ExifInterface.TAG_SUBSEC_TIME_ORIGINAL,"OffsetTimeOriginal"}){
                String value=old.getAttribute(tag);if(value!=null)fresh.setAttribute(tag,value);
            }
            fresh.setAttribute(ExifInterface.TAG_ORIENTATION,Integer.toString(ExifInterface.ORIENTATION_NORMAL));
            fresh.setAttribute(ExifInterface.TAG_IMAGE_WIDTH,Integer.toString(bounds.outWidth));
            fresh.setAttribute(ExifInterface.TAG_IMAGE_LENGTH,Integer.toString(bounds.outHeight));
            fresh.setAttribute("PixelXDimension",Integer.toString(bounds.outWidth));fresh.setAttribute("PixelYDimension",Integer.toString(bounds.outHeight));
            fresh.setAttribute(ExifInterface.TAG_SOFTWARE,"NikkiSync Live rotation");fresh.saveAttributes();
        }catch(IOException e){throw e;}catch(RuntimeException e){throw new IOException("Live 封面旋转失败："+e.getMessage(),e);}
        finally{if(rotated!=null)rotated.recycle();}
    }

    /** Avoid Media3 1.8.0's ScaleAndRotateTransformation -> muxer-metadata-only optimization. */
    private static final class PixelRotation implements MatrixTransformation {
        private final ScaleAndRotateTransformation delegate;
        PixelRotation(int clockwise){delegate=new ScaleAndRotateTransformation.Builder().setRotationDegrees(QuarterTurn.counterClockwise(clockwise)).build();}
        @Override public Size configure(int width,int height){return delegate.configure(width,height);}
        @Override public Matrix getMatrix(long presentationTimeUs){return delegate.getMatrix(presentationTimeUs);}
        @Override public boolean isNoOp(int width,int height){return false;}
    }

    private static void rotateVideo(Context context,File input,File output,int clockwise,
                                    AtomicBoolean cleanupSafe,IntConsumer progress)throws IOException{
        HandlerThread thread=new HandlerThread("NikkiSync-Live-rotation");thread.start();Handler handler=new Handler(thread.getLooper());
        CompletableFuture<Void> complete=new CompletableFuture<>();Transformer[] active=new Transformer[1];AtomicBoolean stopping=new AtomicBoolean(false);
        cleanupSafe.set(false);
        handler.post(()->{
            try{
                Transformer.Listener listener=new Transformer.Listener(){
                    @Override public void onCompleted(Composition composition,ExportResult result){complete.complete(null);}
                    @Override public void onError(Composition composition,ExportResult result,ExportException error){complete.completeExceptionally(error);}
                    @Override public void onFallbackApplied(Composition composition,TransformationRequest original,TransformationRequest fallback){
                        // Refuse codec resolution/HDR fallback instead of reporting a successful but altered export.
                        complete.completeExceptionally(new IOException("编码器请求降级，已取消以保留分辨率/色彩"));
                    }
                };
                active[0]=new Transformer.Builder(context.getApplicationContext()).setLooper(thread.getLooper())
                    .setVideoMimeType(MimeTypes.VIDEO_H264).setPortraitEncodingEnabled(true).setUsePlatformDiagnostics(false)
                    .setEncoderFactory(new DefaultEncoderFactory.Builder(context.getApplicationContext()).setEnableFallback(false).build())
                    .addListener(listener).build();
                EditedMediaItem item=new EditedMediaItem.Builder(MediaItem.fromUri(Uri.fromFile(input)))
                    .setEffects(new Effects(List.of(),List.of(new PixelRotation(clockwise)))).build();
                active[0].start(item,output.getAbsolutePath());
                Runnable poll=new Runnable(){@Override public void run(){
                    if(stopping.get()||complete.isDone())return;
                    try{ProgressHolder holder=new ProgressHolder();if(active[0].getProgress(holder)==Transformer.PROGRESS_STATE_AVAILABLE)progress.accept(holder.progress);
                        handler.postDelayed(this,200);
                    }catch(OutOfMemoryError e){complete.completeExceptionally(LiveExportGuard.memoryFailure(e));}
                    catch(RuntimeException e){complete.completeExceptionally(e);}
                }};handler.post(poll);
            }catch(OutOfMemoryError e){complete.completeExceptionally(LiveExportGuard.memoryFailure(e));}
            catch(Exception e){complete.completeExceptionally(e);}
        });
        boolean interrupted=false;
        try{
            complete.get(10,TimeUnit.MINUTES);
        }catch(InterruptedException e){interrupted=true;throw new InterruptedIOException("Live 旋转已取消");}
        catch(TimeoutException e){throw new IOException("Live 旋转超时，未发布不完整文件",e);}
        catch(ExecutionException e){throw new IOException("Live 视频旋转失败："+e.getCause().getMessage(),e.getCause());}
        finally{
            stopping.set(true);if(Thread.interrupted())interrupted=true;
            CountDownLatch stopped=new CountDownLatch(1);
            handler.post(()->{try{if(active[0]!=null)active[0].cancel();cleanupSafe.set(true);}finally{stopped.countDown();}});
            try{if(stopped.await(30,TimeUnit.SECONDS))thread.quitSafely();}
            catch(InterruptedException e){interrupted=true;}
            // If a codec did not acknowledge shutdown, leave private temp files, never delete under a live writer.
            if(interrupted)Thread.currentThread().interrupt();
        }
        if(!cleanupSafe.get())throw new IOException("视频编码器尚未停止，临时资源保留用于安全清理");
    }
}
