package app.nikkisync.mobile.share;
import static org.junit.Assert.*;
import android.content.*;
import android.database.Cursor;
import android.graphics.*;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowContentResolver;
import java.io.*;
import java.nio.file.Files;
import java.util.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35)
public final class ShareCardPreparationTest {
    @Test public void prepareDoesNotSaveAndCloseRemovesOnlyOwnTemporaryPages() throws Exception {
        File source=File.createTempFile("synthetic-",".png",RuntimeEnvironment.getApplication().getCacheDir());
        Bitmap image=Bitmap.createBitmap(160,240,Bitmap.Config.ARGB_8888);
        try(FileOutputStream out=new FileOutputStream(source)) {image.compress(Bitmap.CompressFormat.PNG,100,out);}
        image.recycle();
        var payload=new ShareCardPayload("a","","",List.of(),List.of(),List.of());
        List<String> stages=new ArrayList<>();
        var prepared=ShareCardPreparation.prepare(RuntimeEnvironment.getApplication(),null,Uri.fromFile(source),null,payload,0,()->true,
                (stage,done,total)->stages.add(stage));
        assertTrue(stages.contains("处理照片方向"));assertTrue(stages.contains("分享图页面"));
        Bitmap preview=prepared.preview(0);assertNotNull(preview);preview.recycle();
        prepared.close();
        assertTrue(source.isFile());
        try {prepared.preview(0);fail("Closed preview must not reopen");} catch(IllegalStateException expected) {}
        source.delete();
    }
    @Test public void explicitSavePinsPageAndPublishesPngEvenWhenPreviewCloses() throws Exception {
        Context context=RuntimeEnvironment.getApplication();
        File dir=Files.createTempDirectory(context.getCacheDir().toPath(),"prepared-").toFile();
        File page=new File(dir,"page.png");byte[] bytes={1,2,3,4};Files.write(page.toPath(),bytes);
        var prepared=new ShareCardPreparation.Prepared(dir,List.of(page),"a",0);
        class Provider extends ContentProvider {
            int inserts,updates,deletes;File output;boolean failUpdate;
            public boolean onCreate(){return true;}
            public Uri insert(Uri uri,ContentValues values) {
                assertEquals("image/png",values.getAsString("mime_type"));inserts++;
                return Uri.parse("content://media/external/images/media/123");
            }
            public ParcelFileDescriptor openFile(Uri uri,String mode) throws FileNotFoundException {
                prepared.close();assertTrue(page.isFile());
                output=new File(context.getCacheDir(),"published.png");
                return ParcelFileDescriptor.open(output,ParcelFileDescriptor.MODE_CREATE|ParcelFileDescriptor.MODE_READ_WRITE);
            }
            public int update(Uri uri,ContentValues values,String selection,String[] args){updates++;return failUpdate?0:1;}
            public int delete(Uri uri,String s,String[] a){deletes++;return 1;}
            public String getType(Uri uri){return "image/png";}
            public Cursor query(Uri u,String[] p,String s,String[] a,String o){return null;}
        }
        Provider provider=new Provider();var info=new android.content.pm.ProviderInfo();info.authority="media";
        provider.attachInfo(context,info);
        ShadowContentResolver.registerProviderInternal("media",provider);
        assertEquals(0,provider.inserts);
        List<String> progress=new ArrayList<>();
        assertNotNull(prepared.save(context,0,(stage,done,total)->{
            if(stage.equals("保存完成"))assertEquals(1,provider.updates);
            progress.add(stage);
        }));
        assertTrue(progress.contains("写入相册"));assertEquals("保存完成",progress.get(progress.size()-1));
        assertEquals(1,provider.inserts);assertEquals(1,provider.updates);assertEquals(0,provider.deletes);
        assertArrayEquals(bytes,Files.readAllBytes(provider.output.toPath()));
        assertFalse(dir.exists());provider.output.delete();
    }
    @Test public void cancellingBeforeWorkPreventsLatePreviewCallbacks() {
        Queue<Runnable> work=new ArrayDeque<>(), callbacks=new ArrayDeque<>();
        var coordinator=new ShareCardExportCoordinator(RuntimeEnvironment.getApplication(),work::add,callbacks::add);
        int[] results={0};
        coordinator.exportLocal(null,"a","","","",new ShareCardExportCoordinator.Listener() {
            public void onSuccess(ShareCardPreparation.Prepared prepared){results[0]++;prepared.close();}
            public void onFailure(Exception error){results[0]++;}
        });
        coordinator.cancel();
        while(!work.isEmpty()) work.remove().run();
        while(!callbacks.isEmpty()) callbacks.remove().run();
        assertEquals(0,results[0]);
    }
}
