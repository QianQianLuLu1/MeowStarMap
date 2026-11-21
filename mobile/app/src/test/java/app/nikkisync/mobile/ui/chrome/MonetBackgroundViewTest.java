package app.nikkisync.mobile.ui.chrome;
import android.graphics.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.GraphicsMode;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class) @GraphicsMode(GraphicsMode.Mode.NATIVE)
public class MonetBackgroundViewTest {
    @Test public void singlePhotoFieldStretchesInsteadOfRepeatingAt1024Pixels(){
        var view=new MonetBackgroundView(RuntimeEnvironment.getApplication());view.setPhotoMode(true);
        Bitmap tile=Bitmap.createBitmap(1024,1024,Bitmap.Config.ARGB_8888);
        Canvas c=new Canvas(tile);Paint p=new Paint();p.setShader(new LinearGradient(0,0,1024,0,Color.RED,Color.BLUE,Shader.TileMode.CLAMP));c.drawRect(0,0,1024,1024,p);
        view.transitionTo(tile);view.layout(0,0,1600,2400);Bitmap result=Bitmap.createBitmap(1600,2400,Bitmap.Config.ARGB_8888);view.draw(new Canvas(result));
        assertTrue(Color.blue(result.getPixel(1500,500))>200);
        assertTrue(Math.abs(Color.red(result.getPixel(1023,500))-Color.red(result.getPixel(1024,500)))<3);
    }
}
