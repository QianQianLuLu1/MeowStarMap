package app.nikkisync.mobile.share;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.Map;
import java.util.stream.Collectors;
import org.junit.Test;

public final class ShareCardPayloadBuilderTest {
    @Test public void buildsOrderedOutfitCameraAndEffects() {
        String metadata = """
                {
                  "camera": {
                    "focalLength": 55,
                    "exposure": -0.3,
                    "contrast": 12
                  },
                  "lighting": {
                    "name": "侧光-右",
                    "strength": 81
                  },
                  "filter": {
                    "name": "粉樱",
                    "strength": 31
                  },
                  "dressing": {
                    "clothes": [
                      {"id":"shoe-1","name":"月影鞋","category":"shoes"},
                      {"id":"hair-1","name":"星河长发","category":"hair"}
                    ]
                  }
                }
                """;

        ShareCardPayload payload = ShareCardPayloadBuilder.build(
                "asset-1",
                "2026-09-21T10:00:00Z",
                "1.5",
                metadata
        );

        assertEquals(2, payload.outfitItems().size());
        assertEquals("发型", payload.outfitItems().get(0).label());
        assertEquals("鞋子", payload.outfitItems().get(1).label());
        assertTrue(payload.cameraItems().stream().anyMatch(item -> "焦距".equals(item.label()) && "55".equals(item.value())));
        assertTrue(payload.effectItems().stream().anyMatch(item -> "光照".equals(item.label()) && item.value().contains("81%")));
        assertTrue(payload.effectItems().stream().anyMatch(item -> "滤镜".equals(item.label()) && item.value().contains("31%")));
    }

    @Test public void malformedMetadataStillProducesExportablePayload() {
        ShareCardPayload payload = ShareCardPayloadBuilder.build("asset-2", null, null, "{not-json");
        assertEquals("asset-2", payload.assetId());
        assertTrue(payload.outfitItems().isEmpty());
        assertTrue(payload.cameraItems().isEmpty());
        assertTrue(payload.effectItems().isEmpty());
    }

    @Test public void unknownNamesStayBlankButKeepPartIdentityForIcons() {
        ShareCardPayload payload = ShareCardPayloadBuilder.build("photo", "", "", """
                {"dressing":{"clothes":[
                {"id":"10200000001","category":"hair"},
                {"id":"10200000002","name":"名称待解析"},
                {"id":"10200000003","name":"10200000003"},
                {"id":"10200000004","name":"浮金星点"}]}}
                """);
        assertEquals(4, payload.outfitItems().size());
        assertEquals("10200000001", payload.outfitItems().get(0).clothingId());
        assertEquals("", payload.outfitItems().get(0).value());
        assertEquals(3, payload.outfitItems().stream().filter(item -> item.value().isEmpty()).count());
    }
    @Test public void readsCanonicalCameraKeysIncludingZeros() {
        var payload=ShareCardPayloadBuilder.build("a","","","""
                {"camera":{"apertureSection":16,"vignetteIntensity":0,"bloomIntensity":8,"bloomThreshold":1.0}}
                """);
        assertTrue(payload.cameraItems().stream().anyMatch(item -> item.label().equals("光圈") && item.value().equals("16")));
        assertTrue(payload.cameraItems().stream().anyMatch(item -> item.label().equals("晕影") && item.value().equals("0")));
        assertTrue(payload.cameraItems().stream().anyMatch(item -> item.label().equals("柔光强度") && item.value().equals("8")));
        assertTrue(payload.cameraItems().stream().anyMatch(item -> item.label().equals("柔光范围")));
    }

    @Test public void rendersTheSameCanonicalCameraValuesAsMiniProgram() {
        var payload = ShareCardPayloadBuilder.build("photo", "", "", """
                {"camera":{"focalLength":29.4,"apertureSection":1.2,"rotation":3.85,"vignetteIntensity":23,
                "bloomIntensity":95.8,"bloomThreshold":-1,"brightness":55.8,"exposure":0.16,
                "contrast":33.7,"saturation":-0.55,"vibrance":0.34,"highlights":-0.37,"shadows":-0.01}}
                """);
        var displayed = payload.cameraItems().stream().collect(Collectors.toMap(
                ShareCardPayload.Item::label,
                item -> ShareCardLayout.parameter(item.label().equals("柔光强度") ? "柔光" : item.label(),
                        item.value()).displayValue()));
        assertEquals(Map.ofEntries(
                Map.entry("焦距", "29.4mm"), Map.entry("光圈", "f/1.2"), Map.entry("镜头旋转", "3.85"),
                Map.entry("晕影", "23%"), Map.entry("柔光强度", "95.8%"), Map.entry("柔光范围", "-1"),
                Map.entry("亮度", "55.8%"), Map.entry("曝光", "0.16"), Map.entry("对比度", "33.7%"),
                Map.entry("饱和度", "-0.55"), Map.entry("自然饱和", "0.34"),
                Map.entry("高光", "-0.37"), Map.entry("阴影", "-0.01")), displayed);
    }
}
