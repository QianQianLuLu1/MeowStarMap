package app.nikkisync.mobile.ui;

import static org.junit.Assert.*;
import android.content.Context;
import android.graphics.*;
import android.graphics.drawable.ColorDrawable;
import android.view.View;
import android.widget.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public final class GalleryGlassRestoreTest {
    @Test public void glassMaterialsStayTranslucentOverPinkBackground() {
        Context context=RuntimeEnvironment.getApplication();
        for(var drawable:new android.graphics.drawable.Drawable[]{
                GalleryUxStyle.glassCard(context),GalleryUxStyle.glassChip(context)}) {
            Bitmap bitmap=Bitmap.createBitmap(200,100,Bitmap.Config.ARGB_8888);
            drawable.setBounds(0,0,200,100);drawable.draw(new Canvas(bitmap));
            assertTrue("Glass must show its backdrop",Color.alpha(bitmap.getPixel(100,50))<220);
            bitmap.recycle();
        }
    }
    @Test public void installedMainUiUsesRecoveredChromeAndRetainsPinkAmbient() throws Exception {
        // Exercise the real UI builder without Android Keystore startup (unavailable in JVM tests).
        var controller=org.robolectric.Robolectric.buildActivity(app.nikkisync.mobile.MainActivity.class);
        var activity=controller.get();
        var build=activity.getClass().getDeclaredMethod("buildUi");
        build.setAccessible(true);build.invoke(activity);
        var navigation=activity.navigationHost();
        assertNotNull(navigation);
        assertTrue(navigation.getChildAt(0) instanceof app.nikkisync.mobile.ui.chrome.ChromeHost);
        var chrome=(app.nikkisync.mobile.ui.chrome.ChromeHost)navigation.getChildAt(0);
        assertTrue(chrome.effectsLayer().getChildAt(0) instanceof app.nikkisync.mobile.ui.chrome.ProgressiveTopBlurView);
        Bitmap actual=Bitmap.createBitmap(200,400,Bitmap.Config.ARGB_8888);
        var background=chrome.contentLayer().getBackground();
        background.setBounds(0,0,200,400);background.draw(new Canvas(actual));
        Bitmap expected=Bitmap.createBitmap(200,400,Bitmap.Config.ARGB_8888);
        var pink=activity.getDrawable(app.nikkisync.mobile.R.drawable.bg_gallery_ambient);
        pink.setBounds(0,0,200,400);pink.draw(new Canvas(expected));
        assertEquals(expected.getPixel(100,20),actual.getPixel(100,20));
        assertEquals(expected.getPixel(100,380),actual.getPixel(100,380));
        actual.recycle();expected.recycle();navigation.close();
    }
}
