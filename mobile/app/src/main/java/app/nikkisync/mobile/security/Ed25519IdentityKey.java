package app.nikkisync.mobile.security;

import org.bouncycastle.asn1.ASN1ObjectIdentifier;
import org.bouncycastle.asn1.ASN1OctetString;
import org.bouncycastle.asn1.DEROctetString;
import org.bouncycastle.asn1.pkcs.PrivateKeyInfo;
import org.bouncycastle.asn1.x509.AlgorithmIdentifier;
import org.bouncycastle.asn1.x509.SubjectPublicKeyInfo;
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters;
import org.bouncycastle.crypto.signers.Ed25519Signer;
import java.io.IOException;
import java.security.SecureRandom;
import java.security.spec.InvalidKeySpecException;

/** Exportable protocol identity, independent of Android's keystore-only Ed25519 JCA providers.
 * The caller must continue encrypting PKCS#8 with the existing AndroidKeyStore AES-GCM key.
 * This does not install or replace any global crypto provider.
 */
final class Ed25519IdentityKey {
    private static final ASN1ObjectIdentifier ED25519 = new ASN1ObjectIdentifier("1.3.101.112");
    private final Ed25519PrivateKeyParameters key;

    private Ed25519IdentityKey(Ed25519PrivateKeyParameters key) { this.key = key; }

    static Ed25519IdentityKey generate() {
        return new Ed25519IdentityKey(new Ed25519PrivateKeyParameters(new SecureRandom()));
    }

    static Ed25519IdentityKey fromPkcs8(byte[] encoded) throws InvalidKeySpecException {
        try {
            PrivateKeyInfo info = PrivateKeyInfo.getInstance(encoded);
            if (!ED25519.equals(info.getPrivateKeyAlgorithm().getAlgorithm())
                    || info.getPrivateKeyAlgorithm().getParameters() != null)
                throw new InvalidKeySpecException("Identity must be an Ed25519 PKCS#8 key");
            byte[] seed = ASN1OctetString.getInstance(info.parsePrivateKey()).getOctets();
            if (seed.length != Ed25519PrivateKeyParameters.KEY_SIZE)
                throw new InvalidKeySpecException("Invalid Ed25519 private key length");
            return new Ed25519IdentityKey(new Ed25519PrivateKeyParameters(seed));
        } catch (IOException | IllegalArgumentException error) {
            throw new InvalidKeySpecException("Invalid identity PKCS#8", error);
        }
    }

    byte[] pkcs8() throws IOException {
        return new PrivateKeyInfo(new AlgorithmIdentifier(ED25519),
                new DEROctetString(key.getEncoded())).getEncoded();
    }

    byte[] publicKeyDer() throws IOException {
        return new SubjectPublicKeyInfo(new AlgorithmIdentifier(ED25519),
                key.generatePublicKey().getEncoded()).getEncoded();
    }

    byte[] sign(byte[] message) {
        Ed25519Signer signer = new Ed25519Signer();
        signer.init(true, key);
        signer.update(message, 0, message.length);
        return signer.generateSignature();
    }
}
