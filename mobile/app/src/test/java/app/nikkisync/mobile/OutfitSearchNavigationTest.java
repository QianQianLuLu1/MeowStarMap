package app.nikkisync.mobile;

import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ImageView;
import android.widget.LinearLayout;
import app.nikkisync.mobile.media.ImageLoader;
import app.nikkisync.mobile.model.Models.PairedServer;
import app.nikkisync.mobile.net.NikkiSyncClient;
import app.nikkisync.mobile.ui.chrome.ChromeHost;
import app.nikkisync.mobile.ui.chrome.ChromeNavigationHost;
import java.lang.reflect.*;
import java.time.Duration;
import java.util.concurrent.ExecutorService;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk=35)
public class OutfitSearchNavigationTest {
    @Test public void missingAndPendingMetadataAppearInTheSharedOnlineSavedAndOfflineDetailSection() throws Exception {
        MainActivity activity=Robolectric.buildActivity(MainActivity.class).get();
        try{
            LinearLayout section=new LinearLayout(activity);
            invoke(activity,"renderClothingSection",new Class[]{String.class,String.class,LinearLayout.class},"screenshot",null,section);
            assertEquals(View.VISIBLE,section.getVisibility());assertTrue(copy(section).contains("没有可显示的穿搭和拍摄参数"));
            invoke(activity,"renderClothingSection",new Class[]{String.class,String.class,LinearLayout.class},"pending","{\"raw\":{\"sourceParametersPresent\":true}}",section);
            assertTrue(copy(section).contains("尚未解码成功"));assertFalse(copy(section).contains("缺少原始数据"));
            invoke(activity,"showMetadataNotice",new Class[]{LinearLayout.class,String.class},section,"尚未缓存这张照片的参数，连接电脑后可读取。");
            assertEquals(1,section.getChildCount());assertFalse(copy(section).contains("查看参数自查方法"));assertFalse(copy(section).contains("原始数据"));
            invoke(activity,"showSavedMetadata",new Class[]{LinearLayout.class,String.class,app.nikkisync.mobile.storage.SavedMetadataSnapshotStore.Snapshot.class},section,"unseen",null);
            assertTrue(copy(section).contains("尚未缓存"));
            @SuppressWarnings("unchecked") var assets=(java.util.List<app.nikkisync.mobile.model.Models.AssetSummary>)field("assets").get(activity);
            assets.add(new app.nikkisync.mobile.model.Models.AssetSummary("screenshot","photo","ready",null,null,1,1000,1000,false,false,null,null,null,"unknown"));
            invoke(activity,"showSavedMetadata",new Class[]{LinearLayout.class,String.class,app.nikkisync.mobile.storage.SavedMetadataSnapshotStore.Snapshot.class},section,"screenshot",null);
            assertTrue(copy(section).contains("没有可显示的穿搭和拍摄参数"));assertFalse(copy(section).contains("尚未缓存"));
        }finally{((ExecutorService)field("io").get(activity)).shutdownNow();}
    }
    @Test public void savedOutfitRendersIconRowsEvenWhenOffline() throws Exception {
        MainActivity activity=Robolectric.buildActivity(MainActivity.class).get();
        ImageLoader images=new ImageLoader(activity);field("imageLoader").set(activity,images);
        try{
            LinearLayout section=new LinearLayout(activity);
            invoke(activity,"renderClothingSection",new Class[]{String.class,String.class,LinearLayout.class},"saved-asset","{\"dressing\":{\"clothes\":[{\"id\":\"123\",\"name\":\"测试发型\",\"category\":\"hair\"}]}}",section);
            assertEquals(View.VISIBLE,section.getVisibility());assertEquals(1,icons(section));
        }finally{images.shutdown();((ExecutorService)field("io").get(activity)).shutdownNow();}
    }
    @Test public void profileSearchBackReturnsToTheSameProfilePage() throws Exception {
        MainActivity activity=Robolectric.buildActivity(MainActivity.class).get();invoke(activity,"buildUi",new Class[]{});
        ImageLoader images=new ImageLoader(activity);field("imageLoader").set(activity,images);
        try{
            field("client").set(activity,new NikkiSyncClient(new PairedServer("test","test","127.0.0.1",1,"0".repeat(64),"","",0),null));
            ChromeNavigationHost navigation=(ChromeNavigationHost)field("navigation").get(activity);
            ChromeHost origin=new ChromeHost(activity);field("profileStatsPage").set(activity,origin);navigation.push(origin);
            Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1));
            invoke(activity,"openProfileSearch",new Class[]{String.class,boolean.class},"test",true);
            assertEquals(2,navigation.overlayCount());
            ChromeHost search=(ChromeHost)navigation.getChildAt(navigation.getChildCount()-1);
            assertTrue(search.contentLayer().getBackground() instanceof android.graphics.drawable.GradientDrawable);
            assertArrayEquals(new int[]{activity.getColor(R.color.background_top),activity.getColor(R.color.background_middle),activity.getColor(R.color.app_background)},((android.graphics.drawable.GradientDrawable)search.contentLayer().getBackground()).getColors());
            navigation.commit();Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2));
            assertEquals(1,navigation.overlayCount());assertSame(origin,navigation.getChildAt(navigation.getChildCount()-1));
        }finally{images.shutdown();((ExecutorService)field("io").get(activity)).shutdownNow();}
    }
    private static int icons(View view){int count=view instanceof ImageView?1:0;if(view instanceof ViewGroup group)for(int i=0;i<group.getChildCount();i++)count+=icons(group.getChildAt(i));return count;}
    private static String copy(View view){String text=view instanceof android.widget.TextView label?label.getText().toString():"";if(view instanceof ViewGroup group)for(int i=0;i<group.getChildCount();i++)text+=copy(group.getChildAt(i));return text;}
    private static Field field(String name)throws Exception{Field field=MainActivity.class.getDeclaredField(name);field.setAccessible(true);return field;}
    private static void invoke(Object target,String name,Class<?>[] types,Object...args)throws Exception{Method method=MainActivity.class.getDeclaredMethod(name,types);method.setAccessible(true);method.invoke(target,args);}
}
