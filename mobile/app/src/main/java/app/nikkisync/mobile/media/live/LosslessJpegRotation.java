package app.nikkisync.mobile.media.live;
import android.graphics.BitmapFactory;
import android.media.ExifInterface;
import java.io.File;
import java.io.IOException;

/** Bounded native rotation: coefficient transform or full-pixel disk-backed edge fallback. */
final class LosslessJpegRotation {
 private static final boolean AVAILABLE;
 static {boolean loaded;try{System.loadLibrary("momo_jpeg");loaded=true;}catch(UnsatisfiedLinkError e){loaded=false;}AVAILABLE=loaded;}
 private LosslessJpegRotation(){}
 static long requiredScratchBytes(int width,int height,long bytes)throws IOException{
  long pixels=(long)width*height;
  if(width<=0||height<=0||pixels>180000000||bytes<4||bytes>64L*1024*1024)throw new IOException("Live 封面超过支持的像素或文件范围，未降低画质");
  return pixels*8+bytes*2+32L*1024*1024;
 }
 static int operation(int orientation,int clockwise){
  int[][] states={{1,0,0,1},{-1,0,0,1},{1,0,0,-1},{0,1,1,0},{0,-1,-1,0},{0,-1,1,0},{-1,0,0,-1},{0,1,-1,0}};
  int[] exifToOp={0,0,1,6,2,3,5,4,7};
  int[] m=states[exifToOp[orientation>=1&&orientation<=8?orientation:1]].clone();
  for(int n=0;n<QuarterTurn.normalize(clockwise)/90;n++)m=new int[]{-m[2],-m[3],m[0],m[1]};
  for(int i=0;i<states.length;i++)if(java.util.Arrays.equals(m,states[i]))return i;
  throw new IllegalArgumentException("无效方向组合");
 }
 static boolean tryRotate(File input,File output,int clockwise)throws IOException{
  if(!AVAILABLE)return false;
  TiledJpegRotation.checkInput(input);
  BitmapFactory.Options bounds=new BitmapFactory.Options();bounds.inJustDecodeBounds=true;BitmapFactory.decodeFile(input.getAbsolutePath(),bounds);
  long scratch=requiredScratchBytes(bounds.outWidth,bounds.outHeight,input.length());
  if(output.getParentFile().getUsableSpace()<scratch)throw new IOException("缓存空间不足以安全旋转大尺寸 Live，请释放空间后重试；未降低画质");
  int orientation=new ExifInterface(input).getAttributeInt(ExifInterface.TAG_ORIENTATION,1);
  int result=transform(input.getAbsolutePath(),output.getAbsolutePath(),output.getParent(),operation(orientation,clockwise));
  android.util.Log.i("NikkiSync-Live","JPEG coefficient rotation "+bounds.outWidth+"x"+bounds.outHeight+" status="+result);
  return result==0;
 }
 private static native int transform(String input,String output,String scratch,int operation)throws IOException;
}
