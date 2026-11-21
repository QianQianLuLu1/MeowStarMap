package app.nikkisync.mobile.widget;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.List;

/** Each desktop frame keeps its own current URI; library changes never shift an index. */
final class PhotoAlbumWidgetState {
    static final long INTERVAL_MS = 30 * 60 * 1000L;
    private final SharedPreferences prefs;
    PhotoAlbumWidgetState(Context context) {
        prefs = context.getApplicationContext().getSharedPreferences("momo.photo.widgets", Context.MODE_PRIVATE);
    }
    String current(int id) { return prefs.getString("uri." + id, ""); }
    int select(int id, List<String> photos, long now, boolean next, boolean timed) {
        if (photos.isEmpty()) return -1;
        int index = photos.indexOf(current(id));
        if (index < 0) return 0;
        long last = prefs.getLong("time." + id, now);
        return next || (timed && (now < last || now - last >= INTERVAL_MS))
                ? (index + 1) % photos.size() : index;
    }
    void displayed(int id, String uri, long now) {
        if (!uri.equals(current(id))) prefs.edit().putString("uri." + id, uri).putLong("time." + id, now).apply();
    }
    void remove(int id) { prefs.edit().remove("uri." + id).remove("time." + id).apply(); }
}
