package app.nikkisync.mobile.storage;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONObject;
import java.util.LinkedHashMap;
import java.util.Map;

public final class SavedPhotoHealthStore {
    public enum State { ACTIVE, MISSING, UNAVAILABLE, MOTION_MISSING, MOTION_UNVERIFIED }

    public static final class Entry {
        private final State state;
        private final long lastCheckedAt;
        public Entry(State state,long lastCheckedAt){this.state=state==null?State.ACTIVE:state;this.lastCheckedAt=lastCheckedAt;}
        public State state(){return state;}
        public long lastCheckedAt(){return lastCheckedAt;}
        public boolean isMissing(){return state==State.MISSING;}
        public boolean isUnavailable(){return state==State.MISSING||state==State.UNAVAILABLE;}
        public String motionWarning(){return switch(state){
            case MOTION_MISSING -> "动态视频不存在或无法访问；静态图仍可打开。";
            case MOTION_UNVERIFIED -> "旧双文件记录没有视频 URI，动态完整性待核验；请重新保存源 Live。";
            default -> null;
        };}
    }
    private static final String PREFS="nikkisync_saved_photo_health",KEY_HEALTH="health";
    private final SharedPreferences prefs;
    public SavedPhotoHealthStore(Context context){prefs=context.getSharedPreferences(PREFS,Context.MODE_PRIVATE);}
    public synchronized Map<String,Entry> load(){
        Map<String,Entry> result=new LinkedHashMap<>();String raw=prefs.getString(KEY_HEALTH,"{}");
        try{JSONObject root=new JSONObject(raw==null?"{}":raw);java.util.Iterator<String> keys=root.keys();
            while(keys.hasNext()){String uri=keys.next();JSONObject item=root.optJSONObject(uri);if(item==null)continue;
                result.put(uri,new Entry(parseState(item.optString("state","ACTIVE")),item.optLong("lastCheckedAt",0L)));}
        }catch(Exception ignored){}return result;
    }
    public synchronized void put(String uri,State state,long checkedAt){
        JSONObject root;try{root=new JSONObject(prefs.getString(KEY_HEALTH,"{}"));}catch(Exception ignored){root=new JSONObject();}
        try{JSONObject item=new JSONObject();item.put("state",state.name());item.put("lastCheckedAt",checkedAt);root.put(uri,item);prefs.edit().putString(KEY_HEALTH,root.toString()).apply();}catch(Exception ignored){}
    }
    public synchronized void remove(String uri){try{JSONObject root=new JSONObject(prefs.getString(KEY_HEALTH,"{}"));root.remove(uri);prefs.edit().putString(KEY_HEALTH,root.toString()).apply();}catch(Exception ignored){}}
    private static State parseState(String raw){try{return State.valueOf(raw);}catch(Exception ignored){return State.ACTIVE;}}
}
