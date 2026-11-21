package app.nikkisync.mobile;

import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;
import app.nikkisync.mobile.model.Models.AssetSummary;
import app.nikkisync.mobile.model.Models.PairedServer;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
public final class PlayerFacingMyPageTest {
    @Test public void inspirationLibraryPredictiveReturnKeepsTheExactMyPage() throws Exception {
        MainActivity activity=Robolectric.buildActivity(MainActivity.class).get();invoke(activity,"buildUi");
        try {
            Method change=MainActivity.class.getDeclaredMethod("switchTab",int.class);change.setAccessible(true);change.invoke(activity,2);
            View my=(View)field(activity,"myContent");findText(my,"打开灵感库").performClick();
            assertEquals("library must enter the same app navigation stack",1,activity.navigationHost().overlayCount());
            activity.navigationHost().measure(View.MeasureSpec.makeMeasureSpec(800,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(1600,View.MeasureSpec.EXACTLY));
            activity.navigationHost().layout(0,0,800,1600);
            View page=activity.navigationHost().getChildAt(1);
            activity.navigationHost().progress(.5f);assertTrue(page.getTranslationX()>0);
            activity.navigationHost().cancel();activity.navigationHost().interrupt();assertEquals(1,activity.navigationHost().overlayCount());
            activity.navigationHost().commit();activity.navigationHost().interrupt();assertEquals(0,activity.navigationHost().overlayCount());
            assertSame(my,field(activity,"myContent"));assertEquals(2,field(activity,"activeTab"));
        } finally {activity.navigationHost().close();((java.util.concurrent.ExecutorService)field(activity,"io")).shutdownNow();}
    }
    @Test public void mainContentSwipesBetweenTabsWithTranslationAndWithoutFading() throws Exception {
        MainActivity activity=Robolectric.buildActivity(MainActivity.class).get();invoke(activity,"buildUi");
        try {
            // Swipe the full tab host, including empty gallery space; a vertical scroll must not switch tabs.
            View content=(View)field(activity,"homeTabs");
            content.measure(View.MeasureSpec.makeMeasureSpec(1000,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(1800,View.MeasureSpec.EXACTLY));content.layout(0,0,1000,1800);
            touch(content,0,800,800,0);touch(content,2,400,810,100);
            View gallery=(View)field(activity,"galleryList");View saved=(View)field(activity,"savedList");
            assertTrue(((View)gallery.getParent()).getTranslationX()<0);assertTrue(((View)saved.getParent()).getTranslationX()>0);
            assertEquals(1,((View)gallery.getParent()).getAlpha(),0);assertEquals(1,((View)saved.getParent()).getAlpha(),0);
            touch(content,1,400,810,200);org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(1));
            assertEquals(1,field(activity,"activeTab"));
            touch(content,0,500,500,300);touch(content,2,510,900,400);touch(content,1,510,900,500);
            assertEquals(1,field(activity,"activeTab"));
            touch(content,0,800,800,600);touch(content,2,300,800,700);touch(content,1,300,800,800);
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(1));assertEquals(2,field(activity,"activeTab"));
        } finally {activity.navigationHost().close();((java.util.concurrent.ExecutorService)field(activity,"io")).shutdownNow();}
    }
    private static void touch(View view,int action,float x,float y,long time) {
        var e=android.view.MotionEvent.obtain(0,time,action,x,y,0);view.dispatchTouchEvent(e);e.recycle();
    }
    @Test public void myPageKeepsUsefulCountsAndConnectionWithoutDiagnostics() throws Exception {
        MainActivity activity = Robolectric.buildActivity(MainActivity.class).get();
        invoke(activity, "buildUi");
        @SuppressWarnings("unchecked") List<AssetSummary> assets = (List<AssetSummary>) field(activity, "assets");
        assets.add(new AssetSummary("a1", "photo", "ready", "2026-09-25T10:20:00Z", "12345",
                1, 3000, 2000, true, true, null, null, "2.9", "inferred"));
        assets.add(new AssetSummary("a2", "photo", "ready", "2026-09-24T10:20:00Z", "12345",
                2, 3000, 2000, false, false, null, null, "2.8", "inferred"));
        invoke(activity, "refreshMyPage");
        String copy = allText((LinearLayout) field(activity, "myContent"));
        assertTrue(copy.contains("照片：2 张"));
        assertTrue(copy.contains("LIVE：1 张"));
        assertTrue(copy.contains("已保存：0 张"));
        assertFalse(copy.contains("同步与设备"));
        assertTrue(copy.contains("复制 UID"));
        assertFalse(copy.contains("已解析参数"));
        assertFalse(copy.contains("版本分布"));
        assertFalse(copy.contains("数据源状态"));
        assertFalse(copy.contains("数据说明"));
        assertFalse(copy.contains("revision"));
        assertFalse(copy.contains("%"));
    }

    @Test public void pairedComputerIsNotReportedConnectedBeforeNetworkSuccess() throws Exception {
        MainActivity activity = Robolectric.buildActivity(MainActivity.class).get();
        invoke(activity, "buildUi");
        Field paired = MainActivity.class.getDeclaredField("pairedServer");
        paired.setAccessible(true);
        paired.set(activity, new PairedServer("id", "我的电脑", "192.0.2.1", 8443,
                "fingerprint", "public-key", "credential", 1));
        invoke(activity, "showSettings");
        String offline = allText((LinearLayout) field(activity, "settingsContent"));
        assertTrue(offline.contains("当前未连接：我的电脑"));
        assertFalse(offline.contains("已连接：我的电脑"));

        app.nikkisync.mobile.net.ConnectionState connected =
                (app.nikkisync.mobile.net.ConnectionState) field(activity, "connectionState");
        connected.httpResult(connected.session(), true);
        invoke(activity, "refreshSettingsPage");
        assertTrue(allText((LinearLayout) field(activity, "settingsContent")).contains("已连接：我的电脑"));
    }

    @Test public void myPageHasThreeSectionsAndSettingsKeepTheirExistingPreference() throws Exception {
        MainActivity activity = Robolectric.buildActivity(MainActivity.class).get();
        invoke(activity, "buildUi");
        Method switchTab = MainActivity.class.getDeclaredMethod("switchTab", int.class);
        switchTab.setAccessible(true); switchTab.invoke(activity, 2);
        LinearLayout content = (LinearLayout)field(activity, "myContent");
        assertEquals(3, content.getChildCount());
        assertTrue(allText(content.getChildAt(0)).contains("搭配师 UID"));
        assertTrue(allText(content.getChildAt(0)).contains("填写昵称"));
        assertTrue(allText(content.getChildAt(1)).contains("图库概况"));
        assertTrue(allText(content.getChildAt(2)).contains("穿搭灵感库"));
        assertFalse(allText(content).contains("本地缓存"));
        View settings=(View)field(activity,"settingsButton");
        assertEquals(View.VISIBLE, settings.getVisibility()); settings.performClick();
        assertEquals(1, activity.navigationHost().overlayCount());
        String options=allText((LinearLayout)field(activity,"settingsContent"));
        if(!BuildConfig.STORE_SUBMISSION)for(String removed:List.of("隐私政策","用户协议","权限与数据说明","第三方服务与组件","APP核准（备案）信息"))
            assertFalse("Public beta settings must omit "+removed,options.contains(removed));
        assertTrue(options.contains("本地缓存"));assertTrue(options.contains("同步与设备"));
        assertTrue(options.contains("保存时附带拍摄参数"));
        findText((View)field(activity,"settingsContent"),"已开启 · 点击关闭").performClick();
        assertFalse(activity.getSharedPreferences("nikkisync.export",0).getBoolean("writeExif",true));
        assertEquals(3,content.getChildCount());
        activity.navigationHost().progress(.5f);activity.navigationHost().cancel();activity.navigationHost().interrupt();
        assertEquals(1,activity.navigationHost().overlayCount());
        activity.navigationHost().commit();activity.navigationHost().interrupt();
        assertEquals(0,activity.navigationHost().overlayCount());assertNull(field(activity,"settingsContent"));
        switchTab.invoke(activity,0);assertEquals(View.GONE,settings.getVisibility());
    }

    private static View findText(View view,String value) {
        if(view instanceof TextView text && value.equals(text.getText().toString()))return view;
        if(view instanceof ViewGroup group)for(int i=0;i<group.getChildCount();i++) {
            View found=findText(group.getChildAt(i),value);if(found!=null)return found;
        }
        return null;
    }

    @Test public void nicknameEditorSavesAndRestoresTheSameUidWithoutChangingOtherPlayers() throws Exception {
        MainActivity activity=Robolectric.buildActivity(MainActivity.class).get();invoke(activity,"buildUi");
        @SuppressWarnings("unchecked") List<AssetSummary> assets=(List<AssetSummary>)field(activity,"assets");
        assets.add(new AssetSummary("a","photo","ready",null,"12345",1,100,100,false,false,null,null,null,null));
        invoke(activity,"refreshMyPage");
        for(String label:List.of("填写昵称","复制 UID")){
            android.widget.Button control=(android.widget.Button)findText((View)field(activity,"myContent"),label);
            assertEquals("custom buttons must retain centered text",android.view.Gravity.CENTER,control.getGravity());
        }
        findText((View)field(activity,"myContent"),"填写昵称").performClick();
        assertEquals(1,activity.navigationHost().overlayCount());
        android.widget.EditText input=findInput(activity.navigationHost());assertNotNull(input);
        input.setText("暖暖摄影师");findText(activity.navigationHost(),"保存并设置为默认").performClick();
        activity.navigationHost().interrupt();
        assertEquals("12345",new app.nikkisync.mobile.storage.StylistProfileStore(activity).defaultUid());
        assertEquals("暖暖摄影师的大喵相机",new app.nikkisync.mobile.storage.ExportWatermarkStore(activity).shareBranding(null).title());
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
        assertTrue(allText((View)field(activity,"myContent")).contains("暖暖摄影师"));
        Field store=MainActivity.class.getDeclaredField("stylistProfiles");store.setAccessible(true);store.set(activity,null);
        invoke(activity,"refreshMyPage");assertTrue(allText((View)field(activity,"myContent")).contains("暖暖摄影师"));
        assets.clear();assets.add(new AssetSummary("b","photo","ready",null,"67890",1,100,100,false,false,null,null,null,null));
        invoke(activity,"refreshMyPage");assertFalse(allText((View)field(activity,"myContent")).contains("暖暖摄影师"));
        activity.navigationHost().close();((java.util.concurrent.ExecutorService)field(activity,"io")).shutdownNow();
    }

    private static android.widget.EditText findInput(View view) {
        if(view instanceof android.widget.EditText input)return input;
        if(view instanceof ViewGroup group)for(int i=0;i<group.getChildCount();i++) {
            android.widget.EditText input=findInput(group.getChildAt(i));if(input!=null)return input;
        }
        return null;
    }

    @Test public void commonOutfitSearchPreservesItsOriginPageForBack() throws Exception {
        MainActivity activity=Robolectric.buildActivity(MainActivity.class).get();invoke(activity,"buildUi");
        try {
            invoke(activity,"refreshMyPage");
            findText((View)field(activity,"myContent"),"查看常用穿搭").performClick();
            assertEquals(1,activity.navigationHost().overlayCount());
            var server=new PairedServer("id","电脑","127.0.0.1",1,"0".repeat(64),"","",0);
            Field client=MainActivity.class.getDeclaredField("client");client.setAccessible(true);
            client.set(activity,new app.nikkisync.mobile.net.NikkiSyncClient(server,null));
            Method open=MainActivity.class.getDeclaredMethod("openProfileSearch",String.class,boolean.class);open.setAccessible(true);
            open.invoke(activity,"暖暖套装",false);
            assertEquals("Search must remain above the original profile page",2,activity.navigationHost().overlayCount());
            assertNotNull(field(activity,"profileStatsPage"));
        } finally {
            activity.navigationHost().close();
            ((java.util.concurrent.ExecutorService)field(activity,"io")).shutdownNow();
        }
    }

    private static void invoke(MainActivity activity, String name) throws Exception {
        Method method = MainActivity.class.getDeclaredMethod(name);
        method.setAccessible(true);
        method.invoke(activity);
    }

    private static Object field(MainActivity activity, String name) throws Exception {
        Field field = MainActivity.class.getDeclaredField(name);
        field.setAccessible(true);
        return field.get(activity);
    }

    private static String allText(View view) {
        StringBuilder out = new StringBuilder();
        appendText(view, out);
        return out.toString();
    }

    private static void appendText(View view, StringBuilder out) {
        if (view instanceof TextView text) out.append(text.getText()).append('\n');
        if (view instanceof ViewGroup group) {
            for (int i = 0; i < group.getChildCount(); i++) appendText(group.getChildAt(i), out);
        }
    }
}
