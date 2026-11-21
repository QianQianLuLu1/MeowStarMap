package app.nikkisync.mobile.media;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class)
@org.robolectric.annotation.GraphicsMode(org.robolectric.annotation.GraphicsMode.Mode.NATIVE)
public class PhotoExifTest {
 @Test public void jpegPngAndWebpMetadataRoundTripRetainsPixelsAndOrientation()throws Exception{
  var c=RuntimeEnvironment.getApplication();
  var bitmap=android.graphics.Bitmap.createBitmap(80,40,android.graphics.Bitmap.Config.ARGB_8888);
  bitmap.eraseColor(android.graphics.Color.CYAN);
  var metadata=PhotoExif.metadata(c,"{\"camera\":{\"focalLength\":35,\"apertureSection\":2.8},\"dressing\":{\"clothes\":[{\"id\":\"123\",\"name\":\"星光裙\"}]}}","2026-09-01T00:00:00Z","2.9");
  for(var format:new android.graphics.Bitmap.CompressFormat[]{android.graphics.Bitmap.CompressFormat.JPEG,android.graphics.Bitmap.CompressFormat.PNG,android.graphics.Bitmap.CompressFormat.WEBP_LOSSLESS}){
   var file=java.io.File.createTempFile("exif-test-",".image",c.getCacheDir());
   try{
    try(var out=new java.io.FileOutputStream(file)){assertTrue(bitmap.compress(format,100,out));}
    var exif=new androidx.exifinterface.media.ExifInterface(file);
    exif.setAttribute(androidx.exifinterface.media.ExifInterface.TAG_ORIENTATION,"6");
    exif.setAttribute(androidx.exifinterface.media.ExifInterface.TAG_MAKE,"MomoCamera");
    exif.setAttribute(androidx.exifinterface.media.ExifInterface.TAG_LENS_MODEL,"MomoCamera");exif.saveAttributes();
    byte[] before=java.nio.file.Files.readAllBytes(file.toPath());
    var pixels=android.graphics.BitmapFactory.decodeFile(file.toString());
    PhotoExif.apply(new androidx.exifinterface.media.ExifInterface(file),metadata);
    var after=new androidx.exifinterface.media.ExifInterface(file);
    assertEquals("MomoCamera",after.getAttribute(androidx.exifinterface.media.ExifInterface.TAG_MODEL));
    assertNull(after.getAttribute(androidx.exifinterface.media.ExifInterface.TAG_MAKE));
    assertEquals("InfinityNikki",after.getAttribute(androidx.exifinterface.media.ExifInterface.TAG_LENS_MODEL));
    assertEquals("Bloom Beneath Bright Skies",after.getAttribute(androidx.exifinterface.media.ExifInterface.TAG_LENS_MAKE));
    assertEquals(6,after.getAttributeInt(androidx.exifinterface.media.ExifInterface.TAG_ORIENTATION,1));
    var read=new org.json.JSONObject(after.getAttribute(androidx.exifinterface.media.ExifInterface.TAG_USER_COMMENT));
    assertEquals("星光裙",read.getJSONObject("dressing").getJSONArray("clothes").getJSONObject(0).getString("name"));
    assertTrue(pixels.sameAs(android.graphics.BitmapFactory.decodeFile(file.toString())));
    if(format==android.graphics.Bitmap.CompressFormat.JPEG){
     byte[] result=java.nio.file.Files.readAllBytes(file.toPath());
     assertArrayEquals(scan(before),scan(result));
    }
   }finally{file.delete();}
  }
 }
 private static byte[] scan(byte[] bytes){for(int i=2;i<bytes.length-1;i++)if((bytes[i]&255)==255&&(bytes[i+1]&255)==218)return java.util.Arrays.copyOfRange(bytes,i,bytes.length);throw new AssertionError("JPEG scan");}
 @Test public void canonicalParametersAndClothesSurviveWithoutIdentityOrNativeSecrets() throws Exception {
  var c=RuntimeEnvironment.getApplication();
  var value=PhotoExif.metadata(c,"{\"identity\":{\"uid\":\"PRIVATE\"},\"camera\":{\"focalLength\":35,\"saturation\":0.5},\"dressing\":{\"clothes\":[{\"id\":\"123\",\"name\":\"星光裙\"}]},\"raw\":{\"secret\":\"PRIVATE\"}}","2026-09-01T00:00:00Z","2.9");
  assertEquals("Bloom Beneath Bright Skies",value.getString("versionName"));
  assertEquals(35,value.getJSONObject("camera").getInt("focalLength"));
  assertEquals("星光裙",value.getJSONObject("dressing").getJSONArray("clothes").getJSONObject(0).getString("name"));
  assertFalse(value.toString().contains("PRIVATE"));
  String ascii=PhotoExif.ascii(value.toString());
  assertTrue(ascii.chars().allMatch(x->x>=32&&x<127));
  assertEquals(value.toString(),new org.json.JSONObject(ascii).toString());
  assertEquals("",PhotoExif.versionName(c,"9.9"));
 }
}
