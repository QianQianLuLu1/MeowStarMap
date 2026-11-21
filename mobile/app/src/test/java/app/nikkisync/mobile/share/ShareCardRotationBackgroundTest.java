package app.nikkisync.mobile.share;

import static org.junit.Assert.*;
import android.graphics.*;
import android.net.Uri;
import java.io.*;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class ShareCardRotationBackgroundTest {
    @Test public void pngBackgroundUsesClockwiseViewerRotation() throws Exception {
        var context=RuntimeEnvironment.getApplication();
        File source=File.createTempFile("rotation-synthetic-",".png",context.getCacheDir());
        Bitmap original=Bitmap.createBitmap(240,160,Bitmap.Config.ARGB_8888);Canvas canvas=new Canvas(original);
        Paint paint=new Paint();paint.setColor(Color.RED);canvas.drawRect(0,0,120,160,paint);
        paint.setColor(Color.BLUE);canvas.drawRect(120,0,240,160,paint);
        try(OutputStream out=new FileOutputStream(source)){original.compress(Bitmap.CompressFormat.PNG,100,out);}original.recycle();
        var payload=new ShareCardPayload("synthetic","","",List.of(),List.of(),List.of());
        try(var prepared=ShareCardPreparation.prepare(context,null,Uri.fromFile(source),null,payload,90,()->true)) {
            Bitmap page=prepared.preview(0);
            try {
                int top=page.getPixel(1400,200),bottom=page.getPixel(1400,page.getHeight()-200);
                assertTrue("Left half becomes top after clockwise rotation",Color.red(top)>Color.blue(top));
                assertTrue("Right half becomes bottom after clockwise rotation",Color.blue(bottom)>Color.red(bottom));
            } finally {page.recycle();}
        } finally {source.delete();}
    }
}
