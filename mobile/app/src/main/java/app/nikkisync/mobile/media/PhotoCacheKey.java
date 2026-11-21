package app.nikkisync.mobile.media;

import app.nikkisync.mobile.model.Models.AssetSummary;
import app.nikkisync.mobile.model.Models.PairedServer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

/** Do not key image pixels by clothing/parameter revisions or by transient IP addresses. */
public final class PhotoCacheKey {
    private PhotoCacheKey(){}
    public static String resource(AssetSummary asset,boolean preview){
        if(preview&&asset.fullPreviewResourceId()!=null)return asset.fullPreviewResourceId();
        if(!preview&&asset.thumbnailResourceId()!=null)return asset.thumbnailResourceId();
        return asset.previewResourceId()!=null?asset.previewResourceId():asset.thumbnailResourceId();
    }
    public static String contentHash(AssetSummary asset,boolean preview){
        String value=preview&&asset.fullPreviewResourceId()!=null?asset.fullPreviewSha256():
            !preview&&asset.thumbnailResourceId()!=null?asset.thumbnailSha256():asset.previewResourceId()!=null?asset.previewSha256():asset.thumbnailSha256();
        return value!=null&&value.matches("(?i)[a-f0-9]{64}")?value.toLowerCase(Locale.ROOT):null;
    }
    private static String identity(PairedServer server,AssetSummary asset){return server.serverId()+"\n"+server.tlsFingerprintSha256()+"\n"+asset.assetId();}
    static String assetPrefix(PairedServer server,String assetId){return hash(server.serverId()+"\n"+server.tlsFingerprintSha256()+"\n"+assetId);}
    private static String key(PairedServer server,AssetSummary asset,boolean preview){
        String hash=contentHash(asset,preview);
        // Old PCs cannot prove unchanged media. Keep conservative revision invalidation until both ends update.
        return identity(server,asset)+"\n"+resource(asset,preview)+"\n"+(hash==null?"revision:"+asset.revision():"sha256:"+hash);
    }
    public static String thumbnail(PairedServer server,AssetSummary asset){return key(server,asset,false);}
    public static String preview(PairedServer server,AssetSummary asset){return key(server,asset,true);}
    static String fileName(PairedServer server,AssetSummary asset,boolean preview){return hash(identity(server,asset))+"-"+hash(key(server,asset,preview))+".jpg";}
    public static String legacy(PairedServer server,AssetSummary asset){return server.serverId()+":"+server.tlsFingerprintSha256()+":"+asset.assetId()+":"+resource(asset,false)+":r"+asset.revision();}
    static String hash(String key){
        try{byte[] bytes=MessageDigest.getInstance("SHA-256").digest(key.getBytes(StandardCharsets.UTF_8));char[] hex="0123456789abcdef".toCharArray(),out=new char[bytes.length*2];for(int i=0;i<bytes.length;i++){out[i*2]=hex[(bytes[i]&255)>>>4];out[i*2+1]=hex[bytes[i]&15];}return new String(out);}
        catch(java.security.NoSuchAlgorithmException impossible){throw new IllegalStateException(impossible);}
    }
}
