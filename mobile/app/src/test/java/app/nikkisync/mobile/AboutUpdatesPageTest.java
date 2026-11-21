package app.nikkisync.mobile;

import static org.junit.Assert.*;

import android.content.Intent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.TextView;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class AboutUpdatesPageTest {
    @Test public void settingsOpensOfflineConnectionAndMetadataSelfCheck() throws Exception {
        MainActivity activity=activity();
        try {
            Button entry=button((View)field(activity,"settingsContent"),"查看自查结果");
            assertNotNull(entry);entry.performClick();
            View page=(View)field(activity,"troubleshootingPage");
            assertNotNull(page);
            String copy=allText(page);
            assertTrue(copy.contains("尚未配对电脑"));
            assertTrue(copy.contains("GamePlayPhotos"));
            assertNotNull(button(page,"扫码配对"));
            assertNull(Shadows.shadowOf(activity).getNextStartedActivity());
        }finally{close(activity);}
    }
    @Test public void settingsOpensDiagnosticExportWithoutRequiringNetwork() throws Exception {
        MainActivity activity=activity();
        try {
            var entry=button((View)field(activity,"settingsContent"),"诊断与反馈");
            assertNotNull(entry);entry.performClick();
            View page=(View)field(activity,"supportPage");
            assertNotNull(button(page,"导出日志"));
            assertTrue(button(page,"导出日志").isEnabled());
            assertNull(Shadows.shadowOf(activity).getNextStartedActivity());
        }finally{close(activity);}
    }

    @Test public void settingsOpensOfflineAboutWithInstalledVersionAuthorAndAvatar() throws Exception {
        MainActivity activity = activity();
        try {
            View settings = (View) field(activity, "settingsContent");
            Button about = button(settings, "关于&更新");
            assertNotNull("Settings must expose About & Updates", about);
            about.performClick();
            View content = (View) field(activity, "aboutContent");
            assertTrue(allText(content).contains(BuildConfig.VERSION_NAME));
            assertTrue(allText(content).contains("构建号 " + BuildConfig.VERSION_CODE));
            assertTrue(allText(content).contains("星尘（支持粉毛拯救世界版）"));
            assertTrue(allText(content).contains("https://github.com/ToStardust/NikkiSync/releases"));
            assertTrue(allText(content).contains("https://github.com/QianQianLuLu1/NikkiGallery"));
            assertTrue(allText(content).contains("RanAxro · Nikki Albums"));
            assertTrue(allText(content).contains("https://github.com/QianQianLuLu1/MeowStarMap"));
            assertTrue(allText(content).contains("NUAN5.PRO"));
            assertTrue(allText(content).contains("暖暖共鸣录"));
            assertNotNull(button(content, "检查更新"));
            assertNotNull(button(content, "开启更新提醒"));
            ImageView avatar = avatar(content);
            assertNotNull(avatar);
            assertNotNull(avatar.getDrawable());
            assertEquals("星尘的头像", avatar.getContentDescription());
            assertNull("Opening About must not start a browser automatically", Shadows.shadowOf(activity).getNextStartedActivity());
        } finally { close(activity); }
    }

    @Test public void updateButtonOpensReleaseListIncludingTestVersions() throws Exception {
        MainActivity activity = activity();
        try {
            Button about = button((View) field(activity, "settingsContent"), "关于&更新");
            assertNotNull(about); about.performClick();
            button((View) field(activity, "aboutContent"), "打开百度网盘").performClick();
            Intent download = Shadows.shadowOf(activity).getNextStartedActivity();
            assertEquals(Intent.ACTION_VIEW, download.getAction());
            assertEquals("https://pan.baidu.com/s/5bb_o2A8iJ2MR4f_hRBlPCw", download.getDataString());
            button((View) field(activity, "aboutContent"), "查看更新").performClick();
            Intent intent = Shadows.shadowOf(activity).getNextStartedActivity();
            assertNotNull(intent);
            assertEquals(Intent.ACTION_VIEW, intent.getAction());
            assertEquals("https://github.com/ToStardust/NikkiSync/releases", intent.getDataString());
            button((View) field(activity, "aboutContent"), "GitHub 项目").performClick();
            assertEquals("https://github.com/ToStardust/NikkiSync", Shadows.shadowOf(activity).getNextStartedActivity().getDataString());
            button((View) field(activity, "aboutContent"), "NikkiGallery 仓库").performClick();
            assertEquals("https://github.com/QianQianLuLu1/NikkiGallery", Shadows.shadowOf(activity).getNextStartedActivity().getDataString());
        } finally { close(activity); }
    }

    @Test public void predictiveBackCancelsOrReturnsToSettingsAndAllowsReopening() throws Exception {
        MainActivity activity = activity();
        try {
            Button about = button((View) field(activity, "settingsContent"), "关于&更新");
            assertNotNull(about); about.performClick(); about.performClick();
            assertEquals(2, activity.navigationHost().overlayCount());
            View first = (View) field(activity, "aboutPage");
            activity.navigationHost().progress(.5f);
            activity.navigationHost().cancel(); activity.navigationHost().interrupt();
            assertSame(first, field(activity, "aboutPage"));
            assertEquals(2, activity.navigationHost().overlayCount());
            activity.navigationHost().progress(.8f);
            activity.navigationHost().commit(); activity.navigationHost().interrupt();
            assertEquals(1, activity.navigationHost().overlayCount());
            assertNull(field(activity, "aboutPage")); assertNull(field(activity, "aboutContent"));
            assertNotNull(field(activity, "settingsContent"));
            about.performClick();
            assertNotSame(first, field(activity, "aboutPage"));
            button((View) field(activity, "aboutPage"), "返回").performClick();
            activity.navigationHost().interrupt();
            assertEquals(1, activity.navigationHost().overlayCount());
            assertNull(field(activity, "aboutPage"));
        } finally { close(activity); }
    }

    private static MainActivity activity() throws Exception {
        MainActivity activity = Robolectric.buildActivity(MainActivity.class).get();
        invoke(activity, "buildUi"); invoke(activity, "showSettings"); return activity;
    }
    private static void close(MainActivity activity) throws Exception {
        activity.navigationHost().close();
        ((java.util.concurrent.ExecutorService) field(activity, "io")).shutdownNow();
        ((java.util.concurrent.ExecutorService) field(activity, "shareWorker")).shutdownNow();
    }
    private static void invoke(MainActivity activity, String name) throws Exception {
        Method method = MainActivity.class.getDeclaredMethod(name); method.setAccessible(true); method.invoke(activity);
    }
    private static Object field(MainActivity activity, String name) throws Exception {
        Field field = MainActivity.class.getDeclaredField(name); field.setAccessible(true); return field.get(activity);
    }
    private static Button button(View view, String text) {
        if (view instanceof Button button && text.equals(button.getText().toString())) return button;
        if (view instanceof ViewGroup group) for (int i=0; i<group.getChildCount(); i++) {
            Button result=button(group.getChildAt(i), text); if(result!=null)return result;
        }
        return null;
    }
    private static ImageView avatar(View view) {
        if(view instanceof ImageView image && "星尘的头像".contentEquals(image.getContentDescription())) return image;
        if(view instanceof ViewGroup group) for(int i=0;i<group.getChildCount();i++) {
            ImageView result=avatar(group.getChildAt(i)); if(result!=null)return result;
        }
        return null;
    }
    private static String allText(View view) {
        StringBuilder text=new StringBuilder();
        if(view instanceof TextView label)text.append(label.getText()).append('\n');
        if(view instanceof ViewGroup group)for(int i=0;i<group.getChildCount();i++)text.append(allText(group.getChildAt(i)));
        return text.toString();
    }
}
