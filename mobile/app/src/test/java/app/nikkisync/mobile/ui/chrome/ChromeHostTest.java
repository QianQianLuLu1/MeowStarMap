package app.nikkisync.mobile.ui.chrome;

import android.content.Context;
import android.view.View;
import android.widget.FrameLayout;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
public class ChromeHostTest {
    @Test public void backdropContentExcludesControlsAndFillsWindowBehindDock() {
        Context context = RuntimeEnvironment.getApplication();
        ChromeHost host = new ChromeHost(context);
        View photo = new View(context), button = new View(context);
        host.contentLayer().addView(photo, new FrameLayout.LayoutParams(-1, -1));
        host.controlsLayer().addView(button);
        host.measure(View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(2200, View.MeasureSpec.EXACTLY));
        host.layout(0, 0, 1080, 2200);
        assertEquals(2200, photo.getHeight());
        assertEquals(1080, photo.getWidth());
        assertEquals(1, host.contentLayer().getChildCount());
        assertNotEquals(photo.getParent(), button.getParent());
        assertTrue(host.indexOfChild(host.controlsLayer()) > host.indexOfChild(host.effectsLayer()));
        assertEquals(0, host.getPaddingBottom());
        assertEquals(Math.round(210*context.getResources().getDisplayMetrics().density),
                host.effectsLayer().getChildAt(0).getHeight());
    }
    @Test public void topFadeIsThirtyPercentShorter() {
        assertEquals(1, ChromeTokens.topMaskAlpha(0), .001);
        assertEquals(1, ChromeTokens.topMaskAlpha(78.4f), .001);
        assertEquals(.79, ChromeTokens.topMaskAlpha(101.5f), .001);
        assertEquals(.58, ChromeTokens.topMaskAlpha(124.6f), .001);
        assertEquals(.14, ChromeTokens.topMaskAlpha(170.8f), .001);
        assertEquals(0, ChromeTokens.topMaskAlpha(200.2f), .001);
        assertEquals(0, ChromeTokens.topMaskAlpha(500), .001);
    }
}
