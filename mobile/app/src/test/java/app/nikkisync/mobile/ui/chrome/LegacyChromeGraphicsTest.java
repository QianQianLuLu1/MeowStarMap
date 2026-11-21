package app.nikkisync.mobile.ui.chrome;

import android.graphics.*;
import android.view.View;
import android.widget.FrameLayout;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk={30,31,32,35},shadows=app.nikkisync.mobile.util.LegacyBluetoothDeviceShadow.class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class LegacyChromeGraphicsTest {
    @Test public void hardwareChromeDrawsOnEverySupportedPlatform() {
        var context=RuntimeEnvironment.getApplication();
        var activity=org.robolectric.Robolectric.buildActivity(android.app.Activity.class).setup().visible().get();
        var root=new FrameLayout(activity);activity.setContentView(root);
        View content=new View(context);content.setBackgroundColor(Color.BLUE);
        root.addView(content,new FrameLayout.LayoutParams(400,600));
        View anchor=new View(context);root.addView(anchor,new FrameLayout.LayoutParams(300,80));
        root.measure(View.MeasureSpec.makeMeasureSpec(400,1073741824),View.MeasureSpec.makeMeasureSpec(600,1073741824));
        root.layout(0,0,400,600);
        var backdrop=new ContentBackdrop(content);backdrop.record(400,600);
        var top=new ProgressiveTopBlurView(context,backdrop);top.layout(0,0,400,210);
        var glass=new LiquidGlassDockView(context,backdrop,anchor);glass.layout(0,0,400,600);
        var node=new RenderNode("compatibility-test");node.setPosition(0,0,400,600);
        var canvas=node.beginRecording(400,600);
        try { assertTrue(canvas.isHardwareAccelerated());top.draw(canvas);glass.draw(canvas); }
        finally { node.endRecording();node.discardDisplayList();backdrop.close();activity.finish(); }
    }
}
