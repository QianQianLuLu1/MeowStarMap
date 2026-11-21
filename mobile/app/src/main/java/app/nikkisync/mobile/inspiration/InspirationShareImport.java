package app.nikkisync.mobile.inspiration;

import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Treat incoming share text as user evidence, not as a guessed/verified game-code format. */
public final class InspirationShareImport {
    public record Incoming(String sourceText, String sourceUrl, String codeSuggestion, List<Uri> imageUris) {}
    private static final Pattern URL = Pattern.compile("https?://[^\\s<>]+", Pattern.CASE_INSENSITIVE);
    private InspirationShareImport() {}

    public static Incoming from(Intent intent) {
        if (intent == null || !(Intent.ACTION_SEND.equals(intent.getAction())
                || Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())))
            return new Incoming("", null, "", List.of());
        CharSequence shared = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        String source = shared == null ? "" : shared.toString();
        Matcher urls = URL.matcher(source);
        String url = urls.find() ? trimUrlPunctuation(urls.group()) : null;
        String token = source.trim();
        String suggested = token.length() <= 256 && !token.isEmpty() && !token.matches(".*\\s.*")
                && !token.startsWith("http://") && !token.startsWith("https://") ? token : "";

        LinkedHashSet<Uri> images = new LinkedHashSet<>();
        Object stream = intent.getExtras() == null ? null : intent.getExtras().get(Intent.EXTRA_STREAM);
        if (stream instanceof Uri one) add(images, one);
        if (stream instanceof ArrayList<?> many) for (Object item : many)
            if (item instanceof Uri uri) add(images, uri);
        ClipData clip = intent.getClipData();
        if (clip != null) for (int i = 0; i < clip.getItemCount(); i++) add(images, clip.getItemAt(i).getUri());
        return new Incoming(source, url, suggested, List.copyOf(images));
    }

    private static void add(LinkedHashSet<Uri> images, Uri uri) {
        if (images.size() < 5 && uri != null && "content".equals(uri.getScheme())) images.add(uri);
    }
    private static String trimUrlPunctuation(String value) {
        int end = value.length();
        while (end > 0 && ".,;!?)，。；！）".indexOf(value.charAt(end - 1)) >= 0) end--;
        return value.substring(0, end);
    }
}
