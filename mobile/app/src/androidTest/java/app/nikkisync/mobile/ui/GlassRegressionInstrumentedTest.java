package app.nikkisync.mobile.ui;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.drawable.BitmapDrawable;
import android.os.SystemClock;
import android.view.*;
import android.widget.*;
import app.nikkisync.mobile.MainActivity;
import app.nikkisync.mobile.model.Models.AssetSummary;
import app.nikkisync.mobile.ui.chrome.PhotoViewerPage;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.lang.reflect.*;
import java.util.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Runs the real MainActivity paging path on the connected GPU; no exports or profile edits. */
@RunWith(AndroidJUnit4.class)
public class GlassRegressionInstrumentedTest {
    @Test public void mainViewerKeepsPhotoVisibleAfterBothPagingDirections()throws Exception{
        var instrumentation=InstrumentationRegistry.getInstrumentation();
        java.util.concurrent.atomic.AtomicReference<MainActivity> foreground=new java.util.concurrent.atomic.AtomicReference<>();
        instrumentation.runOnMainSync(()->instrumentation.getTargetContext().startActivity(new Intent(instrumentation.getTargetContext(),MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_CLEAR_TASK)));
        for(int i=0;i<100&&foreground.get()==null;i++){
            instrumentation.runOnMainSync(()->{for(Activity a:androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(androidx.test.runner.lifecycle.Stage.RESUMED))if(a instanceof MainActivity main)foreground.set(main);});SystemClock.sleep(100);
        }
        assertNotNull("MainActivity must be foreground for device UI acceptance",foreground.get());
        MainActivity activity=foreground.get();List<AssetSummary> photos=new ArrayList<>();
        for(int i=0;i<50&&photos.size()<2;i++){
            instrumentation.runOnMainSync(()->{photos.clear();try{for(var item:(List<AssetSummary>)field(activity,"assets"))if(!item.hasMotion())photos.add(item);}catch(Exception error){throw new RuntimeException(error);}});
            if(photos.size()<2)SystemClock.sleep(200);
        }
        assertTrue("connected library needed for the actual paging path",photos.size()>1);
        try{
            Method open=MainActivity.class.getDeclaredMethod("showViewer",AssetSummary.class,List.class);open.setAccessible(true);
            instrumentation.runOnMainSync(()->{try{open.invoke(activity,photos.get(0),photos.subList(0,2));}catch(Exception error){throw new RuntimeException(error);}});
            SystemClock.sleep(700);
            for(int direction:new int[]{1,-1}){
                instrumentation.runOnMainSync(()->{
                    PhotoViewerPage viewer=(PhotoViewerPage)activity.navigationHost().getChildAt(1);View touch=viewer.findViewWithTag("photo-gestures");
                    float w=viewer.getWidth(),y=viewer.getHeight()/2f,start=direction>0?w*.8f:w*.2f,end=direction>0?w*.2f:w*.8f;long time=SystemClock.uptimeMillis();
                    for(int action:new int[]{MotionEvent.ACTION_DOWN,MotionEvent.ACTION_MOVE,MotionEvent.ACTION_UP}){MotionEvent event=MotionEvent.obtain(time,time+(action==0?0:80),action,action==0?start:end,y,0);touch.dispatchTouchEvent(event);event.recycle();}
                });
                SystemClock.sleep(1000);
                instrumentation.runOnMainSync(()->{try{
                    PhotoViewerPage viewer=(PhotoViewerPage)activity.navigationHost().getChildAt(1);ImageView image=(ImageView)field(viewer,"image");
                    assertNotNull("incoming photo pixels",image.getDrawable());assertEquals("image alpha",1,image.getAlpha(),.001);
                    assertEquals("image pixels must retain full opacity",255,image.getImageAlpha());
                    assertEquals("paging completed",0,image.getTranslationX(),.01);assertTrue("measured photo bounds",image.getWidth()>0&&image.getHeight()>0);
                    assertTrue("photo scale",image.getScaleX()>0&&image.getScaleY()>0);assertEquals("drawable opacity",255,image.getDrawable().getAlpha());
                }catch(Exception error){throw new RuntimeException(error);}});
                Bitmap screen=instrumentation.getUiAutomation().takeScreenshot();int colored=0;
                for(int x=screen.getWidth()/4;x<screen.getWidth()*3/4;x+=25)for(int y=screen.getHeight()/3;y<screen.getHeight()*2/3;y+=25){int pixel=screen.getPixel(x,y);if((pixel&0xffffff)!=0x101012&&(pixel&0xffffff)!=0)colored++;}
                screen.recycle();assertTrue("GPU must show photograph pixels, not just black chrome",colored>20);
            }
        }finally{instrumentation.runOnMainSync(()->activity.navigationHost().close());activity.finish();}
    }
    private static Object field(Object object,String name)throws Exception{Field field=object.getClass().getDeclaredField(name);field.setAccessible(true);return field.get(object);}
}
