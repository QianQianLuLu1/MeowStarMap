package app.nikkisync.mobile.net;

import app.nikkisync.mobile.model.Models.AssetDetail;
import app.nikkisync.mobile.protocol.JsonCodec;
import app.nikkisync.mobile.storage.AssetDetailCache;
import org.json.JSONObject;

/** All viewers, exporters and savers use the same durable responses; no polling or preload-all. */
public final class CachedAssetDetails {
    @FunctionalInterface public interface Fetch {String get(String assetId) throws Exception;}
    private final AssetDetailCache store;
    private final String namespace;
    private final Fetch fetch;
    private final Object[] locks=new Object[32];
    private volatile boolean available=true;
    public CachedAssetDetails(AssetDetailCache store,String namespace,Fetch fetch) {
        this.store=store;this.namespace=namespace;this.fetch=fetch;
        for(int i=0;i<locks.length;i++)locks[i]=new Object();
    }
    public AssetDetail get(String assetId) throws Exception {
        synchronized(locks[(assetId.hashCode()&0x7fffffff)%locks.length]) {
            String cached=peek(assetId);
            if(cached!=null) try {return parse(assetId,cached);}catch(Exception corrupt) {
                try {store.discard(namespace,assetId);}catch(RuntimeException diskFailure) {available=false;}
            }
            if(available)try {store.begin(namespace,assetId);}catch(RuntimeException diskFailure) {available=false;}
            long started=store.generation(namespace);
            return remember(assetId,fetch.get(assetId),started);
        }
    }
    public String peek(String assetId) {
        if(!available)return null;
        try {return store.get(namespace,assetId);}catch(RuntimeException diskFailure) {available=false;return null;}
    }
    private AssetDetail parse(String assetId,String json) throws Exception {
        AssetDetail detail=JsonCodec.assetDetail(json);
        if(!assetId.equals(detail.assetId())) throw new SecurityException("Detail identity mismatch");
        return detail;
    }
    public AssetDetail remember(String assetId,String json) throws Exception {
        return remember(assetId,json,store.generation(namespace));
    }
    private AssetDetail remember(String assetId,String json,long started) throws Exception {
        JSONObject root=new JSONObject(json),asset=root.getJSONObject("asset");
        JSONObject metadata=asset.optJSONObject("metadata");
        JSONObject raw=metadata==null?null:metadata.optJSONObject("raw");
        if(raw!=null) {
            // Preserve availability without persisting the native resolver token/payload.
            raw.put("sourceParametersPresent",raw.optBoolean("sourceParametersPresent",false)
                    || !raw.optString("nativeParamToken","").isBlank() || !raw.optString("nativeParamPayload","").isBlank());
            // The phone renders canonical fields; PC resolver credentials/payloads have no display use.
            var remove=new java.util.ArrayList<String>();var keys=raw.keys();
            while(keys.hasNext()) {String key=keys.next();if(key.startsWith("nativeParam"))remove.add(key);}
            for(String key:remove)raw.remove(key);
        }
        String displayJson=root.toString();AssetDetail detail=parse(assetId,displayJson);
        synchronized(store) {
            if(available&&started==store.generation(namespace)&&asset.has("revision"))
                try {store.put(namespace,assetId,asset.getLong("revision"),displayJson);}
                catch(RuntimeException diskFailure) {available=false;}
        }
        return detail;
    }
    public void observe(String assetId,long revision) {
        if(available) try {store.observe(namespace,assetId,revision);}catch(RuntimeException diskFailure) {available=false;}
    }
    public void clear() {store.clear(namespace);}
}
