package app.nikkisync.mobile.ui;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;

import java.util.ArrayList;
import java.util.List;

public final class SuitSearchHistory {
    private static final String PREFS = "nikkisync_suit_search";
    private static final String KEY_RECENT = "recent_queries";
    private static final int LIMIT = 5;

    private SuitSearchHistory() {}

    public static List<String> load(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String raw = prefs.getString(KEY_RECENT, "[]");
        List<String> result = new ArrayList<>();
        try {
            JSONArray rows = new JSONArray(raw == null ? "[]" : raw);
            for (int index = 0; index < rows.length() && result.size() < LIMIT; index++) {
                String value = rows.optString(index, "").trim();
                if (!value.isEmpty() && !result.contains(value)) result.add(value);
            }
        } catch (Exception ignored) {
            // Invalid old state is treated as an empty history.
        }
        return result;
    }

    public static void record(Context context, String query) {
        String value = query == null ? "" : query.trim();
        if (value.isEmpty()) return;

        List<String> next = new ArrayList<>();
        next.add(value);
        for (String existing : load(context)) {
            if (!existing.equalsIgnoreCase(value) && next.size() < LIMIT) next.add(existing);
        }

        JSONArray rows = new JSONArray();
        for (String item : next) rows.put(item);
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_RECENT, rows.toString())
                .apply();
    }
}
