package app.nikkisync.mobile.media;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.net.Uri;
import java.io.IOException;

/** Decode actual local image pixels, never provider thumbnails. Bounds include decode working memory. */
public final class SavedPhotoDecoder {
 private SavedPhotoDecoder() {}
 public static Bitmap decode(Context context, Uri uri, int maxEdge) throws IOException {
  BitmapFactory.Options o=new BitmapFactory.Options();o.inJustDecodeBounds=true;
  try(var input=context.getContentResolver().openInputStream(uri)){
   if(input==null)throw new IOException("Unavailable photo");
   BitmapFactory.decodeStream(input,null,o);
  }
  if(o.outWidth<=0||o.outHeight<=0||(long)o.outWidth*o.outHeight>160_000_000L)throw new IOException("Invalid dimensions");
  o.inSampleSize=1; maxEdge=Math.max(256,Math.min(4096,maxEdge));
  while(Math.max(o.outWidth,o.outHeight)/(double)o.inSampleSize>maxEdge
    ||(long)Math.ceil(o.outWidth/(double)o.inSampleSize)*Math.ceil(o.outHeight/(double)o.inSampleSize)>8_000_000L)o.inSampleSize*=2;
  o.inJustDecodeBounds=false;o.inPreferredConfig=Bitmap.Config.ARGB_8888;
  Bitmap bitmap;
  try(var input=context.getContentResolver().openInputStream(uri)){bitmap=BitmapFactory.decodeStream(input,null,o);}
  if(bitmap==null)throw new IOException("Invalid photo");
  int direction=1;
  try(var input=context.getContentResolver().openInputStream(uri)){
   if(input!=null)direction=new ExifInterface(input).getAttributeInt(ExifInterface.TAG_ORIENTATION,1);
  }catch(IOException ignored){}
  return orient(bitmap,direction);
 }
 public static Bitmap orient(Bitmap bitmap,int direction){
  Matrix m=new Matrix();
  switch(direction){
   case 2->m.setScale(-1,1);case 3->m.setRotate(180);case 4->m.setScale(1,-1);
   case 5->{m.setScale(-1,1);m.postRotate(90);}case 6->m.setRotate(90);
   case 7->{m.setScale(-1,1);m.postRotate(270);}case 8->m.setRotate(270);default->{return bitmap;}
  }
  Bitmap result=Bitmap.createBitmap(bitmap,0,0,bitmap.getWidth(),bitmap.getHeight(),m,true);
  if(result!=bitmap)bitmap.recycle();return result;
 }
}
