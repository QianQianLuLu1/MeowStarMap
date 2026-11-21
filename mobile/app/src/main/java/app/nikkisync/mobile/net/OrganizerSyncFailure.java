package app.nikkisync.mobile.net;

/** User actions only; never display raw response bodies, paths or authentication data. */
public final class OrganizerSyncFailure {
    private OrganizerSyncFailure(){}
    public static String message(Throwable error){
        int depth=0;
        for(Throwable current=error;current!=null&&depth++<8;current=current.getCause()){
            if(current instanceof SignedHttpClient.HttpStatusException status){
                if(status.status==413||status.status==404)return "整理同步未完成 · 请更新电脑端后重试";
                if(status.status==401||status.status==403)return "整理同步未完成 · 请重新扫码配对电脑";
                return "整理同步暂未完成 · 请保持 App 打开，正在自动重试";
            }
        }
        ConnectionFailure failure=ConnectionFailure.from(error);
        return "整理同步未完成 · "+(failure.requiresPairing()?failure.message():"电脑暂不可达，正在自动重试");
    }
}
