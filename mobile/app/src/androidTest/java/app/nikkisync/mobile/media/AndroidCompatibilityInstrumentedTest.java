package app.nikkisync.mobile.media;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import androidx.exifinterface.media.ExifInterface;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import app.nikkisync.mobile.privacy.PrivacyConsentStore;
import app.nikkisync.mobile.security.DeviceIdentity;
import app.nikkisync.mobile.util.ByteStreams;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters;
import org.bouncycastle.crypto.signers.Ed25519Signer;
import org.bouncycastle.crypto.util.PublicKeyFactory;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Synthetic fixtures on isolated test emulators; run against the final APK's ART code. */
@RunWith(AndroidJUnit4.class)
public class AndroidCompatibilityInstrumentedTest {
    private Context context;
    @Before public void setup() {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        new PrivacyConsentStore(context).accept();
    }

    @Test public void desugaredJavaApisWorkOnArt() throws Exception {
        assertTrue("\u2003 \t".isBlank());
        assertEquals(List.of("A", "B"), List.of("a", "b").stream().map(String::toUpperCase).toList());
        assertEquals(List.of("x"), List.copyOf(List.of("x")));
        assertEquals("x", Map.copyOf(Map.of("key", "x")).get("key"));
        byte[] bytes = "synthetic fixture".getBytes(StandardCharsets.UTF_8);
        assertArrayEquals(bytes, ByteStreams.readAllBytes(new ByteArrayInputStream(bytes)));
        assertEquals(bytes.length, ByteStreams.copy(new ByteArrayInputStream(bytes),null));
        assertFalse(PhotoExif.versionName(context, "2.9").isEmpty());
    }

    @Test public void hardwareWrappedIdentityPersistsAndSignsVerifiableRequests() throws Exception {
        DeviceIdentity first = DeviceIdentity.getOrCreate(context), again = DeviceIdentity.getOrCreate(context);
        assertEquals(first.deviceId(), again.deviceId());
        assertEquals(first.publicKeyBase64Url(), again.publicKeyBase64Url());
        byte[] message = "compatibility-test-only".getBytes(StandardCharsets.UTF_8);
        byte[] signature = Base64.getUrlDecoder().decode(again.signBase64Url(message));
        var verifier = new Ed25519Signer();
        verifier.init(false, (Ed25519PublicKeyParameters)PublicKeyFactory.createKey(
                Base64.getUrlDecoder().decode(first.publicKeyBase64Url())));
        verifier.update(message, 0, message.length);
        assertTrue(verifier.verifySignature(signature));
    }

    @Test public void productionEditedPhotoSavePublishesVerifiedExifWithoutChangingSource() throws Exception {
        File source = File.createTempFile("compat-edited-", ".jpg", context.getCacheDir());
        EditedPhotoExif.Result result = null;
        try {
            try (InputStream input = InstrumentationRegistry.getInstrumentation().getContext()
                    .getAssets().open("livephoto/corners.jpg"); OutputStream output = new FileOutputStream(source)) {
                ByteStreams.copy(input,output);
            }
            byte[] before = Files.readAllBytes(source.toPath());
            result = EditedPhotoExif.prepare(context, Uri.fromFile(source), "image/jpeg", null,
                    "2026-10-21T00:00:00Z", "2.9");
            assertTrue(result.copied()); assertTrue(result.written());
            assertEquals("content", result.uri().getScheme());
            try (InputStream input = context.getContentResolver().openInputStream(result.uri())) {
                ExifInterface exif = new ExifInterface(input);
                assertEquals("MomoCamera", exif.getAttribute(ExifInterface.TAG_MODEL));
                assertEquals("InfinityNikki", exif.getAttribute(ExifInterface.TAG_LENS_MODEL));
            }
            Bitmap original = BitmapFactory.decodeFile(source.getAbsolutePath());
            try (InputStream input = context.getContentResolver().openInputStream(result.uri())) {
                Bitmap saved = BitmapFactory.decodeStream(input);
                try {
                    assertNotNull(saved); assertEquals(original.getWidth(), saved.getWidth());
                    assertEquals(original.getHeight(), saved.getHeight());
                    assertTrue("EXIF must not reencode image pixels", original.sameAs(saved));
                } finally { if (saved != null) saved.recycle(); }
            } finally { original.recycle(); }
            assertArrayEquals(before, Files.readAllBytes(source.toPath()));
        } finally { EditedPhotoExif.discard(context, result); source.delete(); }
    }
}
