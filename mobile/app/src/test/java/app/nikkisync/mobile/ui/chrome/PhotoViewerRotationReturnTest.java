package app.nikkisync.mobile.ui.chrome;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.view.View;
import android.widget.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;
import static org.junit.Assert.*;

/** Draw the real shared-image layer: a screen-aligned clip incorrectly cuts off these corners. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk=35, qualifiers="mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class PhotoViewerRotationReturnTest {
    private record Fixture(PhotoViewerPageTest.HostActivity activity, PhotoViewerPage page, ImageView image, View transition) {}
    private Fixture fixture() throws Exception { return fixture(400,200); }
    private Fixture fixture(int imageWidth,int imageHeight) throws Exception {
        var activity=Robolectric.buildActivity(PhotoViewerPageTest.HostActivity.class).setup().visible().get();
        activity.nav=new ChromeNavigationHost(activity);
        var gallery=new FrameLayout(activity);activity.nav.setRoot(gallery);activity.setContentView(activity.nav);
        var pixels=Bitmap.createBitmap(imageWidth,imageHeight,Bitmap.Config.ARGB_8888);pixels.eraseColor(Color.RED);
        var thumbnail=new ImageView(activity);thumbnail.setImageBitmap(pixels);thumbnail.setScaleType(ImageView.ScaleType.CENTER_CROP);
        var tile=new FrameLayout.LayoutParams(100,100);tile.leftMargin=350;tile.topMargin=450;gallery.addView(thumbnail,tile);
        var page=new PhotoViewerPage(activity,thumbnail);
        var scroll=new ScrollView(activity);var body=new LinearLayout(activity);scroll.addView(body);
        body.addView(new LinearLayout(activity));var image=new ImageView(activity);image.setImageBitmap(pixels);body.addView(image);
        page.setContentView(scroll);page.show();idle();
        activity.nav.measure(View.MeasureSpec.makeMeasureSpec(800,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(1000,View.MeasureSpec.EXACTLY));
        activity.nav.layout(0,0,800,1000);
        var field=PhotoViewerPage.class.getDeclaredField("transition");field.setAccessible(true);
        return new Fixture(activity,page,image,(View)field.get(page));
    }
    private static void idle(){org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(1));}
    private static Bitmap render(Fixture f) {
        var output=Bitmap.createBitmap(800,1000,Bitmap.Config.ARGB_8888);
        f.transition.draw(new Canvas(output));return output;
    }
    @Test public void rotatingCropKeepsAllFourCornersDuringAnchoredReturn() throws Exception {
        for(boolean portrait:new boolean[]{false,true}) {
        int iw=portrait?200:400,ih=portrait?400:200;
        var f=fixture(iw,ih);
        try {
            for(int rotation:new int[]{0,90,180,270}) {
                f.image.setRotation(rotation);
                for(float reveal:new float[]{.25f,.5f,.75f,1}) {
                    f.page.setReveal(reveal);var output=render(f);
                    float fit=PhotoViewerPage.fitScale(800,1000,iw,ih,rotation);
                    float width=100+(iw*fit-100)*reveal,height=100+(ih*fit-100)*reveal;
                    double angle=Math.toRadians(rotation*reveal),cos=Math.cos(angle),sin=Math.sin(angle);
                    for(int xSign:new int[]{-1,1})for(int ySign:new int[]{-1,1}) {
                        float u=xSign*width*.40f,v=ySign*height*.40f;
                        int x=Math.round(400+(float)(cos*u-sin*v)),y=Math.round(500+(float)(sin*u+cos*v));
                        assertTrue("test point must be inside the viewport",x>=0&&x<800&&y>=0&&y<1000);
                        assertEquals("rotated corner missing: rotation="+rotation+", reveal="+reveal+", point="+x+","+y,Color.RED,output.getPixel(x,y));
                    }
                    output.recycle();
                }
            }
        } finally {f.activity.nav.close();f.activity.finish();}
        }
    }
    @Test public void cancelledAndCommittedRotatedReturnRetainsOrientationAndSourceEndpoint() throws Exception {
        var f=fixture();
        try {
            f.image.setRotation(270);f.page.setReveal(1);f.page.settle();
            f.activity.nav.progress(.45f);f.activity.nav.cancel();idle();
            assertEquals(270,f.image.getRotation(),.001f);assertEquals(1,f.image.getAlpha(),.001f);
            assertEquals(1,f.page.getReveal(),.001f);assertEquals(View.INVISIBLE,f.transition.getVisibility());
            f.page.setReveal(0);var output=render(f);
            assertEquals(Color.RED,output.getPixel(400,500));
            assertEquals(Color.TRANSPARENT,output.getPixel(460,500)); // Origin is exactly the 100px tile, not a rotated bounding box.
            output.recycle();
            f.activity.nav.progress(.8f);f.activity.nav.commit();idle();assertEquals(0,f.activity.nav.overlayCount());
        } finally {f.activity.nav.close();f.activity.finish();}
    }
    @Test public void offscreenSourceFadesTheCompleteRotatedPhotoWithoutChangingItsOrientation() throws Exception {
        var f=fixture();
        try {
            var field=PhotoViewerPage.class.getDeclaredField("source");field.setAccessible(true);
            var source=(ImageView)field.get(f.page);((android.view.ViewGroup)source.getParent()).removeView(source);
            f.image.setRotation(90);f.page.setReveal(.5f);var output=render(f);
            for(int x:new int[]{200,600})for(int y:new int[]{50,950})assertEquals("fallback must preserve all rotated corners",127,Color.alpha(output.getPixel(x,y)));
            assertEquals(Color.TRANSPARENT,output.getPixel(100,500));output.recycle();
        } finally {f.activity.nav.close();f.activity.finish();}
    }
}
