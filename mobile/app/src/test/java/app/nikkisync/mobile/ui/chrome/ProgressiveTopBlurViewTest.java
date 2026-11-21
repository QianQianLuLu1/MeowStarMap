package app.nikkisync.mobile.ui.chrome;
import android.graphics.*;
import android.view.View;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.GraphicsMode;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class) @GraphicsMode(GraphicsMode.Mode.NATIVE)
public class ProgressiveTopBlurViewTest {
    @org.junit.Test public void scrollEndDoesNotJumpRadius() throws Exception {
        android.content.Context context=org.robolectric.RuntimeEnvironment.getApplication();
        ProgressiveTopBlurView view=new ProgressiveTopBlurView(context,new ContentBackdrop(new android.view.View(context)));
        java.lang.reflect.Field radius=ProgressiveTopBlurView.class.getDeclaredField("radiusDp");
        radius.setAccessible(true);
        view.setScrolling(true);
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(400));
        org.junit.Assert.assertEquals(21.8f,radius.getFloat(view),.01f);
        view.setScrolling(false);
        org.junit.Assert.assertEquals(21.8f,radius.getFloat(view),.01f);
        java.lang.reflect.Field animator=ProgressiveTopBlurView.class.getDeclaredField("radiusAnimator");
        animator.setAccessible(true);
        ((android.animation.ValueAnimator)animator.get(view)).setCurrentPlayTime(100);
        float middle=radius.getFloat(view);
        org.junit.Assert.assertTrue(middle>21.8f && middle<31.2f);
        view.setScrolling(true);
        org.junit.Assert.assertEquals(middle,radius.getFloat(view),.01f);
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(400));
        org.junit.Assert.assertEquals(21.8f,radius.getFloat(view),.01f);
    }
    @Test public void softwareFallbackKeepsDarkPhotoTitleReadableWithoutCoveringBottom(){
        var c=RuntimeEnvironment.getApplication();var view=new ProgressiveTopBlurView(c,new ContentBackdrop(new View(c)));
        int h=Math.round(210*c.getResources().getDisplayMetrics().density);view.layout(0,0,400,h);
        Bitmap b=Bitmap.createBitmap(400,h,Bitmap.Config.ARGB_8888);b.eraseColor(Color.BLACK);view.draw(new Canvas(b));
        assertTrue(Color.red(b.getPixel(200,0))>=180);assertTrue(Color.red(b.getPixel(200,h-1))<5);
    }
}
