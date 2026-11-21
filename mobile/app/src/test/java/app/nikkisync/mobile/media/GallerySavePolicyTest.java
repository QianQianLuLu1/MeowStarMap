package app.nikkisync.mobile.media;

import android.graphics.*;
import androidx.exifinterface.media.ExifInterface;
import app.nikkisync.mobile.media.live.*;
import java.io.*;
import java.nio.file.Files;
import java.util.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.*;
import org.robolectric.shadows.ShadowBuild;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk={30,31,32,35}) @GraphicsMode(GraphicsMode.Mode.NATIVE)
public class GallerySavePolicyTest {
    static final long SAVED=1792577225272L;
    File directory,image;byte[] original;String metadata;TimeZone previousZone;
    @Before public void setup() throws Exception {
        previousZone=TimeZone.getDefault();TimeZone.setDefault(TimeZone.getTimeZone("UTC"));
        directory=Files.createTempDirectory(RuntimeEnvironment.getApplication().getCacheDir().toPath(),"gallery-date-").toFile();
        image=new File(directory,"source.jpg");
        Bitmap bitmap=Bitmap.createBitmap(48,32,Bitmap.Config.ARGB_8888);bitmap.eraseColor(Color.CYAN);
        try(var out=new FileOutputStream(image)){assertTrue(bitmap.compress(Bitmap.CompressFormat.JPEG,100,out));}finally{bitmap.recycle();}
        var parameters=PhotoExif.metadata(RuntimeEnvironment.getApplication(),"{\"camera\":{\"focalLength\":35}}","2020-01-02T03:04:05Z","2.9");
        var exif=new ExifInterface(image);exif.setAttribute(ExifInterface.TAG_ORIENTATION,"6");PhotoExif.apply(exif,parameters);
        metadata=new ExifInterface(image).getAttribute(ExifInterface.TAG_USER_COMMENT);original=Files.readAllBytes(image.toPath());
        ShadowBuild.setManufacturer("samsung");ShadowBuild.setBrand("samsung");
    }
    @After public void cleanup() throws Exception {
        TimeZone.setDefault(previousZone);
        try(var paths=Files.walk(directory.toPath())){for(var p:paths.sorted(Comparator.reverseOrder()).toList())Files.deleteIfExists(p);}
    }
    @Test public void samsungUnifiesFoldersRegardlessOfManualLiveProfile() {
        assertEquals("DCIM/Camera",GallerySavePolicy.stillPath());
        for(var profile:LivePhotoProfile.values())assertEquals("DCIM/Camera",GallerySavePolicy.livePath(profile));
    }
    @Test public void samsungDatesChangeWithoutLosingGameTimeOrientationOrCompressedPixels() throws Exception {
        File prepared=GallerySavePolicy.prepareLiveImage(image,directory,SAVED);
        assertNotEquals(image,prepared);assertArrayEquals(original,Files.readAllBytes(image.toPath()));
        var exif=new ExifInterface(prepared);
        assertEquals("2026:10:21 10:07:05",exif.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL));
        assertEquals("+00:00",exif.getAttribute(ExifInterface.TAG_OFFSET_TIME_ORIGINAL));
        assertEquals("272",exif.getAttribute(ExifInterface.TAG_SUBSEC_TIME_ORIGINAL));
        assertEquals(6,exif.getAttributeInt(ExifInterface.TAG_ORIENTATION,1));
        assertEquals(metadata,exif.getAttribute(ExifInterface.TAG_USER_COMMENT));
        assertEquals("2020-01-02T03:04:05Z",new org.json.JSONObject(exif.getAttribute(ExifInterface.TAG_USER_COMMENT)).getString("capturedAt"));
        assertArrayEquals(scan(original),scan(Files.readAllBytes(prepared.toPath())));
        // Date editing happens BEFORE packaging: the complete Samsung motion tail stays intact.
        File video=new File(directory,"source.mp4"),output=new File(directory,"container");assertTrue(output.mkdir());
        Files.write(video.toPath(),new byte[]{0,0,0,20,'f','t','y','p','i','s','o','m',0,0,0,0,'i','s','o','m',0,0,0,8,'m','o','o','v',0,0,0,12,'m','d','a','t',1,2,3,4});
        var options=new MotionContainer.Options(500000,10,30,1000000,"pair","model");
        var product=MotionContainer.write(LivePhotoProfile.SAMSUNG_SEF,prepared,video,output,options);
        MotionContainerVerifier.verify(LivePhotoProfile.SAMSUNG_SEF,product,video,options);
        assertTrue(product.companions().isEmpty());
    }
    @Test public void ordinarySamsungPhotoUsesSameDatesEvenWithMetadataExportDisabled() throws Exception {
        // Exercise the shared EXIF operation with a real JPEG. Descriptor duplication is not
        // implemented by Windows Robolectric; its actual MediaStore route has a device test.
        GallerySavePolicy.applyDate(new ExifInterface(image),SAVED);
        assertEquals("2026:10:21 10:07:05",new ExifInterface(image).getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL));
        assertArrayEquals(scan(original),scan(Files.readAllBytes(image.toPath())));
    }
    @Test public void otherBrandsKeepTheirFoldersDatesAndExactJpegBytes() throws Exception {
        for(String brand:new String[]{"OPPO","oneplus","realme","vivo","iQOO","Xiaomi","Redmi","HUAWEI","HONOR","Google",""}) {
            ShadowBuild.setManufacturer(brand);ShadowBuild.setBrand(brand);
            assertEquals("Pictures/NikkiSync",GallerySavePolicy.stillPath());
            assertSame(image,GallerySavePolicy.prepareLiveImage(image,directory,SAVED));
            assertArrayEquals(original,Files.readAllBytes(image.toPath()));
            var values=new android.content.ContentValues();GallerySavePolicy.addDate(values,SAVED);assertEquals(0,values.size());
        }
    }
    @Test public void samsungExifUsesPhoneLocalTimeIncludingKoreaAndDateBoundary() throws Exception {
        TimeZone previous=TimeZone.getDefault();
        try {
            for(String[] zone:new String[][]{{"Asia/Seoul","2026:10:21 19:07:05","+09:00"},
                {"Asia/Hong_Kong","2026:10:21 18:07:05","+08:00"},{"UTC","2026:10:21 10:07:05","+00:00"}}) {
                TimeZone.setDefault(TimeZone.getTimeZone(zone[0]));GallerySavePolicy.applyDate(new ExifInterface(image),SAVED);
                var exif=new ExifInterface(image);assertEquals(zone[1],exif.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL));
                assertEquals(zone[2],exif.getAttribute(ExifInterface.TAG_OFFSET_TIME_ORIGINAL));
            }
            TimeZone.setDefault(TimeZone.getTimeZone("Asia/Seoul"));
            GallerySavePolicy.applyDate(new ExifInterface(image),java.time.Instant.parse("2026-10-21T16:00:00Z").toEpochMilli());
            assertEquals("2026:10:22 01:00:00",new ExifInterface(image).getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL));
        } finally {TimeZone.setDefault(previous);}
    }
    private static byte[] scan(byte[] b) {
        for(int i=2;i<b.length-1;i++)if((b[i]&255)==255&&(b[i+1]&255)==218)return Arrays.copyOfRange(b,i,b.length);
        throw new AssertionError("missing JPEG scan");
    }
}
