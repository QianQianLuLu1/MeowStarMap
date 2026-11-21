package app.nikkisync.mobile.ui;

import app.nikkisync.mobile.net.ConnectionFailure;
import org.junit.Test;
import static org.junit.Assert.*;

public final class TroubleshootingAdviceTest {
    @Test public void connectionChecksReflectKnownStateWithoutClaimingFirewallIsTheOnlyCause() {
        assertTrue(TroubleshootingAdvice.connection(false,false,null,true).contains("扫码"));
        String unreachable=TroubleshootingAdvice.connection(true,false,ConnectionFailure.UNREACHABLE,false);
        assertTrue(unreachable.contains("附近设备"));
        assertFalse(unreachable.contains("请依次确认"));
        assertTrue(TroubleshootingAdvice.connection(true,false,ConnectionFailure.TIMED_OUT,true).contains("超时"));
        assertTrue(TroubleshootingAdvice.connection(true,false,ConnectionFailure.CONNECTION_REFUSED,true).contains("没有接受连接"));
        assertTrue(TroubleshootingAdvice.connection(true,false,ConnectionFailure.PAIRING_REJECTED,true).contains("重新扫码"));
        assertTrue(TroubleshootingAdvice.connection(true,false,ConnectionFailure.CERTIFICATE_CHANGED,true).contains("确认是自己的电脑"));
        assertTrue(TroubleshootingAdvice.connection(true,true,null,true).contains("已连接电脑"));
    }

    @Test public void metadataChecksNameScreenshotAndOriginalDirectoryWithoutPromisingRecovery() {
        String screenshot=TroubleshootingAdvice.metadata("参数缺失","C:/Game/ScreenShot/photo.jpg",false);
        assertTrue(screenshot.contains("ScreenShot"));
        assertTrue(screenshot.contains("无法从画面还原"));
        assertTrue(screenshot.contains("GamePlayPhotos"));
        assertTrue(screenshot.contains("先按连接自查"));
        assertFalse(TroubleshootingAdvice.metadata(null,"C:/Game/GamePlayPhotos/photo.jpg",true).contains("无法从画面还原"));
    }
}
