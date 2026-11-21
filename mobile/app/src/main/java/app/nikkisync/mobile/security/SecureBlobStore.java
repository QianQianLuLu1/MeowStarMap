package app.nikkisync.mobile.security;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Base64;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class SecureBlobStore {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String WRAP_ALIAS = "nikkisync.device.wrap.v1";
    private final SharedPreferences prefs;

    SecureBlobStore(Context context) {
        prefs = context.getSharedPreferences("nikkisync.secure", Context.MODE_PRIVATE);
    }

    void put(String name, byte[] value) throws Exception {
        SecretKey key = getOrCreateKey();
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] encrypted = cipher.doFinal(value);
        String encoded = Base64.getEncoder().encodeToString(cipher.getIV()) + "." +
                Base64.getEncoder().encodeToString(encrypted);
        prefs.edit().putString(name, encoded).apply();
    }

    byte[] get(String name) throws Exception {
        String encoded = prefs.getString(name, null);
        if (encoded == null) return null;
        String[] parts = encoded.split("\\.", 2);
        if (parts.length != 2) throw new IllegalStateException("secure blob is corrupt");
        byte[] iv = Base64.getDecoder().decode(parts[0].getBytes(StandardCharsets.US_ASCII));
        byte[] encrypted = Base64.getDecoder().decode(parts[1].getBytes(StandardCharsets.US_ASCII));
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(128, iv));
        return cipher.doFinal(encrypted);
    }

    void resetWrappingKeyAndBlobs() throws Exception {
        KeyStore store = KeyStore.getInstance(KEYSTORE);
        store.load(null);
        if (store.containsAlias(WRAP_ALIAS)) store.deleteEntry(WRAP_ALIAS);
        prefs.edit().clear().commit();
    }

    private SecretKey getOrCreateKey() throws Exception {
        KeyStore store = KeyStore.getInstance(KEYSTORE);
        store.load(null);
        if (store.containsAlias(WRAP_ALIAS)) return (SecretKey) store.getKey(WRAP_ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(
                WRAP_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build());
        return generator.generateKey();
    }
}
