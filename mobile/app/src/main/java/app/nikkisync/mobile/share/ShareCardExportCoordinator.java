package app.nikkisync.mobile.share;
import android.content.Context;
import android.net.Uri;
import app.nikkisync.mobile.model.Models.AssetSummary;
import app.nikkisync.mobile.net.NikkiSyncClient;
import java.util.Objects;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicLong;

/** Activity owns presentation; worker owns bounded rendering and explicit MediaStore writes. */
public final class ShareCardExportCoordinator {
    public interface Listener {
        default void onProgress(String stage,long completed,long total) {}
        void onSuccess(ShareCardPreparation.Prepared prepared);
        void onFailure(Exception error);
    }
    public interface SaveListener {
        default void onProgress(String stage,long completed,long total) {}
        void onSuccess(Uri uri);void onFailure(Exception error);
    }
    private final Context context;private final Executor worker,callbacks;
    private final AtomicLong generation=new AtomicLong();
    private ShareCardPreparation.Prepared current;
    public ShareCardExportCoordinator(Context context,Executor worker,Executor callbacks) {
        this.context=Objects.requireNonNull(context).getApplicationContext();this.worker=worker;this.callbacks=callbacks;
    }
    public void exportRemote(NikkiSyncClient client,AssetSummary asset,String json,int rotation,Listener listener) {
        generate(client,null,asset,asset.assetId(),asset.capturedAt(),asset.gameVersion(),json,rotation,listener);
    }
    public void exportLocal(Uri uri,String assetId,String capturedAt,String version,String json,Listener listener) {
        exportLocal(null,uri,assetId,capturedAt,version,json,listener);
    }
    public void exportLocal(NikkiSyncClient client,Uri uri,String assetId,String capturedAt,String version,String json,Listener listener) {
        generate(client,uri,null,assetId,capturedAt,version,json,0,listener);
    }
    private void generate(NikkiSyncClient client,Uri uri,AssetSummary asset,String id,String date,String version,String json,int rotation,Listener listener) {
        cancel();long token=generation.get();
        var branding=new app.nikkisync.mobile.storage.ExportWatermarkStore(context).shareBranding(json);
        worker.execute(()->{
            try {
                ShareCardPreparation.check(()->generation.get()==token);
                var payload=ShareCardPayloadBuilder.build(id,date,version,json).withBranding(branding);
                var result=ShareCardPreparation.prepare(context,client,uri,asset,payload,rotation,()->generation.get()==token,
                        (stage,done,total)->callbacks.execute(()->{if(generation.get()==token)listener.onProgress(stage,done,total);}));
                synchronized(this) {
                    if(generation.get()!=token) {result.close();return;}
                    current=result;
                }
                callbacks.execute(()->{if(generation.get()==token) listener.onSuccess(result);else result.close();});
            } catch(Exception error) {callbacks.execute(()->{if(generation.get()==token) listener.onFailure(error);});}
        });
    }
    public void save(ShareCardPreparation.Prepared prepared,int page,SaveListener listener) {
        worker.execute(()->{
            try {Uri uri=prepared.save(context,page,(stage,done,total)->callbacks.execute(()->listener.onProgress(stage,done,total)));
                callbacks.execute(()->listener.onSuccess(uri));}
            catch(Exception error) {callbacks.execute(()->listener.onFailure(error));}
        });
    }
    public interface OriginalSave {Uri save(app.nikkisync.mobile.util.TaskProgress progress) throws Exception;}
    public static final class PartialSaveException extends Exception {
        public final Uri shareUri;
        PartialSaveException(Uri uri,Exception cause){super("分享图已保存，原图保存失败："+cause.getMessage(),cause);shareUri=uri;}
    }
    public void saveBoth(ShareCardPreparation.Prepared prepared,int page,Uri existing,OriginalSave original,SaveListener listener){
        worker.execute(()->{
            Uri share=existing;
            app.nikkisync.mobile.util.TaskProgress progress=(stage,done,total)->callbacks.execute(()->listener.onProgress(stage,done,total));
            try{
                if(share==null)share=prepared.save(context,page,progress);
                try{original.save(progress);}catch(Exception error){throw new PartialSaveException(share,error);}
                Uri result=share;callbacks.execute(()->listener.onSuccess(result));
            }catch(Exception error){callbacks.execute(()->listener.onFailure(error));}
        });
    }
    public synchronized void cancel() {generation.incrementAndGet();if(current!=null) current.close();current=null;}
}
