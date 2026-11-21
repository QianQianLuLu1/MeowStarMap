package app.nikkisync.mobile.ui.chrome;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.view.View;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.GraphicsMode;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @GraphicsMode(GraphicsMode.Mode.NATIVE)
public class ContentBackdropTest {
    @Test public void softwareFallbackOnlyDrawsSourceAndClosesWithoutLeakingControls() {
        ChromeHost host=new ChromeHost(RuntimeEnvironment.getApplication());
        host.contentLayer().setBackgroundColor(Color.RED);
        host.controlsLayer().setBackgroundColor(Color.BLUE);
        host.measure(View.MeasureSpec.makeMeasureSpec(100,1073741824),View.MeasureSpec.makeMeasureSpec(120,1073741824));
        host.layout(0,0,100,120);
        ContentBackdrop backdrop=new ContentBackdrop(host.contentLayer());
        Bitmap bitmap=Bitmap.createBitmap(100,120,Bitmap.Config.ARGB_8888);
        backdrop.draw(new Canvas(bitmap));
        assertEquals(Color.RED,bitmap.getPixel(50,60));
        backdrop.close(); bitmap.eraseColor(Color.GREEN);
        backdrop.draw(new Canvas(bitmap));
        assertEquals(Color.GREEN,bitmap.getPixel(50,60));
        bitmap.recycle();
    }
}
