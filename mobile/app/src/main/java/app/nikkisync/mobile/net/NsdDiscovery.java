package app.nikkisync.mobile.net;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.Looper;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Map;

/** Callbacks are serialized on main and scoped to a discovery generation. */
public final class NsdDiscovery {
    public interface Listener {
        void onEndpoint(String serverId,String host,int port);
        void onDiscoveryState(boolean active);
    }
    interface Backend {
        void discover(NsdManager.DiscoveryListener listener);
        void stop(NsdManager.DiscoveryListener listener);
        void resolve(NsdServiceInfo service,NsdManager.ResolveListener listener);
    }
    private static final String SERVICE_TYPE="_nikkisync._tcp.";
    private final Handler main=new Handler(Looper.getMainLooper());
    private final Backend backend;
    private final WifiManager.MulticastLock multicastLock;
    private final Listener listener;
    private final ArrayDeque<NsdServiceInfo> pending=new ArrayDeque<>();
    private boolean requested,resolving;
    private long generation;
    private NsdManager.DiscoveryListener active;
    private final Runnable retry=()->{if(requested&&active==null)start();};

    public NsdDiscovery(Context context,Listener listener){this(listener,platform(context),multicast(context));}
    private static Backend platform(Context context){
        NsdManager nsd=(NsdManager)context.getSystemService(Context.NSD_SERVICE);
        return new Backend(){
            public void discover(NsdManager.DiscoveryListener listener){nsd.discoverServices(SERVICE_TYPE,NsdManager.PROTOCOL_DNS_SD,listener);}
            public void stop(NsdManager.DiscoveryListener listener){nsd.stopServiceDiscovery(listener);}
            public void resolve(NsdServiceInfo service,NsdManager.ResolveListener listener){nsd.resolveService(service,listener);}
        };
    }
    private static WifiManager.MulticastLock multicast(Context context){
        WifiManager wifi=(WifiManager)context.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        var lock=wifi.createMulticastLock("nikkisync-mdns");lock.setReferenceCounted(false);return lock;
    }
    NsdDiscovery(Listener listener,Backend backend){this(listener,backend,null);}
    private NsdDiscovery(Listener listener,Backend backend,WifiManager.MulticastLock lock){
        this.listener=listener;this.backend=backend;multicastLock=lock;
    }
    public void start(){
        requested=true;if(active!=null)return;main.removeCallbacks(retry);
        long token=++generation;
        active=new NsdManager.DiscoveryListener(){
            public void onDiscoveryStarted(String type){main.post(()->{if(current(token))listener.onDiscoveryState(true);});}
            public void onDiscoveryStopped(String type){main.post(()->failed(token));}
            public void onStartDiscoveryFailed(String type,int code){main.post(()->failed(token));}
            public void onStopDiscoveryFailed(String type,int code){main.post(()->failed(token));}
            public void onServiceLost(NsdServiceInfo service){}
            public void onServiceFound(NsdServiceInfo service){main.post(()->{
                if(current(token))android.util.Log.i("NikkiSync-Connection","Discovery found compatible type: "+supported(service.getServiceType()));
                if(!current(token)||!supported(service.getServiceType())||pending.size()>=32)return;
                pending.add(service);resolveNext(token);
            });}
        };
        try{if(multicastLock!=null)multicastLock.acquire();backend.discover(active);}catch(Exception ignored){failed(token);}
    }
    public void stop(){
        requested=false;main.removeCallbacks(retry);generation++;
        var previous=active;active=null;pending.clear();resolving=false;
        if(previous!=null)try{backend.stop(previous);}catch(Exception ignored){}
        releaseLock();listener.onDiscoveryState(false);
    }
    public void restart(){if(requested){stop();start();}}
    private boolean current(long token){return requested&&active!=null&&generation==token;}
    private void failed(long token){
        if(!current(token))return;
        var previous=active;active=null;generation++;pending.clear();resolving=false;
        try{backend.stop(previous);}catch(Exception ignored){}
        releaseLock();listener.onDiscoveryState(false);
        main.removeCallbacks(retry);main.postDelayed(retry,3_000);
    }
    private void releaseLock(){try{if(multicastLock!=null&&multicastLock.isHeld())multicastLock.release();}catch(Exception ignored){}}
    private void resolveNext(long token){
        if(!current(token)||resolving||pending.isEmpty())return;
        resolving=true;NsdServiceInfo service=pending.remove();
        NsdManager.ResolveListener callback=new NsdManager.ResolveListener(){
            public void onResolveFailed(NsdServiceInfo info,int code){main.post(()->{if(current(token)){resolving=false;resolveNext(token);}});}
            public void onServiceResolved(NsdServiceInfo resolved){main.post(()->{
                if(!current(token))return;resolving=false;
                String serverId=attribute(resolved.getAttributes(),"serverId");
                if(serverId!=null&&resolved.getHost()!=null&&resolved.getPort()>0)
                    listener.onEndpoint(serverId,resolved.getHost().getHostAddress(),resolved.getPort());
                resolveNext(token);
            });}
        };
        try{backend.resolve(service,callback);}catch(Exception ignored){callback.onResolveFailed(service,0);}
    }
    private static boolean supported(String type){return SERVICE_TYPE.equals(type)||"_nikkisync._tcp".equals(type);}
    private static String attribute(Map<String,byte[]> values,String key){byte[] value=values.get(key);return value==null?null:new String(value,StandardCharsets.UTF_8);}
}
