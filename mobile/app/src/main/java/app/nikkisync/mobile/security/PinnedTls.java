package app.nikkisync.mobile.security;

import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Locale;

import app.nikkisync.mobile.util.Hex;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.X509TrustManager;

public final class PinnedTls {
    private final String expectedFingerprint;
    private final SSLSocketFactory socketFactory;

    public PinnedTls(String expectedFingerprint) throws Exception {
        this.expectedFingerprint = expectedFingerprint.replace(":", "").toLowerCase(Locale.ROOT);
        X509TrustManager trustManager = new X509TrustManager() {
            @Override public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                throw new CertificateException("client certificate is not used");
            }

            @Override public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                if (chain == null || chain.length == 0) throw new CertificateException("missing server certificate");
                try {
                    String actual = Hex.lower(MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded()));
                    if (!actual.equals(PinnedTls.this.expectedFingerprint)) {
                        throw new CertificateException("NikkiSync TLS fingerprint mismatch");
                    }
                } catch (CertificateException error) {
                    throw error;
                } catch (Exception error) {
                    throw new CertificateException(error);
                }
            }

            @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        };
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, new X509TrustManager[]{trustManager}, new SecureRandom());
        socketFactory = context.getSocketFactory();
    }

    public SSLSocketFactory socketFactory() { return socketFactory; }

    /** Hostname is not a second trust root: the exact leaf certificate is pinned from the QR payload. */
    public HostnameVerifier hostnameVerifier() { return (hostname, session) -> true; }
}
