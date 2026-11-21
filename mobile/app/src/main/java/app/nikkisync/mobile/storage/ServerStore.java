package app.nikkisync.mobile.storage;

import android.content.Context;
import android.content.SharedPreferences;

import app.nikkisync.mobile.model.Models.PairedServer;

public final class ServerStore {
    private final SharedPreferences prefs;

    public ServerStore(Context context) {
        prefs = context.getSharedPreferences("nikkisync.server", Context.MODE_PRIVATE);
    }

    public PairedServer load() {
        String serverId = prefs.getString("serverId", null);
        String host = prefs.getString("host", null);
        String fingerprint = prefs.getString("tls", null);
        if (serverId == null || host == null || fingerprint == null) return null;
        PairedServer server=new PairedServer(
                serverId,
                prefs.getString("serverName", "NikkiSync PC"),
                host,
                prefs.getInt("port", 0),
                fingerprint,
                prefs.getString("serverPublicKey", ""),
                prefs.getString("deviceCredential", ""),
                prefs.getLong("lastRevision", 0)
        );
        if(!(serverId+"\n"+fingerprint).equals(prefs.getString("hostsOwner","")))return server;
        try{
            org.json.JSONArray values=new org.json.JSONArray(prefs.getString("hosts","[]"));
            java.util.List<String> hosts=new java.util.ArrayList<>();
            for(int i=0;i<Math.min(8,values.length());i++)hosts.add(values.optString(i));
            return server.withHosts(hosts);
        }catch(Exception ignored){return server;}
    }

    public void save(PairedServer server) {
        prefs.edit()
                .putString("serverId", server.serverId())
                .putString("serverName", server.serverName())
                .putString("host", server.host())
                .putString("hosts",new org.json.JSONArray(server.hosts()).toString())
                .putString("hostsOwner",server.serverId()+"\n"+server.tlsFingerprintSha256())
                .putInt("port", server.port())
                .putString("tls", server.tlsFingerprintSha256())
                .putString("serverPublicKey", server.serverPublicKey())
                .putString("deviceCredential", server.deviceCredential())
                .putLong("lastRevision", server.lastRevision())
                .apply();
    }

    public void updateEndpoint(String host, int port) {
        prefs.edit().putString("host", host).putInt("port", port).apply();
    }

    public void updateRevision(long revision) {
        prefs.edit().putLong("lastRevision", revision).apply();
    }

    public void clear() { prefs.edit().clear().apply(); }
}
