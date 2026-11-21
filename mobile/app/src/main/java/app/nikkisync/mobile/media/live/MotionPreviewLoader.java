package app.nikkisync.mobile.media.live;

import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import app.nikkisync.mobile.net.NikkiSyncClient;
import app.nikkisync.mobile.storage.SavedPhotoStore;
import java.io.*;
import java.util.concurrent.*;
import javax.net.ssl.HttpsURLConnection;

/** Download through the existing pinned/signed client; playback never receives a network URL. */
public final class MotionPreviewLoader {
    public interface Video extends AutoCloseable {File file();@Override void close();}
    public interface Callback {void ready(Video video);void failed();}
    public interface Request {void cancel();}
    public interface Source {Request load(Callback callback);}
    private interface Work {MotionPreviewCache.Lease run(Job job)throws Exception;}
    private static final ThreadPoolExecutor WORKERS=new ThreadPoolExecutor(2,2,15,TimeUnit.SECONDS,new LinkedBlockingQueue<>(),r->{Thread t=new Thread(r,"live-preview");t.setDaemon(true);return t;});
    static{WORKERS.allowCoreThreadTimeOut(true);}
    private static final Handler MAIN=new Handler(Looper.getMainLooper());
    private MotionPreviewLoader(){}
    public static MotionPreviewCache cache(Context context){return new MotionPreviewCache(new File(context.getCacheDir(),"motion-preview-v1"));}
    public static Source remote(Context context,NikkiSyncClient client,String assetId){
        MotionPreviewCache cache=cache(context);
        return source(job->{
            if(client==null)throw new IOException("电脑尚未连接");
            var resource=client.asset(assetId).motionResource();job.check();
            var server=client.server();String identity=server.serverId()+"\n"+server.tlsFingerprintSha256();
            return cache.remote(identity,resource,()->job.track(client.resource(assetId,resource.resourceId())));
        });
    }
    public static Source saved(Context context,SavedPhotoStore.Record record){
        Context app=context.getApplicationContext();MotionPreviewCache cache=cache(app);
        return source(job->{
            if(!record.hasMotion())throw new IOException("没有保存动态视频");
            boolean embedded=record.companionUris().isEmpty();
            // Only explicit exported companion links are trusted; never choose a nearby unrelated MP4.
            Uri uri=embedded?record.mediaUri():Uri.parse(record.companionUris().get(0));
            return cache.local(uri.toString(),()->job.track(app.getContentResolver().openInputStream(uri)),embedded);
        });
    }
    private static Source source(Work work){return callback->{Job job=new Job(callback,work);job.future=WORKERS.submit(job);return job;};}
    private static final class Job implements Request,Runnable {
        final Callback callback;final Work work;volatile Future<?> future;boolean cancelled;HttpsURLConnection connection;InputStream stream;
        Job(Callback callback,Work work){this.callback=callback;this.work=work;}
        synchronized void check()throws InterruptedIOException{if(cancelled||Thread.currentThread().isInterrupted())throw new InterruptedIOException("动态预览已取消");}
        synchronized HttpsURLConnection track(HttpsURLConnection value)throws IOException{if(cancelled){value.disconnect();throw new InterruptedIOException();}connection=value;return value;}
        synchronized InputStream track(InputStream value)throws IOException{if(cancelled){if(value!=null)value.close();throw new InterruptedIOException();}stream=value;return value;}
        @Override public void run(){
            try{
                var lease=work.run(this);
                MAIN.post(()->{synchronized(this){if(cancelled){lease.close();return;}}
                    callback.ready(new Video(){public File file(){return lease.file();}public void close(){lease.close();}});
                });
            }catch(Exception error){MAIN.post(()->{synchronized(this){if(cancelled)return;}callback.failed();});}
            finally{synchronized(this){connection=null;stream=null;}}
        }
        @Override public void cancel(){
            HttpsURLConnection c;InputStream s;
            synchronized(this){if(cancelled)return;cancelled=true;c=connection;s=stream;}
            Future<?> f=future;if(f!=null)f.cancel(true);WORKERS.purge();
            // OEM stream close can wait for a socket timeout. Never block a swipe/main thread on it.
            if(c!=null||s!=null)CompletableFuture.runAsync(()->{if(c!=null)c.disconnect();if(s!=null)try{s.close();}catch(IOException ignored){}});
        }
    }
}
