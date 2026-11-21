package app.nikkisync.mobile.net;

import app.nikkisync.mobile.model.Models.PairedServer;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.net.InetSocketAddress;
import java.net.SocketTimeoutException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.Map;

import javax.net.ssl.SSLSocket;

public final class RealtimeWebSocket {
    public interface Listener {
        void onText(String json);
        void onConnectionState(boolean connected);
    }

    private final SignedHttpClient http;
    private final PairedServer server;
    private final Listener listener;
    private final SecureRandom random = new SecureRandom();
    private volatile boolean running;
    private volatile SSLSocket socket;
    private Thread thread;

    public RealtimeWebSocket(SignedHttpClient http, PairedServer server, Listener listener) {
        this.http = http;
        this.server = server;
        this.listener = listener;
    }

    public void start() {
        if (running) return;
        running = true;
        thread = new Thread(this::loop, "NikkiSync-WebSocket");
        thread.start();
    }

    public void stop() {
        running = false;
        SSLSocket current = socket;
        socket = null;
        if (current != null) try { current.close(); } catch (Exception ignored) {}
        if (thread != null) thread.interrupt();
        listener.onConnectionState(false);
    }

    private void loop() {
        long retry = 1_000;
        while (running) {
            try {
                connectAndRead();
                retry = 1_000;
            } catch (Exception error) {
                // No request headers, signatures, pairing data or media in diagnostics.
                if (running) android.util.Log.w("NikkiSync-Realtime", "Realtime disconnected: " + error.getClass().getSimpleName());
                listener.onConnectionState(false);
                if (!running) break;
                try { Thread.sleep(retry); } catch (InterruptedException ignoredSleep) {}
                retry = Math.min(10_000, retry * 2);
            }
        }
    }

    private void connectAndRead() throws Exception {
        SSLSocket current = (SSLSocket) http.tls().socketFactory().createSocket();
        socket = current;
        String phase="tcp-connect";
        try (current) {
        if (!running) return;
        current.connect(new InetSocketAddress(server.host(), server.port()), 5_000);
        current.setSoTimeout(5_000);
        phase="tls-handshake";
        current.startHandshake();
        byte[] keyBytes = new byte[16]; random.nextBytes(keyBytes);
        String key = Base64.getEncoder().encodeToString(keyBytes);
        Map<String, String> auth = http.authHeaders("GET", "/ws/v1", new byte[0]);
        String hostHeader = server.host().contains(":") ? "[" + server.host() + "]:" + server.port() : server.host() + ":" + server.port();
        StringBuilder request = new StringBuilder()
                .append("GET /ws/v1 HTTP/1.1\r\n")
                .append("Host: ").append(hostHeader).append("\r\n")
                .append("Upgrade: websocket\r\n")
                .append("Connection: Upgrade\r\n")
                .append("Sec-WebSocket-Version: 13\r\n")
                .append("Sec-WebSocket-Key: ").append(key).append("\r\n");
        for (Map.Entry<String, String> header : auth.entrySet()) request.append(header.getKey()).append(": ").append(header.getValue()).append("\r\n");
        request.append("\r\n");
        OutputStream output = current.getOutputStream();
        phase="websocket-upgrade";
        output.write(request.toString().getBytes(StandardCharsets.US_ASCII)); output.flush();
        BufferedInputStream input = new BufferedInputStream(current.getInputStream());
        String response = readHttpHead(input);
        validateUpgrade(response, key);
        // Detect sockets stranded by a Wi-Fi change without polling the photo API.
        current.setSoTimeout(15_000);
        if (!running) return;
        android.util.Log.i("NikkiSync-Realtime", "Realtime connected");
        listener.onConnectionState(true);
        phase="frame-read";
        while (running && !current.isClosed()) {
            String text = readTextFrame(readFirstByteWithHeartbeat(input,output),input, output);
            if (text != null) listener.onText(text);
        }
        } catch(Exception error) {
            if(running)android.util.Log.w("NikkiSync-Realtime","Connection phase "+phase+": "+error.getClass().getSimpleName());
            throw error;
        } finally { if (socket == current) socket = null; }
    }

    static void validateUpgrade(String response, String key) throws Exception {
        if (!response.startsWith("HTTP/1.1 101 ")) throw new IllegalStateException("WebSocket upgrade rejected");
        String expected = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1")
                .digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes(StandardCharsets.US_ASCII)));
        String accept = null;
        for (String line : response.split("\r\n")) {
            int colon = line.indexOf(':');
            if (colon > 0 && line.substring(0, colon).equalsIgnoreCase("Sec-WebSocket-Accept")) accept = line.substring(colon + 1).trim();
        }
        if (!expected.equals(accept)) throw new IllegalStateException("WebSocket accept mismatch");
    }

    private static String readHttpHead(InputStream input) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        int state = 0;
        while (output.size() < 16 * 1024) {
            int value = input.read();
            if (value < 0) throw new EOFException(); output.write(value);
            if (state == 0) state = value == '\r' ? 1 : 0;
            else if (state == 1) state = value == '\n' ? 2 : 0;
            else if (state == 2) state = value == '\r' ? 3 : 0;
            else if (state == 3) state = value == '\n' ? 4 : 0;
            if (state == 4) return new String(output.toByteArray(), StandardCharsets.US_ASCII);
        }
        throw new IllegalStateException("WebSocket response headers too large");
    }

    static String readTextFrame(InputStream input, OutputStream output) throws Exception {
        int first = input.read(); if (first < 0) throw new EOFException();
        return readTextFrame(first,input,output);
    }

    static int readFirstByteWithHeartbeat(InputStream input,OutputStream output) throws Exception {
        try { return input.read(); }
        catch(SocketTimeoutException idle) {
            byte[] ping=new byte[6];ping[0]=(byte)0x89;ping[1]=(byte)0x80;
            byte[] mask=new byte[4];new SecureRandom().nextBytes(mask);System.arraycopy(mask,0,ping,2,4);
            output.write(ping);output.flush();
            return input.read(); // Second timeout reconnects; never resume in the middle of a frame.
        }
    }

    private static String readTextFrame(int first,InputStream input,OutputStream output) throws Exception {
        if(first<0)throw new EOFException();
        int second = input.read(); if (second < 0) throw new EOFException();
        int opcode = first & 0x0f;
        long length = second & 0x7f;
        if (length == 126) length = ((long) readByte(input) << 8) | readByte(input);
        else if (length == 127) {
            length = 0;
            for (int i = 0; i < 8; i++) length = (length << 8) | readByte(input);
        }
        if (length < 0 || length > 2 * 1024 * 1024) throw new IllegalStateException("WebSocket frame too large");
        byte[] payload = readExactly(input, (int) length);
        if (payload.length != length) throw new EOFException();
        if (opcode == 0x8) throw new EOFException();
        if (opcode == 0x9) {
            if (length > 125) throw new IllegalStateException("Invalid WebSocket ping");
            byte[] mask = new byte[4]; new SecureRandom().nextBytes(mask);
            ByteArrayOutputStream pong = new ByteArrayOutputStream();
            pong.write(0x8a); pong.write(0x80 | payload.length); pong.write(mask);
            for (int i = 0; i < payload.length; i++) pong.write(payload[i] ^ mask[i % 4]);
            output.write(pong.toByteArray()); output.flush();
            return null;
        }
        if (opcode != 0x1) return null;
        return new String(payload, StandardCharsets.UTF_8);
    }

    private static int readByte(InputStream input) throws Exception {
        int value = input.read(); if (value < 0) throw new EOFException(); return value;
    }

    private static byte[] readExactly(InputStream input, int length) throws Exception {
        byte[] data = new byte[length]; int offset = 0;
        while (offset < length) {
            int read = input.read(data, offset, length - offset);
            if (read < 0) throw new EOFException();
            offset += read;
        }
        return data;
    }
}
