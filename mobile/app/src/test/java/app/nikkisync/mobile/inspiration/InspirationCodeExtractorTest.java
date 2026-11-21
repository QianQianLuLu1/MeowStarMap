package app.nikkisync.mobile.inspiration;

import static org.junit.Assert.*;
import java.util.List;
import org.junit.Test;

public class InspirationCodeExtractorTest {
    @Test public void findsACompleteCodeDespiteChineseEmojiAndSpacingInsideIt() {
        assertEquals(List.of("1wPXwKyiXS4#"), InspirationCodeExtractor.candidates("染色码：1wP🌸Xw中Kyi[爱心]XS4＃"));
        assertEquals(List.of("1aIusYmEei6#"), InspirationCodeExtractor.candidates("复制 1aIus Y mEei6#"));
    }
    @Test public void keepsMultipleCandidatesSeparateAndDoesNotInventMissingParts() {
        assertEquals(List.of("1wPXwKyiXS4#", "1aIusYmEei6#"), InspirationCodeExtractor.candidates("粉色1wPXwKyiXS4#\n蓝色1aIusYmEei6#"));
        assertTrue(InspirationCodeExtractor.candidates("这不是码 https://example.com/1wPXwKyiXS4#extra").isEmpty());
        assertTrue(InspirationCodeExtractor.candidates("染色码 1wPXwKyiXS4").isEmpty());
        assertTrue(InspirationCodeExtractor.candidates("1wPX[smile]wKyiXS4#").isEmpty());
    }
}
