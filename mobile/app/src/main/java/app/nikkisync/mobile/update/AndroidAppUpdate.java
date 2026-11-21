package app.nikkisync.mobile.update;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import app.nikkisync.mobile.BuildConfig;

import java.io.File;
import java.io.IOException;
import java.net.URI;
import java.util.HashSet;
import java.util.List;

public final class AndroidAppUpdate {
    private static final URI FEED=URI.create(
            "https://cnb.cool/nikkisync/icon-packs/-/releases/download/android-update-test/MomoCamera-Android-update.json");

    private AndroidAppUpdate(){}

    private static AndroidUpdateClient client(Context context)throws IOException {
        try(var key=context.getAssets().open("updates/update-public-key.pem")){
            return AndroidUpdateClient.fromPem(key);
        }
    }

    public static AndroidUpdateClient.Release check(Context context)throws IOException {
        return client(context).check(FEED,context.getPackageName(),BuildConfig.VERSION_CODE);
    }

    public static File download(Context context,AndroidUpdateClient.Release release,AndroidUpdateClient.Progress progress)throws IOException {
        return client(context).download(release,new File(context.getCacheDir(),"android-updates"),
                (apk,candidate)->verifyPackage(context,apk,candidate),progress);
    }

    @SuppressWarnings("deprecation")
    private static void verifyPackage(Context context,File apk,AndroidUpdateClient.Release release)throws IOException {
        var manager=context.getPackageManager();
        try {
            int flags=PackageManager.GET_SIGNING_CERTIFICATES;
            PackageInfo installed=manager.getPackageInfo(context.getPackageName(),flags);
            PackageInfo candidate=manager.getPackageArchiveInfo(apk.getAbsolutePath(),flags);
            if(candidate==null||!installed.packageName.equals(candidate.packageName)
                    ||candidate.getLongVersionCode()!=release.versionCode()||!release.version().equals(candidate.versionName)
                    ||candidate.getLongVersionCode()<=installed.getLongVersionCode()
                    ||candidate.signingInfo==null||installed.signingInfo==null)throw new AndroidUpdateClient.VerificationException();
            var current=new HashSet<>(List.of(installed.signingInfo.getApkContentsSigners()));
            var offered=new HashSet<>(List.of(candidate.signingInfo.getApkContentsSigners()));
            if(current.isEmpty()||!current.equals(offered))throw new AndroidUpdateClient.VerificationException();
        }catch(PackageManager.NameNotFoundException|RuntimeException error){throw new AndroidUpdateClient.VerificationException();}
    }

    public static boolean promptInstall(android.app.Activity activity,File apk) {
        if(BuildConfig.STORE_SUBMISSION)throw new IllegalStateException("External installer disabled");
        if(!activity.getPackageManager().canRequestPackageInstalls()){
            activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.fromParts("package",activity.getPackageName(),null)));
            return false;
        }
        Uri content=FileProvider.getUriForFile(activity,activity.getPackageName()+".updates",apk);
        activity.startActivity(new Intent(Intent.ACTION_VIEW)
                .setDataAndType(content,"application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
        return true;
    }
}
