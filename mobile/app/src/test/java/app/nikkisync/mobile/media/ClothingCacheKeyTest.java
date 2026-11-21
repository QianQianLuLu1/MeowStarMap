package app.nikkisync.mobile.media;
import app.nikkisync.mobile.model.Models.PairedServer;
import org.junit.Test;
import static org.junit.Assert.*;

public class ClothingCacheKeyTest {
    PairedServer pc(String id,String tls,String host) {return new PairedServer(id,"PC",host,1,tls,"","",0);}
    @Test public void repeatedOutfitSharesIconAcrossPhotosAndEndpointChanges() {
        assertEquals(ClothingCacheKey.of(pc("pc","tls","old"),"a","id","v1"),
                ClothingCacheKey.of(pc("pc","tls","new"),"b","id","v1"));
    }
    @Test public void dictionaryChangeOrOtherIdentityCannotReuseIcon() {
        String first=ClothingCacheKey.of(pc("pc","tls","ip"),"a","id","v1");
        assertNotEquals(first,ClothingCacheKey.of(pc("pc","tls","ip"),"a","id","v2"));
        assertNotEquals(first,ClothingCacheKey.of(pc("other","tls","ip"),"a","id","v1"));
        assertNotEquals(first,ClothingCacheKey.of(pc("pc","new-tls","ip"),"a","id","v1"));
    }
    @Test public void unknownDictionaryKeepsPerPhotoScope() {
        assertNotEquals(ClothingCacheKey.of(pc("pc","tls","ip"),"a","id",""),
                ClothingCacheKey.of(pc("pc","tls","ip"),"b","id",""));
    }
}
