package app.nikkisync.mobile.storage;

import static org.junit.Assert.*;

import android.net.Uri;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = {30,31,32,33,35})
public final class EditedMediaAccessTest {
    @Test public void grantFailureStillReturnsLinkableMediaInfo() {
        EditedMediaAccess.ResolverOps ops = new EditedMediaAccess.ResolverOps() {
            @Override public void persist(Uri uri) { throw new SecurityException("not persistable"); }
            @Override public String displayName(Uri uri) { return "retouched.jpg"; }
            @Override public String mimeType(Uri uri) { return "image/jpeg"; }
        };

        var info = EditedMediaAccess.describeAndPersist(ops, Uri.parse("content://edit/1"));
        assertEquals("content://edit/1", info.uri());
        assertEquals("retouched.jpg", info.displayName());
        assertEquals("image/jpeg", info.mimeType());
        assertFalse(info.persistGranted());
    }

    @Test public void successfulGrantIsReported() {
        EditedMediaAccess.ResolverOps ops = new EditedMediaAccess.ResolverOps() {
            @Override public void persist(Uri uri) {}
            @Override public String displayName(Uri uri) { return "retouched.heic"; }
            @Override public String mimeType(Uri uri) { return "image/heic"; }
        };

        var info = EditedMediaAccess.describeAndPersist(ops, Uri.parse("content://edit/2"));
        assertTrue(info.persistGranted());
        assertEquals("retouched.heic", info.displayName());
    }
}
