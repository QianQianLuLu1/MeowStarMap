package app.nikkisync.mobile;

import android.view.*;
import android.widget.*;
import app.nikkisync.mobile.model.Models.AssetSummary;
import app.nikkisync.mobile.ui.chrome.ChromeHost;
import app.nikkisync.mobile.ui.SavedFilterSheet;
import java.lang.reflect.*;
import java.util.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk=35)
@org.robolectric.annotation.GraphicsMode(org.robolectric.annotation.GraphicsMode.Mode.NATIVE)
public class FilterPageLayoutTest {
    @Test public void searchAndFilterShareOneRowAndLeaveProgressRoomOnSmallPhones() throws Exception {
        MainActivity activity=activity();
        try {
            Button search=(Button)get(activity,"searchButton"),filter=(Button)get(activity,"galleryFilterButton");
            assertSame("search and filter must share a capsule row",search.getParent(),filter.getParent());
            View row=(View)search.getParent();
            for(int width:new int[]{320,360}){
                int pixels=dp(activity,width-36);row.measure(exact(pixels),exact(dp(activity,48)));row.layout(0,0,pixels,dp(activity,48));
                assertTrue(search.getWidth()>filter.getWidth());assertTrue(filter.getWidth()>=dp(activity,64));
                assertTrue(filter.getLeft()>=search.getRight());
                TextView count=(TextView)get(activity,"countLabel");count.setText("已同步 194 张 · 已缓存 194 张");
                View meta=(View)get(activity,"galleryMeta");meta.measure(exact(pixels),View.MeasureSpec.makeMeasureSpec(dp(activity,100),View.MeasureSpec.AT_MOST));meta.layout(0,0,pixels,meta.getMeasuredHeight());
                assertEquals(1,count.getLineCount());
            }
            Method tab=MainActivity.class.getDeclaredMethod("switchTab",int.class);tab.setAccessible(true);tab.invoke(activity,1);
            assertEquals(View.GONE,row.getVisibility());
        } finally {close(activity);}
    }

    @Test public void folderChoicesExpandInsideOneBottomDrawerWithSpacingAndDraftSelection() throws Exception {
        MainActivity activity=activity();
        try {
            String oldPath="D:\\OldGame\\X6Game\\Saved\\GamePlayPhotos\\1001";
            String newPath="D:\\NewGame\\X6Game\\Saved\\GamePlayPhotos\\1001";
            List<AssetSummary> assets=(List<AssetSummary>)get(activity,"assets");
            assets.add(photo("old",oldPath));assets.add(photo("new",newPath));
            call(activity,"showGalleryFilterSheet");View page=top(activity);
            assertFalse("filters should slide up instead of opening a page",page instanceof ChromeHost);
            View drawer=findType(page,SavedFilterSheet.class);assertNotNull(drawer);assertTrue("drawer leaves the gallery visible above",drawer.getHeight()<page.getHeight());
            renderProof(activity.navigationHost(),"filter-drawer");
            assertNull("native spinner popups must not cover the page",findType(page,Spinner.class));
            View folders=page.findViewWithTag("source-folder");assertNotNull(folders);folders.performClick();
            View picker=top(activity);assertSame(page,picker);assertEquals(1,activity.navigationHost().overlayCount());
            renderProof(activity.navigationHost(),"folder-drawer");
            assertNotNull(findText(picker,"OldGame"));assertNotNull(findText(picker,"NewGame"));
            View old=picker.findViewWithTag(oldPath);assertNotNull(old);
            View newer=picker.findViewWithTag(newPath);assertNotNull(newer);
            android.widget.ScrollView scroll=(android.widget.ScrollView)get(drawer,"scrolling");String geometry="source choices: scroll="+scroll.getScrollY()+", content="+scroll.getChildAt(0).getHeight()+", viewport="+scroll.getHeight();
            // The headless Activity's outer decor is unmeasured; compare the real navigation-local clips.
            android.graphics.Rect a=bounds(old,activity.navigationHost()),b=bounds(newer,activity.navigationHost()),clip=bounds(scroll,activity.navigationHost());
            clip.intersect(bounds((View)old.getParent().getParent(),activity.navigationHost()));
            assertTrue(geometry+", row="+a+", clip="+clip,android.graphics.Rect.intersects(a,clip));assertTrue(geometry+", row="+b+", clip="+clip,android.graphics.Rect.intersects(b,clip));
            assertTrue("folder cards need breathing room",Math.abs(a.top-b.top)>=Math.min(old.getHeight(),newer.getHeight())+dp(activity,8));
            assertTrue("long paths must wrap to the drawer width",old.getWidth()<=drawer.getWidth()-dp(activity,36));
            TextView path=findText(old,"OldGame");path.performClick();assertEquals(oldPath,path.getText().toString());path.performLongClick();
            var clipboard=(android.content.ClipboardManager)activity.getSystemService(android.content.Context.CLIPBOARD_SERVICE);assertEquals(oldPath,clipboard.getPrimaryClip().getItemAt(0).getText().toString());
            old.performClick();
            assertNull("choosing a source remains a draft",get(activity,"galleryFolder"));
            assertEquals(1,activity.navigationHost().overlayCount());
            findButton(top(activity),"应用").performClick();assertEquals(oldPath,get(activity,"galleryFolder"));
        } finally {close(activity);}
    }

    @Test public void versionFilterCombinesWithSourcesAndKeepsDraftUntilApply() throws Exception {
        MainActivity activity=activity();
        try {
            List<AssetSummary> assets=(List<AssetSummary>)get(activity,"assets");
            assets.add(versionPhoto("inferred","1001"," v2.11 ","inferred"));
            assets.add(versionPhoto("explicit","1002","2.11","explicit"));
            assets.add(versionPhoto("older","1001","2.9","explicit"));
            assets.add(versionPhoto("unknown","1001",null,null));
            call(activity,"showGalleryFilterSheet");
            View page=top(activity);
            Button apply=findButton(page,"应用");
            assertEquals(Gravity.CENTER,apply.getGravity());
            assertEquals(android.graphics.Color.WHITE,apply.getCurrentTextColor());
            assertTrue(apply.getBackground() instanceof android.graphics.drawable.RippleDrawable);
            assertTrue(apply.getHeight()>=dp(activity,48));
            var drawer=findType(page,SavedFilterSheet.class);
            var scroll=(ScrollView)get(drawer,"scrolling");
            assertTrue(bounds(scroll,activity.navigationHost()).contains(bounds(page.findViewWithTag("source-folder"),activity.navigationHost())));
            View versions=page.findViewWithTag("source-version");
            assertNotNull(versions);
            versions.performClick();
            assertNotNull(findText(top(activity),"2.11 版本 · 2 张"));
            renderProof(activity.navigationHost(),"version-drawer");
            top(activity).findViewWithTag("2.11").performClick();
            findButton(top(activity),"取消").performClick();
            assertEquals(4,filtered(activity).size());
            call(activity,"showGalleryFilterSheet");
            top(activity).findViewWithTag("source-version").performClick();
            top(activity).findViewWithTag("2.11").performClick();
            top(activity).findViewWithTag("source-uid").performClick();
            top(activity).findViewWithTag("1001").performClick();
            findButton(top(activity),"应用").performClick();
            assertEquals(List.of("inferred"),filtered(activity).stream().map(AssetSummary::assetId).toList());
            call(activity,"showGalleryFilterSheet");
            findButton(top(activity),"重置").performClick();
            top(activity).findViewWithTag("source-version").performClick();
            top(activity).findViewWithTag("__unknown__").performClick();
            findButton(top(activity),"应用").performClick();
            assertEquals(List.of("unknown"),filtered(activity).stream().map(AssetSummary::assetId).toList());
        } finally {close(activity);}
    }

    private static AssetSummary versionPhoto(String id,String uid,String version,String source){
        return new AssetSummary(id,"photo","ready","2026-10-27T01:00:00Z",uid,1,100,200,false,false,null,"r",version,source);
    }
    @SuppressWarnings("unchecked")
    private static List<AssetSummary> filtered(MainActivity activity)throws Exception{
        Method method=MainActivity.class.getDeclaredMethod("filteredGallery");
        method.setAccessible(true);
        return (List<AssetSummary>)method.invoke(activity);
    }

    private static AssetSummary photo(String id,String folder){return new AssetSummary(id,"photo","ready","2026-10-27T01:00:00Z","1001",1,100,200,false,false,null,"r",null,null).withSource(folder+"\\photo.jpeg",folder,123L);}
    private static MainActivity activity()throws Exception{MainActivity a=Robolectric.buildActivity(MainActivity.class).get();call(a,"buildUi");return a;}
    private static void close(MainActivity a)throws Exception{a.navigationHost().close();for(String name:new String[]{"io","organizerIo","organizerNetworkIo"})((java.util.concurrent.ExecutorService)get(a,name)).shutdownNow();}
    private static View top(MainActivity a){ViewGroup nav=a.navigationHost();for(int i=0;i<5;i++){nav.measure(exact(dp(a,360)),exact(dp(a,800)));nav.layout(0,0,dp(a,360),dp(a,800));globalLayout(nav);Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(250));}return nav.getChildAt(nav.getChildCount()-1);}
    // These manually built, unattached views have separate observers; a real ViewRoot dispatches the shared observer.
    private static void globalLayout(View view){view.getViewTreeObserver().dispatchOnGlobalLayout();if(view instanceof ViewGroup group)for(int i=0;i<group.getChildCount();i++)globalLayout(group.getChildAt(i));}
    private static void renderProof(View page,String name)throws Exception{var bitmap=android.graphics.Bitmap.createBitmap(page.getWidth(),page.getHeight(),android.graphics.Bitmap.Config.ARGB_8888);page.draw(new android.graphics.Canvas(bitmap));var directory=new java.io.File("build/reports/filter-ui");assertTrue(directory.isDirectory()||directory.mkdirs());try(var stream=new java.io.FileOutputStream(new java.io.File(directory,name+".png"))){assertTrue(bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,stream));}bitmap.recycle();}
    private static int exact(int n){return View.MeasureSpec.makeMeasureSpec(n,View.MeasureSpec.EXACTLY);}
    private static android.graphics.Rect bounds(View view,ViewGroup root){var rect=new android.graphics.Rect();view.getDrawingRect(rect);root.offsetDescendantRectToMyCoords(view,rect);return rect;}
    private static int dp(MainActivity a,int n){return Math.round(n*a.getResources().getDisplayMetrics().density);}
    private static Object get(Object o,String key)throws Exception{Field f=o.getClass().getDeclaredField(key);f.setAccessible(true);return f.get(o);}
    private static void call(Object o,String key)throws Exception{Method m=o.getClass().getDeclaredMethod(key);m.setAccessible(true);m.invoke(o);}
    private static View findType(View v,Class<?> type){if(type.isInstance(v))return v;if(v instanceof ViewGroup g)for(int i=0;i<g.getChildCount();i++){View found=findType(g.getChildAt(i),type);if(found!=null)return found;}return null;}
    private static TextView findText(View v,String text){if(v instanceof TextView t&&t.getText().toString().contains(text))return t;if(v instanceof ViewGroup g)for(int i=0;i<g.getChildCount();i++){TextView found=findText(g.getChildAt(i),text);if(found!=null)return found;}return null;}
    private static Button findButton(View v,String text){if(v instanceof Button b&&b.getText().toString().equals(text))return b;if(v instanceof ViewGroup g)for(int i=0;i<g.getChildCount();i++){Button found=findButton(g.getChildAt(i),text);if(found!=null)return found;}return null;}
}
