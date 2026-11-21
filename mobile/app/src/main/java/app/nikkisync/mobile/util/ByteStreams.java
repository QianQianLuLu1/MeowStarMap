package app.nikkisync.mobile.util;

import java.io.*;
import java.util.Objects;

/** Stream operations unavailable on Android 11/12; never closes the caller's stream. */
public final class ByteStreams {
    private ByteStreams() {}

    public static byte[] readAllBytes(InputStream input) throws IOException {
        var output = new ByteArrayOutputStream();
        copy(input, output);
        return output.toByteArray();
    }

    public static byte[] readNBytes(InputStream input, int length) throws IOException {
        if (length < 0) throw new IllegalArgumentException("negative byte count");
        var output = new ByteArrayOutputStream(Math.min(length, 8192));
        byte[] buffer = new byte[Math.min(length, 8192)];
        int remaining = length;
        while (remaining > 0) {
            int count = readNBytes(input, buffer, 0, Math.min(remaining, buffer.length));
            if (count == 0) break;
            output.write(buffer, 0, count);
            remaining -= count;
        }
        return output.toByteArray();
    }

    public static int readNBytes(InputStream input, byte[] target, int offset, int length) throws IOException {
        Objects.requireNonNull(input); Objects.requireNonNull(target);
        if (offset < 0 || length < 0 || offset > target.length - length) throw new IndexOutOfBoundsException();
        int total = 0;
        while (total < length) {
            interrupted();
            int count = input.read(target, offset + total, length - total);
            if (count < 0) break;
            if (count == 0) {
                int single = input.read();
                if (single < 0) break;
                target[offset + total++] = (byte) single;
            } else total += count;
        }
        return total;
    }

    public static void skipNBytes(InputStream input, long length) throws IOException {
        while (length > 0) {
            interrupted();
            long skipped = input.skip(length);
            if (skipped < 0 || skipped > length) throw new IOException("invalid skip result");
            if (skipped == 0) {
                if (input.read() < 0) throw new EOFException("truncated stream");
                skipped = 1;
            }
            length -= skipped;
        }
    }

    /** A null output discards bytes while still reading, e.g. for DigestInputStream validation. */
    public static long copy(InputStream input, OutputStream output) throws IOException {
        byte[] buffer = new byte[8192]; long total = 0; int count;
        while ((count = input.read(buffer)) != -1) {
            interrupted();
            if (count == 0) {
                int single = input.read(); if (single < 0) break;
                if (output != null) output.write(single);
                total++;
            } else {
                if (output != null) output.write(buffer, 0, count);
                total += count;
            }
        }
        return total;
    }

    private static void interrupted() throws InterruptedIOException {
        if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException("已取消读取");
    }
}
