package app.nikkisync.mobile.storage;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONObject;

/** Small, durable user profiles. Manual names override explicitly identified metadata. */
public final class StylistProfileStore {
    private final SharedPreferences preferences;
    public StylistProfileStore(Context context) {
        preferences=context.getApplicationContext().getSharedPreferences("nikkisync.stylists",Context.MODE_PRIVATE);
    }
    public String nickname(String uid) {
        String manual=preferences.getString("manual:"+uid,"");
        return manual.isEmpty()?preferences.getString("auto:"+uid,""):manual;
    }
    public String defaultUid(){return preferences.getString("defaultUid","");}
    public void setDefaultUid(String uid){preferences.edit().putString("defaultUid",clean(uid)).apply();}
    public void setManualNickname(String uid,String value) {
        String name=clean(value);
        if(name.isEmpty())preferences.edit().remove("manual:"+uid).apply();
        else preferences.edit().putString("manual:"+uid,name).apply();
    }
    public void rememberMetadata(String json) {
        if(json==null)return;
        try {
            JSONObject identity=new JSONObject(json).optJSONObject("identity");
            if(identity==null)return;
            Object name=identity.opt("nickname"),id=identity.opt("uid");
            if(!(id instanceof String uid)||uid.isBlank()||!(name instanceof String))return;
            String nickname=clean((String)name);
            if(!nickname.isEmpty()&&!nickname.equals(preferences.getString("auto:"+uid,"")))
                preferences.edit().putString("auto:"+uid,nickname).apply();
        }catch(Exception ignored) { /* No guessing from outfit or provider raw fields. */ }
    }
    private static String clean(String value) {
        if(value==null)return "";
        String name=value.trim();
        if(name.length()>64)return "";
        for(int i=0;i<name.length();i++)if(Character.isISOControl(name.charAt(i)))return "";
        return name;
    }
}
