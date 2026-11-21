package app.nikkisync.mobile.ui.chrome;
import android.app.Activity;
import android.graphics.*;
import android.view.*;
import android.widget.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@org.robolectric.annotation.GraphicsMode(org.robolectric.annotation.GraphicsMode.Mode.NATIVE)
public class LiquidGlassScrollTest {
    @Test public void scrolledButtonGlassMovesAndClipsAtTheActualScrollViewport(){
        Activity activity=Robolectric.buildActivity(Activity.class).setup().visible().get();
        FrameLayout root=new FrameLayout(activity);activity.setContentView(root);
        View background=new View(activity);background.setBackgroundColor(Color.BLUE);root.addView(background,new FrameLayout.LayoutParams(-1,-1));
        ScrollView scroll=new ScrollView(activity);LinearLayout form=new LinearLayout(activity);form.setOrientation(LinearLayout.VERTICAL);scroll.addView(form);
        form.addView(new View(activity),new LinearLayout.LayoutParams(-1,100));View button=new View(activity);form.addView(button,new LinearLayout.LayoutParams(-1,80));form.addView(new View(activity),new LinearLayout.LayoutParams(-1,700));
        FrameLayout.LayoutParams viewport=new FrameLayout.LayoutParams(200,220);viewport.leftMargin=100;viewport.topMargin=100;root.addView(scroll,viewport);
        var backdrop=new ContentBackdrop(background);var glass=new LiquidGlassDockView(activity,backdrop,button);root.addView(glass,new FrameLayout.LayoutParams(-1,-1));
        root.measure(View.MeasureSpec.makeMeasureSpec(400,1073741824),View.MeasureSpec.makeMeasureSpec(600,1073741824));root.layout(0,0,400,600);
        Bitmap initial=Bitmap.createBitmap(400,600,Bitmap.Config.ARGB_8888);glass.draw(new Canvas(initial));assertNotEquals(0,initial.getPixel(200,240));
        scroll.scrollTo(0,150);root.getViewTreeObserver().dispatchOnPreDraw();
        Bitmap moved=Bitmap.createBitmap(400,600,Bitmap.Config.ARGB_8888);glass.draw(new Canvas(moved));
        assertEquals("no glass may remain at the old button position",0,moved.getPixel(200,240));
        assertEquals("glass must not spill above the scroller",0,moved.getPixel(200,90));
        assertNotEquals("visible part follows the button",0,moved.getPixel(200,115));
        initial.recycle();moved.recycle();backdrop.close();activity.finish();
    }
}
