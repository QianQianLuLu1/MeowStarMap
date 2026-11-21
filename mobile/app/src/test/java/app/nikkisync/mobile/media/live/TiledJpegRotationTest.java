package app.nikkisync.mobile.media.live;

import android.graphics.*;
import android.media.ExifInterface;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import java.io.*;
import java.nio.file.Files;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@org.robolectric.annotation.Config(sdk={30,31,32,33})
@org.robolectric.annotation.GraphicsMode(org.robolectric.annotation.GraphicsMode.Mode.NATIVE)
public class TiledJpegRotationTest {
 @Test public void fourKCoverFitsWithoutThreeFullFrameAllocations()throws Exception{
  long budget=80L*1024*1024;
  assertTrue(3840L*2160*12+32L*1024*1024>budget);
  assertTrue(TiledJpegRotation.requiredBytes(3840,2160)<60L*1024*1024);
  TiledJpegRotation.requireAvailable(3840,2160,budget);
  assertThrows(IOException.class,()->TiledJpegRotation.requireAvailable(3840,2160,8L*1024*1024));
  assertThrows(IOException.class,()->TiledJpegRotation.requiredBytes(Integer.MAX_VALUE,Integer.MAX_VALUE));
 }
 @Test public void tilesKeepAllExifOrientationsPixelsDimensionsAndSource()throws Exception{
  var context=RuntimeEnvironment.getApplication();var root=Files.createTempDirectory(context.getCacheDir().toPath(),"tile-rotation-");
  Bitmap original=Bitmap.createBitmap(1103,719,Bitmap.Config.ARGB_8888);
  Canvas canvas=new Canvas(original);Paint p=new Paint();
  int[] colors={Color.RED,Color.GREEN,Color.BLUE,Color.YELLOW};
  for(int y=0;y<719;y+=47)for(int x=0;x<1103;x+=61){p.setColor(colors[(x/61+y/47)%4]);canvas.drawRect(x,y,x+61,y+47,p);}
  try{
   for(int orientation=1;orientation<=8;orientation++){
    File input=root.resolve("source-"+orientation+".jpg").toFile();
    try(var out=new FileOutputStream(input)){assertTrue(original.compress(Bitmap.CompressFormat.JPEG,100,out));}
    var exif=new ExifInterface(input);exif.setAttribute(ExifInterface.TAG_ORIENTATION,""+orientation);exif.saveAttributes();
    byte[] before=Files.readAllBytes(input.toPath());
    Bitmap displayed=ImageDecoder.decodeBitmap(ImageDecoder.createSource(input),(d,i,s)->d.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE));
    try{
     for(int angle:new int[]{90,180,270}){
      Matrix rotate=new Matrix();rotate.postRotate(angle);
      Bitmap reference=Bitmap.createBitmap(displayed,0,0,displayed.getWidth(),displayed.getHeight(),rotate,false);
      Bitmap tiled=TiledJpegRotation.decode(input,angle,128L*1024*1024);
      try{
       assertEquals(reference.getWidth(),tiled.getWidth());assertEquals(reference.getHeight(),tiled.getHeight());
       for(int y=3;y<tiled.getHeight();y+=7)for(int x=3;x<tiled.getWidth();x+=7){
        int a=reference.getPixel(x,y),b=tiled.getPixel(x,y);
        assertEquals("pixel "+orientation+"/"+angle+" at "+x+","+y,a,b);
       }
      }finally{tiled.recycle();reference.recycle();}
      assertArrayEquals(before,Files.readAllBytes(input.toPath()));
     }
    }finally{displayed.recycle();}
   }
  }finally{original.recycle();try(var files=Files.walk(root)){for(var f:files.sorted(java.util.Comparator.reverseOrder()).toList())Files.deleteIfExists(f);}}
 }
}
