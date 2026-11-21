package app.nikkisync.mobile.media;

import android.content.Context;
import android.content.SharedPreferences;

/** Disk budgets are independent from the bitmap working set. No files or RAM are preallocated. */
public final class PhotoCachePreferences {
    public static final int[] THUMBNAIL_MIB={512,1024,2048,4096};
    public static final int[] PREVIEW_MIB={256,512,1024,2048};
    public static final int[] MEMORY_MIB={64,128,192,256};
    private static final long MIB=1024L*1024L;
    private final SharedPreferences values;
    public PhotoCachePreferences(Context context){values=context.getApplicationContext().getSharedPreferences("nikkisync.photo-cache-v2",Context.MODE_PRIVATE);}
    private int read(String name,int fallback,int[] allowed){int value=values.getInt(name,fallback);for(int choice:allowed)if(choice==value)return value;return fallback;}
    private void write(String name,int value,int[] allowed){for(int choice:allowed)if(choice==value){values.edit().putInt(name,value).apply();return;}throw new IllegalArgumentException("Unsupported cache limit");}
    public int thumbnailMiB(){return read("thumbnails",2048,THUMBNAIL_MIB);}
    public int previewMiB(){return read("previews",512,PREVIEW_MIB);}
    public int memoryMiB(){return read("memory",128,MEMORY_MIB);}
    public long thumbnailBytes(){return thumbnailMiB()*MIB;}
    public long previewBytes(){return previewMiB()*MIB;}
    public long effectiveMemoryBytes(long heap){return Math.max(1,Math.min(memoryMiB()*MIB,heap/4));}
    public void setThumbnailMiB(int value){write("thumbnails",value,THUMBNAIL_MIB);}
    public void setPreviewMiB(int value){write("previews",value,PREVIEW_MIB);}
    public void setMemoryMiB(int value){write("memory",value,MEMORY_MIB);}
    public boolean automaticOffline(){return values.getBoolean("automatic-offline",true);}
    public void setAutomaticOffline(boolean value){values.edit().putBoolean("automatic-offline",value).apply();}
}
