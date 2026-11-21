package app.nikkisync.mobile.media;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.media.MediaMetadataRetriever;

import java.io.File;

final class MotionFrameMatcher {
    private MotionFrameMatcher() {}

    static long findPresentationTimestampUs(File stillFile, File motionFile) {
        Bitmap still = BitmapFactory.decodeFile(stillFile.getAbsolutePath());
        if (still == null) return 0L;
        Bitmap target = Bitmap.createScaledBitmap(still, 32, 32, true); still.recycle();
        MediaMetadataRetriever retriever = new MediaMetadataRetriever();
        try {
            retriever.setDataSource(motionFile.getAbsolutePath());
            long durationUs = parseLong(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION), 0L) * 1000L;
            if (durationUs <= 0) return 0L;
            long best = 0L; double bestScore = Double.MAX_VALUE;
            for (long t = 0; t <= durationUs; t += 250_000L) {
                double score = frameScore(retriever, target, t); if (score < bestScore) { bestScore = score; best = t; }
            }
            long start = Math.max(0, best - 300_000L), end = Math.min(durationUs, best + 300_000L);
            for (long t = start; t <= end; t += 50_000L) {
                double score = frameScore(retriever, target, t); if (score < bestScore) { bestScore = score; best = t; }
            }
            return best;
        } catch (Exception ignored) { return 0L; }
        finally { target.recycle(); release(retriever); }
    }

    static int frameIndex(File motionFile, long presentationTimestampUs) {
        MediaMetadataRetriever retriever = new MediaMetadataRetriever();
        try {
            retriever.setDataSource(motionFile.getAbsolutePath());
            float fps = parseFloat(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_CAPTURE_FRAMERATE), 30f);
            long durationMs = parseLong(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION), 0L);
            int lastFrame = Math.max(0, Math.round(durationMs / 1000f * fps) - 1);
            return Math.min(Math.max(0, Math.round(presentationTimestampUs / 1_000_000f * fps)), lastFrame);
        } catch (Exception ignored) { return Math.max(0, Math.round(presentationTimestampUs / 1_000_000f * 30f)); }
        finally { release(retriever); }
    }

    private static double frameScore(MediaMetadataRetriever retriever, Bitmap target, long timeUs) {
        Bitmap frame = retriever.getFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST);
        if (frame == null) return Double.MAX_VALUE;
        Bitmap scaled = Bitmap.createScaledBitmap(frame, 32, 32, true); frame.recycle(); long sum = 0;
        for (int y = 0; y < 32; y++) for (int x = 0; x < 32; x++) {
            int a = target.getPixel(x, y), b = scaled.getPixel(x, y);
            sum += Math.abs(Color.red(a) - Color.red(b)) + Math.abs(Color.green(a) - Color.green(b)) + Math.abs(Color.blue(a) - Color.blue(b));
        }
        scaled.recycle(); return sum / (32.0 * 32.0 * 3.0);
    }

    private static long parseLong(String value, long fallback) { try { return value == null ? fallback : Long.parseLong(value); } catch (Exception ignored) { return fallback; } }
    private static float parseFloat(String value, float fallback) { try { return value == null ? fallback : Float.parseFloat(value); } catch (Exception ignored) { return fallback; } }
    private static void release(MediaMetadataRetriever retriever) { try { retriever.release(); } catch (Exception ignored) {} }
}
