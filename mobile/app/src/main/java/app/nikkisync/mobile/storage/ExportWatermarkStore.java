package app.nikkisync.mobile.storage;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONObject;

/** Independent export preferences; empty overrides always follow the current default profile. */
public final class ExportWatermarkStore {
    public record Branding(String title,String footer) {}
    private final SharedPreferences prefs;
    private final StylistProfileStore profiles;
    public ExportWatermarkStore(Context context){
        prefs=context.getApplicationContext().getSharedPreferences("nikkisync.watermarks",Context.MODE_PRIVATE);
        profiles=new StylistProfileStore(context);
    }
    public boolean shareEnabled(){return prefs.getBoolean("shareEnabled",true);}
    public boolean exifEnabled(){return prefs.getBoolean("exifEnabled",true);}
    public void setShareEnabled(boolean enabled){prefs.edit().putBoolean("shareEnabled",enabled).apply();}
    public void setExifEnabled(boolean enabled){prefs.edit().putBoolean("exifEnabled",enabled).apply();}
    public String shareTitle(){return prefs.getString("title","");}
    public String shareFooter(){return prefs.getString("footer","");}
    public String exifText(){return prefs.getString("camera","");}
    public void setShareText(String title,String footer){prefs.edit().putString("title",clean(title,96)).putString("footer",clean(footer,128)).apply();}
    public void setExifText(String name){prefs.edit().putString("camera",clean(name,64)).apply();}
    public Branding shareBranding(String json){
        if(!shareEnabled())return new Branding("大喵相机","MomoCamera");
        String uid=uid(json),name=profiles.nickname(uid);
        String title=shareTitle(),footer=shareFooter();
        return new Branding(title.isEmpty()?camera(name):title,footer.isEmpty()?(uid.isEmpty()?"":"UID："+uid+" ")+"MomoCamera":footer);
    }
    public String exifCameraName(String json){
        return "MomoCamera";
    }
    private String uid(String json){
        String uid=profiles.defaultUid();if(!uid.isEmpty())return uid;
        try{JSONObject identity=new JSONObject(json).optJSONObject("identity");Object value=identity==null?null:identity.opt("uid");return value instanceof String?clean((String)value,64):"";}catch(Exception ignored){return "";}
    }
    private static String camera(String name){return name.isEmpty()?"大喵相机":name+"的大喵相机";}
    private static String clean(String value,int limit){
        if(value==null)return "";String result=value.trim();
        if(result.length()>limit)throw new IllegalArgumentException("水印文字过长");
        for(int i=0;i<result.length();i++)if(Character.isISOControl(result.charAt(i)))throw new IllegalArgumentException("水印不能包含控制字符");
        return result;
    }
}
