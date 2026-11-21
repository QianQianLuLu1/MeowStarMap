package app.nikkisync.mobile.share;
import android.content.*;
import android.graphics.*;
import android.media.ExifInterface;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import app.nikkisync.mobile.model.Models.*;
import app.nikkisync.mobile.net.NikkiSyncClient;
import app.nikkisync.mobile.util.Hex;
import app.nikkisync.mobile.util.TaskProgress;
import java.io.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.function.BooleanSupplier;
import javax.net.ssl.HttpsURLConnection;

/** Owns downloads and temporary pages. No MediaStore insertion during preparation. */
public final class ShareCardPreparation {
    private ShareCardPreparation() {}
    static Prepared prepare(Context context,NikkiSyncClient client,Uri uri,AssetSummary asset,
                            ShareCardPayload payload,int rotation,BooleanSupplier active) throws Exception {
        return prepare(context,client,uri,asset,payload,rotation,active,TaskProgress.NONE);
    }
    static Prepared prepare(Context context,NikkiSyncClient client,Uri uri,AssetSummary asset,
                            ShareCardPayload payload,int rotation,BooleanSupplier active,TaskProgress progress) throws Exception {
        File dir=Files.createTempDirectory(context.getCacheDir().toPath(),"share-card-").toFile();
        File cache=new File(context.getFilesDir(),"share-icons-v1");
        Bitmap background=null;boolean complete=false;int missing=0;
        try {
            check(active);progress.update("读取高清原图",0,0);File source=new File(dir,"source");
            if(uri!=null) {
                try(InputStream in=context.getContentResolver().openInputStream(uri);OutputStream out=new FileOutputStream(source)) {
                    if(in==null) throw new IOException("照片无法读取");copy(in,out,64L*1024*1024,active,null,progress,"读取高清原图",-1);
                }
            } else {
                AssetDetail detail=client.asset(asset.assetId());MediaResource resource=detail.originalStill();
                if(detail.hasMotion() && detail.motionStillResourceId()!=null)
                    for(var candidate:detail.resources()) if(candidate.resourceId().equals(detail.motionStillResourceId())) resource=candidate;
                if(resource==null || !resource.mimeType().startsWith("image/")) throw new IOException("高清封面尚不可用");
                download(client.resource(asset.assetId(),resource.resourceId()),source,64L*1024*1024,resource.sha256(),active,progress,"下载并校验高清原图");
            }
            check(active);progress.update("处理照片方向",0,0);background=decode(source,2400);source.delete();
            if(background==null) throw new IOException("照片无法解码");
            if(rotation!=0) background=transform(background,rotation,false,false);
            if(!cache.isDirectory() && !cache.mkdirs()) throw new IOException("图标缓存不可用");
            String iconVersion=client==null?"":client.clothingCacheVersion(payload.assetId());
            List<ShareCardLayout.Page> layouts=ShareCardLayout.pages(payload);List<File> files=new ArrayList<>();
            for(int index=0;index<layouts.size();index++) {
                check(active);Map<String,Bitmap> icons=new HashMap<>();var page=layouts.get(index);
                try {
                    List<String> ids=new ArrayList<>();
                    for(var part:page.outfit()) ids.add(part.item().clothingId());
                    final int pageNumber=index+1;
                    Map<String,File> iconFiles=ShareCardIconBatch.load(ids,active,
                            id->loadIcon(client,payload,id,iconVersion,cache,active,
                                    ()->client.clothingThumbnail(payload.assetId(),id)),
                            (done,total)->progress.update("部件图片 · 第 "+pageNumber+" / "+layouts.size()+" 页",done,total));
                    for(String id:new LinkedHashSet<>(ids)) {
                        check(active);File cached=iconFiles.get(id);Bitmap icon=null;
                        if(cached!=null) try {icon=decode(cached,256);} catch(IOException ignored) {cached.delete();}
                        if(icon==null) missing++;else icons.put(id,icon);
                    }
                    for (var effect : payload.effectItems()) {
                        check(active);
                        String kind = ShareCardPayload.effectKind(effect.label());
                        if (kind.isEmpty() || effect.effectId().isEmpty()) continue;
                        String key = "effect:" + kind;
                        try {
                            File cached = loadIcon(client,payload,key + ":" + effect.effectId(),iconVersion,cache,active,
                                    ()->client.effectThumbnail(payload.assetId(),kind,effect.effectId()));
                            Bitmap icon = cached == null ? null : decode(cached,256);
                            if (icon != null) icons.put(key,icon);
                        } catch (Exception ignored) { check(active); }
                    }
                    progress.update("绘制分享图 · 第 "+pageNumber+" / "+layouts.size()+" 页",0,0);
                    check(active);
                    Bitmap bitmap=ShareCardExporter.renderPage(background,payload,page,index,layouts.size(),icons);
                    try {
                        File output=new File(dir,"page-"+(index+1)+".png");
                        try(OutputStream out=new FileOutputStream(output)) {
                            progress.update("编码高清 PNG · 第 "+(index+1)+" / "+layouts.size()+" 页",0,0);
                            if(!bitmap.compress(Bitmap.CompressFormat.PNG,100,out)) throw new IOException("分享图编码失败");
                        }
                        files.add(output);progress.update("分享图页面",index+1,layouts.size());
                    } finally {bitmap.recycle();}
                } finally {for(Bitmap icon:icons.values()) if(!icon.isRecycled()) icon.recycle();}
            }
            check(active);Prepared prepared=new Prepared(dir,files,payload.assetId(),missing);
            complete=true;return prepared;
        } finally {if(background!=null) background.recycle();if(!complete) deleteJob(dir);prune(cache);}
    }
    @FunctionalInterface private interface IconRequest { HttpsURLConnection open() throws Exception; }

    private static File loadIcon(NikkiSyncClient client,ShareCardPayload payload,String id,String version,
                                 File cache,BooleanSupplier active,IconRequest request) throws Exception {
        File cached=new File(cache,iconKey(client,payload,id,version)+".img");
        if(cached.isFile()){cached.setLastModified(System.currentTimeMillis());return cached;}
        if(client==null)return null;
        // Each concurrent request owns its temporary file, outside the page directory.
        File temp=File.createTempFile(".share-icon-",".tmp",cache);
        try {
            HttpsURLConnection connection=request.open();
            connection.setReadTimeout(5000);
            download(connection,temp,2L*1024*1024,null,active);
            Bitmap icon=decode(temp,256);if(icon==null)throw new IOException("图标无法解码");
            icon.recycle();check(active);Files.move(temp.toPath(),cached.toPath(),StandardCopyOption.REPLACE_EXISTING);
            return cached;
        } finally {temp.delete();}
    }
    private static String iconKey(NikkiSyncClient client,ShareCardPayload payload,String id,String version) throws Exception {
        String key=client==null?payload.assetId()+"\n"+id+"\n"+payload.gameVersion()+"\n"+payload.outfitItems():
                app.nikkisync.mobile.media.ClothingCacheKey.of(client.server(),payload.assetId(),id,version);
        return Hex.lower(MessageDigest.getInstance("SHA-256").digest(
                key.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    }
    private static void prune(File dir) {
        File[] files=dir.listFiles((parent,name)->name.endsWith(".img"));if(files==null) return;
        Arrays.sort(files,Comparator.comparingLong(File::lastModified));long bytes=0;
        for(File file:files) bytes+=file.length();
        for(File file:files) {if(bytes<=32L*1024*1024) break;long length=file.length();if(file.delete()) bytes-=length;}
    }
    static void check(BooleanSupplier active) throws InterruptedIOException {
        if(Thread.currentThread().isInterrupted() || !active.getAsBoolean()) throw new InterruptedIOException("已取消生成");
    }
    static void download(HttpsURLConnection connection,File target,long limit,String expected,BooleanSupplier active) throws Exception {
        download(connection,target,limit,expected,active,TaskProgress.NONE,"下载图片");
    }
    static void download(HttpsURLConnection connection,File target,long limit,String expected,BooleanSupplier active,TaskProgress progress,String stage) throws Exception {
        try {
            if(connection.getResponseCode()!=200) throw new IOException("电脑图片请求失败");
            String hash=connection.getHeaderField("X-NikkiSync-SHA256");
            if(hash==null || !hash.matches("[a-fA-F0-9]{64}") || expected!=null && !expected.equalsIgnoreCase(hash))
                throw new SecurityException("图片校验信息不一致");
            long declared=connection.getContentLengthLong();if(declared>limit) throw new IOException("图片超过大小限制");
            MessageDigest digest=MessageDigest.getInstance("SHA-256");long actual;
            try(InputStream in=connection.getInputStream();OutputStream out=new FileOutputStream(target)) {
                actual=copy(in,out,limit,active,digest,progress,stage,declared);
            }
            if(declared>=0 && actual!=declared || !Hex.lower(digest.digest()).equalsIgnoreCase(hash))
                throw new SecurityException("图片 SHA-256 校验失败");
        } finally {connection.disconnect();}
    }
    private static long copy(InputStream in,OutputStream out,long limit,BooleanSupplier active,MessageDigest digest) throws Exception {
        return copy(in,out,limit,active,digest,TaskProgress.NONE,"写入图片",-1);
    }
    private static long copy(InputStream in,OutputStream out,long limit,BooleanSupplier active,MessageDigest digest,TaskProgress progress,String stage,long expected) throws Exception {
        byte[] buffer=new byte[64*1024];long total=0;int last=-1;progress.update(stage,0,expected);
        try {
            for(int n;(n=in.read(buffer))!=-1;) {
                check(active);total+=n;if(total>limit) throw new IOException("图片超过大小限制");
                if(digest!=null) digest.update(buffer,0,n);out.write(buffer,0,n);
                int percent=expected>0?(int)Math.min(100,total*100.0/expected):-1;
                if(percent!=last){last=percent;progress.update(stage,total,expected);}
            }
            return total;
        } finally {Arrays.fill(buffer,(byte)0);}
    }
    static Bitmap decode(File file,int maximum) throws IOException {
        BitmapFactory.Options options=new BitmapFactory.Options();options.inJustDecodeBounds=true;
        BitmapFactory.decodeFile(file.getAbsolutePath(),options);
        if(options.outWidth<=0 || options.outHeight<=0 || (long)options.outWidth*options.outHeight>160_000_000L)
            throw new IOException("图片尺寸不可用");
        int sample=1;while(Math.max(options.outWidth,options.outHeight)/sample>maximum) sample*=2;
        options.inSampleSize=sample;options.inJustDecodeBounds=false;
        Bitmap bitmap=BitmapFactory.decodeFile(file.getAbsolutePath(),options);if(bitmap==null) return null;
        int orientation=1;
        try {orientation=new ExifInterface(file.getAbsolutePath()).getAttributeInt(ExifInterface.TAG_ORIENTATION,1);} catch(IOException ignored) {}
        return switch(orientation) {
            case 2 -> transform(bitmap,0,true,false);case 3 -> transform(bitmap,180,false,false);
            case 4 -> transform(bitmap,0,false,true);case 5 -> transform(bitmap,90,true,false);
            case 6 -> transform(bitmap,90,false,false);case 7 -> transform(bitmap,270,true,false);
            case 8 -> transform(bitmap,270,false,false);default -> bitmap;
        };
    }
    private static Bitmap transform(Bitmap source,int degrees,boolean flipX,boolean flipY) {
        Matrix matrix=new Matrix();matrix.postScale(flipX?-1:1,flipY?-1:1);matrix.postRotate(degrees);
        Bitmap result=Bitmap.createBitmap(source,0,0,source.getWidth(),source.getHeight(),matrix,true);
        if(result!=source) source.recycle();return result;
    }
    public static final class Prepared implements AutoCloseable {
        private final File dir;private final List<File> pages;private final String assetId;private final int missing;
        private boolean closed;private int readers;
        Prepared(File dir,List<File> pages,String assetId,int missing) {
            this.dir=dir;this.pages=List.copyOf(pages);this.assetId=assetId;this.missing=missing;
        }
        public int pageCount() {return pages.size();}
        public int missingIcons() {return missing;}
        private synchronized File acquire(int page) {
            if(closed) throw new IllegalStateException("分享图预览已关闭");
            File file=pages.get(page);readers++;return file;
        }
        private synchronized void release() {readers--;if(closed && readers==0) deleteJob(dir);}
        public Bitmap preview(int page) throws Exception {File file=acquire(page);try {return decode(file,2400);} finally {release();}}
        public Uri save(Context context,int page) throws Exception {
            return save(context,page,TaskProgress.NONE);
        }
        public Uri save(Context context,int page,TaskProgress progress) throws Exception {
            File file=acquire(page);try {return publish(context,file,assetId,page,progress);} finally {release();}
        }
        @Override public synchronized void close() {closed=true;if(readers==0) deleteJob(dir);}
    }
    private static Uri publish(Context context,File file,String assetId,int page,TaskProgress progress) throws Exception {
        ContentResolver resolver=context.getContentResolver();ContentValues values=new ContentValues();
        String safe=assetId==null?"photo":assetId.replaceAll("[^A-Za-z0-9_-]","_");
        values.put(MediaStore.Images.Media.DISPLAY_NAME,"NikkiSync-Share-"+safe+"-"+System.currentTimeMillis()+"-"+(page+1)+".png");
        values.put(MediaStore.Images.Media.MIME_TYPE,"image/png");
        values.put(MediaStore.Images.Media.RELATIVE_PATH,Environment.DIRECTORY_PICTURES+"/NikkiSync/Share Cards");
        values.put(MediaStore.Images.Media.IS_PENDING,1);
        Uri uri=resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,values);
        if(uri==null) throw new IOException("系统相册创建分享图失败");
        try {
            try(InputStream in=new FileInputStream(file);OutputStream out=resolver.openOutputStream(uri,"w")) {
                if(out==null) throw new IOException("系统相册无法写入分享图");
                copy(in,out,64L*1024*1024,()->true,null,progress,"写入相册",file.length());
            }
            ContentValues ready=new ContentValues();ready.put(MediaStore.Images.Media.IS_PENDING,0);
            if(resolver.update(uri,ready,null,null)!=1) throw new IOException("系统相册发布分享图失败");
            progress.update("保存完成",1,1);return uri;
        } catch(Exception error) {resolver.delete(uri,null,null);throw error;}
    }
    static void deleteJob(File dir) {File[] files=dir.listFiles();if(files!=null) for(File file:files) file.delete();dir.delete();}
}
