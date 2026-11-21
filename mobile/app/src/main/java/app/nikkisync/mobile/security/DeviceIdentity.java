package app.nikkisync.mobile.security;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyPermanentlyInvalidatedException;

import java.security.InvalidKeyException;
import java.util.Base64;
import java.util.UUID;

import javax.crypto.AEADBadTagException;

import app.nikkisync.mobile.storage.ServerStore;

public final class DeviceIdentity {
    private static final String PRIVATE_KEY = "ed25519.private.pkcs8";
    private final String deviceId;
    private final byte[] publicKeyDer;
    private final Ed25519IdentityKey privateKey;
    private final boolean recovered;

    private DeviceIdentity(String deviceId, byte[] publicKeyDer, Ed25519IdentityKey privateKey, boolean recovered) {
        this.deviceId = deviceId;
        this.publicKeyDer = publicKeyDer;
        this.privateKey = privateKey;
        this.recovered = recovered;
    }

    public static DeviceIdentity getOrCreate(Context context) throws Exception {
        SharedPreferences prefs = context.getSharedPreferences("nikkisync.identity", Context.MODE_PRIVATE);
        SecureBlobStore secure = new SecureBlobStore(context);
        String deviceId = prefs.getString("deviceId", null);
        String publicKey = prefs.getString("publicKey", null);
        byte[] privateKey;
        boolean recovered = false;
        try {
            privateKey = secure.get(PRIVATE_KEY);
        } catch (Exception error) {
            if (!isRecoverableKeystoreFailure(error)) throw error;
            secure.resetWrappingKeyAndBlobs();
            prefs.edit().remove("publicKey").commit();
            new ServerStore(context).clear();
            publicKey = null;
            privateKey = null;
            recovered = true;
        }
        if (deviceId != null && publicKey != null && privateKey != null) {
            return new DeviceIdentity(deviceId, Base64.getUrlDecoder().decode(publicKey),
                    Ed25519IdentityKey.fromPkcs8(privateKey), recovered);
        }
        Ed25519IdentityKey pair = Ed25519IdentityKey.generate();
        if (deviceId == null) deviceId = "android_" + UUID.randomUUID().toString().replace("-", "");
        byte[] publicKeyDer = pair.publicKeyDer();
        publicKey = Base64.getUrlEncoder().withoutPadding().encodeToString(publicKeyDer);
        secure.put(PRIVATE_KEY, pair.pkcs8());
        prefs.edit().putString("deviceId", deviceId).putString("publicKey", publicKey).commit();
        return new DeviceIdentity(deviceId, publicKeyDer, pair, recovered);
    }

    private static boolean isRecoverableKeystoreFailure(Throwable error) {
        for (Throwable current = error; current != null; current = current.getCause()) {
            if (current instanceof KeyPermanentlyInvalidatedException
                    || current instanceof AEADBadTagException
                    || current instanceof InvalidKeyException) return true;
        }
        return false;
    }

    public String deviceId() { return deviceId; }

    public boolean wasRecovered() { return recovered; }

    public String publicKeyBase64Url() {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(publicKeyDer);
    }

    public String signBase64Url(byte[] message) throws Exception {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(privateKey.sign(message));
    }
}
