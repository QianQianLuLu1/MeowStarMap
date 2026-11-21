package app.nikkisync.mobile.net;

import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Looper;
import java.net.InetAddress;
import java.time.Duration;
import java.util.ArrayList;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk={30,31,32,35})
public class NsdDiscoveryTest {
    static class Backend implements NsdDiscovery.Backend {
        final ArrayList<NsdManager.DiscoveryListener> discoveries=new ArrayList<>();
        final ArrayList<NsdManager.ResolveListener> resolutions=new ArrayList<>();
        public void discover(NsdManager.DiscoveryListener listener){discoveries.add(listener);}
        public void stop(NsdManager.DiscoveryListener listener){}
        public void resolve(NsdServiceInfo service,NsdManager.ResolveListener listener){resolutions.add(listener);}
    }
    static class Listener implements NsdDiscovery.Listener {
        int endpoints;String host;
        public void onEndpoint(String id,String host,int port){endpoints++;this.host=host;}
        public void onDiscoveryState(boolean active){}
    }
    private static NsdServiceInfo info(String type)throws Exception{
        var service=new NsdServiceInfo();service.setServiceType(type);service.setServiceName("Momo");
        service.setHost(InetAddress.getByName("192.168.31.130"));service.setPort(28080);service.setAttribute("serverId","paired-pc");return service;
    }
    private static void idle(){Shadows.shadowOf(Looper.getMainLooper()).idle();}

    @Test public void androidServiceTypeWithoutTrailingDotResolvesAndQueuesOtherServices()throws Exception{
        var backend=new Backend();var listener=new Listener();var discovery=new NsdDiscovery(listener,backend);
        discovery.start();var callback=backend.discoveries.get(0);
        callback.onServiceFound(info("_nikkisync._tcp"));callback.onServiceFound(info("_nikkisync._tcp."));idle();
        assertEquals(1,backend.resolutions.size());
        backend.resolutions.get(0).onServiceResolved(info("_nikkisync._tcp"));idle();
        assertEquals(1,listener.endpoints);assertEquals("192.168.31.130",listener.host);assertEquals(2,backend.resolutions.size());
        discovery.stop();
    }
    @Test public void failedStartRetriesButStopCancelsFutureRetries(){
        var backend=new Backend();var discovery=new NsdDiscovery(new Listener(),backend);
        discovery.start();backend.discoveries.get(0).onStartDiscoveryFailed("_nikkisync._tcp.",3);idle();
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(3));assertEquals(2,backend.discoveries.size());
        backend.discoveries.get(1).onStartDiscoveryFailed("_nikkisync._tcp.",3);idle();discovery.stop();
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(4));assertEquals(2,backend.discoveries.size());
    }
    @Test public void lateResolutionFromOldWifiCannotReplaceNewEndpoint()throws Exception{
        var backend=new Backend();var listener=new Listener();var discovery=new NsdDiscovery(listener,backend);
        discovery.start();backend.discoveries.get(0).onServiceFound(info("_nikkisync._tcp."));idle();
        discovery.restart();backend.resolutions.get(0).onServiceResolved(info("_nikkisync._tcp."));idle();assertEquals(0,listener.endpoints);
        backend.discoveries.get(1).onServiceFound(info("_nikkisync._tcp."));idle();
        backend.resolutions.get(1).onServiceResolved(info("_nikkisync._tcp."));idle();assertEquals(1,listener.endpoints);discovery.stop();
    }
}
