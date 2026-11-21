package app.nikkisync.mobile.storage;

import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
public class StylistProfileStoreTest {
    @Before public void clear() {RuntimeEnvironment.getApplication().getSharedPreferences("nikkisync.stylists",0).edit().clear().commit();}
    @Test public void manualNamesPersistPerUidAndTakePriorityOverMetadata() {
        var store=new StylistProfileStore(RuntimeEnvironment.getApplication());
        store.rememberMetadata("{\"identity\":{\"uid\":\"12345\",\"nickname\":\"暖暖\"}}");
        assertEquals("暖暖",store.nickname("12345"));
        store.setManualNickname("12345","  搭配师小暖  ");
        store.rememberMetadata("{\"identity\":{\"uid\":\"12345\",\"nickname\":\"新昵称\"}}");
        assertEquals("搭配师小暖",new StylistProfileStore(RuntimeEnvironment.getApplication()).nickname("12345"));
        assertEquals("",store.nickname("67890"));
        store.setManualNickname("12345","");assertEquals("新昵称",store.nickname("12345"));
    }
    @Test public void absentOrUnrelatedNamesAreNotGuessedFromOutfitOrRawData() {
        var store=new StylistProfileStore(RuntimeEnvironment.getApplication());
        store.rememberMetadata("{\"identity\":{\"uid\":\"12345\"},\"raw\":{\"name\":\"衣服名\"}}");
        store.rememberMetadata("{\"identity\":{\"nickname\":\"无身份昵称\"}}");
        store.rememberMetadata("not json");
        assertEquals("",store.nickname("12345"));assertEquals("",store.nickname(""));
        store.rememberMetadata("{\"identity\":{\"uid\":\"67890\",\"nickname\":\"另一位搭配师\"}}");
        assertEquals("",store.nickname("12345"));assertEquals("另一位搭配师",store.nickname("67890"));
    }
}
