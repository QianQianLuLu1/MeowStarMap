package app.nikkisync.mobile.media;

import android.content.*;
import android.graphics.*;
import android.os.Build;
import android.provider.MediaStore;
import androidx.exifinterface.media.ExifInterface;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.*;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Real Samsung descriptor/MediaStore coverage; running this creates/deletes only its own test image. */
@RunWith(AndroidJUnit4.class)
public class GallerySavePolicyInstrumentedTest {
    @Test public void samsungStillDateSurvivesPublicationAndReadback()throws Exception {
        Assume.assumeTrue("Samsung device required","samsung".equalsIgnoreCase(Build.MANUFACTURER)||"samsung".equalsIgnoreCase(Build.BRAND));
        var resolver=InstrumentationRegistry.getInstrumentation().getTargetContext().getContentResolver();
        long saved=System.currentTimeMillis();var values=new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME,"NikkiSync_date_test_"+saved+".jpg");
        values.put(MediaStore.Images.Media.MIME_TYPE,"image/jpeg");values.put(MediaStore.Images.Media.RELATIVE_PATH,GallerySavePolicy.stillPath());
        values.put(MediaStore.Images.Media.IS_PENDING,1);
        var uri=resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,values);assertNotNull(uri);
        try {
            var image=Bitmap.createBitmap(48,32,Bitmap.Config.ARGB_8888);image.eraseColor(Color.CYAN);
            try(var out=resolver.openOutputStream(uri,"w")){assertNotNull(out);assertTrue(image.compress(Bitmap.CompressFormat.JPEG,100,out));}finally{image.recycle();}
            GallerySavePolicy.prepareStill(resolver,uri,"image/jpeg",saved);
            var ready=new ContentValues();ready.put(MediaStore.Images.Media.IS_PENDING,0);GallerySavePolicy.addDate(ready,saved);
            assertEquals(1,resolver.update(uri,ready,null,null));
            try(var fd=resolver.openFileDescriptor(uri,"r")) {
                assertNotNull(fd);var exif=new ExifInterface(fd.getFileDescriptor());
                String offset=java.time.format.DateTimeFormatter.ofPattern("xxx").format(java.time.Instant.ofEpochMilli(saved).atZone(java.time.ZoneId.systemDefault()));
                assertEquals(offset,exif.getAttribute(ExifInterface.TAG_OFFSET_TIME_ORIGINAL));
                assertNotNull(exif.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL));
            }
            try(var cursor=resolver.query(uri,new String[]{MediaStore.Images.Media.DATE_TAKEN,MediaStore.Images.Media.RELATIVE_PATH},null,null,null)) {
                assertNotNull(cursor);assertTrue(cursor.moveToFirst());assertEquals(saved,cursor.getLong(0));assertEquals("DCIM/Camera/",cursor.getString(1));
            }
        } finally {resolver.delete(uri,null,null);}
    }
}
