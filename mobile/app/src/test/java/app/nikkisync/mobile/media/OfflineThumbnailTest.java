package app.nikkisync.mobile.media;
import android.graphics.Bitmap;
import app.nikkisync.mobile.model.Models.*;
import java.io.*;
import java.security.MessageDigest;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class)
public class OfflineThumbnailTest {
    @Test public void pendingThumbnailSurvivesDisposableCacheRemovalAndDoesNotCrossComputers()throws Exception{
        var context=RuntimeEnvironment.getApplication();ImageLoader images=new ImageLoader(context);
        var server=new PairedServer("pc","PC","127.0.0.1",1,"cert","","",0);var asset=new AssetSummary("asset_a","photo","ready",null,null,1,100,100,false,false,"t","p",null,null);
        String key="pc:cert:asset_a:t:r1";StringBuilder name=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(key.getBytes(java.nio.charset.StandardCharsets.UTF_8)))name.append(String.format("%02x",b));
        File file=new File(context.getFilesDir(),"thumbnail-cache-v1/"+name+".img");Bitmap bitmap=Bitmap.createBitmap(16,16,Bitmap.Config.ARGB_8888);
        try{try(var out=new FileOutputStream(file)){assertTrue(bitmap.compress(Bitmap.CompressFormat.JPEG,90,out));}assertTrue(images.hasCached(server,asset));images.pinForOrganizer(server,asset);assertTrue(file.delete());assertTrue(images.hasCached(server,asset));
            assertFalse(images.hasCached(new PairedServer("other","PC","127.0.0.1",1,"cert","","",0),asset));
        }finally{bitmap.recycle();images.shutdown();}
    }
}
