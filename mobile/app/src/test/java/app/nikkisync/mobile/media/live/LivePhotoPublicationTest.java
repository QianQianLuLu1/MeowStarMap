package app.nikkisync.mobile.media.live;

import android.content.*;
import android.content.pm.ProviderInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import java.io.*;
import java.nio.file.Files;
import java.util.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.*;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk={30,31,32,35})
public class LivePhotoPublicationTest {
    Context context; Provider provider; File source;
    @Before public void setup() throws Exception {
        context=RuntimeEnvironment.getApplication();provider=new Provider();
        var info=new ProviderInfo();info.authority="media";provider.attachInfo(context,info);
        ShadowContentResolver.registerProviderInternal("media",provider);
        source=File.createTempFile("live-source-",".jpg",context.getCacheDir());Files.write(source.toPath(),new byte[]{1,2,3,4});
        ShadowBuild.setManufacturer("samsung");ShadowBuild.setBrand("samsung");
    }
    @After public void cleanup() throws Exception {
        Thread.interrupted();Files.deleteIfExists(source.toPath());
        for(File file:provider.files.values())Files.deleteIfExists(file.toPath());
    }
    @Test public void samsungManualStandardAlsoUsesCameraAndCurrentGalleryDate() throws Exception {
        long before=System.currentTimeMillis();
        var result=LivePhotoExporter.publish(context.getContentResolver(),LivePhotoProfile.STANDARD,"test",new MotionContainer.Product(source,List.of()));
        assertEquals(1,result.size());assertEquals("DCIM/Camera",provider.inserted.get(0).getAsString("relative_path"));
        Long taken=provider.inserted.get(0).getAsLong("datetaken");assertNotNull(taken);
        assertTrue(taken>=before&&taken<=System.currentTimeMillis());
        assertEquals(taken,provider.ready.get(0).getAsLong("datetaken"));
        assertArrayEquals(Files.readAllBytes(source.toPath()),Files.readAllBytes(provider.files.get(result.get(0)).toPath()));
    }
    @Test public void otherDevicesRetainExistingFoldersAndDateBehavior() throws Exception {
        ShadowBuild.setManufacturer("OPPO");ShadowBuild.setBrand("oneplus");
        for(var profile:LivePhotoProfile.values()) {
            provider.inserted.clear();provider.ready.clear();
            LivePhotoExporter.publish(context.getContentResolver(),profile,"test",new MotionContainer.Product(source,profile.paired?List.of(source):List.of()));
            String path=profile==LivePhotoProfile.STANDARD||profile==LivePhotoProfile.XIAOMI?"Pictures/NikkiSync":"DCIM/Camera";
            for(var values:provider.inserted) {assertEquals(path,values.getAsString("relative_path"));assertFalse(values.containsKey("datetaken"));}
        }
    }
    @Test public void allocationFailureRollsBackNewEntryAndBecomesRecoverableError() throws Exception {
        provider.outOfMemory=true;
        IOException error=assertThrows(IOException.class,()->LivePhotoExporter.publish(context.getContentResolver(),LivePhotoProfile.OPLUS,"test",new MotionContainer.Product(source,List.of())));
        assertTrue(error.getMessage().contains("内存"));assertEquals(1,provider.deleted.size());assertEquals(0,provider.ready.size());
    }
    @Test public void secondPairedInsertFailureRollsBackOnlyCreatedMedia() throws Exception {
        provider.failSecondInsert=true;
        assertThrows(IOException.class,()->LivePhotoExporter.publish(context.getContentResolver(),LivePhotoProfile.VIVO_LEGACY_PAIR,"test",new MotionContainer.Product(source,List.of(source))));
        assertEquals(1,provider.deleted.size());assertTrue(source.exists());assertEquals(0,provider.ready.size());
    }
    @Test public void failedPublicationAndCancellationNeverLeavePartialMedia() throws Exception {
        provider.failUpdate=true;
        assertThrows(IOException.class,()->LivePhotoExporter.publish(context.getContentResolver(),LivePhotoProfile.SAMSUNG_SEF,"test",new MotionContainer.Product(source,List.of())));
        assertEquals(1,provider.deleted.size());assertTrue(source.exists());
        int inserts=provider.inserted.size();Thread.currentThread().interrupt();
        try {assertThrows(InterruptedIOException.class,()->LivePhotoExporter.publish(context.getContentResolver(),LivePhotoProfile.SAMSUNG_SEF,"test",new MotionContainer.Product(source,List.of())));}
        finally {Thread.interrupted();}
        assertEquals(inserts,provider.inserted.size());
    }
    public static class Provider extends ContentProvider {
        Map<Uri,File> files=new LinkedHashMap<>();List<ContentValues> inserted=new ArrayList<>(),ready=new ArrayList<>();List<Uri> deleted=new ArrayList<>();
        boolean outOfMemory,failSecondInsert,failUpdate;
        @Override public boolean onCreate(){return true;}
        @Override public String getType(Uri u){return "image/jpeg";}
        @Override public Cursor query(Uri u,String[] p,String s,String[] a,String o){return null;}
        @Override public Uri insert(Uri u,ContentValues v){
            if(failSecondInsert&&!inserted.isEmpty())return null;
            try {Uri uri=Uri.parse("content://media/external/images/media/"+(files.size()+1));
                files.put(uri,File.createTempFile("live-media-",".tmp",getContext().getCacheDir()));inserted.add(new ContentValues(v));return uri;
            } catch(IOException e){throw new IllegalStateException(e);}
        }
        @Override public int update(Uri u,ContentValues v,String s,String[] a){if(failUpdate)return 0;ready.add(new ContentValues(v));return 1;}
        @Override public int delete(Uri u,String s,String[] a){if(!files.containsKey(u))throw new AssertionError("Deleting unrelated media");deleted.add(u);return files.get(u).delete()?1:0;}
        @Override public ParcelFileDescriptor openFile(Uri u,String mode)throws FileNotFoundException {
            if(mode.contains("w")&&outOfMemory)throw new OutOfMemoryError("synthetic allocation failure");
            return ParcelFileDescriptor.open(files.get(u),ParcelFileDescriptor.parseMode(mode));
        }
    }
}
