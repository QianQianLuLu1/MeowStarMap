package app.nikkisync.mobile.util;

import android.bluetooth.BluetoothDevice;
import org.robolectric.annotation.Implements;

/**
 * Robolectric 4.17's Bluetooth shadow references BluetoothAddress, absent on API 31/32.
 * Activity window/audio initialization loads that unused shadow. The app never uses
 * Bluetooth; use the actual old framework implementation for these two SDKs.
 * Keep 4.17: its native BitmapRegionDecoder is required for real pixel regression.
 */
@Implements(value=BluetoothDevice.class,minSdk=31,maxSdk=32)
public final class LegacyBluetoothDeviceShadow {}
