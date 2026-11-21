package app.nikkisync.mobile.storage;

import static org.junit.Assert.*;
import java.util.List;
import org.junit.Test;

public final class SavedLivePhotoRecordTest {
    @Test public void oldConstructorRetainsUnknownExportEvidence() {
        SavedPhotoStore.Record old = new SavedPhotoStore.Record("a","content://image/1",1,true,0,null,null,"OriginOS LIVE");
        assertTrue(old.hasMotion());
        assertNull(old.exportHasMotion());
        assertTrue(old.companionUris().isEmpty());
    }
    @Test public void liveRecordKeepsAllUrisWithoutMakingPlaybackClaim() {
        SavedPhotoStore.Record record = new SavedPhotoStore.Record("a","content://image/1",1,true,90,null,null,"vivo",
            List.of("content://video/2"),"vivo_legacy_pair",true,500000L,"sample_match_v1");
        assertEquals(List.of("content://video/2"),record.companionUris());
        assertEquals(Boolean.TRUE,record.exportHasMotion());
        assertEquals("unknown",record.galleryPlaybackValidation());
        assertEquals(90,record.rotationDegrees());
    }
    @Test public void missingVideoDoesNotMakeTheStillInaccessible() {
        SavedPhotoHealthStore.Entry entry = new SavedPhotoHealthStore.Entry(SavedPhotoHealthStore.State.MOTION_MISSING,1);
        assertFalse(entry.isMissing());
        assertNotNull(entry.motionWarning());
    }
}