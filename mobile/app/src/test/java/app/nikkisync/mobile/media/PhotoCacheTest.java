package app.nikkisync.mobile.media;

import android.graphics.Bitmap;
import android.graphics.Color;
import android.widget.ImageView;
import app.nikkisync.mobile.model.Models.*;
import app.nikkisync.mobile.net.NikkiSyncClient;
import app.nikkisync.mobile.protocol.JsonCodec;
import java.io.*;
import java.net.URL;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import javax.net.ssl.HttpsURLConnection;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.*;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk=35)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class PhotoCacheTest {
    @Test public void excludedAccountPendingPreviewStillOpensWhileThePhoneIsOnline()throws Exception{
        var context=RuntimeEnvironment.getApplication();AtomicInteger requests=new AtomicInteger();ImageLoader loader=new ImageLoader(context,(client,photo,id)->{requests.incrementAndGet();throw new IOException("excluded network request");});File file=source(jpeg(40,30));
        try{var photo=asset("excluded-pending",1,"a".repeat(64));loader.photos.storeThumbnail(PC,photo,file,true);loader.pinForOrganizer(PC,photo);loader.reconcileLibraryIds(PC,List.of(photo.assetId()),List.of());
            ImageView image=new ImageView(context);loader.loadPreview(new NikkiSyncClient(PC,null),photo,image);await(()->image.getDrawable()!=null);assertEquals(0,requests.get());assertFalse(loader.photos.thumbnail(PC,photo).exists());
        }finally{file.delete();loader.shutdown();}
    }
    @Test public void accountRemovalClearsDuplicateDiskVariantsAndKeepsOtherComputerPixels()throws Exception{
        var context=RuntimeEnvironment.getApplication();File folder=new File(context.getFilesDir(),"photo-thumbnails-v2");folder.mkdirs();
        var first=asset("duplicate-account",1,"a".repeat(64));var later=asset("duplicate-account",2,"b".repeat(64));var kept=asset("kept-account",1,"a".repeat(64));
        var other=new PairedServer("other-pc","PC","invalid.local",28080,"other-cert","","",0);byte[] bytes=jpeg(40,30);
        for(String name:List.of(PhotoCacheKey.fileName(PC,first,false),PhotoCacheKey.fileName(PC,later,false),PhotoCacheKey.fileName(PC,kept,false),PhotoCacheKey.fileName(other,first,false)))java.nio.file.Files.write(new File(folder,name).toPath(),bytes);
        var disk=new PhotoDiskCache(context,new PhotoCachePreferences(context));assertEquals(4,disk.thumbnailNames().size());disk.removeOrdinary(PC,first.assetId());
        assertEquals(2,disk.thumbnailNames().size());assertTrue(disk.thumbnail(PC,kept).isFile());assertTrue(disk.thumbnail(other,first).isFile());
    }
    @Test public void scopeRemovalDropsOnlyOrdinaryCacheAndPreservesPendingPinsAndOtherPhotos()throws Exception{
        var context=RuntimeEnvironment.getApplication();var disk=new PhotoDiskCache(context,new PhotoCachePreferences(context));
        AssetSummary removed=asset("removed-account",1,"a".repeat(64)),retained=asset("retained-account",1,"b".repeat(64));File file=source(jpeg(40,30));
        try{disk.storeThumbnail(PC,removed,file,false);disk.storePreview(PC,removed,file);disk.pin(PC,removed);disk.storeThumbnail(PC,retained,file,false);
            disk.removeOrdinary(PC,removed);assertFalse(disk.thumbnail(PC,removed).exists());assertFalse(disk.preview(PC,removed).exists());assertTrue(disk.pinned(PC,removed).exists());assertTrue(disk.thumbnail(PC,retained).exists());
        }finally{file.delete();}
    }
    @Test public void queuedRecoveryTicksCoalesceAndDoNotSpendTheRetryBudgetWithoutWork()throws Exception{
        var context=RuntimeEnvironment.getApplication();AtomicInteger requests=new AtomicInteger();var release=new java.util.concurrent.CountDownLatch(1);
        ImageLoader loader=new ImageLoader(context,(client,photo,id)->{requests.incrementAndGet();throw new IOException("generated persistent failure");});
        try{
            var client=new NikkiSyncClient(PC,null);var items=List.of(asset("queued-retry",1,"a".repeat(64)));loader.warmThumbnails(client,items,null);await(()->loader.offlineProgress().failed()==1&&!loader.offlineProgress().running());
            var field=ImageLoader.class.getDeclaredField("offlineExecutor");field.setAccessible(true);var worker=(java.util.concurrent.ExecutorService)field.get(loader);worker.submit(()->{}).get();
            worker.execute(()->{try{release.await();}catch(InterruptedException ignored){}});
            var retry=ImageLoader.class.getDeclaredField("warmRetryAt");retry.setAccessible(true);retry.setLong(loader,0);loader.warmThumbnails(client,items,null);loader.warmThumbnails(client,items,null);release.countDown();worker.submit(()->{}).get();assertEquals(2,requests.get());
            retry.setLong(loader,0);loader.warmThumbnails(client,items,null);worker.submit(()->{}).get();assertEquals(3,requests.get());
            retry.setLong(loader,0);loader.warmThumbnails(client,items,null);worker.submit(()->{}).get();assertEquals(3,requests.get());
        }finally{release.countDown();loader.shutdown();}
    }
    @Test public void foregroundThumbnailsPublishedDuringFillAreIncludedInProgress()throws Exception{
        var context=RuntimeEnvironment.getApplication();byte[] bytes=jpeg(40,30);var started=new java.util.concurrent.CountDownLatch(1);var resume=new java.util.concurrent.CountDownLatch(1);
        ImageLoader loader=new ImageLoader(context,(client,photo,id)->{started.countDown();if(!resume.await(5,java.util.concurrent.TimeUnit.SECONDS))throw new IOException("fixture timeout");return connection(bytes);});
        File source=source(bytes);AssetSummary first=asset("foreground-count-a",1,hash(bytes)),second=asset("foreground-count-b",1,hash(bytes));
        try{
            loader.warmThumbnails(new NikkiSyncClient(PC,null),List.of(first,second),null);assertTrue(started.await(3,java.util.concurrent.TimeUnit.SECONDS));
            assertTrue(loader.photos.storeThumbnail(PC,second,source,true));resume.countDown();await(()->!loader.offlineProgress().running()&&loader.photos.thumbnail(PC,first).isFile());
            assertEquals(2,loader.cachedAssets(PC,List.of(first,second)).size());assertEquals(2,loader.offlineProgress().cached());
        }finally{resume.countDown();loader.shutdown();source.delete();}
    }
    @Test public void actualPrefetchPassesFiveHundredAndRestartKeepsAllPixelsWithoutRequests()throws Exception{
        var context=RuntimeEnvironment.getApplication();byte[] bytes=jpeg(32,24);String sha=hash(bytes);AtomicInteger requests=new AtomicInteger();
        List<AssetSummary> items=new ArrayList<>();for(int i=0;i<720;i++)items.add(asset("actual-fill-"+i,1,sha));
        ImageLoader.PhotoSource transport=(client,photo,id)->{requests.incrementAndGet();return connection(bytes);};ImageLoader loader=new ImageLoader(context,transport);
        try{
            loader.warmThumbnails(new NikkiSyncClient(PC,null),items,null);long end=System.currentTimeMillis()+30000;
            while(System.currentTimeMillis()<end&&(loader.offlineProgress().running()||loader.offlineProgress().cached()<720)){Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();Thread.sleep(10);}
            assertEquals(720,loader.offlineProgress().cached());assertEquals(0,loader.offlineProgress().failed());assertEquals(720,requests.get());assertEquals(720,loader.cachedAssets(PC,items).size());loader.shutdown();
            loader=new ImageLoader(context,transport);loader.setNetworkAvailable(false);assertEquals(720,loader.cachedAssets(PC,items).size());loader.setNetworkAvailable(true);loader.warmThumbnails(new NikkiSyncClient(PC,null),items,null);
            final ImageLoader restarted=loader;await(()->restarted.offlineProgress().cached()==720&&!restarted.offlineProgress().running());assertEquals(720,requests.get());
        }finally{loader.shutdown();}
    }
    @Test public void failedFillHasABoundedAutomaticRetryForTheSameLibrary()throws Exception{
        var context=RuntimeEnvironment.getApplication();byte[] bytes=jpeg(40,30);AtomicInteger requests=new AtomicInteger();java.util.concurrent.atomic.AtomicBoolean fail=new java.util.concurrent.atomic.AtomicBoolean(true);
        ImageLoader loader=new ImageLoader(context,(client,photo,id)->{requests.incrementAndGet();if(fail.get())throw new IOException("generated transient failure");return connection(bytes);});
        try{
            var client=new NikkiSyncClient(PC,null);var items=List.of(asset("retry-fill",1,hash(bytes)));loader.warmThumbnails(client,items,null);await(()->loader.offlineProgress().failed()==1&&!loader.offlineProgress().running());
            loader.warmThumbnails(client,items,null);Thread.sleep(40);assertEquals(1,requests.get());
            fail.set(false);var retry=ImageLoader.class.getDeclaredField("warmRetryAt");retry.setAccessible(true);retry.setLong(loader,0);loader.warmThumbnails(client,items,null);await(()->loader.offlineProgress().cached()==1&&!loader.offlineProgress().running());assertEquals(2,requests.get());
        }finally{loader.shutdown();}
    }
    @Test public void temporaryMemoryAndReadFailuresDoNotDeleteValidOfflineImages()throws Exception{
        var context=RuntimeEnvironment.getApplication();var choices=new PhotoCachePreferences(context);var normal=new PhotoDiskCache(context,choices);
        File file=source(jpeg(80,60));var photo=asset("read-pressure",1,"a".repeat(64));
        try{
            normal.storeThumbnail(PC,photo,file,true);normal.storePreview(PC,photo,file);
            var pressured=new PhotoDiskCache(context,choices,(image,edge)->{throw new OutOfMemoryError("generated memory-pressure fixture");});
            assertNull(pressured.readThumbnail(PC,photo));assertNull(pressured.readPreview(PC,photo));
            assertTrue(normal.thumbnail(PC,photo).isFile());assertTrue(normal.preview(PC,photo).isFile());
            var busy=new PhotoDiskCache(context,choices,(image,edge)->{throw new IOException("generated read failure");});
            assertNull(busy.readThumbnail(PC,photo));assertNull(busy.readPreview(PC,photo));
            assertEquals(1,busy.usage().thumbnails());assertEquals(1,busy.usage().previews());
            var restored=new PhotoDiskCache(context,choices);Bitmap small=restored.readThumbnail(PC,photo),large=restored.readPreview(PC,photo);assertNotNull(small);assertNotNull(large);small.recycle();large.recycle();
        }finally{file.delete();}
    }
    @Test public void recoveredConnectionRestartsOfflineFillWithoutManualRefresh()throws Exception{
        var context=RuntimeEnvironment.getApplication();byte[] bytes=jpeg(40,40);AtomicInteger requests=new AtomicInteger();
        ImageLoader loader=new ImageLoader(context,(client,asset,id)->{requests.incrementAndGet();return connection(bytes);});
        var activity=Robolectric.buildActivity(app.nikkisync.mobile.MainActivity.class).get();
        try{
            var build=activity.getClass().getDeclaredMethod("buildUi");build.setAccessible(true);build.invoke(activity);
            for(var entry:Map.of("imageLoader",loader,"client",new NikkiSyncClient(PC,null),"pairedServer",PC,"libraryLoadedForSession",true,"connectionForeground",true).entrySet()){var field=activity.getClass().getDeclaredField(entry.getKey());field.setAccessible(true);field.set(activity,entry.getValue());}
            var field=activity.getClass().getDeclaredField("assets");field.setAccessible(true);((List<AssetSummary>)field.get(activity)).addAll(List.of(asset("recovered-a",1,hash(bytes)),asset("recovered-b",1,hash(bytes))));
            field=activity.getClass().getDeclaredField("connectionState");field.setAccessible(true);var state=(app.nikkisync.mobile.net.ConnectionState)field.get(activity);
            var render=activity.getClass().getDeclaredMethod("renderConnectionStatus");render.setAccessible(true);render.invoke(activity);assertEquals(0,requests.get());
            state.httpResult(state.session(),true);render.invoke(activity);await(()->loader.offlineProgress().cached()==2);assertEquals(2,requests.get());
        }finally{loader.shutdown();activity.navigationHost().close();for(String name:List.of("io","organizerIo","organizerNetworkIo")){var field=activity.getClass().getDeclaredField(name);field.setAccessible(true);((java.util.concurrent.ExecutorService)field.get(activity)).shutdownNow();}}
    }
    @Test public void moreThanTwentyThousandCachedPhotosRemainAvailableOfflineAndPinnedIntentSurvivesPruning()throws Exception{
        var context=RuntimeEnvironment.getApplication();byte[] bytes=jpeg(48,48);List<AssetSummary> photos=new ArrayList<>();File directory=new File(context.getFilesDir(),"photo-thumbnails-v2");directory.mkdirs();
        for(int i=0;i<21005;i++){var photo=asset("over-limit-"+i,1,"a".repeat(64));photos.add(photo);try(var out=new FileOutputStream(new File(directory,PhotoCacheKey.fileName(PC,photo,false)))){out.write(bytes);}}
        ImageLoader loader=new ImageLoader(context);loader.setNetworkAvailable(false);var organizer=new app.nikkisync.mobile.storage.OrganizerStore(context);
        try{
            organizer.remember(app.nikkisync.mobile.storage.OrganizerStore.scope(PC),photos);var restored=loader.cachedAssets(PC,organizer.library(app.nikkisync.mobile.storage.OrganizerStore.scope(PC)));
            assertEquals(21005,restored.size());assertEquals("over-limit-21004",restored.get(21004).assetId());
            organizer.enqueue(app.nikkisync.mobile.storage.OrganizerStore.scope(PC),List.of(restored.get(20800)));loader.pinForOrganizer(PC,restored.get(20800));
            long started=System.nanoTime();loader.reconcileLibraryIds(PC,restored.stream().map(AssetSummary::assetId).toList(),List.of(restored.get(0)));System.out.println("generated21005ScopeRemovalMs="+(System.nanoTime()-started)/1_000_000);assertEquals(1,loader.photos.thumbnailNames().size());
            loader.photos.trim(0,0);
            assertTrue(loader.hasCached(PC,restored.get(20800)));assertEquals(1,organizer.entries(app.nikkisync.mobile.storage.OrganizerStore.scope(PC)).size());
            ImageView pending=new ImageView(context);loader.loadOffline(PC,restored.get(20800),pending);await(()->pending.getDrawable()!=null);
        }finally{loader.shutdown();organizer.close();}
    }
    static final PairedServer PC=new PairedServer("photo-cache-pc","PC","invalid.local",28080,"cert","","",0);
    static AssetSummary asset(String id,long revision,String hash)throws Exception {
        return JsonCodec.assetPage("{\"items\":[{\"assetId\":\""+id+"\",\"type\":\"photo\",\"state\":\"ready\",\"revision\":"+revision+
            ",\"previewResourceId\":\"preview\",\"previewSha256\":\""+hash+"\",\"fullPreviewResourceId\":\"original\",\"fullPreviewSha256\":\""+hash+"\"}],\"libraryRevision\":1}").items().get(0);
    }
    static byte[] jpeg(int width,int height)throws Exception {
        Bitmap b=Bitmap.createBitmap(width,height,Bitmap.Config.ARGB_8888);b.eraseColor(Color.MAGENTA);
        try(var out=new ByteArrayOutputStream()){assertTrue(b.compress(Bitmap.CompressFormat.JPEG,95,out));return out.toByteArray();}finally{b.recycle();}
    }
    static String hash(byte[] bytes)throws Exception{return java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));}
    static File source(byte[] bytes)throws Exception{File f=File.createTempFile("photo-source-",".jpg",RuntimeEnvironment.getApplication().getCacheDir());try(var out=new FileOutputStream(f)){out.write(bytes);}return f;}
    static HttpsURLConnection connection(byte[] bytes)throws Exception {
        return new HttpsURLConnection(new URL("https://invalid.local/photo")){
            public int getResponseCode(){return 200;} public InputStream getInputStream(){return new ByteArrayInputStream(bytes);}
            public void disconnect(){} public void connect(){} public boolean usingProxy(){return false;}
            public String getCipherSuite(){return "test";} public java.security.cert.Certificate[] getLocalCertificates(){return null;}
            public java.security.cert.Certificate[] getServerCertificates(){return null;}
        };
    }
    static void await(java.util.function.BooleanSupplier done)throws Exception {
        for(int i=0;i<500&&!done.getAsBoolean();i++){Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();Thread.sleep(5);}
        assertTrue("background cache work did not complete",done.getAsBoolean());
    }
    @Test public void cacheIdentitySurvivesMetadataChangesButNotImageChangesOrOtherComputers()throws Exception {
        var first=asset("same",1,"a".repeat(64));var metadata=asset("same",800,"a".repeat(64));var changed=asset("same",801,"b".repeat(64));
        assertEquals(PhotoCacheKey.thumbnail(PC,first),PhotoCacheKey.thumbnail(PC,metadata));
        assertEquals(PhotoCacheKey.preview(PC,first),PhotoCacheKey.preview(PC,metadata));
        assertNotEquals(PhotoCacheKey.thumbnail(PC,first),PhotoCacheKey.thumbnail(PC,changed));
        assertNotEquals(PhotoCacheKey.thumbnail(PC,first),PhotoCacheKey.thumbnail(new PairedServer("other","PC","invalid.local",1,"cert","","",0),first));
        assertNotEquals(PhotoCacheKey.thumbnail(PC,first),PhotoCacheKey.thumbnail(new PairedServer(PC.serverId(),"PC","invalid.local",1,"other-cert","","",0),first));
        var legacy=new AssetSummary("same","photo","ready",null,null,1,null,null,false,false,null,"preview",null,null);
        assertTrue(PhotoCacheKey.thumbnail(PC,legacy).contains("revision:1"));
    }
    @Test public void thumbnailAndPreviewAreSizedIndependentlyAndPendingSurvivesBothEvictions()throws Exception {
        var context=RuntimeEnvironment.getApplication();var preferences=new PhotoCachePreferences(context);var disk=new PhotoDiskCache(context,preferences);
        byte[] bytes=jpeg(3200,1800);File file=source(bytes);var asset=asset("sized",1,hash(bytes));
        try {
            assertTrue(disk.storeThumbnail(PC,asset,file,true));disk.storePreview(PC,asset,file);
            Bitmap thumb=PhotoDiskCache.decode(disk.thumbnail(PC,asset),512),preview=PhotoDiskCache.decode(disk.preview(PC,asset),2048);
            assertEquals(512,thumb.getWidth());assertEquals(2048,preview.getWidth());thumb.recycle();preview.recycle();
            disk.pin(PC,asset);disk.trim(preferences.thumbnailBytes(),0);
            assertTrue(disk.thumbnail(PC,asset).isFile());assertFalse(disk.preview(PC,asset).exists());
            disk.trim(0,0);assertFalse(disk.thumbnail(PC,asset).exists());assertTrue(disk.pinned(PC,asset).isFile());
        }finally{file.delete();}
    }
    @Test public void restartedGridAndMetadataRefreshReuseDiskWithoutDownloadingAndViewerUsesOwnTier()throws Exception {
        var context=RuntimeEnvironment.getApplication();byte[] bytes=jpeg(1600,900);String sha=hash(bytes);AtomicInteger requests=new AtomicInteger();List<String> resources=Collections.synchronizedList(new ArrayList<>());
        ImageLoader.PhotoSource source=(client,asset,id)->{requests.incrementAndGet();resources.add(id);return connection(bytes);};
        var client=new NikkiSyncClient(PC,null);ImageLoader loader=new ImageLoader(context,source);ImageView view=new ImageView(context);
        try {loader.load(client,asset("repeat",1,sha),view);await(()->view.getDrawable()!=null);assertEquals(1,requests.get());assertEquals(List.of("preview"),resources);}
        finally{loader.shutdown();}
        loader=new ImageLoader(context,source);ImageView next=new ImageView(context);final ImageLoader restarted=loader;
        try {
            loader.load(client,asset("repeat",99,sha),next);await(()->next.getDrawable()!=null);assertEquals(1,requests.get());
            var photo=asset("repeat",99,sha);loader.loadPreview(client,photo,next);
            await(()->requests.get()==2&&restarted.photos.preview(PC,photo).isFile());assertEquals(List.of("preview","original"),resources);
            loader.setNetworkAvailable(false);ImageView offline=new ImageView(context);loader.loadOfflinePreview(PC,asset("repeat",100,sha),offline);await(()->offline.getDrawable()!=null);assertEquals(2,requests.get());
        }finally{loader.shutdown();}
    }
    @Test public void completeLargeOfflineLibraryKeepsOrderAfterRestartAndQueueStillRecordsAndCancels()throws Exception {
        var context=RuntimeEnvironment.getApplication();ImageLoader loader=new ImageLoader(context);File source=source(jpeg(48,48));List<AssetSummary> photos=new ArrayList<>();
        var organizer=new app.nikkisync.mobile.storage.OrganizerStore(context);
        try {
            for(int i=0;i<2200;i++){var photo=asset("large-"+i,1,"a".repeat(64));photos.add(photo);assertTrue(loader.photos.storeThumbnail(PC,photo,source,false));}
            organizer.remember(app.nikkisync.mobile.storage.OrganizerStore.scope(PC),photos);loader.shutdown();loader=new ImageLoader(context);loader.setNetworkAvailable(false);
            List<AssetSummary> available=loader.cachedAssets(PC,organizer.library(app.nikkisync.mobile.storage.OrganizerStore.scope(PC)));
            assertEquals(2200,available.size());assertEquals("large-0",available.get(0).assetId());assertEquals("large-2199",available.get(2199).assetId());
            organizer.enqueue(app.nikkisync.mobile.storage.OrganizerStore.scope(PC),List.of(available.get(2100)));loader.pinForOrganizer(PC,available.get(2100));loader.photos.trim(0,0);
            assertTrue(loader.hasCached(PC,available.get(2100)));var entries=organizer.entries(app.nikkisync.mobile.storage.OrganizerStore.scope(PC));assertEquals(1,entries.size());
            organizer.cancel(app.nikkisync.mobile.storage.OrganizerStore.scope(PC),List.of(entries.get(0).id()));assertEquals("cancel_requested",organizer.entries(app.nikkisync.mobile.storage.OrganizerStore.scope(PC)).get(0).state());
        }finally{loader.shutdown();organizer.close();source.delete();}
    }
    @Test public void warmingStopsAtCapacityRatherThanEvictingTheAlbumAndRedownloadingIt()throws Exception {
        var context=RuntimeEnvironment.getApplication();byte[] bytes=jpeg(48,48);AtomicInteger requests=new AtomicInteger();
        ImageLoader loader=new ImageLoader(context,(client,asset,id)->{requests.incrementAndGet();return connection(bytes);});
        try {
            var field=ImageLoader.class.getDeclaredField("executor");field.setAccessible(true);((java.util.concurrent.ExecutorService)field.get(loader)).submit(()->{}).get();
            loader.photos.trim(1,0);var client=new NikkiSyncClient(PC,null);List<AssetSummary> items=List.of(asset("warm-a",1,hash(bytes)),asset("warm-b",1,hash(bytes)));
            loader.warmThumbnails(client,items,null);await(()->loader.offlineProgress().full());assertEquals(1,requests.get());
            loader.warmThumbnails(client,items,null);Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();Thread.sleep(100);assertEquals(1,requests.get());
        }finally{loader.shutdown();}
    }
    @Test public void actualViewerEntryUpgradesCachedGridPixelsToTheOriginalResource()throws Exception {
        var context=RuntimeEnvironment.getApplication();byte[] bytes=jpeg(2400,1600);List<String> requested=Collections.synchronizedList(new ArrayList<>());
        ImageLoader loader=new ImageLoader(context,(client,asset,id)->{requested.add(id);return connection(bytes);});
        var client=new NikkiSyncClient(PC,null);var photo=asset("entry",1,hash(bytes));ImageView grid=new ImageView(context);
        var activity=Robolectric.buildActivity(app.nikkisync.mobile.MainActivity.class).get();
        try{
            loader.load(client,photo,grid);await(()->grid.getDrawable()!=null);assertEquals(512,grid.getDrawable().getIntrinsicWidth());
            for(var entry:Map.of("imageLoader",loader,"client",client).entrySet()){var field=activity.getClass().getDeclaredField(entry.getKey());field.setAccessible(true);field.set(activity,entry.getValue());}
            ImageView viewer=new ImageView(context);viewer.setImageDrawable(grid.getDrawable());viewer.setRotation(90);
            var method=activity.getClass().getDeclaredMethod("loadViewerPhoto",AssetSummary.class,ImageView.class,boolean.class);method.setAccessible(true);method.invoke(activity,photo,viewer,true);
            await(()->viewer.getDrawable()!=null&&viewer.getDrawable().getIntrinsicWidth()==2048);
            assertEquals(List.of("preview","original"),requested);assertEquals(90,viewer.getRotation(),.001);
        }finally{loader.shutdown();for(String name:List.of("io","organizerIo","organizerNetworkIo")){var field=activity.getClass().getDeclaredField(name);field.setAccessible(true);((java.util.concurrent.ExecutorService)field.get(activity)).shutdownNow();}}
    }
    @Test public void memoryAndDiskChoicesPersistAndRespectTheRuntimeHeap() {
        var context=RuntimeEnvironment.getApplication();var settings=new PhotoCachePreferences(context);
        settings.setThumbnailMiB(2048);settings.setPreviewMiB(1024);settings.setMemoryMiB(256);
        settings=new PhotoCachePreferences(context);assertEquals(2048L*1024*1024,settings.thumbnailBytes());assertEquals(1024L*1024*1024,settings.previewBytes());
        assertTrue(settings.effectiveMemoryBytes(192L*1024*1024)<=64L*1024*1024);
        assertEquals(256L*1024*1024,settings.effectiveMemoryBytes(2L*1024*1024*1024));
        assertThrows(IllegalArgumentException.class,()->new PhotoCachePreferences(context).setThumbnailMiB(Integer.MAX_VALUE));
    }
    @Test public void olderPcDetailsUpgradeTheViewerToItsOriginalStillWithoutChangingTheGridIdentity()throws Exception{
        var photo=asset("legacy-detail",2,"a".repeat(64));
        var detail=new AssetDetail(photo.assetId(),"photo","ready",List.of(new MediaResource("real-original","source_high_quality","photo.jpg","image/jpeg","jpg",10,"b".repeat(64),4000,3000,null)),false,null,null,null,null);
        var upgraded=ImageLoader.withFullPreview(photo,detail);
        assertEquals("real-original",PhotoCacheKey.resource(upgraded,true));assertEquals("b".repeat(64),PhotoCacheKey.contentHash(upgraded,true));
        assertEquals(PhotoCacheKey.thumbnail(PC,photo),PhotoCacheKey.thumbnail(PC,upgraded));
        assertTrue(PhotoDiskCache.previewEdge(128L*1024*1024)<=1280);assertEquals(2048,PhotoDiskCache.previewEdge(1024L*1024*1024));
    }
    @Test public void corruptedCachedThumbnailIsReplacedAndMismatchedTransfersAreNeverPublished()throws Exception {
        var context=RuntimeEnvironment.getApplication();byte[] bytes=jpeg(80,60);AtomicInteger requests=new AtomicInteger();
        ImageLoader loader=new ImageLoader(context,(client,asset,id)->{requests.incrementAndGet();return connection(bytes);});
        try{
            var good=asset("corrupt",1,hash(bytes));File target=loader.photos.thumbnail(PC,good);target.getParentFile().mkdirs();try(var out=new FileOutputStream(target)){out.write(new byte[]{1,2,3});}
            ImageView view=new ImageView(context);loader.load(new NikkiSyncClient(PC,null),good,view);await(()->view.getDrawable()!=null);assertEquals(1,requests.get());
            var wrong=asset("bad-hash",1,"f".repeat(64));loader.load(new NikkiSyncClient(PC,null),wrong,new ImageView(context));await(()->requests.get()==2);Thread.sleep(80);
            assertFalse(loader.photos.thumbnail(PC,wrong).exists());
        }finally{loader.shutdown();}
    }
}
