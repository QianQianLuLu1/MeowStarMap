package app.nikkisync.mobile.net;

import android.os.Build;

import app.nikkisync.mobile.BuildConfig;
import app.nikkisync.mobile.model.Models.AssetDetail;
import app.nikkisync.mobile.model.Models.AssetPage;
import app.nikkisync.mobile.model.Models.Changes;
import app.nikkisync.mobile.model.Models.ClothingSearchResponse;
import app.nikkisync.mobile.model.Models.PairedServer;
import app.nikkisync.mobile.model.Models.ProfileStatsResponse;
import app.nikkisync.mobile.model.Models.PairingPayload;
import app.nikkisync.mobile.model.Models.SuitSearchResponse;
import app.nikkisync.mobile.protocol.JsonCodec;
import app.nikkisync.mobile.security.DeviceIdentity;

import org.json.JSONObject;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

import javax.net.ssl.HttpsURLConnection;

public final class NikkiSyncClient {
    private final PairedServer server;
    private final SignedHttpClient http;
    private final CachedAssetDetails details;

    public NikkiSyncClient(PairedServer server, DeviceIdentity identity) throws Exception {
        this(server,identity,null);
    }

    public NikkiSyncClient(PairedServer server, DeviceIdentity identity, app.nikkisync.mobile.storage.AssetDetailCache cache) throws Exception {
        this.server = server;
        this.http = new SignedHttpClient(server, identity);
        this.details=cache==null?null:new CachedAssetDetails(cache,server.serverId()+"\n"+server.tlsFingerprintSha256(),
                id->http.json("GET","/v1/assets/"+encode(id)));
    }

    public static PairedServer pair(PairingPayload payload, DeviceIdentity identity) throws Exception {
        PairedServer provisional = new PairedServer(payload.serverId(), "NikkiSync PC", payload.host(), payload.port(),
                payload.tlsFingerprintSha256(), "", "", 0).withHosts(payload.hosts());
        if(provisional.hosts().size()>1)provisional=VerifiedEndpointResolver.resolve(provisional);
        SignedHttpClient http = new SignedHttpClient(provisional, identity);
        JSONObject device = new JSONObject()
                .put("deviceId", identity.deviceId())
                .put("deviceName", Build.MANUFACTURER + " " + Build.MODEL)
                .put("platform", "android")
                .put("publicKey", identity.publicKeyBase64Url())
                .put("appVersion", BuildConfig.VERSION_NAME);
        byte[] body = new JSONObject().put("pairingToken", payload.token()).put("device", device)
                .toString().getBytes(StandardCharsets.UTF_8);
        HttpsURLConnection connection = http.open("POST", "/v1/pair", body, false);
        JSONObject response = new JSONObject(SignedHttpClient.readUtf8(connection));
        if (!payload.serverId().equals(response.getString("serverId"))) {
            throw new SecurityException("PC identity changed during pairing");
        }
        return new PairedServer(
                response.getString("serverId"), response.getString("serverName"), provisional.host(), provisional.port(),
                payload.tlsFingerprintSha256(), response.getString("serverPublicKey"),
                response.getString("deviceCredential"), 0
        ).withHosts(provisional.hosts());
    }

    public AssetPage assets(String cursor, int limit) throws Exception {
        String path = "/v1/assets?limit=" + limit;
        if (cursor != null) path += "&cursor=" + encode(cursor);
        AssetPage page=JsonCodec.assetPage(http.json("GET", path));
        if(details!=null) for(var asset:page.items()) details.observe(asset.assetId(),asset.revision());
        return page;
    }

    public org.json.JSONArray syncOrganizer(org.json.JSONArray items)throws Exception {
        byte[] body=new JSONObject().put("items",items).toString().getBytes(StandardCharsets.UTF_8);
        return new JSONObject(SignedHttpClient.readUtf8(http.open("POST","/v1/organizer/sync",body,true))).getJSONArray("items");
    }

    public AssetDetail asset(String assetId) throws Exception {
        return details==null?JsonCodec.assetDetail(http.json("GET", "/v1/assets/" + encode(assetId))):details.get(assetId);
    }

    /** Always asks the paired PC; cached detail and HTTP 404 cannot prove deletion. */
    public boolean sourceExplicitlyDeleted(String assetId) throws Exception {
        JSONObject asset=new JSONObject(http.json("GET", "/v1/assets/"+encode(assetId))).getJSONObject("asset");
        return assetId.equals(asset.optString("assetId")) && "deleted".equals(asset.optString("state"));
    }

    public AssetDetail updateMetadata(String assetId, JSONObject patch) throws Exception {
        byte[] body = patch.toString().getBytes(StandardCharsets.UTF_8);
        HttpsURLConnection connection = http.open("PATCH", "/v1/assets/" + encode(assetId) + "/metadata", body, true);
        String response=SignedHttpClient.readUtf8(connection);
        return details==null?JsonCodec.assetDetail(response):details.remember(assetId,response);
    }

    public SuitSearchResponse searchSuits(String query) throws Exception {
        SuitSearchResponse response=JsonCodec.suitSearch(http.json("GET", "/v1/search/suits?q=" + encode(query)));
        if(details!=null) for(var suit:response.items()) for(var photo:suit.photos()) details.observe(photo.asset().assetId(),photo.asset().revision());
        return response;
    }

    public ClothingSearchResponse searchClothing(String query) throws Exception {
        ClothingSearchResponse response=JsonCodec.clothingSearch(http.json("GET", "/v1/search/clothing?q=" + encode(query)));
        if(details!=null) for(var clothing:response.items()) for(var photo:clothing.photos()) details.observe(photo.asset().assetId(),photo.asset().revision());
        return response;
    }

    public ProfileStatsResponse profileStats() throws Exception {
        return JsonCodec.profileStats(http.json("GET", "/v1/profile/stats"));
    }

    public Changes changes(long after) throws Exception {
        Changes changes=JsonCodec.changes(http.json("GET", "/v1/changes?after=" + after));
        if(details!=null) {
            if(changes.fullResyncRequired()) details.clear();
            else for(var change:changes.items()) details.observe(change.assetId(),change.revision());
        }
        return changes;
    }

    public void clearDetailCache() {if(details!=null) details.clear();}

    public String clothingCacheVersion(String assetId) throws Exception {
        String cached=details==null?null:details.peek(assetId);
        if(cached==null)return "";
        String metadata=JsonCodec.assetDetail(cached).metadataJson();
        if(metadata==null) return "";
        JSONObject raw=new JSONObject(metadata).optJSONObject("raw");
        JSONObject dictionary=raw==null?null:raw.optJSONObject("dictionary");
        return dictionary==null?"":dictionary.optString("providerVersion","");
    }

    public HttpsURLConnection resource(String assetId, String resourceId) throws Exception {
        return http.resource("/v1/assets/" + encode(assetId) + "/resources/" + encode(resourceId));
    }
    public HttpsURLConnection exportStill(String assetId, String resourceId, boolean exif, int rotation) throws Exception {
        return exportStill(assetId,resourceId,exif,rotation,null);
    }
    public HttpsURLConnection exportStill(String assetId,String resourceId,boolean exif,int rotation,String cameraName) throws Exception {
        if (rotation != 0 && rotation != 90 && rotation != 180 && rotation != 270) throw new IllegalArgumentException("Invalid rotation");
        return http.resource("/v1/assets/" + encode(assetId) + "/resources/" + encode(resourceId)
                + "/export?exif=" + exif + "&rotation=" + rotation+(cameraName==null?"":"&cameraName="+encode(cameraName)));
    }

    public HttpsURLConnection clothingThumbnail(String assetId, String clothingId) throws Exception {
        return http.resource("/v1/assets/" + encode(assetId) + "/clothing/" + encode(clothingId) + "/thumbnail");
    }

    public HttpsURLConnection effectThumbnail(String assetId, String kind, String effectId) throws Exception {
        return http.resource("/v1/assets/" + encode(assetId) + "/effects/" + encode(kind) + "/" + encode(effectId) + "/thumbnail");
    }

    public SignedHttpClient signedHttp() { return http; }
    public PairedServer server() { return server; }

    private static String encode(String value) {
        try { return URLEncoder.encode(value, StandardCharsets.UTF_8.name()).replace("+", "%20"); }
        catch (Exception impossible) { throw new IllegalStateException(impossible); }
    }
}
