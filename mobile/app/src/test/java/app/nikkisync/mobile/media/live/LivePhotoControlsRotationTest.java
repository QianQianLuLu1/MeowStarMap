package app.nikkisync.mobile.media.live;

import android.view.View;
import android.view.ViewGroup;
import android.widget.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
public class LivePhotoControlsRotationTest {
    @Test public void callbackSeesUpdatedRotationForFullscreenFit() {
        var context=RuntimeEnvironment.getApplication();
        var body=new LinearLayout(context);var image=new ImageView(context);
        int[] remembered={-1};float[] observed={-1};
        var toolbarRotate=LivePhotoControls.attach(context,body,image,0,value->{
            remembered[0]=value;observed[0]=image.getRotation();
        });
        find(body,"右转 90°").performClick();
        assertEquals(90,remembered[0]);
        assertEquals("fullscreen fit must use the new orientation",90,observed[0],0);
        toolbarRotate.accept(90);
        assertEquals(180,image.getRotation(),0);
        find(body,"左转 90°").performClick();
        assertEquals("toolbar and detail controls share one rotation",90,remembered[0]);
    }
    private static Button find(View view,String text) {
        if(view instanceof Button button&&text.contentEquals(button.getText()))return button;
        if(view instanceof ViewGroup group)for(int i=0;i<group.getChildCount();i++){
            Button button=find(group.getChildAt(i),text);if(button!=null)return button;
        }
        return null;
    }
}
