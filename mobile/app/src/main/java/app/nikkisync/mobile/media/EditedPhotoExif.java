package app.nikkisync.mobile.media;

import android.content.*;
import androidx.exifinterface.media.ExifInterface;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import app.nikkisync.mobile.storage.*;
import java.io.*;
import java.security.*;
import java.util.*;

/** The picker grants read access: publish a lossless metadata derivative, never mutate its source. */
public final class EditedPhotoExif {
 public record Result(Uri uri,boolean copied,boolean written){}
 private EditedPhotoExif(){}
 public static Result prepare(Context c,Uri source,String mime,SavedMetadataSnapshotStore.Snapshot snapshot,
                              String capturedAt,String gameVersion)throws Exception{
  if(!c.getSharedPreferences("nikkisync.export",0).getBoolean("writeExif",true))return new Result(source,false,false);
  String ext=switch(mime==null?"":mime.toLowerCase(Locale.ROOT)){case "image/jpeg","image/jpg"->"jpg";case "image/png"->"png";case "image/webp"->"webp";default->null;};
  if(ext==null)return new Result(source,false,false);
  var metadata=PhotoExif.metadata(c,snapshot==null?null:snapshot.metadataJson(),
    snapshot==null||snapshot.capturedAt()==null||snapshot.capturedAt().isBlank()?capturedAt:snapshot.capturedAt(),
    snapshot==null||snapshot.gameVersion()==null||snapshot.gameVersion().isBlank()?gameVersion:snapshot.gameVersion());
  File temp=File.createTempFile("edited-exif-","."+ext,c.getCacheDir());Uri target=null;
  var resolver=c.getContentResolver();
  try{
   try(var in=resolver.openInputStream(source);var out=new FileOutputStream(temp)){
    if(in==null)throw new IOException("修图无法读取");copy(in,out);
   }
   PhotoExif.apply(new ExifInterface(temp),metadata);
   var check=new ExifInterface(temp);
   if(!PhotoExif.CAMERA.equals(check.getAttribute(ExifInterface.TAG_MODEL))
      ||!("Infinity Nikki virtual photography; game parameters: "+PhotoExif.ascii(metadata.toString())).equals(check.getAttribute(ExifInterface.TAG_IMAGE_DESCRIPTION)))
    throw new IOException("修图 EXIF 校验未通过");
   var values=new ContentValues();values.put(MediaStore.Images.Media.DISPLAY_NAME,"MomoCamera-Edit-"+UUID.randomUUID()+"."+ext);
   values.put(MediaStore.Images.Media.MIME_TYPE,"jpg".equals(ext)?"image/jpeg":mime);
   values.put(MediaStore.Images.Media.RELATIVE_PATH,Environment.DIRECTORY_PICTURES+"/MomoCamera/Edited");
   values.put(MediaStore.Images.Media.IS_PENDING,1);target=resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,values);
   if(target==null)throw new IOException("无法创建修图副本");
   byte[] expected;
   var digest=MessageDigest.getInstance("SHA-256");
   try(var in=new DigestInputStream(new FileInputStream(temp),digest);var out=resolver.openOutputStream(target,"w")){
    if(out==null)throw new IOException("无法保存修图副本");copy(in,out);out.flush();
   }expected=digest.digest();digest.reset();
   try(var raw=resolver.openInputStream(target)){
    if(raw==null)throw new IOException("无法校验修图副本");
    try(var in=new DigestInputStream(raw,digest)){app.nikkisync.mobile.util.ByteStreams.copy(in,null);}
   }
   if(!MessageDigest.isEqual(expected,digest.digest()))throw new IOException("修图副本校验失败");
   var ready=new ContentValues();ready.put(MediaStore.Images.Media.IS_PENDING,0);
   if(resolver.update(target,ready,null,null)!=1)throw new IOException("无法完成修图保存");
   return new Result(target,true,true);
  }catch(Exception e){if(target!=null)try{resolver.delete(target,null,null);}catch(Exception ignored){}throw e;}
  finally{temp.delete();}
 }
 private static void copy(InputStream in,OutputStream out)throws IOException{
  byte[] buffer=new byte[128*1024];long total=0;int n;
  while((n=in.read(buffer))!=-1){if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("已取消");
   total+=n;if(total>100L*1024*1024)throw new IOException("修图文件过大");out.write(buffer,0,n);}
 }
 public static void discard(Context c,Result result){
  if(result!=null&&result.copied())try{c.getContentResolver().delete(result.uri(),null,null);}catch(Exception ignored){}
 }
}
