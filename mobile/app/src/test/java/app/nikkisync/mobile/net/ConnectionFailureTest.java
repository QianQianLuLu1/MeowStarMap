package app.nikkisync.mobile.net;
import org.junit.Test;
import static org.junit.Assert.*;
public class ConnectionFailureTest {
    @Test public void timeoutRetriesWithoutAskingToErasePairing(){
        assertEquals(ConnectionFailure.TIMED_OUT,ConnectionFailure.from(new java.net.SocketTimeoutException()));
        assertFalse(ConnectionFailure.from(new java.net.SocketTimeoutException()).requiresPairing());
        assertEquals(ConnectionFailure.CONNECTION_REFUSED,ConnectionFailure.from(new java.net.ConnectException()));
        assertEquals(ConnectionFailure.ADDRESS_UNAVAILABLE,ConnectionFailure.from(new java.net.UnknownHostException()));
    }
    @Test public void rejectedIdentityAndChangedCertificateHaveDifferentSafeMessages(){
        assertEquals(ConnectionFailure.PAIRING_REJECTED,ConnectionFailure.from(new SignedHttpClient.HttpStatusException(401,"private response")));
        assertEquals(ConnectionFailure.CERTIFICATE_CHANGED,ConnectionFailure.from(new javax.net.ssl.SSLHandshakeException("failed"){ {initCause(new java.security.cert.CertificateException("private certificate"));} }));
        assertFalse(ConnectionFailure.PAIRING_REJECTED.message().contains("private response"));
    }
}
