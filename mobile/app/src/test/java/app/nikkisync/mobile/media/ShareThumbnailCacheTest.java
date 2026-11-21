package app.nikkisync.mobile.media;

import android.content.Context;
import android.graphics.Bitmap;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk = 35)
@org.robolectric.annotation.GraphicsMode(org.robolectric.annotation.GraphicsMode.Mode.NATIVE)
public class ShareThumbnailCacheTest {
    @Test public void legacyDiskBudgetIsKeptAndBitmapMemoryFollowsTheUserLimitAndSafeHeapCap() throws Exception {
        var budget=ImageLoader.class.getDeclaredField("MAX_DISK_CACHE_BYTES");budget.setAccessible(true);
        assertTrue("600 cached files averaging 600KiB must fit",budget.getLong(null)>=600L*600*1024);
        var loader=new ImageLoader(RuntimeEnvironment.getApplication());
        try {
            var memory=ImageLoader.class.getDeclaredField("cache");memory.setAccessible(true);
            assertEquals(Math.max(1,loader.preferences().effectiveMemoryBytes(Runtime.getRuntime().maxMemory())/1024),((android.util.LruCache<?,?>)memory.get(loader)).maxSize());
        } finally {loader.shutdown();}
    }
    @Test public void restartedUiUsesSameClothingFileForAnotherPhotoWithoutNetwork() throws Exception {
        Context context=RuntimeEnvironment.getApplication();String tls="0".repeat(64);
        var server=new app.nikkisync.mobile.model.Models.PairedServer("pc","PC","invalid.local",1,tls,"","",0);
        var client=new app.nikkisync.mobile.net.NikkiSyncClient(server,null);
        File dir=new File(context.getFilesDir(),"thumbnail-cache-v1");dir.mkdirs();
        String key=ClothingCacheKey.of(server,"photo-a","shirt","v1");
        byte[] hash=MessageDigest.getInstance("SHA-256").digest(key.getBytes(StandardCharsets.UTF_8));
        StringBuilder name=new StringBuilder();for(byte b:hash)name.append(String.format("%02x",b));
        File file=new File(dir,name+".img");Bitmap bitmap=Bitmap.createBitmap(96,96,Bitmap.Config.ARGB_8888);bitmap.eraseColor(android.graphics.Color.RED);
        try(FileOutputStream out=new FileOutputStream(file)){bitmap.compress(Bitmap.CompressFormat.PNG,100,out);}bitmap.recycle();
        class Target extends android.widget.ImageView {
            Bitmap loaded;
            Target(){super(context);}
            @Override public void setImageBitmap(Bitmap value){super.setImageBitmap(value);loaded=value;}
        }
        for(String photo:java.util.List.of("photo-a","photo-b")) {
            var loader=new ImageLoader(context);var target=new Target();
            try {
                loader.loadClothingThumbnail(client,photo,"shirt","v1",target);
                for(int i=0;i<200&&target.loaded==null;i++) {
                    org.robolectric.shadows.ShadowLooper.idleMainLooper();Thread.sleep(5);
                }
                assertNotNull(target.loaded);assertEquals(96,target.loaded.getWidth());
                assertEquals(android.graphics.Color.RED,target.loaded.getPixel(48,48));
            } finally {loader.shutdown();}
        }
        file.delete();
    }
    @Test
    public void slowStreamCannotContinuePastExportDeadline() throws Exception {
        java.util.concurrent.atomic.AtomicLong clock = new java.util.concurrent.atomic.AtomicLong();
        java.io.InputStream slow = new java.io.InputStream() {
            @Override public int read() { clock.addAndGet(1); return 1; }
            @Override public int read(byte[] buffer) { clock.addAndGet(100); buffer[0] = 1; return 1; }
        };
        try {
            ImageLoader.copyExportThumbnail(slow, new java.io.ByteArrayOutputStream(), 150, clock::get);
            fail("slow stream must hit the deadline");
        } catch (java.io.IOException error) {
            assertEquals("thumbnail export deadline exceeded", error.getMessage());
            assertTrue(clock.get() <= 200);
        }
    }
    @Test public void offlineExportReadsExistingUiCacheAndRespectsVersion() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        File dir = new File(context.getFilesDir(), "thumbnail-cache-v1");
        dir.mkdirs();
        byte[] hash = MessageDigest.getInstance("SHA-256").digest("clothing:asset:id:v4".getBytes(StandardCharsets.UTF_8));
        StringBuilder name = new StringBuilder();
        for (byte b : hash) name.append(String.format("%02x", b));
        File file = new File(dir, name + ".img");
        try (FileOutputStream corrupt = new FileOutputStream(file)) { corrupt.write(new byte[]{1,2,3}); }
        assertNull(ImageLoader.readClothingForExport(context, null, "asset", "id", "v4"));
        File downloaded = File.createTempFile("share-test", ".tmp", dir);
        Bitmap source = Bitmap.createBitmap(1024, 1024, Bitmap.Config.ARGB_8888);
        try (FileOutputStream output = new FileOutputStream(downloaded)) { source.compress(Bitmap.CompressFormat.PNG, 100, output); }
        source.recycle();
        ImageLoader.publishExportThumbnail(downloaded, file);
        Bitmap cached = ImageLoader.readClothingForExport(context, null, "asset", "id", "v4");
        assertNotNull(cached);
        assertTrue(cached.getWidth() <= 512);
        cached.recycle();
        assertNull(ImageLoader.readClothingForExport(context, null, "asset", "id", "new-version"));
        file.delete();
    }
}
