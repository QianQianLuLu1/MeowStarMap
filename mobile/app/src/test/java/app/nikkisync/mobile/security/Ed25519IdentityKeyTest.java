package app.nikkisync.mobile.security;

import java.security.*;
import java.security.spec.*;
import org.junit.Test;
import static org.junit.Assert.*;

public class Ed25519IdentityKeyTest {
    // Public RFC 8032 section 7.1 test vector 1; never a user's identity.
    private static final String PKCS8 = "302e020100300506032b657004220420" +
            "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
    private static byte[] hex(String text) {
        byte[] bytes = new byte[text.length() / 2];
        for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) Integer.parseInt(text.substring(i * 2, i * 2 + 2), 16);
        return bytes;
    }

    @Test public void matchesRfc8032VectorAndExactWireEncodings() throws Exception {
        Ed25519IdentityKey key = Ed25519IdentityKey.fromPkcs8(hex(PKCS8));
        assertArrayEquals(hex(PKCS8), key.pkcs8());
        assertArrayEquals(hex("302a300506032b6570032100" +
                "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"), key.publicKeyDer());
        assertArrayEquals(hex("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155" +
                "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"), key.sign(new byte[0]));
    }

    @Test public void generatedKeySurvivesPersistenceAndVerifiesInIndependentJca() throws Exception {
        Ed25519IdentityKey first = Ed25519IdentityKey.generate();
        Ed25519IdentityKey restored = Ed25519IdentityKey.fromPkcs8(first.pkcs8());
        assertArrayEquals(first.publicKeyDer(), restored.publicKeyDer());
        byte[] message = "pairing and canonical request".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        Signature verifier = Signature.getInstance("Ed25519", "SunEC");
        verifier.initVerify(KeyFactory.getInstance("Ed25519", "SunEC").generatePublic(new X509EncodedKeySpec(first.publicKeyDer())));
        verifier.update(message);
        assertTrue(verifier.verify(restored.sign(message)));
        verifier.update(new byte[]{42});
        assertFalse(verifier.verify(restored.sign(message)));
        assertFalse(java.util.Arrays.equals(first.publicKeyDer(), Ed25519IdentityKey.generate().publicKeyDer()));
    }

    @Test public void acceptsExistingJcaPkcs8WithoutChangingIdentity() throws Exception {
        KeyPair legacy = KeyPairGenerator.getInstance("Ed25519", "SunEC").generateKeyPair();
        Ed25519IdentityKey imported = Ed25519IdentityKey.fromPkcs8(legacy.getPrivate().getEncoded());
        assertArrayEquals(legacy.getPublic().getEncoded(), imported.publicKeyDer());
        assertArrayEquals(legacy.getPrivate().getEncoded(), imported.pkcs8());
    }

    @Test public void rejectsMalformedTruncatedAndDifferentAlgorithmKeys() throws Exception {
        byte[] otherAlgorithm = hex(PKCS8); otherAlgorithm[11] = 110; // X25519, not Ed25519.
        for (byte[] invalid : new byte[][]{new byte[]{1}, hex(PKCS8.substring(0, PKCS8.length() - 2)), otherAlgorithm}) {
            try { Ed25519IdentityKey.fromPkcs8(invalid); fail("Invalid identity accepted"); }
            catch (InvalidKeySpecException expected) {}
        }
    }
}
