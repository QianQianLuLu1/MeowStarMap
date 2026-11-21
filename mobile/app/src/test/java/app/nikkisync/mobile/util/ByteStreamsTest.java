package app.nikkisync.mobile.util;

import java.io.*;
import org.junit.Test;
import static org.junit.Assert.*;

public class ByteStreamsTest {
    @Test public void shortReadsAndZeroProgressDoNotTruncateData() throws Exception {
        var input = new ByteArrayInputStream(new byte[]{1,2,3,4,5}) {
            boolean zero = true;
            @Override public int read(byte[] target, int offset, int length) {
                if (zero) { zero = false; return 0; }
                return super.read(target, offset, Math.min(1, length));
            }
        };
        assertArrayEquals(new byte[]{1,2,3,4}, ByteStreams.readNBytes(input,4));
        assertArrayEquals(new byte[]{5}, ByteStreams.readAllBytes(input));
    }
    @Test public void readIsBoundedAndAllowsEndOfStream() throws Exception {
        var input = new ByteArrayInputStream(new byte[]{1,2,3});
        assertArrayEquals(new byte[0], ByteStreams.readNBytes(input,0));
        byte[] target = new byte[6];
        assertEquals(3, ByteStreams.readNBytes(input,target,1,4));
        assertArrayEquals(new byte[]{0,1,2,3,0,0},target);
        assertThrows(IllegalArgumentException.class,()->ByteStreams.readNBytes(input,-1));
        assertThrows(IndexOutOfBoundsException.class,()->ByteStreams.readNBytes(input,target,5,2));
    }
    @Test public void skipFallsBackToReadingAndRejectsTruncation() throws Exception {
        var input = new ByteArrayInputStream(new byte[]{1,2,3}) {
            @Override public long skip(long count) { return 0; }
        };
        ByteStreams.skipNBytes(input,2);assertEquals(3,input.read());
        assertThrows(EOFException.class,()->ByteStreams.skipNBytes(input,1));
    }
    @Test public void copyAndDiscardReadTheEntireInput() throws Exception {
        var input = new ByteArrayInputStream(new byte[]{1,2,3});
        var output = new ByteArrayOutputStream();
        assertEquals(3,ByteStreams.copy(input,output));assertArrayEquals(new byte[]{1,2,3},output.toByteArray());
        assertEquals(3,ByteStreams.copy(new ByteArrayInputStream(output.toByteArray()),null));
    }
    @Test public void cancellationIsPreserved() {
        Thread.currentThread().interrupt();
        try { assertThrows(InterruptedIOException.class,()->ByteStreams.readNBytes(new ByteArrayInputStream(new byte[]{1}),1)); }
        finally { Thread.interrupted(); }
    }
}
