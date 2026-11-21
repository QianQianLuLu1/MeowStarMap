package app.nikkisync.mobile.ui.chrome;

import android.app.Activity;
import android.view.*;
import android.widget.*;
import app.nikkisync.mobile.media.live.MotionPreviewLoader;
import java.io.File;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
public class PhotoViewerLiveTest {
    public static class Host extends Activity implements ChromePage.Owner {ChromeNavigationHost nav;public ChromeNavigationHost navigationHost(){return nav;}}
    private Host activity;private PhotoViewerPage page;private ImageView image;private LivePhotoPlayback playback;private FakeEngine engine;
    private MotionPreviewLoader.Callback callback;private boolean released;
    @Before public void setup(){
        activity=Robolectric.buildActivity(Host.class).setup().visible().get();activity.nav=new ChromeNavigationHost(activity);activity.nav.setRoot(new View(activity));activity.setContentView(activity.nav);
        page=new PhotoViewerPage(activity,null);content();page.show();idle();layout();page.setReveal(1);page.settle();
        playback=new LivePhotoPlayback(activity,listener->{callback=listener;return ()->{};},(context,file,events)->engine=new FakeEngine(new View(context),events));
        page.setLivePhoto(playback);callback.ready(new MotionPreviewLoader.Video(){public File file(){return new File("test.mp4");}public void close(){released=true;}});engine.events.firstFrame();
    }
    @After public void cleanup(){activity.nav.close();activity.finish();}
    @Test public void liveKeepsControlsAboveToolbarAndVideoFollowsRotation(){
        layout();image.setRotation(90);page.refreshImageTransform();assertEquals(90,playback.surface().getRotation(),0);
        assertEquals(image.getScaleX(),playback.surface().getScaleX(),0);
        assertTrue("Playback controls must not overlap save/share",playback.controls().getBottom()<=2000-72);
        page.setReveal(.6f);assertFalse(engine.playing);assertEquals(0,playback.surface().getAlpha(),0);
        page.setReveal(1);page.settle();assertTrue(engine.playing);
    }
    @Test public void horizontalGestureHidesMovieAndCancelledPagingRestoresIt(){
        page.setPaging(false,false,null);View touch=page.findViewWithTag("photo-gestures");
        event(touch,MotionEvent.ACTION_DOWN,800,800,0);event(touch,MotionEvent.ACTION_MOVE,300,800,50);
        assertFalse(engine.playing);assertEquals(0,playback.surface().getAlpha(),0);
        event(touch,MotionEvent.ACTION_CANCEL,300,800,100);idle();assertTrue(engine.playing);
    }
    @Test public void detailsPausePlaybackAndClosingDetailsResumes(){
        page.openDetails();idle();assertFalse(engine.playing);assertEquals(0,playback.surface().getAlpha(),0);
        activity.nav.commit();idle();assertTrue(engine.playing);
    }
    @Test public void rebindingOrdinaryPhotoAndDismissingReleaseOldDecoder(){
        page.preparePhoto(null);content();page.show();assertTrue(engine.closed);assertTrue(released);
        assertNull(page.findViewWithTag("live-playback-controls"));assertEquals(255,image.getImageAlpha());
    }
    @Test public void committedSwipeDefersNewVideoUntilPagingFinishes()throws Exception{
        ImageView next=new ImageView(activity);next.setImageDrawable(image.getDrawable());page.setAdjacentPhotos(null,next);
        MotionPreviewLoader.Callback[] incoming={null};
        page.setPaging(false,true,direction->{page.preparePhoto(null);content();page.setLivePhoto(new LivePhotoPlayback(activity,listener->{incoming[0]=listener;return ()->{};},(c,f,e)->new FakeEngine(new View(c),e)));page.show();});
        View touch=page.findViewWithTag("photo-gestures");event(touch,0,800,800,0);event(touch,2,200,800,100);event(touch,1,200,800,200);
        assertTrue(engine.closed);assertNull("Keep the handoff cover throughout the swipe",incoming[0]);
        idle();assertNotNull(incoming[0]);assertNotNull(image.getDrawable());assertEquals(1,image.getAlpha(),0);
    }
    @Test public void anotherOverlayPausesTheCoveredPhoto(){
        activity.nav.push(new FrameLayout(activity));idle();assertFalse(engine.playing);assertEquals(0,playback.surface().getAlpha(),0);
        activity.nav.commit();idle();assertTrue(engine.playing);
    }
    @Test public void movieWaitsForACoverSoASwipeAlwaysHasAPhotoToReturnTo(){
        page.preparePhoto(null);content();image.setImageDrawable(null);page.show();
        MotionPreviewLoader.Callback[] waiting={null};
        page.setLivePhoto(new LivePhotoPlayback(activity,listener->{waiting[0]=listener;return ()->{};},(c,f,e)->new FakeEngine(new View(c),e)));
        assertNull("A fast movie must not race ahead of a slow cover and leave a black swipe",waiting[0]);
        image.setImageBitmap(android.graphics.Bitmap.createBitmap(320,180,android.graphics.Bitmap.Config.ARGB_8888));page.refreshImageTransform();assertNotNull(waiting[0]);
    }
    private void content(){ScrollView scroll=new ScrollView(activity);LinearLayout body=new LinearLayout(activity);scroll.addView(body);body.addView(new LinearLayout(activity));image=new ImageView(activity);image.setImageBitmap(android.graphics.Bitmap.createBitmap(320,180,android.graphics.Bitmap.Config.ARGB_8888));body.addView(image);page.setContentView(scroll);}
    private void layout(){activity.nav.measure(View.MeasureSpec.makeMeasureSpec(1000,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(2000,View.MeasureSpec.EXACTLY));activity.nav.layout(0,0,1000,2000);}
    private static void idle(){Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(1));}
    private static void event(View v,int action,float x,float y,long time){var e=MotionEvent.obtain(0,time,action,x,y,0);v.dispatchTouchEvent(e);e.recycle();}
    private static final class FakeEngine implements LivePhotoPlayback.Engine {final View view;final LivePhotoPlayback.Events events;boolean playing,closed;FakeEngine(View v,LivePhotoPlayback.Events e){view=v;events=e;}public View view(){return view;}public void playing(boolean v){playing=v;}public void muted(boolean v){}public void close(){closed=true;}}
}
