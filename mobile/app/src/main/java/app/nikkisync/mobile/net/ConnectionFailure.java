package app.nikkisync.mobile.net;

/** Safe UI categories only: never expose URLs, request signatures or server response bodies. */
public enum ConnectionFailure {
    UNREACHABLE, CONNECTION_REFUSED, TIMED_OUT, ADDRESS_UNAVAILABLE, PAIRING_REJECTED, CERTIFICATE_CHANGED;

    public static ConnectionFailure from(Throwable error) {
        for(int depth=0;error!=null&&depth<8;depth++,error=error.getCause()) {
            if(error instanceof SignedHttpClient.HttpStatusException status&&(status.status==401||status.status==403))return PAIRING_REJECTED;
            if(error instanceof javax.net.ssl.SSLPeerUnverifiedException
                    ||error instanceof java.security.cert.CertificateException)return CERTIFICATE_CHANGED;
            if(error instanceof java.net.SocketTimeoutException)return TIMED_OUT;
            if(error instanceof java.net.UnknownHostException)return ADDRESS_UNAVAILABLE;
            if(error instanceof java.net.ConnectException)return CONNECTION_REFUSED;
        }
        return UNREACHABLE;
    }
    public boolean requiresPairing(){return this==PAIRING_REJECTED||this==CERTIFICATE_CHANGED;}
    public String message(){return this==PAIRING_REJECTED?"电脑已拒绝原配对 · 请重新扫码配对":
            this==CERTIFICATE_CHANGED?"电脑证书与原配对不符 · 请确认电脑后重新配对":
            this==CONNECTION_REFUSED?"电脑未接受连接 · 正在自动重试":
            this==TIMED_OUT?"连接电脑超时 · 正在自动重试":
            this==ADDRESS_UNAVAILABLE?"电脑地址暂不可用 · 正在自动重试":"电脑暂不可达 · 正在自动重试";}
}
