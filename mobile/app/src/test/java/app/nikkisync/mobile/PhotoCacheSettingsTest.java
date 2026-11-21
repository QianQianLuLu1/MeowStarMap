package app.nikkisync.mobile;

import android.view.*;
import android.widget.*;
import app.nikkisync.mobile.media.*;
import java.lang.reflect.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk=35)
public class PhotoCacheSettingsTest {
    @Test public void explicitlyRequestedFillKeepsScreenOnOnlyWhileForegroundWorkIsRunning()throws Exception{
        MainActivity activity=Robolectric.buildActivity(MainActivity.class).get();invoke(activity,"buildUi");ImageLoader loader=new ImageLoader(activity);
        try{
            for(var entry:java.util.Map.of("imageLoader",loader,"connectionForeground",true,"cacheWakeRequested",true).entrySet()){Field f=MainActivity.class.getDeclaredField(entry.getKey());f.setAccessible(true);f.set(activity,entry.getValue());}
            var state=(app.nikkisync.mobile.net.ConnectionState)field(activity,"connectionState");state.httpResult(state.session(),true);
            Field progress=ImageLoader.class.getDeclaredField("offlineProgress");progress.setAccessible(true);progress.set(loader,new ImageLoader.OfflineProgress(1,10,true,false,0));
            invoke(activity,"updateCacheWakeLock");assertTrue((activity.getWindow().getAttributes().flags&android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)!=0);
            progress.set(loader,new ImageLoader.OfflineProgress(10,10,false,false,0));invoke(activity,"updateCacheWakeLock");assertEquals(0,activity.getWindow().getAttributes().flags&android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            invoke(activity,"showCacheSettings");assertTrue(allText((View)field(activity,"cacheSettingsPage")).contains("保持亮屏"));
        }finally{activity.navigationHost().close();loader.shutdown();for(String name:new String[]{"io","organizerIo","organizerNetworkIo"})((java.util.concurrent.ExecutorService)field(activity,name)).shutdownNow();}
    }
    @Test public void offlineSettingsExposeSeparatePersistentDiskAndMemoryChoicesAndDoNotStack()throws Exception{
        MainActivity activity=Robolectric.buildActivity(MainActivity.class).get();invoke(activity,"buildUi");invoke(activity,"showSettings");
        new PhotoCachePreferences(activity).setThumbnailMiB(1024);
        button(activity.navigationHost(),"缓存与离线整理").performClick();
        assertEquals(2,activity.navigationHost().overlayCount());invoke(activity,"showCacheSettings");assertEquals(2,activity.navigationHost().overlayCount());
        View page=(View)field(activity,"cacheSettingsPage");String text=allText(page);
        assertTrue(text.contains("离线缩略图"));assertTrue(text.contains("缩略图容量上限"));assertTrue(text.contains("高清预览容量上限"));assertTrue(text.contains("图片内存缓存上限"));assertTrue(text.contains("两端一起更新"));
        button(page,"1024 MiB · 更改").performClick();assertEquals(3,activity.navigationHost().overlayCount());
        button(activity.navigationHost(),"2048 MiB").performClick();activity.navigationHost().interrupt();
        assertEquals(2048,new PhotoCachePreferences(activity).thumbnailMiB());
        assertTrue(allText((View)field(activity,"cacheSettingsPage")).contains("2048 MiB · 更改"));
        activity.navigationHost().close();
        for(String name:new String[]{"io","organizerIo","organizerNetworkIo"})((java.util.concurrent.ExecutorService)field(activity,name)).shutdownNow();
    }
    static Object field(Object value,String name)throws Exception{Field f=value.getClass().getDeclaredField(name);f.setAccessible(true);return f.get(value);}
    static void invoke(Object value,String name)throws Exception{Method m=value.getClass().getDeclaredMethod(name);m.setAccessible(true);m.invoke(value);}
    static Button button(View view,String title){if(view instanceof Button b&&title.contentEquals(b.getText()))return b;if(view instanceof ViewGroup group)for(int i=0;i<group.getChildCount();i++){Button b=button(group.getChildAt(i),title);if(b!=null)return b;}return null;}
    static String allText(View view){StringBuilder out=new StringBuilder();if(view instanceof TextView t)out.append(t.getText());if(view instanceof ViewGroup group)for(int i=0;i<group.getChildCount();i++)out.append(allText(group.getChildAt(i)));return out.toString();}
}
