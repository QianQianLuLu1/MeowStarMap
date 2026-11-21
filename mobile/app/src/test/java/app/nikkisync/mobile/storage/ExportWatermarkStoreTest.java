package app.nikkisync.mobile.storage;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
public class ExportWatermarkStoreTest {
    @Before public void clear(){for(String name:new String[]{"nikkisync.stylists","nikkisync.watermarks"})
        RuntimeEnvironment.getApplication().getSharedPreferences(name,0).edit().clear().commit();}
    @Test public void defaultProfilePersistsAndUncustomizedWatermarksFollowItsName(){
        var context=RuntimeEnvironment.getApplication();var profiles=new StylistProfileStore(context);
        profiles.setManualNickname("12345","晚星");profiles.setDefaultUid("12345");
        var settings=new ExportWatermarkStore(context);
        assertTrue(settings.shareEnabled());assertTrue(settings.exifEnabled());
        assertEquals("晚星的大喵相机",settings.shareBranding(null).title());
        assertEquals("UID：12345 MomoCamera",settings.shareBranding(null).footer());
        assertEquals("MomoCamera",settings.exifCameraName(null));
        profiles.setManualNickname("12345","月亮");
        assertEquals("月亮的大喵相机",new ExportWatermarkStore(context).shareBranding(null).title());
        assertEquals("12345",new StylistProfileStore(context).defaultUid());
    }
    @Test public void shareAndExifSettingsAreIndependentAndDisabledShareNeverRevealsIdentity(){
        var context=RuntimeEnvironment.getApplication();var profiles=new StylistProfileStore(context);
        profiles.setManualNickname("12345","晚星");profiles.setDefaultUid("12345");
        var settings=new ExportWatermarkStore(context);
        settings.setShareText("私人标题","UID 私人文字");settings.setExifText("自定义相机");
        assertEquals("私人标题",settings.shareBranding(null).title());assertEquals("MomoCamera",settings.exifCameraName(null));
        settings.setShareEnabled(false);
        assertEquals("大喵相机",settings.shareBranding(null).title());assertEquals("MomoCamera",settings.shareBranding(null).footer());
        assertEquals("MomoCamera",settings.exifCameraName(null));
        settings.setExifEnabled(false);assertEquals("MomoCamera",settings.exifCameraName(null));
        settings.setShareEnabled(true);assertEquals("私人标题",settings.shareBranding(null).title());
        settings.setShareText("","");assertEquals("晚星的大喵相机",settings.shareBranding(null).title());
    }
    @Test public void withoutDefaultOnlyTheExplicitPhotoUidMaySupplyItsOwnNickname(){
        var context=RuntimeEnvironment.getApplication();var profiles=new StylistProfileStore(context);
        profiles.setManualNickname("other","别人的昵称");var settings=new ExportWatermarkStore(context);
        assertEquals("大喵相机",settings.shareBranding(null).title());
        assertEquals("MomoCamera",settings.shareBranding(null).footer());
        assertEquals("别人的昵称的大喵相机",settings.shareBranding("{\"identity\":{\"uid\":\"other\"}}").title());
        assertEquals("大喵相机",settings.shareBranding("invalid JSON").title());
    }
}
