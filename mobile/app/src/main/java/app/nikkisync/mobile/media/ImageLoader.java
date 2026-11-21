package app.nikkisync.mobile.media;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.os.Handler;
import android.os.Looper;
import android.util.LruCache;
import android.widget.ImageView;
import app.nikkisync.mobile.R;

import app.nikkisync.mobile.model.Models.AssetSummary;
import app.nikkisync.mobile.net.NikkiSyncClient;

import java.io.InputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.ArrayList;
import java.util.Set;
import java.util.function.Consumer;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.HttpsURLConnection;

public final class ImageLoader {
    private record LibraryScope(String owner,Set<String> ids){}
    private volatile LibraryScope sharedLibrary;
    private boolean shared(app.nikkisync.mobile.model.Models.PairedServer server,AssetSummary asset){LibraryScope scope=sharedLibrary;return scope==null||!scope.owner().equals(server.serverId()+"\n"+server.tlsFingerprintSha256())||scope.ids().contains(asset.assetId());}
    public void reconcileLibraryIds(app.nikkisync.mobile.model.Models.PairedServer server,List<String> previous,List<AssetSummary> next){
        Set<String> ids=new java.util.HashSet<>();for(AssetSummary asset:next)ids.add(asset.assetId());sharedLibrary=new LibraryScope(server.serverId()+"\n"+server.tlsFingerprintSha256(),Set.copyOf(ids));
        List<String> removed=previous.stream().filter(id->!ids.contains(id)).toList();if(removed.isEmpty())return;
        pauseOfflineCaching();cache.evictAll();
        for(String id:removed)photos.removeOrdinary(server,id);
        cache.evictAll();
    }
    private volatile boolean networkAvailable=true;
    public void setNetworkAvailable(boolean available){networkAvailable=available;if(!available)pauseOfflineCaching();}
    private static String assetKey(app.nikkisync.mobile.model.Models.PairedServer server,AssetSummary asset){
        return PhotoCacheKey.legacy(server,asset);
    }
    public boolean hasCached(app.nikkisync.mobile.model.Models.PairedServer server,AssetSummary asset){try{String key=assetKey(server,asset);return photos.thumbnail(server,asset).isFile()||photos.preview(server,asset).isFile()||photos.pinned(server,asset).isFile()||diskFile(key).isFile()||pinnedFile(key).isFile();}catch(Exception error){return false;}}
    public List<AssetSummary> cachedAssets(app.nikkisync.mobile.model.Models.PairedServer server,List<AssetSummary> assets){
        Set<String> small=photos.thumbnailNames(),large=photos.previewNames(),pins=photos.pinnedNames(),legacy=PhotoDiskCache.names(diskDir,".img"),oldPins=PhotoDiskCache.names(new File(diskDir.getParentFile(),"organizer-thumbnails"),".img");
        List<AssetSummary> out=new ArrayList<>();for(AssetSummary asset:assets){
            String smallName=PhotoCacheKey.fileName(server,asset,false);
            if(small.contains(smallName)||pins.contains(smallName)||large.contains(PhotoCacheKey.fileName(server,asset,true))){out.add(asset);continue;}
            String oldName=PhotoCacheKey.hash(assetKey(server,asset))+".img";if(legacy.contains(oldName)||oldPins.contains(oldName))out.add(asset);
        }return List.copyOf(out);
    }
    private File pinnedFile(String key)throws Exception{return diskFile(new File(diskDir.getParentFile(),"organizer-thumbnails"),key);}
    public void pinForOrganizerAsync(app.nikkisync.mobile.model.Models.PairedServer server,java.util.List<AssetSummary> photos){
        executor.execute(()->{for(AssetSummary asset:photos)try{pinForOrganizer(server,asset);}catch(Exception ignored){/* Existing cache still remains available. */}});
    }
    public void pinForOrganizer(app.nikkisync.mobile.model.Models.PairedServer server,AssetSummary asset)throws Exception{
        if(photos.thumbnail(server,asset).isFile()){photos.pin(server,asset);return;}
        File preview=photos.preview(server,asset);if(preview.isFile()){photos.storeThumbnail(server,asset,preview,true);photos.pin(server,asset);return;}
        String key=assetKey(server,asset);File pin=pinnedFile(key);if(pin.isFile())return;File source=diskFile(key);if(!source.isFile())return;
        Bitmap bitmap=decodeDisplayFile(source);if(bitmap==null)return;
        pin.getParentFile().mkdirs();try(FileOutputStream out=new FileOutputStream(pin)){if(!bitmap.compress(Bitmap.CompressFormat.JPEG,85,out))throw new java.io.IOException("thumbnail");}finally{bitmap.recycle();}
    }
    public void loadOffline(app.nikkisync.mobile.model.Models.PairedServer server,AssetSummary asset,ImageView target){
        if(asset.isVideo()){showVideoPlaceholder(asset,target);return;}
        loadPhoto(null,server,asset,target,false,false);
    }
    /** Display previews only. Original and share-card exports retain their separate full-quality paths. */
    static Bitmap decodeDisplayFile(File file){
        BitmapFactory.Options options=new BitmapFactory.Options();options.inJustDecodeBounds=true;
        BitmapFactory.decodeFile(file.getAbsolutePath(),options);
        if(options.outWidth<=0||options.outHeight<=0)return null;
        options.inSampleSize=1;
        while(Math.max(options.outWidth,options.outHeight)/(options.inSampleSize*2)>=1280)options.inSampleSize*=2;
        options.inJustDecodeBounds=false;Bitmap decoded=BitmapFactory.decodeFile(file.getAbsolutePath(),options);
        if(decoded==null)return null;
        int longest=Math.max(decoded.getWidth(),decoded.getHeight());if(longest<=1280)return decoded;
        float scale=1280f/longest;Bitmap display=Bitmap.createScaledBitmap(decoded,Math.max(1,Math.round(decoded.getWidth()*scale)),Math.max(1,Math.round(decoded.getHeight()*scale)),true);
        if(display!=decoded)decoded.recycle();return display;
    }
    public static final long MAX_DISK_CACHE_BYTES = 512L * 1024L * 1024L;
    private final ExecutorService executor = Executors.newFixedThreadPool(4);
    private final Handler main = new Handler(Looper.getMainLooper());
    private final LruCache<String, Bitmap> cache;
    private final File diskDir;
    final PhotoDiskCache photos;
    private final PhotoCachePreferences preferences;
    @FunctionalInterface interface PhotoSource {HttpsURLConnection open(NikkiSyncClient client,AssetSummary asset,String resourceId)throws Exception;}
    private final PhotoSource photoSource;
    private final ExecutorService offlineExecutor=Executors.newSingleThreadExecutor();
    private final java.util.concurrent.Semaphore previewDecode=new java.util.concurrent.Semaphore(1);
    private final AtomicLong warmGeneration=new AtomicLong();
    private volatile boolean closed;
    private volatile HttpsURLConnection warmConnection;
    private String warmSignature="";
    private String signatureOwner="",signatureDigest="";
    private List<AssetSummary> signatureAssets=List.of();
    private volatile long warmRetryAt;
    private volatile long warmScheduled;
    private int warmRetries;
    private volatile OfflineProgress offlineProgress=new OfflineProgress(0,0,false,false,0);
    public record OfflineProgress(int cached,int total,boolean running,boolean full,int failed){
        public String description(){return "离线缩略图 "+cached+" / "+total+" 张"+(running?" · 正在缓存":full?" · 空间已满，可提高上限":failed>0?" · 部分未缓存，可点击重试":cached>=total&&total>0?" · 已就绪":" · 连接电脑后可继续");}
    }
    private final Object[] downloadLocks = new Object[32];
    private long diskBytes=-1;

    @FunctionalInterface
    private interface ConnectionFactory {
        HttpsURLConnection open() throws Exception;
    }

    public ImageLoader(Context context) {
        this(context,(client,asset,id)->client.resource(asset.assetId(),id));
    }
    ImageLoader(Context context,PhotoSource source) {
        photoSource=source;preferences=new PhotoCachePreferences(context);photos=new PhotoDiskCache(context,preferences);
        for(int i=0;i<downloadLocks.length;i++)downloadLocks[i]=new Object();
        int maxKb = (int)Math.max(1,preferences.effectiveMemoryBytes(Runtime.getRuntime().maxMemory())/1024);
        cache = new LruCache<>(maxKb) {
            @Override protected int sizeOf(String key, Bitmap bitmap) { return Math.max(1,bitmap.getByteCount() / 1024); }
        };
        diskDir = new File(context.getFilesDir(), "thumbnail-cache-v1");
        if (!diskDir.exists()) diskDir.mkdirs();
        File[] unfinished=diskDir.listFiles((dir,name)->name.endsWith(".part")&&System.currentTimeMillis()-new File(dir,name).lastModified()>86400000L);
        if(unfinished!=null)for(File file:unfinished)file.delete();
        executor.execute(()->{pruneDiskCache();photos.trim(preferences.thumbnailBytes(),preferences.previewBytes());});
    }

    public void load(NikkiSyncClient client, AssetSummary asset, ImageView target) {
        if(asset.isVideo()){showVideoPlaceholder(asset,target);return;}
        if(client!=null)loadPhoto(client,client.server(),asset,target,false,true);
        else{target.setTag(R.id.photo_source_asset_id,asset.assetId());target.setTag(R.id.photo_source_identity,"unpaired:"+asset.assetId());target.setTag("unpaired:"+asset.assetId());target.setImageDrawable(null);}
    }
    public void loadPreview(NikkiSyncClient client,AssetSummary asset,ImageView target){
        if(asset.isVideo()){showVideoPlaceholder(asset,target);return;}
        if(client==null)return;
        if(asset.fullPreviewResourceId()!=null){loadPhoto(client,client.server(),asset,target,true,true);return;}
        loadPhoto(null,client.server(),asset,target,true,false);
        Object expected=target.getTag();
        executor.execute(()->{
            try{AssetSummary upgraded=withFullPreview(asset,client.asset(asset.assetId()));
                main.post(()->{if(!closed&&java.util.Objects.equals(expected,target.getTag()))loadPhoto(client,client.server(),upgraded,target,true,true);});
            }catch(Exception ignored){/* Legacy PC unavailable: retain the cached still. */}
        });
    }
    static AssetSummary withFullPreview(AssetSummary asset,app.nikkisync.mobile.model.Models.AssetDetail detail){
        if(!asset.assetId().equals(detail.assetId()))return asset;
        var original=detail.originalStill();if(original==null||!original.mimeType().startsWith("image/"))return asset;
        return new AssetSummary(asset.assetId(),asset.type(),asset.state(),asset.capturedAt(),asset.uid(),asset.revision(),asset.width(),asset.height(),asset.hasMotion(),asset.hasMetadata(),
            asset.thumbnailResourceId(),asset.previewResourceId(),asset.gameVersion(),asset.gameVersionSource(),asset.thumbnailSha256(),asset.previewSha256(),original.resourceId(),original.sha256(),asset.mediaFingerprint());
    }
    public void loadOfflinePreview(app.nikkisync.mobile.model.Models.PairedServer server,AssetSummary asset,ImageView target){if(asset.isVideo()){showVideoPlaceholder(asset,target);return;}loadPhoto(null,server,asset,target,true,false);}
    public static void showVideoPlaceholder(AssetSummary asset,ImageView target){
        target.setTag("video:"+asset.assetId());target.setTag(R.id.photo_source_asset_id,asset.assetId());target.setTag(R.id.photo_source_identity,"video:"+asset.assetId());
        target.setScaleType(ImageView.ScaleType.CENTER_INSIDE);target.setImageResource(android.R.drawable.ic_media_play);
    }
    public PhotoCachePreferences preferences(){return preferences;}
    public OfflineProgress offlineProgress(){return offlineProgress;}
    public void offlineSnapshot(int cached,int total){if(!networkAvailable)offlineProgress=new OfflineProgress(cached,total,false,false,0);}
    public long effectiveMemoryMiB(){return cache.maxSize()/1024;}
    public void trimMemory(){cache.evictAll();}
    public void applyCacheLimits(Runnable complete){
        pauseOfflineCaching();cache.resize((int)Math.max(1,preferences.effectiveMemoryBytes(Runtime.getRuntime().maxMemory())/1024));
        executor.execute(()->{photos.trim(preferences.thumbnailBytes(),preferences.previewBytes());if(complete!=null&&!closed)main.post(complete);});
    }
    public synchronized void pauseOfflineCaching(){
        warmGeneration.incrementAndGet();warmSignature="";warmRetries=0;warmRetryAt=0;warmScheduled=0;HttpsURLConnection connection=warmConnection;if(connection!=null)connection.disconnect();
        OfflineProgress old=offlineProgress;offlineProgress=new OfflineProgress(old.cached,old.total,false,old.full,old.failed);
    }
    public synchronized void retryOfflineCaching(){pauseOfflineCaching();}
    public synchronized void warmThumbnails(NikkiSyncClient client,List<AssetSummary> assets,Consumer<OfflineProgress> listener){
        if(closed||client==null)return;
        // Independent recordings can be many gigabytes; never fetch them as images.
        assets=assets.stream().filter(asset->!asset.isVideo()).toList();
        String owner=client.server().serverId()+"\n"+client.server().tlsFingerprintSha256();
        if(!owner.equals(signatureOwner)||!signatureAssets.equals(assets)){
            // A large library must not allocate one giant concatenated UTF-8 key
            // on every recovery tick. Summaries are immutable; retain a copy to
            // detect even callers that mutate their list in place.
            try{MessageDigest digest=MessageDigest.getInstance("SHA-256");digest.update(owner.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                for(AssetSummary asset:assets){digest.update((byte)0);digest.update(PhotoCacheKey.thumbnail(client.server(),asset).getBytes(java.nio.charset.StandardCharsets.UTF_8));}
                signatureDigest=hex(digest.digest());signatureAssets=List.copyOf(assets);signatureOwner=owner;
            }catch(java.security.NoSuchAlgorithmException impossible){throw new IllegalStateException(impossible);}
        }
        String signature=signatureDigest+":"+preferences.thumbnailMiB()+":"+preferences.automaticOffline();
        if(signature.equals(warmSignature)){
            if(warmScheduled==warmGeneration.get()||offlineProgress.running()||offlineProgress.full()||offlineProgress.failed()==0||warmRetries>=2||System.currentTimeMillis()<warmRetryAt)return;
            warmRetries++;
        }else warmRetries=0;
        warmSignature=signature;long ticket=warmGeneration.incrementAndGet();warmScheduled=ticket;
        List<AssetSummary> snapshot=List.copyOf(assets);
        offlineExecutor.execute(()->{
            try{
            Set<String> counted=new java.util.HashSet<>();for(AssetSummary asset:cachedAssets(client.server(),snapshot))counted.add(asset.assetId());
            int count=counted.size(),failed=0;boolean full=false;
            boolean enabled=preferences.automaticOffline()&&networkAvailable;
            publishWarm(ticket,new OfflineProgress(count,snapshot.size(),enabled,false,0),listener);
            if(!enabled)return;
            long last=0;
            for(AssetSummary asset:snapshot){
                if(closed||ticket!=warmGeneration.get()||!networkAvailable)break;
                if(photos.thumbnail(client.server(),asset).isFile()||photos.pinned(client.server(),asset).isFile()){if(counted.add(asset.assetId()))count++;continue;}
                try{
                    if(!photos.thumbnailRoom()){full=true;break;}
                    if(!ensureThumbnail(client,client.server(),asset,false,ticket)){full=true;break;}
                    if(counted.add(asset.assetId()))count++;
                }catch(Exception|OutOfMemoryError error){if(error instanceof OutOfMemoryError)cache.evictAll();if(ticket!=warmGeneration.get()||!networkAvailable)break;failed++;}
                long now=System.currentTimeMillis();if(now-last>=500){last=now;publishWarm(ticket,new OfflineProgress(count,snapshot.size(),true,false,failed),listener);}
            }
            if(!closed&&ticket==warmGeneration.get())count=cachedAssets(client.server(),snapshot).size();
            publishWarm(ticket,new OfflineProgress(count,snapshot.size(),false,full,failed),listener);
            }catch(OutOfMemoryError pressure){
                cache.evictAll();OfflineProgress last=offlineProgress;
                publishWarm(ticket,new OfflineProgress(Math.min(last.cached(),snapshot.size()),snapshot.size(),false,false,Math.max(1,last.failed())),listener);
            }finally{if(warmScheduled==ticket)warmScheduled=0;}
        });
    }
    private void publishWarm(long ticket,OfflineProgress progress,Consumer<OfflineProgress> listener){
        if(closed||ticket!=warmGeneration.get())return;if(!progress.running()&&progress.failed()>0)warmRetryAt=System.currentTimeMillis()+30000;offlineProgress=progress;
        if(listener!=null)main.post(()->{if(!closed&&ticket==warmGeneration.get())listener.accept(progress);});
    }
    private void loadPhoto(NikkiSyncClient client,app.nikkisync.mobile.model.Models.PairedServer server,AssetSummary asset,ImageView target,boolean preview,boolean allowNetwork){
        if(allowNetwork&&!shared(server,asset)){loadPhoto(null,server,asset,target,preview,false);return;}
        if(closed)return;
        String identity=server.serverId()+":"+server.tlsFingerprintSha256()+":"+asset.assetId();
        String key=(preview?"preview:":"thumbnail:")+(preview?PhotoCacheKey.preview(server,asset):PhotoCacheKey.thumbnail(server,asset));
        boolean same=identity.equals(target.getTag(R.id.photo_source_identity));boolean bound=key.equals(target.getTag())&&target.getDrawable()!=null;
        target.setTag(R.id.photo_source_asset_id,asset.assetId());target.setTag(R.id.photo_source_identity,identity);target.setTag(key);
        Bitmap memory=cache.get(key);if(memory!=null){target.setImageBitmap(memory);return;}
        if(bound)return;if(!same)target.setImageDrawable(null);
        executor.execute(()->{
            boolean acquired=false;
            try{
                if(allowNetwork&&!shared(server,asset))return;
                if(!shared(server,asset)){
                    Bitmap pin=photos.pinned(server,asset).isFile()?photos.readThumbnail(server,asset):null;
                    if(pin==null){File old=pinnedFile(assetKey(server,asset));if(old.isFile())pin=decodeDisplayFile(old);}
                    if(pin!=null)show(target,key,pin);return;
                }
                if(preview){previewDecode.acquire();acquired=true;}
                synchronized(downloadLocks[(PhotoCacheKey.thumbnail(server,asset).hashCode()&0x7fffffff)%downloadLocks.length]){
                    Bitmap bitmap=cache.get(key);if(bitmap!=null){show(target,key,bitmap);return;}
                    bitmap=preview?photos.readPreview(server,asset):photos.readThumbnail(server,asset);
                    if(bitmap==null){
                        ensureLocalThumbnail(server,asset,true);
                        if(preview){
                            Bitmap small=photos.readThumbnail(server,asset);if(small!=null){show(target,key,small);}
                            bitmap=photos.readPreview(server,asset);
                            if(bitmap==null&&allowNetwork&&networkAvailable&&client!=null){
                                File temp=downloadPhoto(client,asset,true,0);
                                try{if(!shared(server,asset))return;photos.storePreview(server,asset,temp,()->shared(server,asset));if(!photos.thumbnail(server,asset).isFile())photos.storeThumbnail(server,asset,temp,true,()->shared(server,asset));bitmap=photos.readPreview(server,asset);}
                                finally{temp.delete();}
                            }
                        }else{
                            bitmap=photos.readThumbnail(server,asset);
                            if(bitmap==null&&allowNetwork&&networkAvailable&&client!=null){ensureThumbnail(client,server,asset,true,0);bitmap=photos.readThumbnail(server,asset);}
                        }
                    }
                    if(bitmap!=null){if(!shared(server,asset))return;cache.put(key,bitmap);show(target,key,bitmap);}
                }
            }catch(OutOfMemoryError pressure){cache.evictAll();}
            catch(Exception ignored){/* The cached small still stays visible if a preview cannot be reached. */}
            finally{if(acquired)previewDecode.release();}
        });
    }
    private void show(ImageView target,String key,Bitmap bitmap){main.post(()->{if(!closed&&key.equals(target.getTag()))target.setImageBitmap(bitmap);});}
    private boolean ensureThumbnail(NikkiSyncClient client,app.nikkisync.mobile.model.Models.PairedServer server,AssetSummary asset,boolean evict,long ticket)throws Exception{
        if(!shared(server,asset))throw new java.io.IOException("Photo outside shared library");
        synchronized(downloadLocks[(PhotoCacheKey.thumbnail(server,asset).hashCode()&0x7fffffff)%downloadLocks.length]){
            if(photos.thumbnail(server,asset).isFile()||photos.pinned(server,asset).isFile())return true;
            if(ensureLocalThumbnail(server,asset,evict))return true;
            File temp=downloadPhoto(client,asset,false,ticket);
            try{if(!shared(server,asset))throw new java.io.IOException("Photo outside shared library");return photos.storeThumbnail(server,asset,temp,evict,()->shared(server,asset));}finally{temp.delete();}
        }
    }
    private boolean ensureLocalThumbnail(app.nikkisync.mobile.model.Models.PairedServer server,AssetSummary asset,boolean evict)throws Exception{
        if(photos.thumbnail(server,asset).isFile()||photos.pinned(server,asset).isFile())return true;
        File large=photos.preview(server,asset);if(large.isFile())return photos.storeThumbnail(server,asset,large,evict,()->shared(server,asset));
        File legacy=diskFile(assetKey(server,asset));if(!legacy.isFile())legacy=pinnedFile(assetKey(server,asset));if(!legacy.isFile())return false;
        // Migrate only the exact old revision, and validate a known source hash before trusting it.
        String expected=PhotoCacheKey.contentHash(asset,false);if(expected!=null&&!expected.equals(fileHash(legacy)))return false;
        if(!photos.storeThumbnail(server,asset,legacy,evict,()->shared(server,asset)))return false;
        if(java.util.Objects.equals(PhotoCacheKey.resource(asset,false),PhotoCacheKey.resource(asset,true)))photos.storePreview(server,asset,legacy,()->shared(server,asset));
        // Keep bounded v1 entries for older organizer/favorite snapshots, whose keys lack content hashes.
        // They age out under the existing legacy budget; a migration never erases a pending preview.
        return true;
    }
    private File downloadPhoto(NikkiSyncClient client,AssetSummary asset,boolean preview,long ticket)throws Exception{
        if(!networkAvailable||closed)throw new java.io.IOException("Offline");
        String resource=PhotoCacheKey.resource(asset,preview);if(resource==null)throw new java.io.IOException("No photo resource");
        HttpsURLConnection connection=photoSource.open(client,asset,resource);File temp=null;
        try{
            if(ticket!=0){if(ticket!=warmGeneration.get())throw new java.io.IOException("Cancelled");warmConnection=connection;}
            connection.setConnectTimeout(3000);connection.setReadTimeout(8000);
            if(connection.getResponseCode()!=200)throw new java.io.IOException("Photo request failed");
            temp=File.createTempFile("photo-download-",".part",diskDir);MessageDigest digest=MessageDigest.getInstance("SHA-256");long total=0,deadline=System.currentTimeMillis()+(preview?60000:30000);
            try(InputStream in=connection.getInputStream();FileOutputStream out=new FileOutputStream(temp)){
                byte[] buffer=new byte[64*1024];int n;while((n=in.read(buffer))!=-1){
                    if(closed||!networkAvailable||Thread.currentThread().isInterrupted()||ticket!=0&&ticket!=warmGeneration.get())throw new java.io.IOException("Cancelled");
                    total+=n;if(total>256L*1024*1024||System.currentTimeMillis()>deadline)throw new java.io.IOException("Photo transfer limit");out.write(buffer,0,n);digest.update(buffer,0,n);
                }
            }
            String expected=PhotoCacheKey.contentHash(asset,preview);if(expected!=null&&!expected.equals(hex(digest.digest())))throw new java.io.IOException("Photo changed during transfer");
            File result=temp;temp=null;return result;
        }finally{connection.disconnect();if(ticket!=0&&warmConnection==connection)warmConnection=null;if(temp!=null)temp.delete();}
    }
    private static String fileHash(File file)throws Exception{MessageDigest digest=MessageDigest.getInstance("SHA-256");try(InputStream in=new FileInputStream(file)){byte[] buffer=new byte[65536];int n;while((n=in.read(buffer))!=-1)digest.update(buffer,0,n);}return hex(digest.digest());}
    private static String hex(byte[] bytes){char[] digits="0123456789abcdef".toCharArray(),out=new char[bytes.length*2];for(int i=0;i<bytes.length;i++){out[2*i]=digits[(bytes[i]&255)>>>4];out[2*i+1]=digits[bytes[i]&15];}return new String(out);}

    public void loadClothingThumbnail(NikkiSyncClient client, String assetId, String clothingId, String cacheVersion, ImageView target) {
        loadClothingThumbnail(client,null,assetId,clothingId,cacheVersion,target);
    }

    public void loadClothingThumbnail(NikkiSyncClient client, app.nikkisync.mobile.model.Models.PairedServer rememberedServer, String assetId, String clothingId, String cacheVersion, ImageView target) {
        String key = ClothingCacheKey.of(client==null?rememberedServer:client.server(),assetId,clothingId,cacheVersion);
        loadNetwork(key, target, () -> {if(client==null)throw new IllegalStateException("Offline icon is not cached");return client.clothingThumbnail(assetId, clothingId);}, () -> showClothingPlaceholder(target));
    }

    private void loadNetwork(String key, ImageView target, ConnectionFactory connectionFactory, Runnable onFailure) {
        boolean same=key.equals(target.getTag())&&target.getDrawable()!=null;
        target.setTag(key);
        Bitmap cached = cache.get(key);
        if (cached != null) { target.setImageBitmap(cached); return; }
        if(same)return;
        target.setImageDrawable(null);
        executor.execute(() -> {
            synchronized(downloadLocks[(key.hashCode()&0x7fffffff)%downloadLocks.length]) {
            HttpsURLConnection connection = null;
            File temp=null;
            try {
                Bitmap memory=cache.get(key);
                if(memory!=null) {main.post(()->{if(key.equals(target.getTag()))target.setImageBitmap(memory);});return;}
                File disk = diskFile(key);
                if(!disk.isFile()&&pinnedFile(key).isFile())disk=pinnedFile(key);
                if (disk.isFile()) {
                    Bitmap bitmap;
                    bitmap = decodeDisplayFile(disk);
                    if (bitmap != null) {
                        disk.setLastModified(System.currentTimeMillis());
                        cache.put(key, bitmap);
                        main.post(() -> { if (key.equals(target.getTag())) target.setImageBitmap(bitmap); });
                        return;
                    }
                    disk.delete();
                }
                if(!networkAvailable)throw new IllegalStateException("Offline");
                connection = connectionFactory.open();
                int responseCode = connection.getResponseCode();
                if (responseCode != 200) throw new IllegalStateException("image request HTTP " + responseCode);
                Bitmap bitmap;
                temp = File.createTempFile("ui-", ".part", diskDir);
                try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(temp)) {
                    byte[] buffer = new byte[64 * 1024]; int read;
                    while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
                }
                bitmap = decodeDisplayFile(temp);
                if (bitmap == null) { temp.delete(); throw new IllegalStateException("image decode failed"); }
                publishExportThumbnail(temp,disk);
                cache.put(key, bitmap);
                main.post(() -> { if (key.equals(target.getTag())) target.setImageBitmap(bitmap); });
                diskFileAdded(disk.length());
            } catch (Exception ignored) {
                if (onFailure != null) main.post(() -> { if (key.equals(target.getTag())) onFailure.run(); });
            } finally {
                if (connection != null) connection.disconnect();
                if(temp!=null)temp.delete();
            }
            }
        });
    }

    /** Keep a failed clothing image visible and diagnosable instead of leaving an empty grey tile. */
    private void showClothingPlaceholder(ImageView target) {
        final int size = 128;
        Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        canvas.drawColor(Color.rgb(236, 232, 228));
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setColor(Color.rgb(112, 105, 100));
        paint.setTextAlign(Paint.Align.CENTER);
        paint.setTextSize(25f);
        canvas.drawText("暂无图", size / 2f, size / 2f + 9f, paint);
        target.setImageBitmap(bitmap);
    }

    private File diskFile(String key) throws Exception {
        return diskFile(diskDir, key);
    }

    private static File diskFile(File directory, String key) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] hash = digest.digest(key.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        StringBuilder name = new StringBuilder(64);
        for (byte b : hash) name.append(String.format("%02x", b));
        return new File(directory, name + ".img");
    }

    /** Worker-thread export path. Returns an independently owned, bounded bitmap, including offline cache hits. */
    public static Bitmap readClothingForExport(Context context, NikkiSyncClient client,
                                               String assetId, String clothingId, String version) {
        return readClothingForExport(context, client, assetId, clothingId, version,
                android.os.SystemClock.elapsedRealtime() + 12000);
    }

    public static Bitmap readClothingForExport(Context context, NikkiSyncClient client,
                                               String assetId, String clothingId, String version, long deadline) {
        if (clothingId == null || clothingId.isBlank()) return null;
        HttpsURLConnection connection = null;
        File temp = null;
        try {
            File dir = new File(context.getFilesDir(), "thumbnail-cache-v1");
            dir.mkdirs();
            File disk = diskFile(dir, ClothingCacheKey.of(client==null?null:client.server(),assetId,clothingId,version));
            Bitmap cached = decodeExportThumbnail(disk);
            if (cached != null) return cached;
            if (client == null || android.os.SystemClock.elapsedRealtime() >= deadline) return null;
            connection = client.clothingThumbnail(assetId, clothingId);
            connection.setConnectTimeout((int) Math.max(1, Math.min(1500, deadline - android.os.SystemClock.elapsedRealtime())));
            connection.setReadTimeout((int) Math.max(1, Math.min(2500, deadline - android.os.SystemClock.elapsedRealtime())));
            if (connection.getResponseCode() != 200) return null;
            // Unique temporary files cannot collide with the UI loader's .part file.
            temp = File.createTempFile("share-", ".tmp", dir);
            try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(temp)) {
                copyExportThumbnail(input, output, deadline, android.os.SystemClock::elapsedRealtime);
            }
            Bitmap bitmap = decodeExportThumbnail(temp);
            if (bitmap != null) {
                try { publishExportThumbnail(temp, disk); } catch (Exception ignored) { /* Export can use decoded pixels. */ }
            }
            return bitmap;
        } catch (Exception ignored) {
            return null;
        } finally {
            if (connection != null) connection.disconnect();
            if (temp != null) temp.delete();
        }
    }

    static void publishExportThumbnail(File temp, File disk) throws java.io.IOException {
        // Same-directory atomic replacement also repairs corrupt old entries without exposing partial data.
        try {
            java.nio.file.Files.move(temp.toPath(), disk.toPath(),
                    java.nio.file.StandardCopyOption.ATOMIC_MOVE, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        } catch (java.nio.file.FileSystemException unsupportedReplacement) {
            // Windows-hosted native tests/filesystems may not support atomic replacement.
            // Move a complete validated file, never copy bytes into an entry readers can see.
            java.nio.file.Files.move(temp.toPath(), disk.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        }
    }

    static void copyExportThumbnail(InputStream input, java.io.OutputStream output, long deadline,
                                    java.util.function.LongSupplier clock) throws java.io.IOException {
        byte[] buffer = new byte[8192];
        int total = 0;
        while (true) {
            if (clock.getAsLong() >= deadline) throw new java.io.IOException("thumbnail export deadline exceeded");
            int read = input.read(buffer);
            if (clock.getAsLong() >= deadline) throw new java.io.IOException("thumbnail export deadline exceeded");
            if (read == -1) return;
            total += read;
            if (total > 4 * 1024 * 1024) throw new java.io.IOException("thumbnail exceeds export limit");
            output.write(buffer, 0, read);
        }
    }

    private static Bitmap decodeExportThumbnail(File file) throws java.io.IOException {
        if (!file.isFile()) return null;
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        try (InputStream input = new FileInputStream(file)) { BitmapFactory.decodeStream(input, null, bounds); }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null;
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = 1;
        while (Math.max(bounds.outWidth, bounds.outHeight) / options.inSampleSize > 512) options.inSampleSize *= 2;
        try (InputStream input = new FileInputStream(file)) { return BitmapFactory.decodeStream(input, null, options); }
    }

    private synchronized void diskFileAdded(long bytes) {
        if(diskBytes>=0)diskBytes+=bytes;
        pruneDiskCache();
    }

    private synchronized void pruneDiskCache() {
        if(diskBytes>=0&&diskBytes<=MAX_DISK_CACHE_BYTES)return;
        File[] files = diskDir.listFiles((dir, name) -> name.endsWith(".img"));
        if (files == null) return;
        long total = 0; for (File file : files) total += file.length();
        diskBytes=total;
        if (total <= MAX_DISK_CACHE_BYTES) return;
        Arrays.sort(files, Comparator.comparingLong(File::lastModified));
        for (File file : files) {
            if (total <= MAX_DISK_CACHE_BYTES) break;
            long size = file.length(); if (file.delete()) total -= size;
        }
        diskBytes=total;
    }

    public void shutdown() { closed=true;pauseOfflineCaching();offlineExecutor.shutdownNow();executor.shutdownNow();cache.evictAll(); }
}
