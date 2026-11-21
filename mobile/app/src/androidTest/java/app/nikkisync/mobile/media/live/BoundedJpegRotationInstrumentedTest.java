package app.nikkisync.mobile.media.live;

import static org.junit.Assert.*;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ImageDecoder;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.media.ExifInterface;
import androidx.media3.common.util.UnstableApi;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.util.Comparator;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Executes the packaged JNI, Android storage checks, EXIF rewrite and cancellation. */
@UnstableApi
@RunWith(AndroidJUnit4.class)
public class BoundedJpegRotationInstrumentedTest {
 @Test public void packagedNativeRotationPreservesAllExifDirectionsAndOddEdges()throws Exception{
  System.loadLibrary("momo_jpeg"); // A bitmap fallback must not conceal a missing/broken native package.
  File root=root();
  try{
   for(int width:new int[]{512,511})for(int exif=1;exif<=8;exif++)for(int angle:new int[]{90,180,270}){
    File input=fixture(root,width,exif),output=new File(root,"out-"+width+"-"+exif+"-"+angle+".jpg");
    byte[] original=Files.readAllBytes(input.toPath());
    Bitmap source=decode(input),expected=null,actual=null;
    try{
     Matrix m=new Matrix();m.setRotate(angle);expected=Bitmap.createBitmap(source,0,0,source.getWidth(),source.getHeight(),m,false);
     LivePhotoRotation.rotateJpeg(input,output,angle);actual=decode(output);
     assertEquals(expected.getWidth(),actual.getWidth());assertEquals(expected.getHeight(),actual.getHeight());
     for(int y:new int[]{1,3})for(int x:new int[]{1,3}){
      int a=expected.getPixel(expected.getWidth()*x/4,expected.getHeight()*y/4),b=actual.getPixel(actual.getWidth()*x/4,actual.getHeight()*y/4);
      assertTrue(Math.abs(Color.red(a)-Color.red(b))<12);assertTrue(Math.abs(Color.green(a)-Color.green(b))<12);assertTrue(Math.abs(Color.blue(a)-Color.blue(b))<12);
     }
     ExifInterface result=new ExifInterface(output);
     assertEquals(1,result.getAttributeInt(ExifInterface.TAG_ORIENTATION,0));
     assertEquals("2026:10:20 12:00:00",result.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL));
     assertArrayEquals(original,Files.readAllBytes(input.toPath()));
    }finally{source.recycle();if(expected!=null)expected.recycle();if(actual!=null)actual.recycle();}
   }
  }finally{clean(root);}
 }
 @Test public void interruptionDeletesIncompleteOutputAndKeepsOriginal()throws Exception{
  System.loadLibrary("momo_jpeg");File root=root();
  try{
   File input=fixture(root,512,1),output=new File(root,"cancelled.jpg");byte[] original=Files.readAllBytes(input.toPath());
   AtomicReference<Throwable> error=new AtomicReference<>();
   Thread worker=new Thread(()->{Thread.currentThread().interrupt();try{LivePhotoRotation.rotateJpeg(input,output,90);}catch(Throwable e){error.set(e);}});
   worker.start();worker.join(10000);assertFalse(worker.isAlive());assertTrue(error.get() instanceof IOException);
   assertFalse(output.exists());assertArrayEquals(original,Files.readAllBytes(input.toPath()));
  }finally{clean(root);}
 }
 private static Bitmap decode(File f)throws IOException{return ImageDecoder.decodeBitmap(ImageDecoder.createSource(f),(d,i,s)->d.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE));}
 private static File root()throws Exception{
  Context c=InstrumentationRegistry.getInstrumentation().getTargetContext();return Files.createTempDirectory(c.getCacheDir().toPath(),"bounded-jpeg-test-").toFile();
 }
 private static File fixture(File root,int width,int orientation)throws Exception{
  File file=new File(root,"in-"+width+"-"+orientation+".jpg");if(file.exists())return file;
  int height=width==512?320:319;Bitmap bitmap=Bitmap.createBitmap(width,height,Bitmap.Config.ARGB_8888);Canvas canvas=new Canvas(bitmap);Paint paint=new Paint();
  int[] colors={Color.RED,Color.GREEN,Color.BLUE,Color.YELLOW};int i=0;
  for(int y=0;y<2;y++)for(int x=0;x<2;x++){paint.setColor(colors[i++]);canvas.drawRect(x*width/2f,y*height/2f,(x+1)*width/2f,(y+1)*height/2f,paint);}
  try(var out=Files.newOutputStream(file.toPath())){assertTrue(bitmap.compress(Bitmap.CompressFormat.JPEG,95,out));}finally{bitmap.recycle();}
  ExifInterface e=new ExifInterface(file);e.setAttribute(ExifInterface.TAG_ORIENTATION,Integer.toString(orientation));e.setAttribute(ExifInterface.TAG_DATETIME_ORIGINAL,"2026:10:20 12:00:00");e.saveAttributes();return file;
 }
 private static void clean(File root)throws Exception{try(var paths=Files.walk(root.toPath())){for(var p:paths.sorted(Comparator.reverseOrder()).collect(java.util.stream.Collectors.toList()))Files.deleteIfExists(p);}}
}
