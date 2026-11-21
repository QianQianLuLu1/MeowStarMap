package app.nikkisync.mobile.inspiration;

import static org.junit.Assert.*;

import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import java.util.ArrayList;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

@RunWith(RobolectricTestRunner.class)
public final class InspirationShareImportTest {
    @Test public void sharedCaptionIsPreservedWithoutGuessingAnOutfitCode() {
        Intent intent = new Intent(Intent.ACTION_SEND).setType("text/plain")
                .putExtra(Intent.EXTRA_TEXT, "搭配码在评论区\nhttps://example.com/post/7");
        var imported = InspirationShareImport.from(intent);
        assertEquals("搭配码在评论区\nhttps://example.com/post/7", imported.sourceText());
        assertEquals("https://example.com/post/7", imported.sourceUrl());
        assertEquals("", imported.codeSuggestion());
    }

    @Test public void singleTokenCanBeSuggestedButOriginalTextStaysIntact() {
        Intent intent = new Intent(Intent.ACTION_SEND).setType("text/plain")
                .putExtra(Intent.EXTRA_TEXT, "  OUTFIT-123  ");
        var imported = InspirationShareImport.from(intent);
        assertEquals("  OUTFIT-123  ", imported.sourceText());
        assertEquals("OUTFIT-123", imported.codeSuggestion());
    }

    @Test public void imageSharesKeepOnlyUniqueContentUrisAndLimitTheCount() {
        ArrayList<Uri> shared = new ArrayList<>();
        for (int i = 0; i < 7; i++) shared.add(Uri.parse("content://provider/image/" + i));
        shared.add(Uri.parse("file:///private/unsafe.jpg"));
        Intent intent = new Intent(Intent.ACTION_SEND_MULTIPLE).setType("image/*")
                .putParcelableArrayListExtra(Intent.EXTRA_STREAM, shared);
        intent.setClipData(ClipData.newRawUri("duplicate", shared.get(0)));
        var imported = InspirationShareImport.from(intent);
        assertEquals(5, imported.imageUris().size());
        assertEquals(shared.get(0), imported.imageUris().get(0));
    }
}
