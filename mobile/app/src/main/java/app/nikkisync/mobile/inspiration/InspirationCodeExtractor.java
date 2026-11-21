package app.nikkisync.mobile.inspiration;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Conservative suggestions for the commonly shared 11-character code ending in #.
 * This does not validate a code with the game, and never changes the original text. */
public final class InspirationCodeExtractor {
    private static final Pattern URL = Pattern.compile("https?://[^\\s]+", Pattern.CASE_INSENSITIVE);
    private InspirationCodeExtractor() {}

    public static List<String> candidates(String input) {
        if (input == null || input.isBlank() || input.length() > 20000) return List.of();
        List<int[]> urls = new ArrayList<>();
        Matcher matcher = URL.matcher(input);
        while (matcher.find()) urls.add(new int[]{matcher.start(), matcher.end()});
        LinkedHashSet<String> found = new LinkedHashSet<>();
        for (int end = 0; end < input.length() && found.size() < 20; end++) {
            char marker = input.charAt(end);
            if (marker != '#' && marker != '＃') continue;
            boolean inUrl = false;
            for (int[] url : urls) if (end >= url[0] && end < url[1]) { inUrl = true; break; }
            if (inUrl) continue;
            StringBuilder reversed = new StringBuilder();
            int at = end;
            while (at > 0 && end - at < 160 && reversed.length() < 11) {
                int point = input.codePointBefore(at);
                at -= Character.charCount(point);
                if (point == '\n' || point == '\r' || point == '#') break;
                if (point < 128 && Character.isLetterOrDigit(point)) reversed.append((char) point);
                else if (point < 128 && !Character.isWhitespace(point) && point != '[' && point != ']') break;
            }
            if (reversed.length() != 11 || reversed.charAt(10) != '1') continue;
            // A longer uninterrupted ASCII token is not safe to truncate into a candidate.
            if (at > 0 && input.charAt(at - 1) < 128 && Character.isLetterOrDigit(input.charAt(at - 1))) continue;
            found.add(reversed.reverse().append('#').toString());
        }
        return List.copyOf(found);
    }
}
