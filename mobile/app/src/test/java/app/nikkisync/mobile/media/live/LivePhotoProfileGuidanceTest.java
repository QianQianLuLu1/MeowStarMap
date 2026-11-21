package app.nikkisync.mobile.media.live;
import static org.junit.Assert.*;
import org.junit.Test;

public final class LivePhotoProfileGuidanceTest {
    @Test public void guidanceDistinguishesFormatFamiliesWithoutCertificationClaims() {
        for(var profile:LivePhotoProfile.values()) assertFalse(profile.guidance().isBlank());
        assertTrue(LivePhotoProfile.VIVO_LEGACY_PAIR.guidance().contains("双文件"));
        assertTrue(LivePhotoProfile.VIVO_SINGLE_XMP.guidance().contains("单文件"));
        assertTrue(LivePhotoProfile.SAMSUNG_SEF.guidance().contains("旧式"));
        assertTrue(LivePhotoProfile.HUAWEI_LEGACY.guidance().contains("鸿蒙"));
        assertTrue(LivePhotoProfile.HONOR_COMPAT.guidance().contains("实机确认"));
        assertEquals(LivePhotoProfile.HONOR_COMPAT,LivePhotoProfile.defaultFor("HONOR","HONOR"));
    }
}
