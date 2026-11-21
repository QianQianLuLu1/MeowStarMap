package app.nikkisync.mobile.storage;

import android.content.Context;
import android.content.SharedPreferences;

import app.nikkisync.mobile.model.Models.AssetSummary;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.time.DateTimeException;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/** Remembers the latest newly discovered shooting batch for each paired computer. */
public final class RecentPhotoBatchStore {
    private static final long SAME_SHOOT_MS = 30 * 60 * 1000L;
    private final SharedPreferences preferences;

    private record Batch(Set<String> ids, long anchorEpoch, long updatedAt) {}

    public RecentPhotoBatchStore(Context context) {
        preferences = context.getApplicationContext().getSharedPreferences("recent_photo_batches", Context.MODE_PRIVATE);
    }

    public synchronized Set<String> load(String scope) {
        return Set.copyOf(read(scope).ids());
    }

    public synchronized Set<String> reconcile(String scope, Collection<String> previousIds,
                                               boolean hasBaseline, List<AssetSummary> current) {
        return reconcile(scope, previousIds, hasBaseline, current, System.currentTimeMillis());
    }

    synchronized Set<String> reconcile(String scope, Collection<String> previousIds,
                                       boolean hasBaseline, List<AssetSummary> current, long now) {
        if (scope == null || scope.isBlank()) return Set.of();
        Batch old = read(scope);
        if (!hasBaseline) {
            write(scope, new Batch(Set.of(), Long.MIN_VALUE, now));
            return Set.of();
        }
        Set<String> known = new HashSet<>(previousIds);
        Set<String> available = new HashSet<>();
        List<AssetSummary> added = new ArrayList<>();
        for (AssetSummary asset : current) {
            if (asset.assetId() == null || asset.assetId().isBlank()) continue;
            available.add(asset.assetId());
            if (!known.contains(asset.assetId())) added.add(asset);
        }
        LinkedHashSet<String> retained = new LinkedHashSet<>(old.ids());
        retained.retainAll(available);
        if (added.isEmpty()) {
            if (!retained.equals(old.ids())) write(scope, new Batch(retained, old.anchorEpoch(), old.updatedAt()));
            return Set.copyOf(retained);
        }
        long anchor = added.stream().mapToLong(asset -> captureEpoch(asset.capturedAt())).max().orElse(Long.MIN_VALUE);
        if (anchor == Long.MIN_VALUE) anchor = now;
        boolean sameShoot = !retained.isEmpty() && old.anchorEpoch() != Long.MIN_VALUE
                && Math.abs(anchor - old.anchorEpoch()) <= SAME_SHOOT_MS;
        LinkedHashSet<String> next = sameShoot ? retained : new LinkedHashSet<>();
        for (AssetSummary asset : added) next.add(asset.assetId());
        write(scope, new Batch(next, sameShoot ? Math.max(anchor, old.anchorEpoch()) : anchor, now));
        return Set.copyOf(next);
    }

    private Batch read(String scope) {
        if (scope == null || scope.isBlank()) return new Batch(Set.of(), Long.MIN_VALUE, 0);
        String raw = preferences.getString("batch:" + scope, null);
        if (raw == null) return new Batch(Set.of(), Long.MIN_VALUE, 0);
        try {
            JSONObject json = new JSONObject(raw);
            JSONArray array = json.getJSONArray("ids");
            Set<String> ids = new LinkedHashSet<>();
            for (int i = 0; i < array.length(); i++) {
                String id = array.optString(i, "");
                if (!id.isBlank()) ids.add(id);
            }
            return new Batch(ids, json.optLong("anchorEpoch", Long.MIN_VALUE), json.optLong("updatedAt", 0));
        } catch (JSONException error) {
            return new Batch(Set.of(), Long.MIN_VALUE, 0);
        }
    }

    private void write(String scope, Batch batch) {
        try {
            JSONObject json = new JSONObject();
            json.put("ids", new JSONArray(batch.ids()));
            json.put("anchorEpoch", batch.anchorEpoch());
            json.put("updatedAt", batch.updatedAt());
            preferences.edit().putString("batch:" + scope, json.toString()).commit();
        } catch (JSONException error) {
            throw new IllegalStateException("Cannot save recent photo batch", error);
        }
    }

    private static long captureEpoch(String raw) {
        if (raw == null || raw.isBlank()) return Long.MIN_VALUE;
        String value = raw.trim();
        try { return Instant.parse(value).toEpochMilli(); }
        catch (DateTimeException | ArithmeticException ignored) {}
        try { return OffsetDateTime.parse(value).toInstant().toEpochMilli(); }
        catch (DateTimeException | ArithmeticException ignored) {}
        try { return LocalDateTime.parse(value.replace(' ', 'T')).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli(); }
        catch (DateTimeException | ArithmeticException ignored) { return Long.MIN_VALUE; }
    }
}
