package app.nikkisync.mobile.security;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import java.io.*;
import java.security.*;
import java.security.cert.Certificate;
import java.security.spec.*;
import java.util.*;
import javax.crypto.*;
import javax.crypto.spec.SecretKeySpec;
import static org.junit.Assert.*;

/** Real JCA AES-GCM, with an in-memory stand-in for the hardware wrapping key only. */
@RunWith(RobolectricTestRunner.class)
@org.robolectric.annotation.Config(sdk={30,31,32,35})
public class DeviceIdentityTest {
    private Context context;
    private Provider[] originalProviders;
    private Provider desktopEd25519;
    private static final Map<String, Key> WRAPPING_KEYS = new HashMap<>();

    @Before public void setup() {
        context = RuntimeEnvironment.getApplication();
        originalProviders = Security.getProviders();
        desktopEd25519 = Security.getProvider("SunEC");
        for (String name : List.of("nikkisync.identity", "nikkisync.secure", "nikkisync.server"))
            context.getSharedPreferences(name, 0).edit().clear().commit();
        WRAPPING_KEYS.clear();
        assertNull(Security.getProvider("AndroidKeyStore"));
        Provider wrapping = new Provider("AndroidKeyStore", 1.0, "Unit-test wrapping key") {};
        wrapping.put("KeyStore.AndroidKeyStore", MemoryKeyStore.class.getName());
        wrapping.put("KeyGenerator.AES", WrappingKeyGenerator.class.getName());
        Security.insertProviderAt(wrapping, 1);
    }

    @After public void cleanup() {
        Security.removeProvider("AndroidKeyStore");
        Security.removeProvider("UninitializedEd25519");
        for (int i = 0; i < originalProviders.length; i++)
            if (Security.getProvider(originalProviders[i].getName()) == null)
                Security.insertProviderAt(originalProviders[i], i + 1);
        WRAPPING_KEYS.clear();
    }

    private static void preferIncompatibleEd25519Provider() {
        // Android may have no exportable Ed25519 provider to fall through to.
        // Desktop JCA otherwise silently hides the bug by retrying SunEC/BC.
        for (Provider existing : Security.getProviders()) {
            if (existing.getService("KeyPairGenerator", "Ed25519") != null
                    || existing.getService("KeyFactory", "Ed25519") != null
                    || existing.getService("Signature", "Ed25519") != null)
                Security.removeProvider(existing.getName());
        }
        Provider provider = new Provider("UninitializedEd25519", 1.0, "Models Android keystore-only Ed25519") {};
        provider.put("KeyPairGenerator.Ed25519", UninitializedGenerator.class.getName());
        provider.put("KeyFactory.Ed25519", KeystoreOnlyFactory.class.getName());
        provider.put("Signature.Ed25519", KeystoreOnlySignature.class.getName());
        Security.insertProviderAt(provider, 1);
    }

    @Test public void firstLaunchAndRestartWorkWithKeystoreOnlyDefaultEd25519() throws Exception {
        preferIncompatibleEd25519Provider();
        assertEquals("UninitializedEd25519", KeyPairGenerator.getInstance("Ed25519").getProvider().getName());
        DeviceIdentity first = DeviceIdentity.getOrCreate(context);
        byte[] message = "GET\n/v1/assets\n123\nnonce\nhash".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        assertValidSignature(first, message);
        DeviceIdentity restarted = DeviceIdentity.getOrCreate(context);
        assertEquals(first.deviceId(), restarted.deviceId());
        assertEquals(first.publicKeyBase64Url(), restarted.publicKeyBase64Url());
        assertFalse(restarted.wasRecovered());
        assertValidSignature(restarted, message);
        assertNotNull(context.getSharedPreferences("nikkisync.secure", 0).getString("ed25519.private.pkcs8", null));
    }

    @Test public void upgradePreservesLegacyKeyAndPairingWithIncompatibleProvider() throws Exception {
        KeyPair legacy = KeyPairGenerator.getInstance("Ed25519", "SunEC").generateKeyPair();
        String publicKey = Base64.getUrlEncoder().withoutPadding().encodeToString(legacy.getPublic().getEncoded());
        new SecureBlobStore(context).put("ed25519.private.pkcs8", legacy.getPrivate().getEncoded());
        context.getSharedPreferences("nikkisync.identity", 0).edit()
                .putString("deviceId", "android_existing").putString("publicKey", publicKey).commit();
        context.getSharedPreferences("nikkisync.server", 0).edit().putString("serverId", "paired_pc").commit();
        preferIncompatibleEd25519Provider();
        DeviceIdentity restored = DeviceIdentity.getOrCreate(context);
        assertEquals("android_existing", restored.deviceId());
        assertEquals(publicKey, restored.publicKeyBase64Url());
        assertFalse(restored.wasRecovered());
        assertEquals("paired_pc", context.getSharedPreferences("nikkisync.server", 0).getString("serverId", null));
        assertValidSignature(restored, new byte[]{1, 2, 3});
    }

    private void assertValidSignature(DeviceIdentity identity, byte[] message) throws Exception {
        Signature verifier = Signature.getInstance("Ed25519", desktopEd25519);
        verifier.initVerify(KeyFactory.getInstance("Ed25519", desktopEd25519).generatePublic(
                new X509EncodedKeySpec(Base64.getUrlDecoder().decode(identity.publicKeyBase64Url()))));
        verifier.update(message);
        assertTrue("Signature must remain compatible with the PC protocol", verifier.verify(
                Base64.getUrlDecoder().decode(identity.signBase64Url(message))));
    }

    public static final class UninitializedGenerator extends KeyPairGeneratorSpi {
        @Override public void initialize(int size, SecureRandom random) { throw new IllegalArgumentException("KeyGenParameterSpec required"); }
        @Override public KeyPair generateKeyPair() { throw new IllegalStateException("Not initialized"); }
    }
    public static final class KeystoreOnlyFactory extends KeyFactorySpi {
        @Override protected PublicKey engineGeneratePublic(KeySpec spec) throws InvalidKeySpecException { throw new InvalidKeySpecException("Keystore keys only"); }
        @Override protected PrivateKey engineGeneratePrivate(KeySpec spec) throws InvalidKeySpecException { throw new InvalidKeySpecException("Keystore keys only"); }
        @Override protected <T extends KeySpec> T engineGetKeySpec(Key key, Class<T> type) throws InvalidKeySpecException { throw new InvalidKeySpecException(); }
        @Override protected Key engineTranslateKey(Key key) throws InvalidKeyException { throw new InvalidKeyException(); }
    }
    public static final class KeystoreOnlySignature extends SignatureSpi {
        @Override protected void engineInitVerify(PublicKey key) throws InvalidKeyException { throw new InvalidKeyException("Keystore keys only"); }
        @Override protected void engineInitSign(PrivateKey key) throws InvalidKeyException { throw new InvalidKeyException("Keystore keys only"); }
        @Override protected void engineUpdate(byte b) { throw new AssertionError(); }
        @Override protected void engineUpdate(byte[] b, int off, int len) { throw new AssertionError(); }
        @Override protected byte[] engineSign() { throw new AssertionError(); }
        @Override protected boolean engineVerify(byte[] sig) { throw new AssertionError(); }
        @Override protected void engineSetParameter(String name, Object value) { throw new UnsupportedOperationException(); }
        @Override protected Object engineGetParameter(String name) { throw new UnsupportedOperationException(); }
    }
    public static final class WrappingKeyGenerator extends KeyGeneratorSpi {
        private String alias;
        @Override protected void engineInit(SecureRandom random) { throw new UnsupportedOperationException(); }
        @Override protected void engineInit(int size, SecureRandom random) { throw new UnsupportedOperationException(); }
        @Override protected void engineInit(AlgorithmParameterSpec spec, SecureRandom random) {
            alias = ((KeyGenParameterSpec) spec).getKeystoreAlias();
        }
        @Override protected SecretKey engineGenerateKey() {
            byte[] bytes = new byte[32]; new SecureRandom().nextBytes(bytes);
            SecretKey key = new SecretKeySpec(bytes, "AES"); WRAPPING_KEYS.put(alias, key); return key;
        }
    }
    public static final class MemoryKeyStore extends KeyStoreSpi {
        @Override public Key engineGetKey(String alias, char[] password) { return WRAPPING_KEYS.get(alias); }
        @Override public boolean engineContainsAlias(String alias) { return WRAPPING_KEYS.containsKey(alias); }
        @Override public void engineDeleteEntry(String alias) { WRAPPING_KEYS.remove(alias); }
        @Override public void engineLoad(InputStream stream, char[] password) {}
        @Override public void engineStore(OutputStream stream, char[] password) { throw new UnsupportedOperationException(); }
        @Override public Certificate[] engineGetCertificateChain(String alias) { return null; }
        @Override public Certificate engineGetCertificate(String alias) { return null; }
        @Override public Date engineGetCreationDate(String alias) { return null; }
        @Override public void engineSetKeyEntry(String alias, Key key, char[] password, Certificate[] chain) { throw new UnsupportedOperationException(); }
        @Override public void engineSetKeyEntry(String alias, byte[] key, Certificate[] chain) { throw new UnsupportedOperationException(); }
        @Override public void engineSetCertificateEntry(String alias, Certificate cert) { throw new UnsupportedOperationException(); }
        @Override public Enumeration<String> engineAliases() { return Collections.enumeration(WRAPPING_KEYS.keySet()); }
        @Override public int engineSize() { return WRAPPING_KEYS.size(); }
        @Override public boolean engineIsKeyEntry(String alias) { return WRAPPING_KEYS.containsKey(alias); }
        @Override public boolean engineIsCertificateEntry(String alias) { return false; }
        @Override public String engineGetCertificateAlias(Certificate cert) { return null; }
    }
}
