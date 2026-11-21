package app.nikkisync.mobile.update;

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import app.nikkisync.mobile.R;
import app.nikkisync.mobile.support.SupportDiagnostics;
import app.nikkisync.mobile.support.SupportDiagnostics.ErrorCode;

import java.io.File;
import java.io.IOException;
import java.util.concurrent.Executor;

public final class AndroidUpdatePanel extends LinearLayout {
    private final Activity activity;
    private final Executor worker;
    private final Handler main=new Handler(Looper.getMainLooper());
    private final TextView status;
    private final Button check,download,notice;
    private AndroidUpdateClient.Release offered;
    private File verified;
    private boolean busy,closed;

    public AndroidUpdatePanel(Activity activity,Executor worker,Runnable toggleNotifications){
        super(activity);
        this.activity=activity;this.worker=worker;
        setOrientation(VERTICAL);
        setPadding(dp(14),dp(13),dp(14),dp(13));
        setBackgroundResource(R.drawable.bg_glass_card);
        var title=new TextView(activity);title.setText("应用更新");title.setTextSize(16);
        title.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);title.setTextColor(activity.getColor(R.color.text_primary));
        addView(title);
        status=new TextView(activity);status.setTextSize(13);status.setTextColor(activity.getColor(R.color.text_secondary));
        status.setAccessibilityLiveRegion(ACCESSIBILITY_LIVE_REGION_POLITE);
        status.setText("通过 CNB 检查签名版本，可在这里下载后交给 Android 安装。");
        var spacing=new LayoutParams(-1,-2);spacing.topMargin=dp(6);addView(status,spacing);
        check=button("检查更新",this::check);
        download=button("下载更新",this::downloadOrInstall);
        notice=button("开启更新提醒",toggleNotifications);
        refresh();
    }

    public void close(){closed=true;}

    public void notificationResult(String message){
        status.setText(message);refresh();
    }

    private void refresh(){
        check.setEnabled(!busy);
        download.setVisibility(offered==null?GONE:VISIBLE);
        download.setEnabled(!busy);
        download.setText(verified==null?"下载 "+(offered==null?"更新":offered.version()):"安装已下载更新");
        notice.setText(AndroidUpdateJob.enabled(activity)?"关闭更新提醒":"开启更新提醒");
    }

    public void check(){
        if(busy||closed)return;
        offered=null;verified=null;busy=true;status.setText("正在检查签名更新…");refresh();
        worker.execute(()->{
            AndroidUpdateClient.Release release=null;
            String message;
            try {
                release=AndroidAppUpdate.check(activity);
                message=release==null?"当前已是最新版本。":"发现 "+release.version()+" · "+String.format(java.util.Locale.ROOT,"%.1f MB",release.size()/1_000_000d)
                        +(release.notes().isBlank()?"":"\n"+release.notes());
            }catch(AndroidUpdateClient.FeedUnavailableException unavailable){
                message="CNB 更新通道暂未发布版本。";
            }catch(AndroidUpdateClient.VerificationException invalid){
                SupportDiagnostics.record(activity,ErrorCode.UPDATE_SIGNATURE);message="更新清单签名验证失败。";
            }catch(IOException failure){
                SupportDiagnostics.record(activity,ErrorCode.UPDATE_CHECK);message="暂时无法连接 CNB，可稍后重试。";
            }
            var result=release;
            String summary=message;
            main.post(()->{
                if(closed)return;
                offered=result;busy=false;status.setText(summary);refresh();
            });
        });
    }

    private void downloadOrInstall(){
        if(busy||offered==null||closed)return;
        if(verified!=null&&verified.isFile()){
            try {
                status.setText(AndroidAppUpdate.promptInstall(activity,verified)
                        ?"请在 Android 安装界面确认更新。":"允许此来源安装后，返回点击「安装已下载更新」。");
            }catch(RuntimeException unavailable){
                SupportDiagnostics.record(activity,ErrorCode.UPDATE_INSTALL);
                status.setText("未能打开系统安装界面。");
            }
            return;
        }
        var release=offered;verified=null;busy=true;status.setText("正在下载 "+release.version()+"…");refresh();
        worker.execute(()->{
            File apk=null;
            String message;
            int[] last={-1};
            try {
                apk=AndroidAppUpdate.download(activity,release,(bytes,total)->{
                    int percent=(int)(bytes*100/total);
                    if(percent==last[0])return;
                    last[0]=percent;
                    main.post(()->{if(!closed)status.setText(percent==100?"正在校验安装包…":"下载中 · "+percent+"%");});
                });
                message="安装包已验证。点击下方按钮继续。";
            }catch(AndroidUpdateClient.VerificationException invalid){
                SupportDiagnostics.record(activity,ErrorCode.UPDATE_APK_VERIFY);message="安装包的内容或签名未通过验证。";
            }catch(IOException failure){
                SupportDiagnostics.record(activity,ErrorCode.UPDATE_DOWNLOAD);message="下载中断。重新点击下载会尝试续传。";
            }
            File result=apk;
            String summary=message;
            main.post(()->{
                if(closed)return;
                verified=result;busy=false;status.setText(summary);refresh();
            });
        });
    }

    private Button button(String label,Runnable action){
        Button button=new Button(activity);
        button.setText(label);button.setAllCaps(false);button.setMinimumHeight(dp(48));
        button.setTextColor(activity.getColor(R.color.text_primary));button.setBackgroundResource(R.drawable.bg_glass_chip);
        var layout=new LayoutParams(-1,-2);layout.topMargin=dp(8);addView(button,layout);
        button.setOnClickListener(view->action.run());
        return button;
    }

    private int dp(int value){return Math.round(value*getResources().getDisplayMetrics().density);}
}
