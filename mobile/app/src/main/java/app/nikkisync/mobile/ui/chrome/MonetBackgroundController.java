package app.nikkisync.mobile.ui.chrome;

import android.content.Context;
import android.graphics.*;
import android.os.Handler;
import android.os.Looper;
import app.nikkisync.mobile.model.Models.AssetSummary;
import app.nikkisync.mobile.net.NikkiSyncClient;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import javax.net.ssl.HttpsURLConnection;

public final class MonetBackgroundController implements AutoCloseable {
    private long generation;private boolean closed;
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private String lastKey="";
    public synchronized long beginRequest(){return ++generation;}
    public synchronized boolean isCurrent(long ticket){return !closed && generation==ticket;}
    @Override public synchronized void close(){closed=true;generation++;worker.shutdownNow();}
    public void restore(Context context,MonetBackgroundView target){
        File file=new File(context.getFilesDir(),"monet-root-preview.png");
        if(file.isFile())try(InputStream in=new FileInputStream(file)){Bitmap b=BitmapFactory.decodeStream(in);if(b!=null)target.transitionTo(b);}catch(IOException ignored){}
    }
    public synchronized void updateRoot(Context context,NikkiSyncClient client,List<AssetSummary> assets,MonetBackgroundView target){
        List<AssetSummary> recent=recent(assets);
        String key=recent.stream().map(MonetBackgroundController::paletteKey).collect(java.util.stream.Collectors.joining("|"));
        if(key.equals(lastKey))return;lastKey=key;
        submit(context,client,recent,target,true);
    }
    public void updatePhoto(Context context,NikkiSyncClient client,AssetSummary asset,MonetBackgroundView target){submit(context,client,List.of(asset),target,false);}
    public static List<AssetSummary> recent(List<AssetSummary> assets){
        List<AssetSummary> sorted=new ArrayList<>(assets);sorted.sort(Comparator.comparing((AssetSummary a)->capture(a.capturedAt())).reversed().thenComparing(AssetSummary::assetId));
        LinkedHashMap<String,AssetSummary> unique=new LinkedHashMap<>();for(AssetSummary a:sorted){unique.putIfAbsent(a.assetId(),a);if(unique.size()==3)break;}return List.copyOf(unique.values());
    }
    private static java.time.Instant capture(String value){try{return java.time.Instant.parse(value);}catch(Exception ignored){return java.time.Instant.MIN;}}
    private void submit(Context supplied,NikkiSyncClient client,List<AssetSummary> photos,MonetBackgroundView target,boolean root){
        Context context=supplied.getApplicationContext();long ticket=beginRequest();Handler main=new Handler(Looper.getMainLooper());
        if(!isCurrent(ticket))return;
        try{worker.execute(()->{
            List<MonetPalette> palettes=new ArrayList<>();
            MonetPaletteCache cache=new MonetPaletteCache(context);
            for(AssetSummary a:photos){
                if(!isCurrent(ticket))return;
                String key=paletteKey(a);MonetPalette cached=cache.get(key);if(cached!=null){palettes.add(cached);continue;}
                Bitmap b=load(context,client,a);if(b==null)continue;
                try{MonetPalette palette=MonetAnalyzer.analyze(b);palettes.add(palette);cache.put(key,palette);}finally{b.recycle();}
            }
            if(palettes.isEmpty()){synchronized(this){if(isCurrent(ticket))lastKey="";}return;}
            Bitmap tile=root?MonetTileRenderer.renderRoot(palettes):MonetTileRenderer.renderPhoto(palettes.get(0));
            synchronized(this){if(!isCurrent(ticket)){tile.recycle();return;}if(root)persist(context,tile);}
            main.post(()->{if(isCurrent(ticket))target.transitionTo(tile);});
        });}catch(RejectedExecutionException ignored){} // close may race task submission.
    }
    private static String paletteKey(AssetSummary a){return a.assetId()+":"+a.thumbnailResourceId()+":"+a.previewResourceId()+":"+a.revision()+":"+MonetPaletteCache.ALGORITHM;}
    private static Bitmap load(Context context,NikkiSyncClient client,AssetSummary asset){
        String resource=asset.thumbnailResourceId()!=null?asset.thumbnailResourceId():asset.previewResourceId();if(resource==null)return null;
        String key=asset.assetId()+":"+resource+":r"+asset.revision();HttpsURLConnection connection=null;
        try{
            byte[] hash=MessageDigest.getInstance("SHA-256").digest(key.getBytes(StandardCharsets.UTF_8));StringBuilder name=new StringBuilder();for(byte b:hash)name.append(String.format("%02x",b));
            File cached=new File(new File(context.getFilesDir(),"thumbnail-cache-v1"),name+".img");
            if(cached.isFile())try(InputStream input=new FileInputStream(cached)){Bitmap b=decode(app.nikkisync.mobile.util.ByteStreams.readNBytes(input,8*1024*1024));if(b!=null)return b;}
            if(client==null)return null;
            connection=client.resource(asset.assetId(),resource);connection.setConnectTimeout(2000);connection.setReadTimeout(2500);
            if(connection.getResponseCode()!=200)return null;
            try(InputStream input=connection.getInputStream()){
                byte[] bytes=app.nikkisync.mobile.util.ByteStreams.readNBytes(input,8*1024*1024+1);if(bytes.length>8*1024*1024)return null;
                Bitmap b=decode(bytes);
                if(b!=null){cached.getParentFile().mkdirs();File temp=File.createTempFile("monet-",".tmp",cached.getParentFile());
                    try{try(OutputStream out=new FileOutputStream(temp)){out.write(bytes);}java.nio.file.Files.move(temp.toPath(),cached.toPath(),java.nio.file.StandardCopyOption.REPLACE_EXISTING);}catch(IOException ignored){}finally{temp.delete();}}
                return b;
            }
        }catch(Exception ignored){return null;}finally{if(connection!=null)connection.disconnect();}
    }
    private static Bitmap decode(byte[] bytes){
        BitmapFactory.Options o=new BitmapFactory.Options();o.inJustDecodeBounds=true;BitmapFactory.decodeByteArray(bytes,0,bytes.length,o);if(o.outWidth<=0||o.outHeight<=0)return null;
        o.inSampleSize=1;while(Math.max(o.outWidth,o.outHeight)/o.inSampleSize>192)o.inSampleSize*=2;
        o.inJustDecodeBounds=false;return BitmapFactory.decodeByteArray(bytes,0,bytes.length,o);
    }
    private static void persist(Context context,Bitmap tile){
        Bitmap preview=Bitmap.createScaledBitmap(tile,192,192,true);File temp=new File(context.getFilesDir(),"monet-root-preview.tmp");
        try{try(OutputStream out=new FileOutputStream(temp)){preview.compress(Bitmap.CompressFormat.PNG,100,out);}java.nio.file.Files.move(temp.toPath(),new File(context.getFilesDir(),"monet-root-preview.png").toPath(),java.nio.file.StandardCopyOption.REPLACE_EXISTING);}
        catch(IOException ignored){}finally{preview.recycle();temp.delete();}
    }
}
