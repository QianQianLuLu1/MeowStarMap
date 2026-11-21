package app.nikkisync.mobile.privacy;

import android.content.Context;
import android.content.SharedPreferences;

/** Consent is explicit, versioned, local and never inferred from installation or pairing. */
public final class PrivacyConsentStore {
    public static final String POLICY_VERSION="2026-11-10.1";
    private final SharedPreferences prefs;
    private final Context context;
    public PrivacyConsentStore(Context context){this.context=context.getApplicationContext();prefs=this.context.getSharedPreferences("momo.privacy",Context.MODE_PRIVATE);}
    public boolean accepted(){return POLICY_VERSION.equals(prefs.getString("version",""))&&acceptedAt()>0;}
    public long acceptedAt(){return prefs.getLong("acceptedAt",0);}
    public void accept(){if(!prefs.edit().putString("version",POLICY_VERSION).putLong("acceptedAt",System.currentTimeMillis()).commit())throw new IllegalStateException("无法保存隐私选择，请重试");app.nikkisync.mobile.widget.PhotoAlbumWidgetProvider.refreshAll(context);}
    public void withdraw(){prefs.edit().clear().commit();app.nikkisync.mobile.widget.PhotoAlbumWidgetProvider.refreshAll(context);}
}
