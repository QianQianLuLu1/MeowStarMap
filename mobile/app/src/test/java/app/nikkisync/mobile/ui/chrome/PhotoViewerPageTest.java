package app.nikkisync.mobile.ui.chrome;

import android.app.Activity;
import android.view.View;
import android.widget.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
public class PhotoViewerPageTest {
    @Test public void photoDetailsKeepTheGlassBackdropAndReadableText() throws Exception {
        Fixture f=fixture();try{
            f.page.openDetails();idle();
            var field=PhotoViewerPage.class.getDeclaredField("sheet");field.setAccessible(true);
            ChromeSheetLayout sheet=(ChromeSheetLayout)field.get(f.page);
            assertNull("An opaque sheet would cover the glass", sheet.getBackground());
            FrameLayout layer=(FrameLayout)sheet.getParent();
            FrameLayout recording=(FrameLayout)layer.getChildAt(0);
            assertTrue(recording.getChildAt(0) instanceof LiquidGlassDockView);
            assertEquals(f.activity.getColor(app.nikkisync.mobile.R.color.photo_detail_text),
                    ((TextView)findText(sheet,"照片详情")).getCurrentTextColor());
            assertEquals(f.activity.getColor(app.nikkisync.mobile.R.color.photo_detail_glass_ink),
                    ((TextView)findText(sheet,"完成")).getCurrentTextColor());
        }finally{f.activity.nav.close();f.activity.finish();}
    }
    @Test public void selectionCircleBackgroundSurvivesViewerHeaderTint(){
        Fixture f=fixture();try{
            f.page.preparePhoto(null);ScrollView scroll=new ScrollView(f.activity);LinearLayout body=new LinearLayout(f.activity);scroll.addView(body);
            LinearLayout header=new LinearLayout(f.activity);Button check=new Button(f.activity);check.setTag("photo-selection");
            var circle=new android.graphics.drawable.GradientDrawable();circle.setShape(android.graphics.drawable.GradientDrawable.OVAL);check.setBackground(circle);header.addView(check);body.addView(header);body.addView(new ImageView(f.activity));
            f.page.setContentView(scroll);assertSame(circle,check.getBackground());
        }finally{f.activity.nav.close();f.activity.finish();}
    }
    @Test public void committedSwipeKeepsOutgoingPhotoUntilIncomingFinishesInBothDirections() throws Exception {
        for(int direction:new int[]{1,-1}) {
            Fixture f=fixture();
            try {
                ImageView outgoing=f.image;
                ImageView adjacent=new ImageView(f.activity);
                adjacent.setImageBitmap(android.graphics.Bitmap.createBitmap(1000,1000,android.graphics.Bitmap.Config.ARGB_8888));
                ImageView[] incoming={null};
                f.page.setPaging(true,true,change->{
                    f.page.preparePhoto(null);
                    ScrollView scroll=new ScrollView(f.activity);LinearLayout body=new LinearLayout(f.activity);scroll.addView(body);
                    body.addView(new LinearLayout(f.activity));incoming[0]=new ImageView(f.activity);body.addView(incoming[0]);
                    f.page.setContentView(scroll);f.page.show();
                });
                f.page.setAdjacentPhotos(direction<0?adjacent:null,direction>0?adjacent:null);
                View touch=f.page.findViewWithTag("photo-gestures");float start=direction>0?800:200,end=direction>0?200:800;
                event(touch,0,start,800,0);event(touch,2,end,800,100);event(touch,1,end,800,200);
                assertSame("The outgoing image must still cover its side after release",f.page,outgoing.getParent());
                assertNotNull(incoming[0].getDrawable());assertEquals(255,incoming[0].getImageAlpha());
                var field=PhotoViewerPage.class.getDeclaredField("pagingAnimation");field.setAccessible(true);
                var animation=(android.animation.ValueAnimator)field.get(f.page);
                for(float fraction:new float[]{0,.25f,.5f,.75f}) {
                    animation.setCurrentFraction(fraction);
                    assertEquals(direction*1000,incoming[0].getTranslationX()-outgoing.getTranslationX(),.1f);
                    assertSame(f.page,outgoing.getParent());
                }
                animation.end();assertNull("Release the outgoing view after completion",outgoing.getParent());
                assertEquals(0,incoming[0].getTranslationX(),.01f);
            } finally {f.activity.nav.close();f.activity.finish();}
        }
    }
    @Test public void pagingOffsetSurvivesImageMeasurementAndTransformRefresh() throws Exception {
        Fixture f=fixture();
        try {
            f.page.setPaging(true,true,direction->{
                f.page.preparePhoto(null);
                var scroll=new ScrollView(f.activity);var body=new LinearLayout(f.activity);scroll.addView(body);
                body.addView(new LinearLayout(f.activity));var incoming=new ImageView(f.activity);
                incoming.setImageBitmap(android.graphics.Bitmap.createBitmap(1000,1000,android.graphics.Bitmap.Config.ARGB_8888));body.addView(incoming);
                f.page.setContentView(scroll);f.page.show();
            });
            View touch=f.page.findViewWithTag("photo-gestures");
            event(touch,0,800,800,0);event(touch,2,200,800,100);event(touch,1,200,800,200);
            var field=PhotoViewerPage.class.getDeclaredField("image");field.setAccessible(true);
            ImageView incoming=(ImageView)field.get(f.page);
            assertEquals("ImageView.setAlpha(int) is image opacity, not View opacity",255,incoming.getImageAlpha());
            assertEquals("the photo surface must also be visible",1f,incoming.getAlpha(),.001f);
            float offset=incoming.getTranslationX();assertTrue(offset>0);
            f.page.refreshImageTransform();
            assertEquals("layout/bitmap updates must not flash the incoming image at zero",offset,incoming.getTranslationX(),.01f);
        } finally {f.activity.nav.close();f.activity.finish();}
    }
    @Test public void detailsCanReopenAfterEveryDismissRouteAndPredictiveCancelKeepsThem() throws Exception {
        Fixture f=fixture();
        try {
            for(int route=0;route<3;route++) {
                f.page.openDetails();idle();assertEquals(2,f.activity.nav.overlayCount());
                f.activity.nav.measure(View.MeasureSpec.makeMeasureSpec(1000,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(2000,View.MeasureSpec.EXACTLY));
                f.activity.nav.layout(0,0,1000,2000);
                f.activity.nav.progress(.5f);f.activity.nav.cancel();idle();
                assertEquals("cancel must retain the same details",2,f.activity.nav.overlayCount());
                if(route==0) {
                    var field=PhotoViewerPage.class.getDeclaredField("sheet");field.setAccessible(true);
                    View sheet=(View)field.get(f.page);findText(sheet,"完成").performClick();
                } else if(route==1) f.activity.nav.commit();
                else event(f.activity.nav,0,20,20,0);
                if(route==2)event(f.activity.nav,1,20,20,20);
                idle();assertEquals(1,f.activity.nav.overlayCount());
            }
            f.page.openDetails();idle();assertEquals(2,f.activity.nav.overlayCount());
        } finally {f.activity.nav.close();f.activity.finish();}
    }
    private static View findText(View view,String value) {
        if(view instanceof TextView text&&value.equals(text.getText().toString()))return view;
        if(view instanceof android.view.ViewGroup group)for(int i=0;i<group.getChildCount();i++){View found=findText(group.getChildAt(i),value);if(found!=null)return found;}
        return null;
    }
    @Test public void sourceAnchorSurvivesSamePhotoCacheRevisionButRejectsRecycledPhoto() throws Exception {
        HostActivity a=Robolectric.buildActivity(HostActivity.class).setup().visible().get();
        var loader=new app.nikkisync.mobile.media.ImageLoader(a);
        try {
            a.nav=new ChromeNavigationHost(a);var gallery=new FrameLayout(a);a.nav.setRoot(gallery);a.setContentView(a.nav);
            var thumbnail=new ImageView(a);gallery.addView(thumbnail,new FrameLayout.LayoutParams(200,200));
            var asset=new app.nikkisync.mobile.model.Models.AssetSummary("same-photo","photo","ready",null,null,1,200,200,false,false,null,null,null,null);
            loader.load(null,asset,thumbnail);
            var page=new PhotoViewerPage(a,thumbnail);
            var matches=PhotoViewerPage.class.getDeclaredMethod("sourceMatches");matches.setAccessible(true);
            assertTrue((Boolean)matches.invoke(page));
            var revision=new app.nikkisync.mobile.model.Models.AssetSummary("same-photo","photo","ready",null,null,2,200,200,false,false,null,null,null,null);
            loader.load(null,revision,thumbnail);
            assertTrue("A metadata/cache revision must not turn an anchored return into a fade",(Boolean)matches.invoke(page));
            var server=new app.nikkisync.mobile.model.Models.PairedServer("another-pc","test","127.0.0.1",28080,"test-fingerprint","","",0);
            loader.load(new app.nikkisync.mobile.net.NikkiSyncClient(server,null),revision,thumbnail);
            assertFalse("Same asset ID on another computer cannot reuse the source anchor",(Boolean)matches.invoke(page));
            loader.load(null,revision,thumbnail);
            var other=new app.nikkisync.mobile.model.Models.AssetSummary("other-photo","photo","ready",null,null,2,200,200,false,false,null,null,null,null);
            loader.load(null,other,thumbnail);
            assertFalse("Never shrink into a recycled tile showing another photo",(Boolean)matches.invoke(page));
            gallery.removeView(thumbnail);
            assertFalse((Boolean)matches.invoke(page));
        } finally {loader.shutdown();a.finish();}
    }
    private record Fixture(HostActivity activity, PhotoViewerPage page, ImageView image) {}
    private Fixture fixture() {
        HostActivity a=Robolectric.buildActivity(HostActivity.class).setup().get();
        a.nav=new ChromeNavigationHost(a);a.nav.setRoot(new View(a));a.setContentView(a.nav);
        PhotoViewerPage page=new PhotoViewerPage(a,null);
        ScrollView scroll=new ScrollView(a);LinearLayout body=new LinearLayout(a);scroll.addView(body);
        body.addView(new LinearLayout(a));ImageView image=new ImageView(a);body.addView(image);
        image.setImageBitmap(android.graphics.Bitmap.createBitmap(1000,1000,android.graphics.Bitmap.Config.ARGB_8888));
        page.setContentView(scroll);page.show();idle();
        a.nav.measure(View.MeasureSpec.makeMeasureSpec(1000,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(2000,View.MeasureSpec.EXACTLY));a.nav.layout(0,0,1000,2000);
        page.setReveal(1);page.settle();return new Fixture(a,page,image);
    }
    private static void idle(){org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(1));}
    private static void event(View v,int action,float x,float y,long time){
        android.view.MotionEvent e=android.view.MotionEvent.obtain(0,time,action,x,y,0);v.dispatchTouchEvent(e);e.recycle();
    }
    @Test public void downwardDragCommitsButShortOrCancelledDragRestoresPhoto(){
        Fixture f=fixture();View touch=f.page.findViewWithTag("photo-gestures");assertNotNull("gestures need an untransformed input surface",touch);
        event(touch,0,500,700,0);event(touch,2,500,740,100);event(touch,1,500,740,200);idle();
        assertEquals(1,f.activity.nav.overlayCount());assertEquals(1,f.page.getReveal(),.001f);
        event(touch,0,500,700,300);event(touch,2,500,1250,400);event(touch,3,500,1250,450);idle();
        assertEquals(1,f.activity.nav.overlayCount());
        event(touch,0,500,700,500);event(touch,2,500,1250,600);event(touch,1,500,1250,700);idle();
        assertEquals(0,f.activity.nav.overlayCount());f.activity.finish();
    }
    @Test public void horizontalSwipeChangesPhotoOnlyAfterRelease(){
        Fixture f=fixture();java.util.List<Integer> changes=new java.util.ArrayList<>();
        f.page.setPaging(true,true,changes::add);View touch=f.page.findViewWithTag("photo-gestures");
        ImageView next=new ImageView(f.activity);f.page.setAdjacentPhotos(null,next);
        next.setImageBitmap(android.graphics.Bitmap.createBitmap(1000,1000,android.graphics.Bitmap.Config.ARGB_8888));
        event(touch,0,800,800,0);event(touch,2,200,810,100);assertTrue(changes.isEmpty());
        assertEquals(View.VISIBLE,next.getVisibility());assertEquals(400,next.getTranslationX(),.01f);
        event(touch,1,200,810,200);idle();assertEquals(java.util.List.of(1),changes);
        assertEquals(1,f.activity.nav.overlayCount());f.activity.nav.close();f.activity.finish();
    }
    @Test public void unloadedNeighborCannotCommitToAnEmptyPhoto(){
        Fixture f=fixture();java.util.List<Integer> changes=new java.util.ArrayList<>();
        try {
            f.page.setPaging(true,true,changes::add);ImageView next=new ImageView(f.activity);f.page.setAdjacentPhotos(null,next);
            View touch=f.page.findViewWithTag("photo-gestures");
            event(touch,0,800,800,0);event(touch,2,200,810,100);event(touch,1,200,810,200);idle();
            assertTrue("Wait for preload instead of finishing into a black page",changes.isEmpty());
            assertEquals(0,f.image.getTranslationX(),.01f);
            assertNotNull(f.image.getDrawable());
        } finally {f.activity.nav.close();f.activity.finish();}
    }
    @Test public void zoomedPanUsesStableScreenCoordinatesAndNeverPages(){
        Fixture f=fixture();java.util.List<Integer> changes=new java.util.ArrayList<>();f.page.setPaging(true,true,changes::add);
        View touch=f.page.findViewWithTag("photo-gestures");
        event(touch,0,500,1000,0);event(touch,1,500,1000,30);
        event(touch,0,500,1000,100);event(touch,1,500,1000,130);idle();
        assertTrue(f.image.getScaleX()>2);
        event(touch,0,500,1000,1500);event(touch,2,550,1030,1550);event(touch,2,600,1060,1600);event(touch,1,600,1060,1700);
        assertEquals(100,f.image.getTranslationX(),.01f);assertEquals(60,f.image.getTranslationY(),.01f);
        assertEquals(0,touch.getTranslationX(),0);assertEquals(1,touch.getScaleX(),0);assertTrue(changes.isEmpty());
        f.activity.nav.close();f.activity.finish();
    }
    @Test public void headerSelectionButtonKeepsItsMeaning(){
        Fixture f=fixture();f.page.preparePhoto(null);ScrollView scroll=new ScrollView(f.activity);LinearLayout body=new LinearLayout(f.activity);scroll.addView(body);
        LinearLayout header=new LinearLayout(f.activity);Button selected=new Button(f.activity);selected.setText("✓");header.addView(selected);body.addView(header);body.addView(new ImageView(f.activity));
        f.page.setContentView(scroll);f.page.show();assertEquals("✓",selected.getText().toString());
        f.activity.nav.close();f.activity.finish();
    }
    @Test public void secondFingerCancelsPendingDownwardDismiss(){
        Fixture f=fixture();View touch=f.page.findViewWithTag("photo-gestures");
        event(touch,0,500,700,0);event(touch,2,500,1150,100);assertTrue(f.page.getReveal()<1);
        android.view.MotionEvent.PointerProperties a=new android.view.MotionEvent.PointerProperties();a.id=0;a.toolType=1;
        android.view.MotionEvent.PointerProperties b=new android.view.MotionEvent.PointerProperties();b.id=1;b.toolType=1;
        android.view.MotionEvent.PointerCoords x=new android.view.MotionEvent.PointerCoords();x.x=500;x.y=1150;x.pressure=1;x.size=1;
        android.view.MotionEvent.PointerCoords y=new android.view.MotionEvent.PointerCoords();y.x=650;y.y=1150;y.pressure=1;y.size=1;
        android.view.MotionEvent e=android.view.MotionEvent.obtain(0,120,android.view.MotionEvent.ACTION_POINTER_DOWN|(1<<8),2,new android.view.MotionEvent.PointerProperties[]{a,b},new android.view.MotionEvent.PointerCoords[]{x,y},0,0,1,1,0,0,android.view.InputDevice.SOURCE_TOUCHSCREEN,0);
        touch.dispatchTouchEvent(e);e.recycle();
        assertEquals(1,f.page.getReveal(),.001f);assertEquals(1,f.image.getAlpha(),.001f);
        assertEquals(1,f.activity.nav.overlayCount());f.activity.nav.close();f.activity.finish();
    }
    @Test public void pagingRetainsReadyNeighborWhilePrimaryAsyncLoadIsPending(){
        Fixture f=fixture();ImageView next=new ImageView(f.activity);next.setImageBitmap(android.graphics.Bitmap.createBitmap(80,120,android.graphics.Bitmap.Config.ARGB_8888));
        f.page.setAdjacentPhotos(null,next);ImageView replacement=new ImageView(f.activity);
        f.page.setPaging(false,true,direction->{
            f.page.preparePhoto(null);ScrollView scroll=new ScrollView(f.activity);LinearLayout body=new LinearLayout(f.activity);scroll.addView(body);
            body.addView(new LinearLayout(f.activity));body.addView(replacement);f.page.setContentView(scroll);f.page.show();
        });
        View touch=f.page.findViewWithTag("photo-gestures");event(touch,0,800,800,0);event(touch,2,200,800,100);event(touch,1,200,800,200);
        assertNotNull("preloaded pixels must survive page rebinding",replacement.getDrawable());
        assertEquals(80,replacement.getDrawable().getIntrinsicWidth());f.activity.nav.close();f.activity.finish();
    }
    @Test public void rotatedPortraitFitsEntirelyInsideLandscapeBounds() {
        assertEquals(.5f,PhotoViewerPage.fitScale(1000,2000,1000,2000,90),.0001f);
        assertEquals(1f,PhotoViewerPage.fitScale(1000,2000,1000,2000,0),.0001f);
    }
    public static class HostActivity extends Activity implements ChromePage.Owner {
        ChromeNavigationHost nav;
        public ChromeNavigationHost navigationHost(){return nav;}
    }
    @Test public void photoIsFullScreenAndDetailsOnlyOpenOnRequest() {
        HostActivity a=Robolectric.buildActivity(HostActivity.class).setup().get();
        a.nav=new ChromeNavigationHost(a);a.nav.setRoot(new View(a));a.setContentView(a.nav);
        PhotoViewerPage page=new PhotoViewerPage(a,null);
        ScrollView scroll=new ScrollView(a);LinearLayout body=new LinearLayout(a);body.setOrientation(1);scroll.addView(body);
        LinearLayout header=new LinearLayout(a);body.addView(header);
        ImageView photo=new ImageView(a);body.addView(photo);
        photo.setImageBitmap(android.graphics.Bitmap.createBitmap(20,30,android.graphics.Bitmap.Config.ARGB_8888));
        TextView details=new TextView(a);details.setText("穿搭");body.addView(details);
        page.setContentView(scroll);page.show();
        assertEquals(1,a.nav.overlayCount());
        assertEquals(-1,photo.getLayoutParams().height);
        assertFalse(details.isAttachedToWindow());
        page.openDetails();assertEquals(2,a.nav.overlayCount());
        page.setReveal(.5f);assertEquals(.5f,page.getReveal(),.001f);
        page.setReveal(1);page.settle();
        assertEquals("settled image must remain opaque",255,photo.getImageAlpha());
        photo.performClick();assertFalse(page.isChromeVisible());
        photo.performClick();assertTrue(page.isChromeVisible());
        a.nav.commit();org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(1));
        assertEquals("back from details only closes the sheet",1,a.nav.overlayCount());
        a.nav.progress(.4f);assertEquals(.6f,page.getReveal(),.001f);
        a.nav.cancel();org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(1));
        assertEquals(1f,page.getReveal(),.001f);assertEquals(1,a.nav.overlayCount());
        a.nav.commit();org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(1));
        assertFalse(a.nav.hasOverlay());
        a.nav.close();a.finish();
    }
}
