package app.nikkisync.mobile;

import android.os.Looper;
import app.nikkisync.mobile.model.Models.PairedServer;
import app.nikkisync.mobile.net.ConnectionState;
import app.nikkisync.mobile.net.NikkiSyncClient;
import app.nikkisync.mobile.security.DeviceIdentity;
import app.nikkisync.mobile.storage.ServerStore;
import java.lang.reflect.Field;
import java.util.*;
import java.util.concurrent.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

/** Exercise the Activity's recovery scheduler without opening sockets or user storage. */
@RunWith(RobolectricTestRunner.class) @Config(sdk=35)
public class MainConnectionRecoveryTest {
    @Test public void foregroundRecoveryReconcilesMissedChangesEvenWhenHttpOrWebSocketLooksConnected()throws Exception{
        for(boolean socketConnected:List.of(false,true))try(var fixture=new Fixture()){
            fixture.state.httpResult(fixture.state.session(),true);
            fixture.state.realtimeResult(fixture.state.session(),socketConnected);
            fixture.recover.run();
            assertEquals("An idle album must check for missed events without re-downloading the album",1,fixture.worker.queued.size());
            fixture.recover.run();
            assertEquals("A slow check must not accumulate periodic requests",1,fixture.worker.queued.size());
        }
    }
    @Test public void foregroundReconciliationDoesNotStartDuringInitialLibraryLoad()throws Exception{
        try(var fixture=new Fixture()){
            fixture.state.httpResult(fixture.state.session(),true);set(fixture.activity,"libraryLoading",true);
            fixture.recover.run();assertEquals(0,fixture.worker.queued.size());
        }
    }
    @Test public void connectionStartsInspirationSyncWithoutWaitingForLargeAlbum()throws Exception{
        try(var fixture=new Fixture()){
            fixture.state.realtimeResult(fixture.state.session(),true);set(fixture.activity,"libraryLoading",true);
            var ready=MainActivity.class.getDeclaredMethod("onConnectionAvailable");ready.setAccessible(true);
            ready.invoke(fixture.activity);ready.invoke(fixture.activity);
            assertEquals("Inspiration can sync while the album is loading, without duplicate requests",1,fixture.inspirationWorker.queued.size());
        }
    }
    static final class QueueExecutor extends AbstractExecutorService {
        final List<Runnable> queued=new ArrayList<>();boolean stopped;
        public void execute(Runnable command){queued.add(command);}
        public void shutdown(){stopped=true;}public List<Runnable> shutdownNow(){stopped=true;return List.copyOf(queued);}
        public boolean isShutdown(){return stopped;}public boolean isTerminated(){return stopped;}
        public boolean awaitTermination(long timeout,TimeUnit unit){return stopped;}
    }
    static final class Fixture implements AutoCloseable {
        final MainActivity activity=Robolectric.buildActivity(MainActivity.class).get();
        final QueueExecutor worker=new QueueExecutor(),inspirationWorker=new QueueExecutor();final ConnectionState state;final Runnable recover;
        Fixture()throws Exception{
            ((ExecutorService)get(activity,"io")).shutdownNow();set(activity,"io",worker);
            ((ExecutorService)get(activity,"inspirationIo")).shutdownNow();set(activity,"inspirationIo",inspirationWorker);
            var server=new PairedServer("recovery-fixture","PC","127.0.0.1",1,"a".repeat(64),"","",7);
            var store=new ServerStore(activity);store.clear();store.save(server);set(activity,"serverStore",store);set(activity,"pairedServer",server);
            set(activity,"client",new NikkiSyncClient(server,null));
            var constructor=DeviceIdentity.class.getDeclaredConstructor(String.class,byte[].class,Class.forName("app.nikkisync.mobile.security.Ed25519IdentityKey"),boolean.class);constructor.setAccessible(true);
            set(activity,"identity",constructor.newInstance("fixture",new byte[0],null,false));
            activity.getSharedPreferences("momo.privacy",0).edit().putString("version",app.nikkisync.mobile.privacy.PrivacyConsentStore.POLICY_VERSION).putLong("acceptedAt",1).commit();
            set(activity,"connectionForeground",true);set(activity,"libraryLoadedForSession",true);
            state=(ConnectionState)get(activity,"connectionState");state.beginSession();recover=(Runnable)get(activity,"connectionRecovery");
        }
        public void close()throws Exception{
            ((android.os.Handler)get(activity,"main")).removeCallbacksAndMessages(null);
            for(String name:List.of("io","organizerIo","organizerNetworkIo","inspirationIo","shareWorker"))((ExecutorService)get(activity,name)).shutdownNow();
        }
    }
    static Object get(Object target,String name)throws Exception{Field field=MainActivity.class.getDeclaredField(name);field.setAccessible(true);return field.get(target);}
    static void set(Object target,String name,Object value)throws Exception{Field field=MainActivity.class.getDeclaredField(name);field.setAccessible(true);field.set(target,value);}
}
