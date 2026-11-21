package app.nikkisync.mobile.support;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import app.nikkisync.mobile.BuildConfig;
import app.nikkisync.mobile.net.ConnectionFailure;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Export only app-owned counters. No system log, request data, paths or user identifiers are read. */
public final class SupportDiagnostics {
    public enum ErrorCode {
        PAIR_FAILED, LIBRARY_UNREACHABLE, LIBRARY_REJECTED, LIBRARY_CERTIFICATE, SHARE_EXPORT,
        UPDATE_CHECK, UPDATE_SIGNATURE, UPDATE_DOWNLOAD, UPDATE_APK_VERIFY, UPDATE_INSTALL
    }

    private SupportDiagnostics(){}

    private static SharedPreferences prefs(Context context){
        return context.getSharedPreferences("momo.diagnostics",Context.MODE_PRIVATE);
    }

    public static synchronized void record(Context context,ErrorCode code){
        var prefs=prefs(context);
        prefs.edit().putInt(code.name(),Math.min(9999,prefs.getInt(code.name(),0)+1)).apply();
    }

    public static void recordLibraryFailure(Context context,ConnectionFailure failure){
        record(context,switch(failure){
            case UNREACHABLE, CONNECTION_REFUSED, TIMED_OUT, ADDRESS_UNAVAILABLE->ErrorCode.LIBRARY_UNREACHABLE;
            case PAIRING_REJECTED->ErrorCode.LIBRARY_REJECTED;
            case CERTIFICATE_CHANGED->ErrorCode.LIBRARY_CERTIFICATE;
        });
    }

    public static JSONObject snapshot(Context context){
        var errors=new JSONArray();
        var counts=prefs(context);
        try {
            for(var code:ErrorCode.values()){
                int count=counts.getInt(code.name(),0);
                if(count>0)errors.put(new JSONObject().put("code",code.name()).put("count",count));
            }
            return new JSONObject().put("schema",1).put("platform","android").put("version",BuildConfig.VERSION_NAME)
                    .put("build",BuildConfig.VERSION_CODE).put("osBuild",Build.VERSION.SDK_INT).put("errors",errors);
        }catch(JSONException impossible){throw new IllegalStateException(impossible);}
    }
}
