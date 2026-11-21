package app.nikkisync.mobile.update;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import app.nikkisync.mobile.BuildConfig;
import app.nikkisync.mobile.MainActivity;
import app.nikkisync.mobile.privacy.PrivacyConsentStore;

import java.io.IOException;
import java.util.concurrent.TimeUnit;

/** Periodic Android-managed checks. The job only checks the signed feed and posts a local notification. */
public final class AndroidUpdateJob extends JobService {
    public static final String OPEN_UPDATES="app.nikkisync.mobile.OPEN_UPDATES";
    private static final String CHANNEL="app-updates";
    private static final int JOB_ID=5301,NOTICE_ID=5302;
    private Thread checkThread;

    private static SharedPreferences prefs(Context context){
        return context.getSharedPreferences("momo.android.updates",Context.MODE_PRIVATE);
    }

    // SELF_UPDATE=false（移植版默认）时整条自更新管线失效：上游 feed/验签公钥与本应用包名、签名不匹配。
    public static boolean enabled(Context context){return BuildConfig.SELF_UPDATE&&!BuildConfig.STORE_SUBMISSION&&prefs(context).getBoolean("enabled",false);}

    public static boolean setEnabled(Context context,boolean enabled){
        if(!BuildConfig.SELF_UPDATE||BuildConfig.STORE_SUBMISSION)return false;
        JobScheduler jobs=context.getSystemService(JobScheduler.class);
        NotificationManager notifications=context.getSystemService(NotificationManager.class);
        if(!enabled){
            prefs(context).edit().putBoolean("enabled",false).apply();
            jobs.cancel(JOB_ID);notifications.cancel(NOTICE_ID);
            return true;
        }
        if(!notifications.areNotificationsEnabled())return false;
        notifications.createNotificationChannel(new NotificationChannel(CHANNEL,"应用更新",NotificationManager.IMPORTANCE_DEFAULT));
        if(notifications.getNotificationChannel(CHANNEL).getImportance()==NotificationManager.IMPORTANCE_NONE)return false;
        if(jobs.getPendingJob(JOB_ID)==null&&jobs.schedule(new JobInfo.Builder(JOB_ID,new ComponentName(context,AndroidUpdateJob.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPersisted(true)
                .setPeriodic(TimeUnit.HOURS.toMillis(6)).build())!=JobScheduler.RESULT_SUCCESS)return false;
        prefs(context).edit().putBoolean("enabled",true).apply();
        return true;
    }

    @Override public boolean onStartJob(JobParameters job){
        if(!enabled(this)||!new PrivacyConsentStore(this).accepted())return false;
        NotificationManager manager=getSystemService(NotificationManager.class);
        if(!manager.areNotificationsEnabled())return false;
        checkThread=new Thread(()->{
            var thread=Thread.currentThread();
            AndroidUpdateClient.Release result;
            try{result=AndroidAppUpdate.check(this);}
            catch(IOException error){result=null;}
            var release=result;
            new Handler(Looper.getMainLooper()).post(()->{
                if(checkThread!=thread)return;
                checkThread=null;
                if(enabled(this)&&new PrivacyConsentStore(this).accepted()&&release!=null&&manager.areNotificationsEnabled()
                        &&release.versionCode()>prefs(this).getInt("notified",0)){
                    var intent=new Intent(this,MainActivity.class).setAction(OPEN_UPDATES)
                            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP|Intent.FLAG_ACTIVITY_SINGLE_TOP);
                    var tap=PendingIntent.getActivity(this,0,intent,PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
                    manager.notify(NOTICE_ID,new Notification.Builder(this,CHANNEL)
                            .setSmallIcon(android.R.drawable.stat_sys_download_done).setContentTitle("喵星图有新版本")
                            .setContentText("版本 "+release.version()+" · 点击查看并下载").setContentIntent(tap).setAutoCancel(true).build());
                    prefs(this).edit().putInt("notified",release.versionCode()).apply();
                }
                jobFinished(job,false);
            });
        },"android-update-check");
        checkThread.start();
        return true;
    }

    @Override public boolean onStopJob(JobParameters job){
        if(checkThread!=null){checkThread.interrupt();checkThread=null;}
        return enabled(this);
    }
}
