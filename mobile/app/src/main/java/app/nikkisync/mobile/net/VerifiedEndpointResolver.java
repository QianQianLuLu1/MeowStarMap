package app.nikkisync.mobile.net;

import app.nikkisync.mobile.model.Models.PairedServer;
import app.nikkisync.mobile.util.ByteStreams;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

/** Only a pinned TLS handshake and matching server identity can select an endpoint. */
public final class VerifiedEndpointResolver {
    private VerifiedEndpointResolver(){}
    public static PairedServer resolve(PairedServer server)throws Exception{
        Exception preferredFailure;
        try{return inspect(server);}catch(Exception error){preferredFailure=error;}
        if(Thread.currentThread().isInterrupted())throw new IOException("连接检查已取消");
        if(server.hosts().size()==1)throw preferredFailure;
        Map<String,PairedServer> verified=new ConcurrentHashMap<>();
        try{
            String host=EndpointRace.first(server.hosts().subList(1,server.hosts().size()),candidate->{
                PairedServer result=inspect(server.withEndpoint(candidate,server.port()));
                verified.put(candidate,result);return true;
            },5000);
            return verified.get(host);
        }catch(IOException error){
            if(ConnectionFailure.from(preferredFailure).requiresPairing())throw preferredFailure;
            throw error;
        }
    }
    public static PairedServer inspect(PairedServer server)throws Exception{
        // No pairing token, credential or request signature is sent during discovery.
        HttpsURLConnection connection=new SignedHttpClient(server,null).open("GET","/v1/server",new byte[0],false);
        connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(1200);connection.setReadTimeout(1500);
        try{
            if(connection.getResponseCode()!=200)throw new IOException("电脑连接检查失败");
            byte[] bytes;
            try(InputStream input=connection.getInputStream()){bytes=ByteStreams.readNBytes(input,8193);}
            if(bytes.length>8192)throw new IOException("电脑连接信息过大");
            return verifiedInfo(server,new JSONObject(new String(bytes,StandardCharsets.UTF_8)));
        }finally{connection.disconnect();}
    }
    static PairedServer verifiedInfo(PairedServer server,JSONObject info)throws Exception{
        if(!server.serverId().equals(info.optString("serverId"))||info.optInt("protocolVersion",-1)!=1)
            throw new IOException("发现的设备与原配对不符");
        ArrayList<String> hosts=new ArrayList<>();
        var addresses=info.optJSONArray("connectionHosts");
        if(addresses!=null)for(int i=0;i<Math.min(8,addresses.length());i++)hosts.add(addresses.optString(i));
        hosts.addAll(server.hosts());return server.withHosts(hosts);
    }
}
