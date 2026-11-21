package app.nikkisync.mobile.media.live;

import android.graphics.*;
import android.media.ExifInterface;
import android.os.Build;
import java.io.File;
import java.io.IOException;
import java.io.InterruptedIOException;

/** Full-resolution destination plus one bounded tile; never retain a full decoded source. */
final class TiledJpegRotation {
 static final int TILE=512;
 private TiledJpegRotation(){}
 static long requiredBytes(int width,int height)throws IOException{
  if(width<=0||height<=0||width>65535||height>65535)throw new IOException("JPEG 尺寸无效");
  return (long)width*height*4+(long)Math.min(TILE,width)*Math.min(TILE,height)*4+16L*1024*1024;
 }
 static void requireAvailable(int width,int height,long available)throws IOException{
  if(requiredBytes(width,height)>available)throw new IOException("当前内存不足以全分辨率旋转封面，请稍后重试；未降低画质");
 }
 static void checkInput(File input)throws IOException{
  Bitmap probe=null;
  try{
   probe=ImageDecoder.decodeBitmap(ImageDecoder.createSource(input),(d,info,source)->{
    if(info.getColorSpace()!=null&&info.getColorSpace().isWideGamut())throw new IllegalArgumentException("宽色域 JPEG 旋转尚未验收，未改变色彩");
    d.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);d.setTargetSize(32,32);
   });
   if(Build.VERSION.SDK_INT>=34&&probe.hasGainmap())throw new IOException("GainMap 图片需同步旋转 HDR 层，当前不降级处理");
  }finally{if(probe!=null)probe.recycle();}
 }
 static Bitmap decode(File input,int clockwise,long available)throws IOException{
  BitmapRegionDecoder decoder=null;Bitmap output=null,tile=null;
  try(var encoded=new java.io.FileInputStream(input)){
   checkInput(input);
   // Keep the Android 11-compatible source alive through every lazy region decode.
   decoder=BitmapRegionDecoder.newInstance(encoded,false);
   int width=decoder.getWidth(),height=decoder.getHeight();
   android.util.Log.i("NikkiSync-Live","JPEG rotation "+width+"x"+height+" requiredMiB="+(requiredBytes(width,height)/1048576)+" availableMiB="+(available/1048576));
   requireAvailable(width,height,available);
   Matrix transform=new Matrix();int orientation=new ExifInterface(input).getAttributeInt(ExifInterface.TAG_ORIENTATION,1);
   switch(orientation){
    case 2 -> transform.setScale(-1,1);
    case 3 -> transform.setRotate(180);
    case 4 -> transform.setScale(1,-1);
    case 5 -> transform.setValues(new float[]{0,1,0,1,0,0,0,0,1});
    case 6 -> transform.setRotate(90);
    case 7 -> transform.setValues(new float[]{0,-1,0,-1,0,0,0,0,1});
    case 8 -> transform.setRotate(270);
    default -> { }
   }
   transform.postRotate(QuarterTurn.normalize(clockwise));
   RectF bounds=new RectF(0,0,width,height);transform.mapRect(bounds);transform.postTranslate(-bounds.left,-bounds.top);
   output=Bitmap.createBitmap(Math.round(bounds.width()),Math.round(bounds.height()),Bitmap.Config.ARGB_8888);
   Canvas canvas=new Canvas(output);canvas.setMatrix(transform);
   BitmapFactory.Options options=new BitmapFactory.Options();options.inSampleSize=1;options.inScaled=false;options.inPreferredConfig=Bitmap.Config.ARGB_8888;
   for(int y=0;y<height;y+=TILE)for(int x=0;x<width;x+=TILE){
    if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("Live 封面旋转已取消");
    Rect region=new Rect(x,y,Math.min(width,x+TILE),Math.min(height,y+TILE));
    tile=decoder.decodeRegion(region,options);
    if(tile==null||tile.getWidth()!=region.width()||tile.getHeight()!=region.height())throw new IOException("Live 封面分块解码失败，未缩小图片");
    canvas.drawBitmap(tile,(float)x,(float)y,null);tile.recycle();tile=null;
   }
   Bitmap result=output;output=null;return result;
  }catch(OutOfMemoryError e){throw new IOException("旋转封面时内存暂不足，请稍后重试；未降低画质",e);}
  finally{
   if(tile!=null)tile.recycle();if(output!=null)output.recycle();if(decoder!=null)decoder.recycle();
  }
 }
}
