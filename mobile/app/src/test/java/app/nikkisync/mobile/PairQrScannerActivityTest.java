package app.nikkisync.mobile;

import static org.junit.Assert.*;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.TextView;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.Result;
import com.journeyapps.barcodescanner.BarcodeCallback;
import com.journeyapps.barcodescanner.BarcodeResult;
import com.journeyapps.barcodescanner.DecoratedBarcodeView;
import java.lang.reflect.Field;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.shadow.api.Shadow;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = {30,31,32,35}, shadows = {PairQrScannerActivityTest.ShadowScanner.class,app.nikkisync.mobile.util.LegacyBluetoothDeviceShadow.class})
public class PairQrScannerActivityTest {
    @Test public void firstScanRequestsCameraWithoutOpeningItBeforeGrant() throws Exception {
        var controller = Robolectric.buildActivity(PairQrScannerActivity.class).setup();
        try {
            var activity = controller.get();
            var request = Shadows.shadowOf(activity).getLastRequestedPermission();
            assertNotNull("First scan must request camera permission", request);
            assertArrayEquals(new String[]{Manifest.permission.CAMERA}, request.requestedPermissions);
            assertEquals(0, scanner(activity).resumeCalls);
            assertTrue(allText(content(activity)).contains("相机权限"));
            assertNotNull(button(content(activity), "取消扫码"));
            grant(activity, request.requestCode);
            assertEquals(1, scanner(activity).resumeCalls);
            assertNull(button(content(activity), "取消扫码"));
        } finally { controller.pause().stop().destroy(); }
    }

    @Test public void alreadyGrantedStartsWithoutPromptAndRechecksOnResume() throws Exception {
        Shadows.shadowOf(org.robolectric.RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.CAMERA);
        var controller = Robolectric.buildActivity(PairQrScannerActivity.class).setup();
        try {
            var activity = controller.get();
            assertNull(Shadows.shadowOf(activity).getLastRequestedPermission());
            assertEquals(1, scanner(activity).resumeCalls);
            controller.pause();
            Shadows.shadowOf(activity.getApplication()).denyPermissions(Manifest.permission.CAMERA);
            controller.resume();
            assertEquals(1, scanner(activity).resumeCalls);
            assertTrue(allText(content(activity)).contains("相机权限"));
        } finally { controller.pause().stop().destroy(); }
    }

    @Test public void denialStaysReadableAndAllowsRetryWithoutResumeRequestLoop() throws Exception {
        var controller = Robolectric.buildActivity(PairQrScannerActivity.class).setup();
        try {
            var activity = controller.get();
            var request = Shadows.shadowOf(activity).getLastRequestedPermission();
            assertNotNull(request);
            Shadows.shadowOf(activity.getPackageManager()).setShouldShowRequestPermissionRationale(Manifest.permission.CAMERA, true);
            activity.onRequestPermissionsResult(request.requestCode, new String[]{Manifest.permission.CAMERA}, new int[]{PackageManager.PERMISSION_DENIED});
            assertEquals(0, scanner(activity).resumeCalls);
            assertNotNull(button(content(activity), "允许相机权限"));
            controller.pause().resume();
            assertSame("Returning to a denied scanner must not ask again automatically", request,
                    Shadows.shadowOf(activity).getLastRequestedPermission());
            assertNotNull(button(content(activity), "允许相机权限"));
            button(content(activity), "允许相机权限").performClick();
            grant(activity, request.requestCode);
            assertEquals(1, scanner(activity).resumeCalls);
        } finally { controller.pause().stop().destroy(); }
    }

    @Test public void previousBlockedRequestSurvivesReopeningWithoutAnotherAutomaticPrompt() throws Exception {
        var first = Robolectric.buildActivity(PairQrScannerActivity.class).setup();
        assertNotNull(Shadows.shadowOf(first.get()).getLastRequestedPermission());
        first.pause().stop().destroy();
        var reopened = Robolectric.buildActivity(PairQrScannerActivity.class).setup();
        try {
            assertNull(Shadows.shadowOf(reopened.get()).getLastRequestedPermission());
            assertEquals(0, scanner(reopened.get()).resumeCalls);
            assertNotNull(button(content(reopened.get()), "打开设置"));
        } finally { reopened.pause().stop().destroy(); }
    }

    @Test public void authorizedCameraFailureShowsRetryInsteadOfSilentBlackPreview() throws Exception {
        Shadows.shadowOf(org.robolectric.RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.CAMERA);
        var controller = Robolectric.buildActivity(PairQrScannerActivity.class).setup();
        try {
            var activity = controller.get();
            assertEquals(1, scanner(activity).resumeCalls);
            Field field = PairQrScannerActivity.class.getDeclaredField("cameraStateListener"); field.setAccessible(true);
            ((com.journeyapps.barcodescanner.CameraPreview.StateListener) field.get(activity)).cameraError(new RuntimeException("Camera unavailable"));
            assertTrue(allText(content(activity)).contains("相机暂时无法打开"));
            button(content(activity), "重试相机").performClick();
            assertEquals(2, scanner(activity).resumeCalls);
            assertNull(button(content(activity), "重试相机"));
        } finally { controller.pause().stop().destroy(); }
    }

    @Test public void permanentDenialOpensAppSettingsAndGrantOnReturnRestartsScan() throws Exception {
        var controller = Robolectric.buildActivity(PairQrScannerActivity.class).setup();
        try {
            var activity = controller.get();
            var request = Shadows.shadowOf(activity).getLastRequestedPermission();
            assertNotNull(request);
            activity.onRequestPermissionsResult(request.requestCode, new String[]{Manifest.permission.CAMERA}, new int[]{PackageManager.PERMISSION_DENIED});
            assertNotNull(button(content(activity), "打开设置"));
            button(content(activity), "打开设置").performClick();
            Intent settings = Shadows.shadowOf(activity).getNextStartedActivity();
            assertEquals(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, settings.getAction());
            assertEquals("package:" + activity.getPackageName(), settings.getDataString());
            controller.pause();
            Shadows.shadowOf(activity.getApplication()).grantPermissions(Manifest.permission.CAMERA);
            controller.resume();
            assertEquals(1, scanner(activity).resumeCalls);
        } finally { controller.pause().stop().destroy(); }
    }

    @Test public void grantWhilePausedWaitsForForegroundAndCompletedScanNeverRestarts() throws Exception {
        var controller = Robolectric.buildActivity(PairQrScannerActivity.class).setup();
        try {
            var activity = controller.get();
            var request = Shadows.shadowOf(activity).getLastRequestedPermission();
            assertNotNull(request);
            controller.pause();
            grant(activity, request.requestCode);
            assertEquals(0, scanner(activity).resumeCalls);
            controller.resume();
            assertEquals(1, scanner(activity).resumeCalls);
            scanner(activity).callback.barcodeResult(new BarcodeResult(new Result("NS1|test", null, null, BarcodeFormat.QR_CODE), null));
            assertEquals(Activity.RESULT_OK, Shadows.shadowOf(activity).getResultCode());
            assertEquals("NS1|test", Shadows.shadowOf(activity).getResultIntent().getStringExtra(PairQrScannerActivity.EXTRA_PAIRING_URI));
            controller.pause().resume();
            assertEquals(1, scanner(activity).resumeCalls);
        } finally { controller.pause().stop().destroy(); }
    }

    @Test public void cancelledPermissionRequestAndScanCancelDoNotProducePairingResult() throws Exception {
        var controller = Robolectric.buildActivity(PairQrScannerActivity.class).setup();
        try {
            var activity = controller.get();
            var request = Shadows.shadowOf(activity).getLastRequestedPermission();
            assertNotNull(request);
            activity.onRequestPermissionsResult(request.requestCode, new String[0], new int[0]);
            assertEquals(0, scanner(activity).resumeCalls);
            button(content(activity), "取消扫码").performClick();
            assertTrue(activity.isFinishing());
            assertEquals(Activity.RESULT_CANCELED, Shadows.shadowOf(activity).getResultCode());
            assertNull(Shadows.shadowOf(activity).getResultIntent());
        } finally { controller.pause().stop().destroy(); }
    }

    private static void grant(PairQrScannerActivity activity, int code) {
        Shadows.shadowOf(activity.getApplication()).grantPermissions(Manifest.permission.CAMERA);
        activity.onRequestPermissionsResult(code, new String[]{Manifest.permission.CAMERA}, new int[]{PackageManager.PERMISSION_GRANTED});
    }
    private static ShadowScanner scanner(PairQrScannerActivity activity) throws Exception {
        Field field = PairQrScannerActivity.class.getDeclaredField("scanner"); field.setAccessible(true);
        return Shadow.extract(field.get(activity));
    }
    private static View content(Activity activity) { return activity.findViewById(android.R.id.content); }
    private static Button button(View view, String text) {
        if (view instanceof Button b && text.contentEquals(b.getText()) && b.getVisibility() == View.VISIBLE) return b;
        if (view instanceof ViewGroup group && group.getVisibility() == View.VISIBLE) for (int i = 0; i < group.getChildCount(); i++) {
            Button result = button(group.getChildAt(i), text); if (result != null) return result;
        }
        return null;
    }
    private static String allText(View view) {
        if (view.getVisibility() != View.VISIBLE) return "";
        StringBuilder result = new StringBuilder();
        if (view instanceof TextView label) result.append(label.getText());
        if (view instanceof ViewGroup group) for (int i = 0; i < group.getChildCount(); i++) result.append(allText(group.getChildAt(i)));
        return result.toString();
    }
    @Implements(value = DecoratedBarcodeView.class, isInAndroidSdk = false)
    public static class ShadowScanner extends org.robolectric.shadows.ShadowViewGroup {
        int resumeCalls;
        BarcodeCallback callback;
        @Implementation protected void resume() { resumeCalls++; }
        @Implementation protected void pause() {}
        @Implementation protected void pauseAndWait() {}
        @Implementation protected void decodeContinuous(BarcodeCallback value) { callback = value; }
    }
}
