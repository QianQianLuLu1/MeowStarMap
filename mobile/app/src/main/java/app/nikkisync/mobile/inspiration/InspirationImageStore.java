package app.nikkisync.mobile.inspiration;

import android.content.ContentResolver;
import android.content.Context;
import android.net.Uri;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.UUID;

/** Copies user-selected reference images into app-private storage; never edits the shared original URI. */
public final class InspirationImageStore {
    public static final long MAX_BYTES = 15L * 1024 * 1024;
    public record Saved(String localName, String mimeType, long bytes) {}
    private final File directory;

    public InspirationImageStore(Context context) {
        directory = new File(context.getApplicationContext().getFilesDir(), "inspiration/images");
    }

    public Saved copyUri(ContentResolver resolver, Uri uri) throws IOException {
        if (uri == null || !"content".equals(uri.getScheme()))
            throw new IOException("Reference image must be a content URI");
        String mime = resolver.getType(uri);
        InputStream stream = resolver.openInputStream(uri);
        if (stream == null) throw new IOException("Cannot open reference image");
        return copy(stream, mime);
    }

    public Saved copy(InputStream input, String mimeType) throws IOException { return copy(input, mimeType, MAX_BYTES); }

    Saved copy(InputStream input, String mimeType, long limit) throws IOException {
        if (input == null) throw new IOException("Invalid reference image stream");
        if (limit < 1) { input.close(); throw new IOException("Invalid reference image size limit"); }
        String extension;
        try {
            extension = extension(mimeType);
            Files.createDirectories(directory.toPath());
        } catch (IOException error) {
            try { input.close(); } catch (IOException closeError) { error.addSuppressed(closeError); }
            throw error;
        }
        String name = UUID.randomUUID() + extension;
        File output = resolve(name), temporary = new File(directory, name + ".tmp");
        long size = 0;
        try (InputStream source = input;
             OutputStream target = Files.newOutputStream(temporary.toPath(), StandardOpenOption.CREATE_NEW)) {
            byte[] buffer = new byte[64 * 1024]; int count;
            while ((count = source.read(buffer)) != -1) {
                size += count;
                if (size > limit) throw new IOException("Reference image exceeds the 15 MB limit");
                target.write(buffer, 0, count);
            }
            if (size == 0) throw new IOException("Reference image is empty");
        } catch (Exception error) {
            Files.deleteIfExists(temporary.toPath());
            if (error instanceof IOException io) throw io;
            throw new IOException("Unable to copy reference image", error);
        }
        try {
            try { Files.move(temporary.toPath(), output.toPath(), StandardCopyOption.ATOMIC_MOVE); }
            catch (AtomicMoveNotSupportedException unsupported) {
                Files.move(temporary.toPath(), output.toPath());
            }
            return new Saved(name, mimeType, size);
        } finally { Files.deleteIfExists(temporary.toPath()); }
    }

    public File resolve(String localName) {
        if (localName == null || !localName.matches("[a-f0-9-]{36}\\.(jpg|png|webp|heic)"))
            throw new IllegalArgumentException("Invalid private reference image name");
        return new File(directory, localName);
    }

    /** Deletes only an app-private copy after rollback or explicit removal of its reference. */
    public void deleteLocal(String localName) throws IOException { Files.deleteIfExists(resolve(localName).toPath()); }

    private static String extension(String mime) throws IOException {
        if (mime == null) throw new IOException("Reference image type is missing");
        return switch (mime.toLowerCase(java.util.Locale.ROOT)) {
            case "image/jpeg", "image/jpg" -> ".jpg";
            case "image/png" -> ".png";
            case "image/webp" -> ".webp";
            case "image/heic", "image/heif" -> ".heic";
            default -> throw new IOException("Unsupported reference image type: " + mime);
        };
    }
}
