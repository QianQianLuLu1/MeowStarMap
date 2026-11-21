package app.nikkisync.mobile.media;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import androidx.exifinterface.media.ExifInterface;
import app.nikkisync.mobile.media.live.LivePhotoProfile;
import java.io.*;
import java.nio.file.Files;
import java.time.*;
import java.time.format.DateTimeFormatter;
import java.util.Locale;

/** Samsung's gallery date is the save time. Original game time stays in parameters/saved snapshots. */
public final class GallerySavePolicy {
    private GallerySavePolicy(){}
    private static boolean samsung(){return "samsung".equalsIgnoreCase(Build.MANUFACTURER)||"samsung".equalsIgnoreCase(Build.BRAND);}
    public static String stillPath(){return samsung()?"DCIM/Camera":"Pictures/NikkiSync";}
    public static String livePath(LivePhotoProfile profile){
        return samsung()?"DCIM/Camera":profile==LivePhotoProfile.STANDARD||profile==LivePhotoProfile.XIAOMI?"Pictures/NikkiSync":"DCIM/Camera";
    }
    public static void addDate(ContentValues values,long savedAt){if(samsung())values.put(MediaStore.Images.Media.DATE_TAKEN,savedAt);}
    public static File prepareLiveImage(File source,File directory,long savedAt)throws IOException {
        if(!samsung())return source;
        // Never rewrite EXIF after motion is appended: EXIF writers may discard the motion trailer.
        File copy=new File(directory,"gallery-date.jpg");Files.copy(source.toPath(),copy.toPath());
        applyDate(new ExifInterface(copy),savedAt);return copy;
    }
    public static void prepareStill(ContentResolver resolver,Uri uri,String mime,long savedAt)throws IOException {
        if(!samsung()||!("image/jpeg".equalsIgnoreCase(mime)||"image/jpg".equalsIgnoreCase(mime)
            ||"image/png".equalsIgnoreCase(mime)||"image/webp".equalsIgnoreCase(mime)))return;
        try(var fd=resolver.openFileDescriptor(uri,"rw")){
            if(fd==null)throw new IOException("无法设置相册保存日期");applyDate(new ExifInterface(fd.getFileDescriptor()),savedAt);
        }
    }
    static void applyDate(ExifInterface exif,long savedAt)throws IOException {
        if(!samsung())return;
        var local=Instant.ofEpochMilli(savedAt).atZone(ZoneId.systemDefault());
        String date=DateTimeFormatter.ofPattern("yyyy:MM:dd HH:mm:ss",Locale.ROOT).format(local);
        String offset=DateTimeFormatter.ofPattern("xxx",Locale.ROOT).format(local);
        String subseconds=String.format(Locale.ROOT,"%03d",Math.floorMod(savedAt,1000L));
        for(String tag:new String[]{ExifInterface.TAG_DATETIME,ExifInterface.TAG_DATETIME_ORIGINAL,ExifInterface.TAG_DATETIME_DIGITIZED})exif.setAttribute(tag,date);
        for(String tag:new String[]{ExifInterface.TAG_OFFSET_TIME,ExifInterface.TAG_OFFSET_TIME_ORIGINAL,ExifInterface.TAG_OFFSET_TIME_DIGITIZED})exif.setAttribute(tag,offset);
        for(String tag:new String[]{ExifInterface.TAG_SUBSEC_TIME,ExifInterface.TAG_SUBSEC_TIME_ORIGINAL,ExifInterface.TAG_SUBSEC_TIME_DIGITIZED})exif.setAttribute(tag,subseconds);
        exif.saveAttributes();
    }
}
