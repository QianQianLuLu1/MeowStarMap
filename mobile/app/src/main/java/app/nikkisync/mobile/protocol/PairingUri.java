package app.nikkisync.mobile.protocol;

import android.net.Uri;

import app.nikkisync.mobile.model.Models.PairingPayload;

import java.time.Instant;
import java.util.Locale;

public final class PairingUri {
    private PairingUri() {}

    public static PairingPayload parse(String raw) {
        if (raw != null && raw.trim().startsWith("NS1|")) return parseCompact(raw.trim());
        Uri uri = Uri.parse(raw.trim());
        if (!"nikki-sync".equals(uri.getScheme()) || !"pair".equals(uri.getHost())) {
            throw new IllegalArgumentException("这不是 NikkiSync 配对链接");
        }
        String serverId = required(uri, "serverId");
        String host = required(uri, "host");
        int port = Integer.parseInt(required(uri, "port"));
        String token = required(uri, "token");
        int protocol = Integer.parseInt(required(uri, "protocol"));
        String expiresAt = required(uri, "expiresAt");
        String tls = required(uri, "tls").replace(":", "").toLowerCase(Locale.ROOT);
        if (protocol != 1) throw new IllegalArgumentException("PC 协议版本不兼容");
        if (port < 1 || port > 65535) throw new IllegalArgumentException("端口无效");
        if (!tls.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("TLS 指纹无效");
        Instant.parse(expiresAt); // Validate syntax; only the computer can check the one-use token's expiry.
        String alternatives=uri.getQueryParameter("hosts");
        java.util.List<String> hosts=alternatives==null?java.util.List.of(host):java.util.Arrays.asList(alternatives.substring(0,Math.min(256,alternatives.length())).split(","));
        return new PairingPayload(serverId, host, port, token, protocol, expiresAt, tls,hosts);
    }

    private static PairingPayload parseCompact(String raw) {
        String[] p = raw.split("\\|", -1);
        if (p.length != 7) throw new IllegalArgumentException("配对二维码格式无效");
        int port = Integer.parseInt(p[3]); long expires = Long.parseLong(p[5]); String tls = p[6].replace(":", "").toLowerCase(Locale.ROOT);
        if (port < 1 || port > 65535) throw new IllegalArgumentException("端口无效");
        if (!tls.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("TLS 指纹无效");
        return new PairingPayload(p[1], p[2], port, p[4], 1, Instant.ofEpochSecond(expires).toString(), tls);
    }

    private static String required(Uri uri, String name) {
        String value = uri.getQueryParameter(name);
        if (value == null || value.isBlank()) throw new IllegalArgumentException("配对链接缺少 " + name);
        return value;
    }
}
