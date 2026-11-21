package app.nikkisync.mobile.inspiration;

import static org.junit.Assert.*;

import android.content.Context;
import java.util.List;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;

@RunWith(RobolectricTestRunner.class)
public final class InspirationStoreTest {
    private Context context;
    private InspirationStore store;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        context.deleteDatabase("nikkisync-inspiration.db");
        store = new InspirationStore(context);
    }

    @After public void tearDown() { store.close(); }

    @Test public void saveOfflineKeepsRawCodeSourceAndUserFieldsAfterReopen() {
        var draft = new InspirationStore.Draft("月光染色", "  dye-123  ", "dye",
                "原帖正文\n第二行", "https://example.com/post/1", "周末试试",
                List.of("蓝色", "优雅"), List.of("舞会"), "want");
        var saved = store.create(draft, 1000L);
        assertFalse(saved.id().isBlank());
        store.close();
        store = new InspirationStore(context);
        var loaded = store.get(saved.id());
        assertEquals("  dye-123  ", loaded.code().rawCode());
        assertEquals("原帖正文\n第二行", loaded.code().sourceText());
        assertEquals("https://example.com/post/1", loaded.code().sourceUrl());
        assertEquals("周末试试", loaded.notes());
        assertEquals(List.of("蓝色", "优雅"), loaded.tags());
        assertEquals(List.of("舞会"), loaded.categories());
        assertEquals("pending", loaded.code().parsedState());
    }

    @Test public void editingUserFieldsNeverRewritesTheOriginalSharedTextOrCode() {
        var saved = store.create(new InspirationStore.Draft("标题", "code-1", "outfit",
                "原文", null, "旧备注", List.of("A"), List.of("旧分类"), "want"), 1000L);
        store.updateUserFields(saved.id(), "新标题", "我自己的备注", List.of("B"),
                List.of("新分类"), "tried", 2000L);
        var edited = store.get(saved.id());
        assertEquals("新标题", edited.title());
        assertEquals("我自己的备注", edited.notes());
        assertEquals(List.of("B"), edited.tags());
        assertEquals("tried", edited.status());
        assertEquals("原文", edited.code().sourceText());
        assertEquals("code-1", edited.code().rawCode());
        assertEquals(2000L, edited.updatedAt());
    }

    @Test public void offlineSearchFindsCodeTagsAndSourceWithoutPc() {
        store.create(new InspirationStore.Draft("晴天", "ABCD", "outfit", "小红书分享", null,
                "", List.of("粉色"), List.of("日常"), "want"), 1L);
        store.create(new InspirationStore.Draft("夜色", "EFGH", "dye", "朋友分享", null,
                "", List.of("蓝色"), List.of("舞会"), "tried"), 2L);
        assertEquals(1, store.search("EFGH", null, null).size());
        assertEquals(1, store.search("蓝色", null, null).size());
        assertEquals(1, store.search("朋友", "tried", "舞会").size());
        assertTrue(store.search("朋友", "want", null).isEmpty());
        assertTrue(store.search("null", null, null).isEmpty());
    }

    @Test public void deletionIsATombstoneForFuturePrivateBackup() {
        var saved = store.create(new InspirationStore.Draft("标题", "x", "unknown", "原文", null,
                "", List.of(), List.of(), "want"), 1000L);
        store.delete(saved.id(), 3000L);
        assertTrue(store.search("", null, null).isEmpty());
        assertNull(store.get(saved.id()));
        assertEquals(saved.id(), store.changesAfter(2000L).get(0).id());
        assertEquals(3000L, store.changesAfter(2000L).get(0).deletedAt());
    }

    @Test public void parserSnapshotIsSeparateFromEditableNote() {
        var saved = store.create(new InspirationStore.Draft("我的标题", "raw", "outfit", "原文", null,
                "我的备注", List.of("自定义"), List.of(), "want"), 1000L);
        store.recordParseResult(saved.code().id(), "success", "{\"clothingIds\":[\"1020100111\"]}",
                "resolver-v1", "dict-v1", 2000L);
        var parsed = store.get(saved.id());
        assertEquals("我的标题", parsed.title());
        assertEquals("我的备注", parsed.notes());
        assertEquals(List.of("自定义"), parsed.tags());
        assertEquals("raw", parsed.code().rawCode());
        assertEquals("success", parsed.code().parsedState());
        assertEquals("dict-v1", parsed.code().dictionaryVersion());
        store.recordParseResult(saved.code().id(), "failed", null, null, null, 1500L);
        var failed = store.get(saved.id());
        assertEquals("failed", failed.code().parsedState());
        assertEquals("dict-v1", failed.code().dictionaryVersion());
        assertTrue(failed.updatedAt() > parsed.updatedAt());
    }

    @Test public void screenshotOnlyInspirationCanWaitForACodeLater() {
        var saved = store.create(new InspirationStore.Draft("只有码", "code", "outfit", "", null,
                "", List.of(), List.of(), "want"), 1000L);
        store.updateCode(saved.id(), "", "unknown", 2000L);
        assertEquals("", store.get(saved.id()).code().rawCode());
        var imageOnly = store.create(new InspirationStore.Draft("截图待整理", "", "unknown", "", null,
                "之后找码", List.of(), List.of("截图"), "want"), 3000L);
        assertEquals("pending", imageOnly.code().parsedState());
        assertEquals("截图待整理", imageOnly.title());
    }

    @Test public void titlelessCodeAndSelfMadeStatusSurviveReopen() {
        var entry=store.create(new InspirationStore.Draft("","CODE","outfit","",null,"",List.of(),List.of("日常"),"self"),1);
        store.close();store=new InspirationStore(context);
        assertEquals("",store.get(entry.id()).title());assertEquals("self",store.get(entry.id()).status());
    }

    @Test public void removingOneReferenceOnlyUnlinksThatEntryImage() {
        var first=store.create(new InspirationStore.Draft("","a","dye","",null,"",List.of(),List.of(),"self"),1);
        var second=store.create(new InspirationStore.Draft("","b","dye","",null,"",List.of(),List.of(),"want"),1);
        store.attachImage(first.id(),"11111111-1111-1111-1111-111111111111.jpg","image/jpeg",12,2);
        store.attachImage(second.id(),"22222222-2222-2222-2222-222222222222.jpg","image/jpeg",12,2);
        var image=store.get(first.id()).images().get(0);
        assertFalse(store.detachImage(second.id(),image.id(),3));
        assertTrue(store.detachImage(first.id(),image.id(),4));
        assertTrue(store.get(first.id()).images().isEmpty());assertEquals(1,store.get(second.id()).images().size());
        assertTrue(store.get(first.id()).updatedAt()>first.updatedAt());
    }

    @Test public void imageAndFieldEditsRollbackTogetherIfAnAttachmentFails() {
        var entry=store.create(new InspirationStore.Draft("标题","old","dye","原文",null,"备注",List.of(),List.of("旧"),"want"),1);
        store.attachImage(entry.id(),"11111111-1111-1111-1111-111111111111.jpg","image/jpeg",12,2);
        var current=store.get(entry.id());var image=current.images().get(0);
        var draft=new InspirationStore.Draft("标题","new","dye","原文",null,"备注",List.of(),List.of("新"),"self");
        assertThrows(IllegalArgumentException.class,()->store.saveWithImages(current,draft,List.of(new InspirationImageStore.Saved("invalid.jpg","image/jpeg",12)),List.of(image.id()),3));
        var after=store.get(entry.id());assertEquals("old",after.code().rawCode());assertEquals(List.of("旧"),after.categories());
        assertEquals("want",after.status());assertEquals(1,after.images().size());
    }

    @Test public void classificationChoicesReuseLiveRecordsWithoutDuplicateOrDeletedCategories() {
        var first=store.create(new InspirationStore.Draft("","a","outfit","",null,"",List.of(),List.of("日常","舞会"),"want"),1);
        var second=store.create(new InspirationStore.Draft("","b","dye","",null,"",List.of(),List.of("日常","已删分类"),"self"),2);
        assertEquals(3,store.categoryNames().size());store.delete(second.id(),3);
        assertEquals(List.of("日常","舞会"),store.categoryNames());
    }
}
