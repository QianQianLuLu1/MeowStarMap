package app.nikkisync.mobile.ui;

import static org.junit.Assert.*;

import java.util.List;

import org.junit.Test;

public final class SavedMetadataTextTest {
    @Test public void summaryShowsOnlyPlayerFacingOutfitCount() {
        String json = """
                {
                  "camera":{"focalLength":50,"exposure":1.2},
                  "filter":{"id":"filter-a","strength":80},
                  "lighting":{"id":"light-b","strength":40},
                  "dressing":{"clothes":[
                    {"id":"10201","name":"裙子","category":"dresses"},
                    {"id":"10202","name":"鞋子","category":"shoes"}
                  ]}
                }
                """;
        String text = SavedMetadataText.summary(json);
        assertEquals("穿搭：2 件", text);
    }

    @Test public void clothingLinesKeepHumanReadableNamesOffline() {
        String json = "{\"dressing\":{\"clothes\":[{\"id\":\"10201\",\"name\":\"裙子\",\"category\":\"dresses\"}]}}";
        assertEquals(List.of("裙子 · 连衣裙"), SavedMetadataText.clothingLines(json));
    }

    @Test public void unknownClothingNameNeverLeaksInternalId() {
        String json = "{\"dressing\":{\"clothes\":[{\"id\":\"981234\",\"category\":\"shoes\"}]}}";
        assertEquals(List.of("名称暂缺 · 鞋子"), SavedMetadataText.clothingLines(json));
        assertFalse(SavedMetadataText.summary(json).contains("981234"));
        String placeholder = "{\"dressing\":{\"clothes\":[{\"id\":\"981234\",\"name\":\"服装 981234\",\"category\":\"shoes\"}]}}";
        assertEquals(List.of("名称暂缺 · 鞋子"), SavedMetadataText.clothingLines(placeholder));
    }

    @Test public void invalidMetadataDoesNotCrashSavedDetails() {
        assertEquals("暂无可展示的穿搭信息", SavedMetadataText.summary("{broken"));
        assertTrue(SavedMetadataText.clothingLines("{broken").isEmpty());
    }
}
