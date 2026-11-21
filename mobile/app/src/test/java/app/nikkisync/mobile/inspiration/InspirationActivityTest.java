package app.nikkisync.mobile.inspiration;

import static org.junit.Assert.*;

import android.view.View;
import android.view.ViewGroup;
import android.content.Intent;
import android.os.Looper;
import android.widget.TextView;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import android.widget.EditText;
import app.nikkisync.mobile.ui.chrome.ChromeSheetLayout;

@RunWith(RobolectricTestRunner.class)
public final class InspirationActivityTest {
    @org.junit.Before public void acceptPrivacyForExistingEditorTests(){new app.nikkisync.mobile.privacy.PrivacyConsentStore(org.robolectric.RuntimeEnvironment.getApplication()).accept();}
    @Test public void customCategoryHasCompactHeightAndAVisibleEditableField() throws Exception {
        var controller=Robolectric.buildActivity(InspirationActivity.class).setup();
        try {
            var activity=controller.get();showEditor(activity,null);
            findText((View)field(activity,"activeEditor"),"＋ 新增分类").performClick();
            var nav=activity.navigationHost();View layer=nav.getChildAt(nav.getChildCount()-1);
            nav.measure(View.MeasureSpec.makeMeasureSpec(900,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(2400,View.MeasureSpec.EXACTLY));nav.layout(0,0,900,2400);
            EditText name=input(layer);assertNotNull(name);assertTrue("single name must not consume 400dp",name.getHeight()<100*activity.getResources().getDisplayMetrics().density);
            assertNotNull("input needs a visible border/material",name.getBackground());
            assertEquals(activity.getColor(app.nikkisync.mobile.R.color.text_primary),name.getCurrentTextColor());
            name.setText("拍照");findText(layer,"添加").performClick();nav.interrupt();
            assertTrue(containsText((View)field(activity,"activeEditor"),"拍照"));
        } finally {controller.pause().stop().destroy();}
    }
    @Test public void notebookOpensOfflineWithoutPairingOrGalleryState() {
        var controller = Robolectric.buildActivity(InspirationActivity.class).setup();
        try {
            assertTrue(containsText(controller.get().getWindow().getDecorView(), "穿搭灵感库"));
            assertTrue(containsText(controller.get().getWindow().getDecorView(), "记录新的灵感"));
        } finally { controller.pause().stop().destroy(); }
    }

    @Test public void androidShareOpensAnEditableDraftWithOriginalText() throws Exception {
        Intent share = new Intent(Intent.ACTION_SEND).setType("text/plain")
                .putExtra(Intent.EXTRA_TEXT, "  OUTFIT-123  ");
        var controller = Robolectric.buildActivity(InspirationActivity.class, share).setup();
        try {
            Shadows.shadowOf(Looper.getMainLooper()).idle();
            Object editor=field(controller.get(),"activeEditor");
            assertTrue("Editor must use the current GPU glass sheet",editor instanceof ChromeSheetLayout);
            assertTrue(containsText((View)editor,"  OUTFIT-123  "));
        } finally { controller.pause().stop().destroy(); }
    }

    @Test public void newEditorOffersReferenceImagesAndSavesWithoutTitle() throws Exception {
        var controller=Robolectric.buildActivity(InspirationActivity.class).setup();
        try {
            var activity=controller.get();showEditor(activity,null);
            Object editor=field(activity,"activeEditor");assertTrue(editor instanceof ChromeSheetLayout);
            View form=(View)editor;
            assertTrue(containsText(form,"填入染色码 / 搭配码"));
            assertTrue(containsText(form,"选择分类"));assertTrue(containsText(form,"选择状态"));
            assertFalse(containsText(form,"来源原文"));assertTrue(containsText(form,"添加参考图"));
            assertNotNull(findText(form,"粘贴"));
            assertEquals(1,countInputs(form));
            input(form).setText("  CODE-123  ");findText(form,"自搭").performClick();findText(form,"保存").performClick();
            settle(activity);
            var entries=((InspirationStore)field(activity,"store")).search("CODE-123",null,null);
            assertEquals(1,entries.size());assertEquals("",entries.get(0).title());
            assertEquals("self",entries.get(0).status());assertEquals("  CODE-123  ",entries.get(0).code().rawCode());
        }finally {controller.pause().stop().destroy();}
    }

    @Test public void pasteRecognizesOneCodeKeepsOriginalAndAsksBeforeChoosingMultiple() throws Exception {
        var controller=Robolectric.buildActivity(InspirationActivity.class).setup();
        try {
            var activity=controller.get();showEditor(activity,null);View editor=(View)field(activity,"activeEditor");
            var clipboard=(android.content.ClipboardManager)activity.getSystemService(android.content.Context.CLIPBOARD_SERVICE);
            clipboard.setPrimaryClip(android.content.ClipData.newPlainText("分享", "染色：1wP🌸Xw中KyiXS4#"));
            findText(editor,"粘贴").performClick();
            assertEquals("1wPXwKyiXS4#",input(editor).getText().toString());
            assertTrue(containsText(editor,"请核对"));
            findText(editor,"恢复粘贴原文").performClick();
            assertEquals("染色：1wP🌸Xw中KyiXS4#",input(editor).getText().toString());
            clipboard.setPrimaryClip(android.content.ClipData.newPlainText("分享", "1wPXwKyiXS4# 1aIusYmEei6#"));
            findText(editor,"粘贴").performClick();
            assertTrue(containsText(editor,"请选择"));
            assertNotNull(findText(editor,"1aIusYmEei6#"));
            findText(editor,"1aIusYmEei6#").performClick();
            assertEquals("1aIusYmEei6#",input(editor).getText().toString());
        }finally {controller.pause().stop().destroy();}
    }

    @Test public void pickedReferenceIsCopiedAndItsRemovalIsCommittedOnlyOnSave() throws Exception {
        var source=java.nio.file.Files.createTempFile("inspiration-test-", ".png");
        byte[] bytes=java.util.Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAABQAAAAeCAIAAACjcKk8AAAAHklEQVR4nGMockohGzGMah7VPKp5VPOo5lHNw1kzAEYskF8kUse2AAAAAElFTkSuQmCC");
        java.nio.file.Files.write(source,bytes);
        var provider=new ReferenceProvider(source.toFile());var providerInfo=new android.content.pm.ProviderInfo();providerInfo.authority="reference.test";providerInfo.exported=true;
        provider.attachInfo(org.robolectric.RuntimeEnvironment.getApplication(),providerInfo);
        org.robolectric.shadows.ShadowContentResolver.registerProviderInternal("reference.test",provider);
        var controller=Robolectric.buildActivity(InspirationActivity.class).setup();
        try {
            var activity=controller.get();showEditor(activity,null);View sheet=(View)field(activity,"activeEditor");
            assertNotNull(findText(sheet,"＋ 添加参考图"));input(sheet).setText("1wPXwKyiXS4#");
            Field pageField=InspirationActivity.class.getDeclaredField("page");pageField.setAccessible(true);
            InspirationPage page=(InspirationPage)pageField.get(activity);
            page.receiveReferenceImages(List.of(android.net.Uri.parse("content://reference.test/image/1")));
            assertTrue(containsText(sheet,"已选 1 张"));findText(sheet,"保存").performClick();settle(activity);activity.navigationHost().interrupt();
            var store=(InspirationStore)field(activity,"store");var entry=store.search("1wPXwKyiXS4#",null,null).get(0);
            assertEquals(1,entry.images().size());
            var images=(InspirationImageStore)field(activity,"imageStore");var privateFile=images.resolve(entry.images().get(0).localName());
            assertArrayEquals(bytes,java.nio.file.Files.readAllBytes(privateFile.toPath()));
            settle(activity);settle(activity);
            View cover=findDescription(activity.getWindow().getDecorView(),"查看穿搭参考图");
            assertTrue(cover instanceof android.widget.ImageView);assertNotNull(((android.widget.ImageView)cover).getDrawable());
            showEditor(activity,entry);sheet=(View)field(activity,"activeEditor");findText(sheet,"移除").performClick();
            findText(sheet,"取消").performClick();activity.navigationHost().interrupt();assertEquals(1,store.get(entry.id()).images().size());assertTrue(privateFile.exists());
            var bad=new ReferenceProvider(new java.io.File(source.toString()+".missing"));var badInfo=new android.content.pm.ProviderInfo();badInfo.authority="reference.bad";badInfo.exported=true;
            bad.attachInfo(activity,badInfo);org.robolectric.shadows.ShadowContentResolver.registerProviderInternal("reference.bad",bad);
            showEditor(activity,store.get(entry.id()));sheet=(View)field(activity,"activeEditor");findText(sheet,"移除").performClick();
            page.receiveReferenceImages(List.of(android.net.Uri.parse("content://reference.bad/image/1")));findText(sheet,"保存").performClick();settle(activity);
            assertEquals("a failed replacement must not discard the old reference",1,store.get(entry.id()).images().size());assertTrue(privateFile.exists());
            assertNotNull(field(activity,"activeEditor"));findText(sheet,"取消").performClick();activity.navigationHost().interrupt();
            showEditor(activity,store.get(entry.id()));sheet=(View)field(activity,"activeEditor");findText(sheet,"移除").performClick();
            findText(sheet,"保存").performClick();settle(activity);assertTrue(store.get(entry.id()).images().isEmpty());assertFalse(privateFile.exists());
            assertArrayEquals(bytes,java.nio.file.Files.readAllBytes(source));
        } finally {controller.pause().stop().destroy();java.nio.file.Files.deleteIfExists(source);}
    }

    @Test public void referenceButtonLaunchesTheSystemImagePicker() throws Exception {
        var controller=Robolectric.buildActivity(InspirationActivity.class).setup();
        try {
            var activity=controller.get();showEditor(activity,null);
            findText((View)field(activity,"activeEditor"),"＋ 添加参考图").performClick();
            var launched=Shadows.shadowOf(activity).getNextStartedActivityForResult();
            assertNotNull(launched);assertTrue(launched.intent.getType().startsWith("image/"));
        } finally {controller.pause().stop().destroy();}
    }

    private static final class ReferenceProvider extends android.content.ContentProvider {
        private final java.io.File file;
        ReferenceProvider(java.io.File file){this.file=file;}
        @Override public boolean onCreate(){return true;}
        @Override public String getType(android.net.Uri uri){return "image/png";}
        @Override public android.os.ParcelFileDescriptor openFile(android.net.Uri uri,String mode)throws java.io.FileNotFoundException{return android.os.ParcelFileDescriptor.open(file,android.os.ParcelFileDescriptor.MODE_READ_ONLY);}
        @Override public android.database.Cursor query(android.net.Uri u,String[] p,String s,String[] a,String o){return null;}
        @Override public android.net.Uri insert(android.net.Uri u,android.content.ContentValues v){return null;}
        @Override public int delete(android.net.Uri u,String s,String[] a){return 0;}
        @Override public int update(android.net.Uri u,android.content.ContentValues v,String s,String[] a){return 0;}
    }

    @Test public void simplifiedEditingPreservesHiddenUserFieldsAndParsedSnapshot() throws Exception {
        var controller=Robolectric.buildActivity(InspirationActivity.class).setup();
        try {
            var activity=controller.get();var store=(InspirationStore)field(activity,"store");
            var entry=store.create(new InspirationStore.Draft("旧标题","CODE-OLD","dye","原分享正文","https://example.com/p",
                    "旧备注",List.of("旧标签"),List.of("旧分类"),"tried"),1);
            store.recordParseResult(entry.code().id(),"success","{\"clothingIds\":[\"1\"]}","r1","d1",2);
            showEditor(activity,store.get(entry.id()));View editor=(View)field(activity,"activeEditor");
            findText(editor,"已复刻").performClick();findText(editor,"保存").performClick();settle(activity);
            var saved=store.get(entry.id());assertEquals("旧标题",saved.title());assertEquals("旧备注",saved.notes());
            assertEquals(List.of("旧标签"),saved.tags());assertEquals(List.of("旧分类"),saved.categories());
            assertEquals("原分享正文",saved.code().sourceText());assertEquals("https://example.com/p",saved.code().sourceUrl());
            assertEquals("success",saved.code().parsedState());assertEquals("reproduced",saved.status());
        }finally {controller.pause().stop().destroy();}
    }

    @Test public void glassEditorCancelAndPredictiveBackDoNotSaveAnUnconfirmedCode() throws Exception {
        var controller=Robolectric.buildActivity(InspirationActivity.class).setup();
        try {
            var activity=controller.get();showEditor(activity,null);input((View)field(activity,"activeEditor")).setText("UNSAVED-CODE");
            activity.navigationHost().progress(.5f);activity.navigationHost().cancel();activity.navigationHost().interrupt();
            assertNotNull(field(activity,"activeEditor"));assertEquals(2,activity.navigationHost().overlayCount());
            activity.navigationHost().commit();activity.navigationHost().interrupt();
            assertNull(field(activity,"activeEditor"));assertEquals(1,activity.navigationHost().overlayCount());
            assertTrue(((InspirationStore)field(activity,"store")).search("UNSAVED-CODE",null,null).isEmpty());
        }finally {controller.pause().stop().destroy();}
    }

    @Test public void changingOnlyCategoriesKeepsSnapshotButCorrectingCodeInvalidatesIt() throws Exception {
        var controller=Robolectric.buildActivity(InspirationActivity.class).setup();
        try {
            var activity=controller.get();var store=(InspirationStore)field(activity,"store");
            var entry=store.create(new InspirationStore.Draft("","DYE-OLD","dye","原文",null,"",List.of(),List.of("日常"),"want"),1);
            store.recordParseResult(entry.code().id(),"success","{\"clothingIds\":[\"1\"]}","r1","d1",2);
            showEditor(activity,store.get(entry.id()));View sheet=(View)field(activity,"activeEditor");
            findText(sheet,"日常").performClick();findText(sheet,"保存").performClick();settle(activity);activity.navigationHost().interrupt();
            assertEquals(List.of(),store.get(entry.id()).categories());assertEquals("success",store.get(entry.id()).code().parsedState());
            showEditor(activity,store.get(entry.id()));sheet=(View)field(activity,"activeEditor");
            input(sheet).setText("DYE-NEW");findText(sheet,"保存").performClick();settle(activity);
            assertEquals("DYE-NEW",store.get(entry.id()).code().rawCode());assertEquals("pending",store.get(entry.id()).code().parsedState());
            assertNull(store.get(entry.id()).code().snapshotJson());assertEquals("原文",store.get(entry.id()).code().sourceText());
        }finally {controller.pause().stop().destroy();}
    }

    private static Object field(InspirationActivity activity,String name) throws Exception {
        Field page=InspirationActivity.class.getDeclaredField("page");page.setAccessible(true);
        Field f=InspirationPage.class.getDeclaredField(name);f.setAccessible(true);return f.get(page.get(activity));
    }
    private static void showEditor(InspirationActivity activity,InspirationStore.Entry entry) throws Exception {
        Field page=InspirationActivity.class.getDeclaredField("page");page.setAccessible(true);
        Method m=InspirationPage.class.getDeclaredMethod("showEditor",InspirationStore.Entry.class,InspirationShareImport.Incoming.class);
        m.setAccessible(true);m.invoke(page.get(activity),entry,null);
    }
    private static void settle(InspirationActivity activity) throws Exception {
        ((ExecutorService)field(activity,"io")).submit(()->{}).get(10,TimeUnit.SECONDS);
        Shadows.shadowOf(Looper.getMainLooper()).idle();
    }
    private static int countInputs(View view) {
        int count=view instanceof EditText?1:0;
        if(view instanceof ViewGroup group)for(int i=0;i<group.getChildCount();i++)count+=countInputs(group.getChildAt(i));
        return count;
    }
    private static EditText input(View view) {
        if(view instanceof EditText edit)return edit;
        if(view instanceof ViewGroup group)for(int i=0;i<group.getChildCount();i++){EditText found=input(group.getChildAt(i));if(found!=null)return found;}
        return null;
    }
    private static View findText(View view,String value) {
        if(view instanceof TextView text&&value.equals(text.getText().toString()))return view;
        if(view instanceof ViewGroup group)for(int i=0;i<group.getChildCount();i++){View found=findText(group.getChildAt(i),value);if(found!=null)return found;}
        return null;
    }
    private static View findDescription(View view,String value) {
        if(value.contentEquals(view.getContentDescription()==null?"":view.getContentDescription()))return view;
        if(view instanceof ViewGroup group)for(int i=0;i<group.getChildCount();i++){View found=findDescription(group.getChildAt(i),value);if(found!=null)return found;}
        return null;
    }

    private static boolean containsText(View view, String expected) {
        if (view instanceof TextView text && text.getText().toString().contains(expected)) return true;
        if (view instanceof ViewGroup group) for (int i = 0; i < group.getChildCount(); i++)
            if (containsText(group.getChildAt(i), expected)) return true;
        return false;
    }
}
