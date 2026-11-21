package app.nikkisync.mobile.share;

import static org.junit.Assert.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import java.util.ArrayList;
import java.util.List;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public final class ShareCardLayoutTest {
    @Test public void keepsAllHundredPartsInTwoColumnsAndBoundedPages() {
        List<ShareCardPayload.Item> items = new ArrayList<>();
        for (int i=0;i<100;i++) items.add(new ShareCardPayload.Item("饰品",
                "长名称需要完整折行而不能截掉的服装部件".repeat(3), "part-"+i));
        var pages=ShareCardLayout.pages(new ShareCardPayload("a","","",items,List.of(),List.of()));
        assertTrue(pages.size()>1);
        assertEquals(100,pages.stream().mapToInt(page -> page.outfit().size()).sum());
        for(var page:pages) {
            assertTrue(page.height()<=4096);
            for(int i=0;i<page.outfit().size();i++) {
                var item=page.outfit().get(i);
                assertEquals(i%2,item.column());
                assertEquals(items.get(Integer.parseInt(item.item().clothingId().substring(5))).value(),
                        String.join("",item.lines()));
                assertTrue(310+item.y()+178+item.lines().size()*29 < page.height()-66);
            }
        }
    }
    @Test public void missingZeroUnitsAndOnlyKnownSliderDomains() {
        var empty=ShareCardLayout.pages(new ShareCardPayload("a","","",List.of(),List.of(),List.of())).get(0);
        assertEquals(12,empty.parameters().size());
        assertTrue(empty.parameters().stream().allMatch(row -> row.displayValue().equals("—") && row.ratio()==null));
        assertEquals("54mm",ShareCardLayout.parameter("焦距","54").displayValue());
        assertNull(ShareCardLayout.parameter("焦距","54").ratio());
        assertEquals("f/16",ShareCardLayout.parameter("光圈","16").displayValue());
        assertEquals("0%",ShareCardLayout.parameter("晕影","0").displayValue());
        assertEquals(Double.valueOf(0),ShareCardLayout.parameter("晕影","0").ratio());
        assertEquals(Double.valueOf(.25),ShareCardLayout.parameter("曝光","-0.5").ratio());
        assertNull(ShareCardLayout.parameter("亮度","150").ratio());
    }
}
