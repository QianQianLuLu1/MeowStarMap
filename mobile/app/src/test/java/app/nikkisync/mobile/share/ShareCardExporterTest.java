package app.nikkisync.mobile.share;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import org.robolectric.annotation.GraphicsMode;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.ArrayList;
import java.util.List;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public final class ShareCardExporterTest {
    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE)
    public void effectBadgesDrawTheMatchingPoseAndLightingArtwork() {
        Bitmap pose = Bitmap.createBitmap(32, 32, Bitmap.Config.ARGB_8888);
        Bitmap light = Bitmap.createBitmap(32, 32, Bitmap.Config.ARGB_8888);
        pose.eraseColor(Color.RED);
        light.eraseColor(Color.GREEN);
        var payload = ShareCardPayloadBuilder.build("photo", "", "", """
                {"pose":{"id":"1090012102","name":"浮荧共舞"},
                 "lighting":{"id":"HueEdgeLight_001_R","name":"柔黄-右","strength":89}}
                """);
        var page = ShareCardLayout.pages(payload).get(0);
        Bitmap rendered = ShareCardExporter.renderPage(null, payload, page, 0, 1,
                java.util.Map.of("effect:pose", pose, "effect:lighting", light));
        try {
            assertEquals(Color.RED, rendered.getPixel(716, 1430));
            assertEquals(Color.GREEN, rendered.getPixel(716, 1554));
        } finally { rendered.recycle(); pose.recycle(); light.recycle(); }
    }

    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE)
    public void actualPixelsShowPartIconsAndWarmPinkAccent() throws Exception {
        Bitmap background=Bitmap.createBitmap(1440,1800,Bitmap.Config.ARGB_8888);
        Canvas source=new Canvas(background);Paint fill=new Paint();
        fill.setShader(new android.graphics.LinearGradient(0,0,1440,1800,0xFF705773,0xFFE9BCB4,android.graphics.Shader.TileMode.CLAMP));
        source.drawRect(0,0,1440,1800,fill);
        java.util.Map<String,Bitmap> icons=new java.util.HashMap<>();
        List<ShareCardPayload.Item> parts=new ArrayList<>();
        for(int i=0;i<12;i++) {
            Bitmap icon=Bitmap.createBitmap(128,128,Bitmap.Config.ARGB_8888);
            Canvas c=new Canvas(icon);fill.setShader(null);fill.setColor(i%2==0?0xFFFFEBC8:0xFFF6BCC0);
            c.drawCircle(64,64,48,fill);icons.put("part-"+i,icon);
            parts.add(new ShareCardPayload.Item("饰品",i==2?"":i==3?"一件需要完整换行展示的长名字":"示例部件 "+(i+1),"part-"+i));
        }
        var payload=new ShareCardPayload("synthetic","2026-10-08","2.0",parts,
                List.of(new ShareCardPayload.Item("焦距","54"),new ShareCardPayload.Item("光圈","16"),
                        new ShareCardPayload.Item("亮度","100"),new ShareCardPayload.Item("曝光","-0.5"),
                        new ShareCardPayload.Item("柔光强度","8"),new ShareCardPayload.Item("对比度","79")),
                List.of(new ShareCardPayload.Item("动作","示例动作"),new ShareCardPayload.Item("滤镜","粉樱 · 100%")));
        Bitmap rendered=ShareCardExporter.renderPage(background,payload,ShareCardLayout.pages(payload).get(0),0,1,icons);
        try {
            assertEquals(0xFFF6BCC0,rendered.getPixel(100,172));
            assertEquals(0xFFFFEBC8,rendered.getPixel(175,399));
            java.io.File output=new java.io.File("build/outputs/share-card-preview.png");
            output.getParentFile().mkdirs();
            try(var stream=new java.io.FileOutputStream(output)) {assertTrue(rendered.compress(Bitmap.CompressFormat.PNG,100,stream));}
        } finally {rendered.recycle();background.recycle();for(Bitmap icon:icons.values())icon.recycle();}
    }
    @Test public void renderUsesPortraitMinimumSizeWithoutBackground() {
        ShareCardPayload payload = new ShareCardPayload(
                "asset-1",
                "2026-09-22T10:00:00Z",
                "1.5",
                List.of(new ShareCardPayload.Item("发型", "星河长发")),
                List.of(new ShareCardPayload.Item("焦距", "55")),
                List.of(new ShareCardPayload.Item("滤镜", "粉樱 · 31%"))
        );

        Bitmap bitmap = ShareCardExporter.render(null, payload);
        try {
            assertEquals(ShareCardExporter.WIDTH, bitmap.getWidth());
            assertEquals(1740, bitmap.getHeight());
        } finally {
            bitmap.recycle();
        }
    }

    @Test public void renderGrowsForLongOutfitList() {
        List<ShareCardPayload.Item> outfit = new ArrayList<>();
        for (int index = 0; index < 24; index++) {
            outfit.add(new ShareCardPayload.Item("饰品 " + index, "测试服装 " + index));
        }
        ShareCardPayload payload = new ShareCardPayload(
                "asset-2",
                null,
                null,
                outfit,
                List.of(),
                List.of()
        );

        Bitmap bitmap = ShareCardExporter.render(null, payload);
        try {
            assertEquals(ShareCardExporter.WIDTH, bitmap.getWidth());
            assertTrue(bitmap.getHeight() > 1740);
            assertTrue(bitmap.getHeight() <= 4096);
        } finally {
            bitmap.recycle();
        }
    }

    @Test public void renderAcceptsBitmapBackgroundThroughOffscreenPath() {
        Bitmap background = Bitmap.createBitmap(160, 240, Bitmap.Config.ARGB_8888);
        ShareCardPayload payload = new ShareCardPayload(
                "asset-3",
                null,
                null,
                List.of(),
                List.of(),
                List.of()
        );

        Bitmap rendered = ShareCardExporter.render(background, payload);
        try {
            assertEquals(ShareCardExporter.WIDTH, rendered.getWidth());
            assertEquals(1740, rendered.getHeight());
        } finally {
            rendered.recycle();
            background.recycle();
        }
    }
}
