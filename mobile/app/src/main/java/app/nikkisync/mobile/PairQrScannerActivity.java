package app.nikkisync.mobile;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.ResultPoint;
import com.journeyapps.barcodescanner.BarcodeCallback;
import com.journeyapps.barcodescanner.BarcodeResult;
import com.journeyapps.barcodescanner.CameraPreview;
import com.journeyapps.barcodescanner.DecoratedBarcodeView;
import com.journeyapps.barcodescanner.DefaultDecoderFactory;
import com.journeyapps.barcodescanner.camera.CameraSettings;
import java.util.Collections;
import java.util.List;

public final class PairQrScannerActivity extends Activity {
    public static final String EXTRA_PAIRING_URI = "pairingUri";
    private static final int CAMERA_PERMISSION = 601;
    private static final String PERMISSION_PREFS = "pair_scanner";
    private static final String CAMERA_REQUESTED = "camera_requested";
    private static final String REQUEST_PENDING = "camera_request_pending";
    private DecoratedBarcodeView scanner;
    private LinearLayout blockedContent;
    private TextView blockedMessage;
    private Button retryButton;
    private boolean resumed;
    private boolean scannerRunning;
    private boolean requestPending;
    private boolean cameraFailed;
    private boolean completed;

    private final CameraPreview.StateListener cameraStateListener = new CameraPreview.StateListener() {
        @Override public void previewSized() {}
        @Override public void previewStarted() {}
        @Override public void previewStopped() {}
        @Override public void cameraClosed() {}
        @Override public void cameraError(Exception error) {
            if (!resumed || completed || !scannerRunning) return;
            pauseScanner();
            cameraFailed = hasCameraPermission();
            showBlockedState();
        }
    };

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        requestPending = state != null && state.getBoolean(REQUEST_PENDING);
        scanner = new DecoratedBarcodeView(this);
        CameraSettings cameraSettings = new CameraSettings(); cameraSettings.setAutoFocusEnabled(true); scanner.getBarcodeView().setCameraSettings(cameraSettings);
        scanner.getBarcodeView().setDecoderFactory(new DefaultDecoderFactory(Collections.singletonList(BarcodeFormat.QR_CODE)));
        scanner.setStatusText("");
        scanner.getBarcodeView().addStateListener(cameraStateListener);
        FrameLayout root = new FrameLayout(this); root.addView(scanner, new FrameLayout.LayoutParams(-1, -1));
        TextView hint = new TextView(this); hint.setText("将电脑上的配对二维码放入框内\n仅首次配对需要扫描"); hint.setTextSize(16); hint.setGravity(Gravity.CENTER); hint.setTextColor(0xffffffff); hint.setBackgroundColor(0x99000000); hint.setPadding(24,20,24,20);
        root.addView(hint, new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM));
        blockedContent = new LinearLayout(this);
        blockedContent.setOrientation(LinearLayout.VERTICAL);
        blockedContent.setGravity(Gravity.CENTER);
        blockedContent.setPadding(dp(32), dp(32), dp(32), dp(32));
        blockedContent.setBackgroundColor(0xfffff5f7);
        blockedMessage = new TextView(this);
        blockedMessage.setTextSize(18);
        blockedMessage.setTextColor(0xff584b51);
        blockedMessage.setGravity(Gravity.CENTER);
        blockedContent.addView(blockedMessage, new LinearLayout.LayoutParams(-1, -2));
        retryButton = new Button(this);
        blockedContent.addView(retryButton, new LinearLayout.LayoutParams(-1, -2));
        Button cancel = new Button(this);
        cancel.setText("取消扫码");
        cancel.setOnClickListener(view -> { setResult(RESULT_CANCELED); finish(); });
        blockedContent.addView(cancel, new LinearLayout.LayoutParams(-1, -2));
        blockedContent.setVisibility(View.GONE);
        root.addView(blockedContent, new FrameLayout.LayoutParams(-1, -1));
        Button temporaryNetwork=new Button(this);temporaryNetwork.setText("临时组网");
        temporaryNetwork.setBackgroundResource(R.drawable.bg_glass_card);
        FrameLayout.LayoutParams temporaryLayout=new FrameLayout.LayoutParams(-2,-2,Gravity.TOP|Gravity.END);temporaryLayout.topMargin=dp(52);temporaryLayout.rightMargin=dp(16);root.addView(temporaryNetwork,temporaryLayout);
        temporaryNetwork.setOnClickListener(v->new android.app.AlertDialog.Builder(this).setTitle("电脑热点 · 临时组网")
            .setMessage("适合校园网或公共 Wi-Fi 限制设备互访、同网仍连接失败的情况。需要电脑支持 Windows 移动热点。\n\n1. 电脑助手 → 同步设置 → 临时组网，点击开启临时热点。\n2. 手机 Wi-Fi 连接电脑显示的热点，输入显示的密码。提示无互联网时选择保持连接。\n3. 回到 App 扫描电脑配对码；已配对的设备会尝试自动重连。\n\n使用完在电脑点击结束临时组网。热点可能共享电脑流量；无可共享网络或网卡不支持时，请按电脑提示处理。")
            .setPositiveButton("打开手机 Wi-Fi",(d,w)->{try{startActivity(new Intent(Settings.ACTION_WIFI_SETTINGS));}catch(Exception ignored){Toast.makeText(this,"请在系统设置打开 Wi-Fi",Toast.LENGTH_SHORT).show();}}).setNegativeButton("返回扫码",null).show());
        setContentView(root);
        scanner.decodeContinuous(new BarcodeCallback() {
            @Override public void barcodeResult(BarcodeResult result) {
                if (completed || result == null) return; String text = result.getText();
                if (text == null || !(text.startsWith("NS1|") || text.startsWith("nikki-sync://pair?"))) { Toast.makeText(PairQrScannerActivity.this, "这不是 NikkiSync 配对二维码", Toast.LENGTH_SHORT).show(); return; }
                completed = true; scannerRunning = false; scanner.pauseAndWait(); setResult(RESULT_OK, new Intent().putExtra(EXTRA_PAIRING_URI, text)); finish();
            }
            @Override public void possibleResultPoints(List<ResultPoint> resultPoints) {}
        });
    }
    @Override protected void onResume() {
        super.onResume();
        resumed = true;
        updateScanner();
        // Request only on the first entry, never from a denial/resume loop.
        if (!completed && !isFinishing() && !hasCameraPermission() && !requestPending && !wasCameraRequested()) {
            requestCameraPermission();
        }
    }

    @Override protected void onPause() {
        resumed = false;
        pauseScanner();
        super.onPause();
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        state.putBoolean(REQUEST_PENDING, requestPending);
        super.onSaveInstanceState(state);
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(code, permissions, grantResults);
        if (code != CAMERA_PERMISSION) return;
        requestPending = false;
        cameraFailed = false;
        // The live permission check also handles cancellation or a revoked grant.
        updateScanner();
    }

    private boolean hasCameraPermission() {
        return checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean wasCameraRequested() {
        return getSharedPreferences(PERMISSION_PREFS, MODE_PRIVATE).getBoolean(CAMERA_REQUESTED, false);
    }

    private void requestCameraPermission() {
        if (!resumed || completed || isFinishing() || requestPending) return;
        if (hasCameraPermission()) { updateScanner(); return; }
        requestPending = true;
        getSharedPreferences(PERMISSION_PREFS, MODE_PRIVATE).edit().putBoolean(CAMERA_REQUESTED, true).apply();
        showBlockedState();
        requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION);
    }

    private void updateScanner() {
        if (!resumed || completed || isFinishing()) return;
        if (!hasCameraPermission() || cameraFailed) {
            pauseScanner();
            showBlockedState();
            return;
        }
        blockedContent.setVisibility(View.GONE);
        scanner.setVisibility(View.VISIBLE);
        if (!scannerRunning) {
            scannerRunning = true;
            try { scanner.resume(); }
            catch (RuntimeException error) {
                pauseScanner();
                cameraFailed = hasCameraPermission();
                showBlockedState();
            }
        }
    }

    private void pauseScanner() {
        scannerRunning = false;
        if (scanner != null) scanner.pause();
    }

    private void showBlockedState() {
        scanner.setVisibility(View.INVISIBLE);
        blockedContent.setVisibility(View.VISIBLE);
        retryButton.setEnabled(!requestPending);
        if (cameraFailed && hasCameraPermission()) {
            blockedMessage.setText("相机暂时无法打开\n请检查系统的相机访问开关，或关闭其他正在使用相机的应用后重试。");
            retryButton.setText("重试相机");
            retryButton.setOnClickListener(view -> { cameraFailed = false; updateScanner(); });
        } else {
            boolean settingsRequired = wasCameraRequested() && !shouldShowRequestPermissionRationale(Manifest.permission.CAMERA);
            blockedMessage.setText(requestPending
                    ? "扫码配对需要相机权限\n请在系统提示中允许使用相机。"
                    : "扫码配对需要相机权限\n相机仅用于识别电脑上的配对二维码。" + (settingsRequired ? "\n请在应用设置 → 权限中允许使用相机，再返回继续扫码。" : ""));
            retryButton.setText(settingsRequired ? "打开设置" : "允许相机权限");
            retryButton.setOnClickListener(view -> {
                if (!settingsRequired) { requestCameraPermission(); return; }
                try { startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))); }
                catch (ActivityNotFoundException error) { Toast.makeText(this, "请在手机设置中打开 NikkiSync 的相机权限", Toast.LENGTH_LONG).show(); }
            });
        }
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
