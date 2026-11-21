package app.nikkisync.mobile.net;

import app.nikkisync.mobile.model.Models.PairedServer;
import app.nikkisync.mobile.security.DeviceIdentity;
import app.nikkisync.mobile.security.PinnedTls;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;

import app.nikkisync.mobile.util.Hex;

import javax.net.ssl.HttpsURLConnection;

public final class SignedHttpClient {
    private final PairedServer server;
    private final DeviceIdentity identity;
    private final PinnedTls tls;
    private final VerifiedServerClock clock;
    private final SecureRandom random = new SecureRandom();

    public SignedHttpClient(PairedServer server, DeviceIdentity identity) throws Exception {
        this.server = server;
        this.identity = identity;
        this.tls = new PinnedTls(server.tlsFingerprintSha256());
        this.clock = new VerifiedServerClock(this::readServerClock,System::currentTimeMillis,android.os.SystemClock::elapsedRealtime);
    }

    public Map<String, String> authHeaders(String method, String pathAndQuery, byte[] body) throws Exception {
        String timestamp = Long.toString(clock.timestamp());
        byte[] nonceBytes = new byte[16]; random.nextBytes(nonceBytes);
        String nonce = Base64.getUrlEncoder().withoutPadding().encodeToString(nonceBytes);
        String bodyHash = Hex.lower(MessageDigest.getInstance("SHA-256").digest(body));
        String canonical = method + "\n" + pathAndQuery + "\n" + timestamp + "\n" + nonce + "\n" + bodyHash;
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("X-NikkiSync-Device-Id", identity.deviceId());
        headers.put("X-NikkiSync-Timestamp", timestamp);
        headers.put("X-NikkiSync-Nonce", nonce);
        headers.put("X-NikkiSync-Signature", identity.signBase64Url(canonical.getBytes(StandardCharsets.UTF_8)));
        return headers;
    }

    public String json(String method, String pathAndQuery) throws Exception {
        HttpsURLConnection connection = open(method, pathAndQuery, new byte[0], true);
        return readUtf8(connection);
    }

    public HttpsURLConnection resource(String pathAndQuery) throws Exception {
        return open("GET", pathAndQuery, new byte[0], true);
    }

    public HttpsURLConnection open(String method, String pathAndQuery, byte[] body, boolean signed) throws Exception {
        return open(method,pathAndQuery,body,signed,"application/json; charset=utf-8");
    }

    public HttpsURLConnection open(String method,String pathAndQuery,byte[] body,boolean signed,String contentType) throws Exception {
        HttpsURLConnection connection = (HttpsURLConnection) new URL(baseUrl() + pathAndQuery).openConnection();
        connection.setSSLSocketFactory(tls.socketFactory());
        connection.setHostnameVerifier(tls.hostnameVerifier());
        connection.setConnectTimeout(5_000);
        connection.setReadTimeout(20_000);
        connection.setRequestMethod(method);
        connection.setRequestProperty("Accept", "application/json");
        if (signed) for (Map.Entry<String, String> header : authHeaders(method, pathAndQuery, body).entrySet()) {
            connection.setRequestProperty(header.getKey(), header.getValue());
        }
        if (body.length > 0) {
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", contentType);
            connection.setFixedLengthStreamingMode(body.length);
            connection.getOutputStream().write(body);
        }
        return connection;
    }

    public PinnedTls tls() { return tls; }

    private VerifiedServerClock.Sample readServerClock() throws Exception {
        // This GET carries no credentials and uses the same pinned certificate as
        // every signed request. An old or unavailable server retains old behavior.
        HttpsURLConnection connection=open("GET","/v1/server",new byte[0],false);
        connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(1200);connection.setReadTimeout(1500);
        try{
            if(connection.getResponseCode()!=200)throw new java.io.IOException("电脑连接检查失败");
            byte[] bytes;
            try(InputStream input=connection.getInputStream()){bytes=app.nikkisync.mobile.util.ByteStreams.readNBytes(input,8193);}
            if(bytes.length>8192)throw new java.io.IOException("电脑连接信息过大");
            var info=new org.json.JSONObject(new String(bytes,StandardCharsets.UTF_8));
            return VerifiedServerClock.fromVerifiedInfo(server,info,connection.getHeaderFieldDate("Date",0),android.os.SystemClock.elapsedRealtime());
        }finally{connection.disconnect();}
    }

    private String baseUrl() {
        String host = server.host().contains(":") ? "[" + server.host() + "]" : server.host();
        return "https://" + host + ":" + server.port();
    }

    public static String readUtf8(HttpsURLConnection connection) throws Exception {
        int status = connection.getResponseCode();
        InputStream input = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
        String body = input == null ? "" : new String(readAll(input), StandardCharsets.UTF_8);
        if (status < 200 || status >= 300) throw new HttpStatusException(status, body);
        return body;
    }

    private static byte[] readAll(InputStream input) throws Exception {
        try (input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16 * 1024]; int read;
            while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
            return output.toByteArray();
        }
    }

    public static final class HttpStatusException extends Exception {
        public final int status;
        public final String body;
        public HttpStatusException(int status, String body) { super("HTTP " + status + ": " + body); this.status = status; this.body = body; }
    }
}
