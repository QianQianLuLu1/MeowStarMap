package app.nikkisync.mobile.net;

import android.content.Intent;
import android.os.Build;
import android.os.Looper;
import android.view.View;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import androidx.activity.result.PickVisualMediaRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import app.nikkisync.mobile.MainActivity;
import app.nikkisync.mobile.privacy.PrivacyConsentStore;
import app.nikkisync.mobile.ui.chrome.ChromeNavigationHost;
import java.lang.reflect.Field;
import java.time.Duration;
import java.util.concurrent.ExecutorService;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

/** Exercise real framework entry points on Android 11, 12, 12L and the current target. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = {30, 31, 32, 35}, shadows=app.nikkisync.mobile.util.LegacyBluetoothDeviceShadow.class)
public class LegacyAndroidCompatibilityTest {
    @Test public void freshLauncherShowsConsentWithoutCreatingIdentity() throws Exception {
        var controller = Robolectric.buildActivity(MainActivity.class).setup();
        var activity = controller.get();
        try {
            assertNotNull(activity.navigationHost());
            assertNull(get(activity, "identity"));
            assertNull(get(activity, "discovery"));
        } finally { cleanup(activity); controller.pause().stop().destroy(); }
    }

    @Test public void oldSystemsStartDiscoveryWithoutAnAndroid13Permission() throws Exception {
        var activity = Robolectric.buildActivity(MainActivity.class).get();
        var backend = new Backend();
        var discovery = new NsdDiscovery(activity, backend);
        set(activity, "discovery", discovery);
        try {
            invoke(activity, "requestNearbyAndDiscover");
            assertEquals("consent still gates discovery", 0, backend.starts);
            new PrivacyConsentStore(activity).accept();
            invoke(activity, "requestNearbyAndDiscover");
            assertEquals(Build.VERSION.SDK_INT < 33 ? 1 : 0, backend.starts);
        } finally { discovery.stop(); cleanup(activity); }
    }

    @Test public void resumeRestartsDiscoveryOnOldSystems() throws Exception {
        var activity = Robolectric.buildActivity(MainActivity.class).get();
        var backend = new Backend();
        var discovery = new NsdDiscovery(activity, backend);
        set(activity, "discovery", discovery);
        try {
            new PrivacyConsentStore(activity).accept();
            invoke(activity, "resumeConnection");
            assertEquals(Build.VERSION.SDK_INT < 33 ? 1 : 0, backend.starts);
        } finally { discovery.stop(); cleanup(activity); }
    }

    @Test public void navigationPushCancelAndBackWorkWithoutNewBlurApis() {
        var context = RuntimeEnvironment.getApplication();
        var host = new ChromeNavigationHost(context);
        host.setRoot(new View(context));
        host.layout(0, 0, 500, 1000);
        host.push(new View(context));
        host.progress(.4f);
        host.cancel();
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1));
        assertEquals(1, host.overlayCount());
        host.commit();
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1));
        assertFalse(host.hasOverlay());
        host.close();
    }

    @Test public void editedImagePickerFallsBackToDocumentAccessOnOldSystems() {
        var context = RuntimeEnvironment.getApplication();
        Intent intent = new ActivityResultContracts.PickMultipleVisualMedia().createIntent(context,
                new PickVisualMediaRequest.Builder()
                        .setMediaType(ActivityResultContracts.PickVisualMedia.ImageOnly.INSTANCE).build());
        if (Build.VERSION.SDK_INT < 33) {
            assertEquals(Intent.ACTION_OPEN_DOCUMENT, intent.getAction());
            assertTrue(intent.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false));
            assertEquals("image/*", intent.getType());
        } else assertEquals("android.provider.action.PICK_IMAGES", intent.getAction());
    }

    private static final class Backend implements NsdDiscovery.Backend {
        int starts;
        public void discover(NsdManager.DiscoveryListener listener) { starts++; }
        public void stop(NsdManager.DiscoveryListener listener) {}
        public void resolve(NsdServiceInfo service, NsdManager.ResolveListener listener) {}
    }
    private static Object get(Object target, String name) throws Exception {
        Field field = MainActivity.class.getDeclaredField(name); field.setAccessible(true); return field.get(target);
    }
    private static void set(Object target, String name, Object value) throws Exception {
        Field field = MainActivity.class.getDeclaredField(name); field.setAccessible(true); field.set(target, value);
    }
    private static void invoke(Object target, String name) throws Exception {
        var method = MainActivity.class.getDeclaredMethod(name); method.setAccessible(true); method.invoke(target);
    }
    private static void cleanup(MainActivity activity) throws Exception {
        ((android.os.Handler)get(activity, "main")).removeCallbacksAndMessages(null);
        ((ExecutorService)get(activity, "io")).shutdownNow();
        ((ExecutorService)get(activity, "shareWorker")).shutdownNow();
        if (activity.navigationHost() != null) activity.navigationHost().close();
    }
}
