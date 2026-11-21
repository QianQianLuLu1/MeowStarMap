package app.nikkisync.mobile.widget;
import android.content.Context;
import android.graphics.Bitmap;
import android.net.Uri;
import java.io.IOException;
import app.nikkisync.mobile.media.SavedPhotoDecoder;
final class WidgetPhotoDecoder {
 private WidgetPhotoDecoder(){}
 static Bitmap decode(Context context,Uri uri)throws IOException{return SavedPhotoDecoder.decode(context,uri,1536);}
 static Bitmap orient(Bitmap bitmap,int direction){return SavedPhotoDecoder.orient(bitmap,direction);}
}
