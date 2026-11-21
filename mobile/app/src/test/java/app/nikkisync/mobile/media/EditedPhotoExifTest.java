package app.nikkisync.mobile.media;
import android.content.*;
import android.database.Cursor;
import android.graphics.*;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import java.io.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.*;
import app.nikkisync.mobile.storage.*;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class) @Config(sdk={30,31,32,35}) @GraphicsMode(GraphicsMode.Mode.NATIVE)
public class EditedPhotoExifTest {
 static final Uri SOURCE=Uri.parse("content://test.edited/source");
 Context context;PhotoProvider provider;
 @Before public void setup()throws Exception{
  context=RuntimeEnvironment.getApplication();provider=new PhotoProvider(context.getCacheDir());
  var info=new android.content.pm.ProviderInfo();info.authority="test.edited;media";info.exported=true;
  provider.attachInfo(context,info);
  org.robolectric.shadows.ShadowContentResolver.registerProviderInternal("test.edited",provider);
  org.robolectric.shadows.ShadowContentResolver.registerProviderInternal("media",provider);
  context.getSharedPreferences("nikkisync.export",0).edit().clear().commit();
  var image=Bitmap.createBitmap(40,20,Bitmap.Config.ARGB_8888);image.eraseColor(Color.BLUE);
  try(var out=new FileOutputStream(provider.source)){image.compress(Bitmap.CompressFormat.JPEG,100,out);}
 }
 @Test public void readOnlyPickerPhotoGetsVerifiedDerivativeAndOriginalAssetParameters()throws Exception{
  byte[] before=java.nio.file.Files.readAllBytes(provider.source.toPath());
  var snapshot=new SavedMetadataSnapshotStore.Snapshot("asset-a","{\"camera\":{\"focalLength\":35},\"dressing\":{\"clothes\":[{\"name\":\"裙子\",\"id\":\"123\"}]}}","2026-09-01T00:00:00Z","2.9",1);
  var result=EditedPhotoExif.prepare(context,SOURCE,"image/jpeg",snapshot,null,null);
  assertTrue(result.copied());assertTrue(result.written());assertNotEquals(SOURCE,result.uri());
  assertArrayEquals(before,java.nio.file.Files.readAllBytes(provider.source.toPath()));
  assertTrue(provider.published);
  var exif=new androidx.exifinterface.media.ExifInterface(provider.target);
  assertEquals(PhotoExif.CAMERA,exif.getAttribute(androidx.exifinterface.media.ExifInterface.TAG_MODEL));
  assertEquals("Bloom Beneath Bright Skies",exif.getAttribute(androidx.exifinterface.media.ExifInterface.TAG_LENS_MAKE));
  var json=new org.json.JSONObject(exif.getAttribute(androidx.exifinterface.media.ExifInterface.TAG_USER_COMMENT));
  assertEquals("123",json.getJSONObject("dressing").getJSONArray("clothes").getJSONObject(0).getString("id"));
  context.deleteDatabase("nikkisync-edited-variants.db");
  try(var store=new EditedVariantStore(context)){
   store.linkSelected("asset-a","content://saved/source",result.uri().toString(),SOURCE.toString(),1,"retouched.jpg","image/jpeg");
   assertEquals("asset-a",store.findByUri(SOURCE.toString()).assetId());
   assertEquals(result.uri().toString(),store.loadForAsset("asset-a").get(0).uri());
  }
 }
 @Test public void unsupportedOrDisabledExifDoesNotCreateFalseSuccess()throws Exception{
  assertFalse(EditedPhotoExif.prepare(context,SOURCE,"image/heic",null,null,"2.9").written());
  assertNull(provider.target);
  context.getSharedPreferences("nikkisync.export",0).edit().putBoolean("writeExif",false).commit();
  assertFalse(EditedPhotoExif.prepare(context,SOURCE,"image/jpeg",null,null,"2.9").copied());
  assertNull(provider.target);
 }
 @Test public void failedPublicationRemovesOnlyTheNewCopy()throws Exception{
  provider.failPublish=true;
  try{EditedPhotoExif.prepare(context,SOURCE,"image/jpeg",null,null,"2.9");fail();}catch(IOException expected){}
  assertTrue(provider.source.exists());assertNotNull(provider.target);assertFalse(provider.target.exists());
 }
 public static class PhotoProvider extends ContentProvider{
  final File directory,source;File target;boolean published,failPublish;
  PhotoProvider(File dir){directory=dir;source=new File(dir,"picked-original.jpg");}
  @Override public boolean onCreate(){return true;}
  @Override public String getType(Uri uri){return "image/jpeg";}
  @Override public Cursor query(Uri u,String[] p,String s,String[] a,String o){return null;}
  @Override public Uri insert(Uri u,ContentValues v){target=new File(directory,"exported-edit.jpg");return Uri.parse("content://media/external/images/media/101");}
  @Override public int update(Uri u,ContentValues v,String s,String[] a){if(failPublish)return 0;published=true;return 1;}
  @Override public int delete(Uri u,String s,String[] a){if(SOURCE.equals(u))throw new AssertionError("Deleting source");return target.delete()?1:0;}
  @Override public ParcelFileDescriptor openFile(Uri u,String mode)throws FileNotFoundException{
   boolean original=SOURCE.equals(u);if(original&&mode.contains("w"))throw new SecurityException("Picker read only");
   return ParcelFileDescriptor.open(original?source:target,ParcelFileDescriptor.parseMode(mode));
  }
 }
}
