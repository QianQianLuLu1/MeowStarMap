package app.nikkisync.mobile.widget;
import android.graphics.*;
import android.net.Uri;
import java.io.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.*;
import app.nikkisync.mobile.privacy.PrivacyConsentStore;
import app.nikkisync.mobile.storage.SavedPhotoStore;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class) @Config(sdk={30,31,32,35}) @GraphicsMode(GraphicsMode.Mode.NATIVE)
public class SavedPhotoQualityTest {
 @Test public void viewerReadsOriginalResolutionAndWidgetsClassifyAfterExifRotation()throws Exception{
  var c=RuntimeEnvironment.getApplication();new PrivacyConsentStore(c).accept();
  var photo=Bitmap.createBitmap(3000,1500,Bitmap.Config.ARGB_8888);photo.eraseColor(Color.GREEN);
  var f=new File(c.getCacheDir(),"high-resolution.jpg");
  try(var out=new FileOutputStream(f)){photo.compress(Bitmap.CompressFormat.JPEG,100,out);}
  var exif=new androidx.exifinterface.media.ExifInterface(f);exif.setAttribute(androidx.exifinterface.media.ExifInterface.TAG_ORIENTATION,"6");exif.saveAttributes();
  var uri=mediaUri(f);
  var decoded=app.nikkisync.mobile.media.SavedPhotoDecoder.decode(c,uri,4096);
  assertEquals(1500,decoded.getWidth());assertEquals(3000,decoded.getHeight());
  c.getSharedPreferences("nikkisync_saved_photos",0).edit().putString("records","[{\"assetId\":\"a\",\"uri\":\""+uri+"\",\"savedAt\":1}]").commit();
  assertNull(PhotoAlbumWidgetProvider.prepare(c,903,true,100,false,false).photo());
 }
 @Test public void wideSkipsPortraitAndSquareKeepsIt() throws Exception {
  var c=RuntimeEnvironment.getApplication(); new PrivacyConsentStore(c).accept();
  c.getSharedPreferences("nikkisync_saved_photos",0).edit().clear().commit();
  var b=Bitmap.createBitmap(100,200,Bitmap.Config.ARGB_8888); b.eraseColor(Color.BLUE);
  var f=new File(c.getCacheDir(),"portrait.png");
  try(var out=new FileOutputStream(f)){b.compress(Bitmap.CompressFormat.PNG,100,out);}
  String uri=mediaUri(f).toString();
  var direct=app.nikkisync.mobile.media.SavedPhotoDecoder.decode(c,Uri.parse(uri),1536);
  assertNotNull(direct);direct.recycle();
  c.getSharedPreferences("nikkisync_saved_photos",0).edit().putString("records","[{\"assetId\":\"a\",\"uri\":\""+uri+"\",\"savedAt\":1}]").commit();
  assertNull(PhotoAlbumWidgetProvider.prepare(c,901,true,100,false,false).photo());
  assertNotNull(PhotoAlbumWidgetProvider.prepare(c,902,false,100,false,false).photo());
 }
 @Test public void launcherOutputRetainsHighResolutionWithinBudget() {
  var result=PhotoAlbumWidgetRenderer.render(RuntimeEnvironment.getApplication(),null,true,1200,600);
  assertTrue(result.getWidth()>=1000);
  assertTrue(result.getByteCount()<=3_000_000);
 }
 private static Uri mediaUri(File file) {
  Uri uri=Uri.parse("content://momo.quality.fixture/"+file.getName());
  Shadows.shadowOf(RuntimeEnvironment.getApplication().getContentResolver()).registerInputStreamSupplier(uri,()->{
   try{return new FileInputStream(file);}catch(IOException error){throw new UncheckedIOException(error);}
  });
  return uri;
 }
}
