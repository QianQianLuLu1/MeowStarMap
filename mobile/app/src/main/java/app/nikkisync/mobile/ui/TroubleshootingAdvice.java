package app.nikkisync.mobile.ui;

import app.nikkisync.mobile.net.ConnectionFailure;

/** Player-facing checks based on observable state, without exposing endpoints or raw server errors. */
public final class TroubleshootingAdvice {
    private TroubleshootingAdvice() {}

    public static String connection(boolean paired, boolean reachable, ConnectionFailure failure,
                                    boolean nearbyPermission) {
        if (!paired) return "尚未配对电脑。请打开电脑助手的“手机连接”，用 App 扫码完成配对。";
        if (reachable) return "已连接电脑。照片列表可以同步；若实时更新暂缓，点击图库“刷新”后继续使用。";
        if (failure == ConnectionFailure.PAIRING_REJECTED)
            return "电脑拒绝了原配对。请确认连接的是自己的电脑，在电脑助手生成新二维码后重新扫码。";
        if (failure == ConnectionFailure.CERTIFICATE_CHANGED)
            return "电脑身份与原配对不一致。请先确认是自己的电脑，再用新的配对码重新配对。";
        if (failure == ConnectionFailure.CONNECTION_REFUSED)
            return "已找到电脑地址，但电脑没有接受连接。请打开电脑助手，确认同步服务正在运行，然后重试。";
        if (failure == ConnectionFailure.TIMED_OUT)
            return "连接电脑超时，电脑没有在等待时间内回应。请确认手机与电脑在同一局域网，并在电脑助手“本地网络权限”中检查“允许手机连接”。";
        if (failure == ConnectionFailure.ADDRESS_UNAVAILABLE)
            return "已保存的电脑地址当前无法使用。请确认电脑与手机在同一网络，打开电脑助手后重新连接。";
        if (!nearbyPermission)
            return "手机的“附近设备”权限未开启，自动发现电脑受限。请先在系统应用权限中开启，再重试连接。";
        return "电脑暂时没有响应。请确认电脑助手正在运行，并在电脑助手“本地网络权限”中检查“允许手机连接”。";
    }

    public static String metadata(String notice, String sourcePath, boolean reachable) {
        StringBuilder text = new StringBuilder();
        if (notice != null && !notice.isBlank()) text.append(notice).append("\n\n");
        if (PlayerFacingDetails.isScreenShotPath(sourcePath))
            text.append("这张照片位于 ScreenShot。请先在电脑找到游戏内相机保存的原图；仅有截图时，无法从画面还原没有写入文件的穿搭和拍摄参数。\n");
        else text.append("先在照片详情查看文件路径。若它来自 ScreenShot 或系统截图，尝试找到对应的游戏内相机原图。\n");
        text.append("在电脑助手“同步设置 → 额外扫描目录”确认原游戏相册已收录，优先选择 GamePlayPhotos 或包含 UID 的相册文件夹，然后重新扫描。\n");
        if (!reachable) text.append("当前未连接电脑，先按连接自查恢复连接，再重新打开照片详情。\n");
        text.append("若原图有参数标记却仍无法读取，检查电脑端“在线参数解析”的状态；解析服务暂不可用时稍后重试。");
        return text.toString();
    }
}
