package app.nikkisync.mobile.inspiration;

import static org.junit.Assert.*;

import android.content.Context;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.file.Files;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;

@RunWith(RobolectricTestRunner.class)
public final class InspirationImageStoreTest {
    private InspirationImageStore images;

    @Before public void setUp() { images = new InspirationImageStore(RuntimeEnvironment.getApplication()); }

    @Test public void copiedReferenceIsPrivateAndRetainsExactBytes() throws Exception {
        byte[] original = new byte[] {1, 2, 3, 4, 5};
        var saved = images.copy(new ByteArrayInputStream(original), "image/jpeg");
        assertEquals("image/jpeg", saved.mimeType());
        assertEquals(original.length, saved.bytes());
        assertArrayEquals(original, Files.readAllBytes(images.resolve(saved.localName()).toPath()));
        assertTrue(saved.localName().endsWith(".jpg"));
    }

    @Test public void oversizeOrNonImageIsRejectedWithoutPublishedFile() throws Exception {
        assertThrows(IOException.class, () -> images.copy(new ByteArrayInputStream(new byte[16]), "text/plain"));
        assertThrows(IOException.class, () -> images.copy(new ByteArrayInputStream(new byte[17]), "image/png", 16));
    }

    @Test public void pathTraversalCannotResolveOutsideThePrivateImageDirectory() {
        assertThrows(IllegalArgumentException.class, () -> images.resolve("../other.jpg"));
    }

    @Test public void rejectedMimeStillClosesTheSharedInputStream() {
        class Tracked extends ByteArrayInputStream {
            boolean closed;
            Tracked() { super(new byte[] {1}); }
            @Override public void close() throws IOException { closed = true; super.close(); }
        }
        Tracked input = new Tracked();
        assertThrows(IOException.class, () -> images.copy(input, "application/octet-stream"));
        assertTrue(input.closed);
    }
}
