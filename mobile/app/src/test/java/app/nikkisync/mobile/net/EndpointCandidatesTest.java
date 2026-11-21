package app.nikkisync.mobile.net;

import android.content.Context;
import app.nikkisync.mobile.model.Models.*;
import app.nikkisync.mobile.protocol.PairingUri;
import app.nikkisync.mobile.storage.ServerStore;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk=30)
public final class EndpointCandidatesTest {
    @Test public void supplementaryAddressesAreLiteralBoundedAndDeduplicated(){
        assertEquals(List.of("192.168.1.5","10.1.2.3"),EndpointCandidates.normalize("192.168.1.5",
            List.of("192.168.1.5","10.1.2.3","10.1.2.3","127.0.0.1","169.254.1.2","0.0.0.0","224.0.0.1","example.com","10.0.0.01","1.2.3.4/path")));
        assertEquals(8,EndpointCandidates.normalize("192.168.1.5",java.util.stream.IntStream.range(1,30).mapToObj(i->"10.1.2."+i).toList()).size());
    }
    @Test public void bothLegacyCompactAndAdditiveUriAreSupported(){
        String fingerprint="ab".repeat(32);
        assertEquals(List.of("192.168.1.5"),PairingUri.parse("NS1|server|192.168.1.5|28080|token|4102444800|"+fingerprint).hosts());
        PairingPayload value=PairingUri.parse("nikki-sync://pair?serverId=server&host=192.168.1.5&port=28080&token=token&protocol=1&expiresAt=2100-01-01T00:00:00Z&tls="+fingerprint+"&hosts=192.168.1.5%2C10.1.2.3%2C127.0.0.1");
        assertEquals(List.of("192.168.1.5","10.1.2.3"),value.hosts());
    }
    @Test public void phoneClockDoesNotRejectAValidQrBeforeTheComputerChecksItsToken(){
        String fingerprint="ab".repeat(32);
        // These timestamps are deliberately in the past on the phone. Only the
        // paired computer has the authoritative one-use session and expiry.
        assertEquals("2020-01-01T00:00:00Z",PairingUri.parse("NS1|server|192.168.1.5|28080|token|1577836800|"+fingerprint).expiresAt());
        assertEquals("2020-01-01T00:00:00Z",PairingUri.parse("nikki-sync://pair?serverId=server&host=192.168.1.5&port=28080&token=token&protocol=1&expiresAt=2020-01-01T00:00:00Z&tls="+fingerprint).expiresAt());
        assertThrows(Exception.class,()->PairingUri.parse("nikki-sync://pair?serverId=server&host=192.168.1.5&port=28080&token=token&protocol=1&expiresAt=bad&tls="+fingerprint));
    }
    @Test public void candidatesPersistAcrossRestartAndDoNotLeakIntoAnotherPairing(){
        Context context=RuntimeEnvironment.getApplication();ServerStore store=new ServerStore(context);store.clear();
        PairedServer original=new PairedServer("pc1","PC","192.168.1.5",28080,"ab".repeat(32),"public","credential",7)
            .withHosts(List.of("10.1.2.3","172.25.9.8"));
        store.save(original);
        PairedServer reloaded=new ServerStore(context).load();
        assertEquals(List.of("192.168.1.5","10.1.2.3","172.25.9.8"),reloaded.hosts());
        store.save(reloaded.withEndpoint("10.1.2.3",28080));
        assertEquals("10.1.2.3",store.load().hosts().get(0));assertEquals(7,store.load().lastRevision());
        store.save(new PairedServer("pc2","Other","10.8.8.8",28080,"cd".repeat(32),"public2","credential2",0));
        assertEquals(List.of("10.8.8.8"),store.load().hosts());store.clear();
    }
    @Test public void staleSupplementaryFieldsFromAnOlderAppCannotBelongToANewPairing(){
        Context context=RuntimeEnvironment.getApplication();ServerStore store=new ServerStore(context);store.clear();
        store.save(new PairedServer("pc1","PC","192.168.1.5",28080,"ab".repeat(32),"public","credential",7).withHosts(List.of("10.1.2.3")));
        // Older versions update their known fields and leave unfamiliar fields intact.
        context.getSharedPreferences("nikkisync.server",Context.MODE_PRIVATE).edit()
            .putString("serverId","pc2").putString("host","10.8.8.8").putString("tls","cd".repeat(32)).apply();
        assertEquals(List.of("10.8.8.8"),store.load().hosts());store.clear();
    }
}
