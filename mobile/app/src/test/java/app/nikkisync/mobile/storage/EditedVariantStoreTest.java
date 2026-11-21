package app.nikkisync.mobile.storage;

import static org.junit.Assert.*;

import android.content.Context;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;

@RunWith(RobolectricTestRunner.class)
public final class EditedVariantStoreTest {
    private Context context;
    private EditedVariantStore store;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        context.deleteDatabase("nikkisync-edited-variants.db");
        store = new EditedVariantStore(context);
    }

    @After public void tearDown() {
        store.close();
    }
    @Test public void upgradeRetainsExistingLinksAndChecksTheirSelectedUris(){
        store.close();context.deleteDatabase("nikkisync-edited-variants.db");
        var old=context.openOrCreateDatabase("nikkisync-edited-variants.db",0,null);
        old.execSQL("CREATE TABLE edited_variants (variant_id TEXT PRIMARY KEY,asset_id TEXT NOT NULL,uri TEXT NOT NULL UNIQUE,linked_at INTEGER NOT NULL,display_name TEXT,mime_type TEXT,source_saved_uri TEXT)");
        old.execSQL("INSERT INTO edited_variants VALUES ('old','a','content://old',1,NULL,NULL,'source')");
        old.setVersion(1);old.close();store=new EditedVariantStore(context);
        assertEquals("old",store.findByUri("content://old").variantId());
        assertEquals(EditedVariantStore.LinkStatus.DUPLICATE,store.linkSelected("a","source","content://copy","content://old",2,null,null).status());
        assertEquals(1,store.loadAll().size());
    }

    @Test public void oneAssetKeepsMultipleEditedVariantsInLinkOrder() {
        assertEquals(EditedVariantStore.LinkStatus.ADDED,
                store.link("asset-a", "content://original/a", "content://edit/1", 1000L, "one.jpg", "image/jpeg").status());
        assertEquals(EditedVariantStore.LinkStatus.ADDED,
                store.link("asset-a", "content://original/a", "content://edit/2", 2000L, "two.heic", "image/heic").status());

        var rows = store.loadForAsset("asset-a");
        assertEquals(2, rows.size());
        assertEquals("content://edit/2", rows.get(0).uri());
        assertEquals("content://edit/1", rows.get(1).uri());
    }

    @Test public void sameUriSameAssetIsIdempotentAndKeepsFirstLinkedAt() {
        store.link("asset-a", "content://original/a", "content://edit/1", 1000L, "one.jpg", "image/jpeg");
        var result = store.link("asset-a", "content://original/a", "content://edit/1", 9000L, "renamed.jpg", "image/jpeg");

        assertEquals(EditedVariantStore.LinkStatus.DUPLICATE, result.status());
        assertEquals(1000L, result.variant().linkedAt());
        assertEquals(1, store.loadForAsset("asset-a").size());
    }

    @Test public void sameUriCannotSilentlyMoveToAnotherAsset() {
        store.link("asset-a", "content://original/a", "content://edit/shared", 1000L, null, "image/jpeg");
        var result = store.link("asset-b", "content://original/b", "content://edit/shared", 2000L, null, "image/jpeg");

        assertEquals(EditedVariantStore.LinkStatus.CONFLICT, result.status());
        assertEquals("asset-a", result.conflictingAssetId());
        assertTrue(store.loadForAsset("asset-b").isEmpty());
    }

    @Test public void derivativeRetainsSelectedUriForDuplicateAndConflictChecks() {
        store.linkSelected("a","content://source","content://generated/1","content://picked/1",1000L,"edit.jpg","image/jpeg");
        assertEquals("content://generated/1",store.findByUri("content://picked/1").uri());
        assertEquals(EditedVariantStore.LinkStatus.DUPLICATE,store.linkSelected("a","source","content://generated/2","content://picked/1",2000L,null,null).status());
        assertEquals(EditedVariantStore.LinkStatus.CONFLICT,store.link("b","source","content://picked/1",2000L,null,null).status());
    }

    @Test public void unlinkRemovesOnlyRequestedAssociation() {
        var one = store.link("asset-a", "content://original/a", "content://edit/1", 1000L, null, "image/jpeg").variant();
        store.link("asset-a", "content://original/a", "content://edit/2", 2000L, null, "image/jpeg");

        assertTrue(store.unlink(one.variantId()));
        assertNull(store.findByUri("content://edit/1"));
        assertNotNull(store.findByUri("content://edit/2"));
    }
}
