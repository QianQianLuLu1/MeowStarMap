package app.nikkisync.mobile.media;
import app.nikkisync.mobile.model.Models.PairedServer;

/** Dictionary IDs identify shared icons; credentials and transient IP addresses never enter keys. */
public final class ClothingCacheKey {
    private ClothingCacheKey() {}
    public static String of(PairedServer server,String assetId,String clothingId,String version) {
        if(server==null) return "clothing:"+assetId+":"+clothingId+":"+(version==null?"":version);
        String scope=version==null||version.isBlank()?"asset:"+assetId: "dictionary:"+version;
        return "clothing-v2\n"+server.serverId()+"\n"+server.tlsFingerprintSha256()+"\n"+clothingId+"\n"+scope;
    }
}
