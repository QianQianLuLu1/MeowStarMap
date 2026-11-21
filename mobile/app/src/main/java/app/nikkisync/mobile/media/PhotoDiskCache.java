package app.nikkisync.mobile.media;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import app.nikkisync.mobile.model.Models.AssetSummary;
import app.nikkisync.mobile.model.Models.PairedServer;
import java.io.*;
import java.nio.file.*;
import java.util.*;

/** Small offline thumbnails and disposable full-screen previews never evict one another. */
public final class PhotoDiskCache {
    public static final int THUMBNAIL_EDGE=512, PREVIEW_EDGE=2048;
    static int previewEdge(long heap){return heap<256L*1024*1024?1280:PREVIEW_EDGE;}
    private final Bucket thumbnails,previews;
    private final File pins;
    @FunctionalInterface interface Decoder {Bitmap read(File file,int edge)throws IOException;}
    private final Decoder decoder;
    private record Read(Bitmap bitmap,boolean corrupt){}
    public record Usage(long thumbnailBytes,long previewBytes,int thumbnails,int previews){}
    public PhotoDiskCache(Context context,PhotoCachePreferences preferences){
        this(context,preferences,PhotoDiskCache::decodeBounded);
    }
    PhotoDiskCache(Context context,PhotoCachePreferences preferences,Decoder decoder){
        this.decoder=decoder;
        File files=context.getApplicationContext().getFilesDir();
        thumbnails=new Bucket(new File(files,"photo-thumbnails-v2"),preferences.thumbnailBytes());
        previews=new Bucket(new File(files,"photo-previews-v2"),preferences.previewBytes());
        pins=new File(files,"organizer-thumbnails-v2");
    }
    public File thumbnail(PairedServer server,AssetSummary asset){return new File(thumbnails.directory,PhotoCacheKey.fileName(server,asset,false));}
    public File preview(PairedServer server,AssetSummary asset){return new File(previews.directory,PhotoCacheKey.fileName(server,asset,true));}
    public File pinned(PairedServer server,AssetSummary asset){return new File(pins,PhotoCacheKey.fileName(server,asset,false));}
    public void removeOrdinary(PairedServer server,AssetSummary asset){removeOrdinary(server,asset.assetId());}
    public void removeOrdinary(PairedServer server,String assetId){String prefix=PhotoCacheKey.assetPrefix(server,assetId);thumbnails.discardAsset(prefix);previews.discardAsset(prefix);}
    public boolean storeThumbnail(PairedServer server,AssetSummary asset,File source,boolean evict)throws IOException{
        return storeThumbnail(server,asset,source,evict,()->true);
    }
    boolean storeThumbnail(PairedServer server,AssetSummary asset,File source,boolean evict,java.util.function.BooleanSupplier current)throws IOException{
        return thumbnails.store(thumbnail(server,asset).getName(),source,THUMBNAIL_EDGE,82,evict,current);
    }
    public void storePreview(PairedServer server,AssetSummary asset,File source)throws IOException{
        storePreview(server,asset,source,()->true);
    }
    void storePreview(PairedServer server,AssetSummary asset,File source,java.util.function.BooleanSupplier current)throws IOException{
        previews.store(preview(server,asset).getName(),source,previewEdge(Runtime.getRuntime().maxMemory()),92,true,current);
    }
    public void pin(PairedServer server,AssetSummary asset)throws IOException{
        File source=thumbnail(server,asset);if(!source.isFile())return;
        File target=pinned(server,asset);if(target.isFile())return;
        if(!pins.isDirectory()&&!pins.mkdirs())throw new IOException("Cannot create pending thumbnail storage");
        File temp=File.createTempFile("pin-",".part",pins);
        try{Files.copy(source.toPath(),temp.toPath(),StandardCopyOption.REPLACE_EXISTING);publish(temp,target);}finally{temp.delete();}
    }
    public Bitmap readThumbnail(PairedServer server,AssetSummary asset){
        File file=thumbnail(server,asset);if(!file.isFile())file=pinned(server,asset);
        Read result=read(file,THUMBNAIL_EDGE);Bitmap bitmap=result.bitmap();if(bitmap!=null)thumbnails.touch(file);
        else if(result.corrupt()&&file.getParentFile().equals(thumbnails.directory))thumbnails.discard(file.getName());
        else if(result.corrupt()&&file.isFile())file.delete();
        return bitmap;
    }
    public Bitmap readPreview(PairedServer server,AssetSummary asset){
        File file=preview(server,asset);Read result=read(file,previewEdge(Runtime.getRuntime().maxMemory()));Bitmap bitmap=result.bitmap();if(bitmap!=null)previews.touch(file);else if(result.corrupt())previews.discard(file.getName());return bitmap;
    }
    private Read read(File file,int edge){
        try{Bitmap bitmap=decoder.read(file,edge);return new Read(bitmap,bitmap==null);}
        // Allocation pressure and transient I/O do not prove corrupt bytes. Keep
        // the persistent image so reopening/rebinding can decode it again.
        catch(IOException|RuntimeException|OutOfMemoryError transientFailure){return new Read(null,false);}
    }
    public synchronized Usage usage(){return new Usage(thumbnails.bytes(),previews.bytes(),thumbnails.names().size(),previews.names().size());}
    /** Runs on a worker. Names are indexed once per snapshot, rather than stat'ing every resource. */
    public Set<String> thumbnailNames(){return thumbnails.names();}
    public Set<String> previewNames(){return previews.names();}
    public Set<String> pinnedNames(){return names(pins,".jpg");}
    public boolean thumbnailRoom(){return thumbnails.room();}
    public void trim(long thumbnailBytes,long previewBytes){thumbnails.trim(thumbnailBytes);previews.trim(previewBytes);}
    public static Bitmap decode(File file,int edge){
        try{return decodeBounded(file,edge);}catch(IOException|RuntimeException|OutOfMemoryError error){return null;}
    }
    private static Bitmap decodeBounded(File file,int edge)throws IOException{
        if(!file.isFile())return null;
        BitmapFactory.Options options=new BitmapFactory.Options();options.inJustDecodeBounds=true;
        try(InputStream input=new FileInputStream(file)){BitmapFactory.decodeStream(input,null,options);}
        if(options.outWidth<=0||options.outHeight<=0||Math.max(options.outWidth,options.outHeight)>131072)return null;
        options.inSampleSize=1;
        while(Math.max(options.outWidth,options.outHeight)/(options.inSampleSize*2)>=edge)options.inSampleSize*=2;
        options.inJustDecodeBounds=false;
        Bitmap bitmap;try(InputStream input=new FileInputStream(file)){bitmap=BitmapFactory.decodeStream(input,null,options);}if(bitmap==null)return null;
        int longest=Math.max(bitmap.getWidth(),bitmap.getHeight());if(longest<=edge)return bitmap;
        float scale=edge/(float)longest;Bitmap scaled=Bitmap.createScaledBitmap(bitmap,Math.max(1,Math.round(bitmap.getWidth()*scale)),Math.max(1,Math.round(bitmap.getHeight()*scale)),true);
        if(scaled!=bitmap)bitmap.recycle();return scaled;
    }
    static Set<String> names(File directory,String suffix){
        String[] names=directory.list((dir,name)->name.endsWith(suffix));return names==null?Set.of():new HashSet<>(Arrays.asList(names));
    }
    private static void publish(File temp,File target)throws IOException{
        try{Files.move(temp.toPath(),target.toPath(),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);}
        catch(FileSystemException unsupported){Files.move(temp.toPath(),target.toPath(),StandardCopyOption.REPLACE_EXISTING);}
    }
    private static final class Bucket {
        final File directory;
        private long limit,total;
        private Map<String,Entry> entries;
        private final Map<String,String> byAsset=new HashMap<>();
        private final Map<String,Set<String>> duplicateVersions=new HashMap<>();
        private record Entry(long size,long used){}
        Bucket(File directory,long limit){this.directory=directory;this.limit=limit;}
        private void initialize(){
            if(entries!=null)return;entries=new HashMap<>();
            File[] files=directory.listFiles();if(files==null)return;
            for(File file:files){String name=file.getName();
                if(name.matches("[a-f0-9]{64}-[a-f0-9]{64}\\.jpg")){
                    entries.put(name,new Entry(file.length(),file.lastModified()));total+=file.length();String prefix=name.substring(0,64),previous=byAsset.put(prefix,name);if(previous!=null)duplicateVersions.computeIfAbsent(prefix,key->new HashSet<>()).add(previous);
                }else if(name.endsWith(".part")&&System.currentTimeMillis()-file.lastModified()>86400000L)file.delete();
            }
        }
        synchronized long bytes(){initialize();return total;}
        synchronized Set<String> names(){initialize();return new HashSet<>(entries.keySet());}
        synchronized boolean room(){initialize();return total<limit;}
        synchronized void touch(File file){
            if(!file.getParentFile().equals(directory))return;initialize();Entry entry=entries.get(file.getName());
            if(entry!=null){long now=System.currentTimeMillis();entries.put(file.getName(),new Entry(entry.size,now));file.setLastModified(now);}
        }
        boolean store(String name,File source,int edge,int quality,boolean evict,java.util.function.BooleanSupplier current)throws IOException{
            // Decode/encode off the bucket lock so UI disk hits are not queued behind background compression.
            if(!directory.isDirectory()&&!directory.mkdirs())throw new IOException("Cannot create photo cache");
            File target=new File(directory,name);if(target.isFile())return true;
            Bitmap bitmap=decode(source,edge);if(bitmap==null)throw new IOException("Cannot decode photo cache source");
            File temp=File.createTempFile("photo-",".part",directory);
            try{
                try(OutputStream out=new FileOutputStream(temp)){if(!bitmap.compress(Bitmap.CompressFormat.JPEG,quality,out))throw new IOException("Cannot encode photo cache");}
                synchronized(this){
                    if(!current.getAsBoolean())throw new IOException("Photo cache scope changed");
                    initialize();if(target.isFile())return true;
                    long size=temp.length();String prefix=name.substring(0,64),previous=byAsset.get(prefix);
                    long reclaim=previous==null?0:entries.getOrDefault(previous,new Entry(0,0)).size;
                    // Background fill stops here. It must never cycle through a library larger than its budget.
                    if(size>limit||!evict&&total-reclaim+size>limit)return false;
                    publish(temp,target);entries.put(name,new Entry(size,System.currentTimeMillis()));total+=size;byAsset.put(prefix,name);
                    if(previous!=null&&!previous.equals(name))remove(previous);
                    prune();return true;
                }
            }finally{bitmap.recycle();temp.delete();}
        }
        synchronized void trim(long bytes){initialize();limit=Math.max(0,bytes);prune();}
        synchronized void discard(String name){initialize();remove(name);}
        synchronized void discardAsset(String prefix){initialize();String current=byAsset.get(prefix);if(current!=null)remove(current);Set<String> older=duplicateVersions.remove(prefix);if(older!=null)for(String name:older)remove(name);}
        private void prune(){
            if(total<=limit)return;
            List<String> names=new ArrayList<>(entries.keySet());names.sort(Comparator.comparingLong(name->entries.get(name).used));
            for(String name:names){if(total<=limit)break;remove(name);}
        }
        private void remove(String name){
            File file=new File(directory,name);if(!file.exists()||file.delete()){
                Entry entry=entries.remove(name);if(entry!=null)total-=entry.size;
                if(name.equals(byAsset.get(name.substring(0,64))))byAsset.remove(name.substring(0,64));
                Set<String> older=duplicateVersions.get(name.substring(0,64));if(older!=null){older.remove(name);if(older.isEmpty())duplicateVersions.remove(name.substring(0,64));}
            }
        }
    }
}
