package app.nikkisync.mobile.media;
import android.graphics.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.GraphicsMode;
import java.io.*;
import java.nio.file.Files;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class) @GraphicsMode(GraphicsMode.Mode.NATIVE)
public class ImageLoaderDisplayTest {
    @Test public void largePcPreviewIsBoundedForDisplayWithoutChangingCachedMedia()throws Exception{
        File file=File.createTempFile("nikki-display-",".png");
        Bitmap source=Bitmap.createBitmap(3840,2160,Bitmap.Config.ARGB_8888);source.eraseColor(Color.BLUE);
        try(OutputStream out=new FileOutputStream(file)){source.compress(Bitmap.CompressFormat.PNG,100,out);}source.recycle();
        byte[] original=Files.readAllBytes(file.toPath());
        Bitmap result=ImageLoader.decodeDisplayFile(file);
        assertTrue(result.getWidth()<=1280);assertTrue(result.getHeight()<=1280);
        assertEquals(16f/9,result.getWidth()/(float)result.getHeight(),.01);
        assertEquals(Color.BLUE,result.getPixel(20,20));assertArrayEquals(original,Files.readAllBytes(file.toPath()));
        result.recycle();file.delete();
    }
}
