package app.nikkisync.mobile.net;

import app.nikkisync.mobile.model.Models.PairedServer;
import java.util.List;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk=30)
public final class VerifiedEndpointResolverTest {
    private PairedServer server(){return new PairedServer("pc1","PC","192.168.1.5",28080,"ab".repeat(32),"public","credential",9);}
    @Test public void otherIdentityOrProtocolCannotSupplyReplacementAddresses() throws Exception{
        for(String json:List.of("{serverId:'pc2',protocolVersion:1,connectionHosts:['10.8.8.8']}",
            "{serverId:'pc1',protocolVersion:2,connectionHosts:['10.8.8.8']}","{}")){
            try{VerifiedEndpointResolver.verifiedInfo(server(),new JSONObject(json));fail("identity mismatch accepted");}
            catch(java.io.IOException expected){}
        }
        assertEquals(List.of("192.168.1.5"),server().hosts());
    }
    @Test public void verifiedRefreshRetainsCredentialsRevisionAndKnownAddresses()throws Exception{
        PairedServer value=VerifiedEndpointResolver.verifiedInfo(server().withHosts(List.of("172.25.9.8")),
            new JSONObject("{serverId:'pc1',protocolVersion:1,connectionHosts:['10.1.2.3','127.0.0.1','other.example'] }"));
        assertEquals(List.of("192.168.1.5","10.1.2.3","172.25.9.8"),value.hosts());
        assertEquals("credential",value.deviceCredential());assertEquals(9,value.lastRevision());
        assertEquals(server().tlsFingerprintSha256(),value.tlsFingerprintSha256());
    }
    @Test public void legacyServerWithoutCandidatesKeepsTheExistingEndpoint()throws Exception{
        assertEquals(List.of("192.168.1.5"),VerifiedEndpointResolver.verifiedInfo(server(),
            new JSONObject("{serverId:'pc1',protocolVersion:1}")).hosts());
    }
}
