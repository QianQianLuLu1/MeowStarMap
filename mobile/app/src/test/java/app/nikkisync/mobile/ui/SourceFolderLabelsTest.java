package app.nikkisync.mobile.ui;

import java.util.*;
import org.junit.Test;
import static org.junit.Assert.*;

public class SourceFolderLabelsTest {
    @Test public void gameFoldersExplainTheirRoleAndKeepOriginalIdentifiers(){
        assertEquals("账号相册 · UID 1001",SourceFolderLabels.title("D:\\Game\\GamePlayPhotos\\1001\\"));
        assertEquals("实况视频 · Videos",SourceFolderLabels.title("D:\\Game\\GamePlayPhotos\\1001\\Videos"));
        assertEquals("游戏截图 · ScreenShot",SourceFolderLabels.title("D:/Game/ScreenShot"));
        assertEquals("全部文件夹",SourceFolderLabels.title(null));assertEquals("未知目录",SourceFolderLabels.title(""));
    }
    @Test public void matchingFolderNamesIncludeEnoughParentsToTellMovedCopiesApart(){
        String a="D:\\OldGame\\X6Game\\Saved\\GamePlayPhotos\\1001",b="D:\\NewGame\\X6Game\\Saved\\GamePlayPhotos\\1001";
        String c="D:\\NewGame\\X6Game\\Saved\\GamePlayPhotos\\1001\\Videos",d="E:\\NewGame\\X6Game\\Saved\\GamePlayPhotos\\1001\\Videos";
        var labels=SourceFolderLabels.contexts(Arrays.asList(null,"",a,b,c,d));
        assertTrue(labels.get(a).contains("OldGame"));assertTrue(labels.get(b).contains("NewGame"));assertNotEquals(labels.get(a),labels.get(b));
        assertTrue(labels.get(c).startsWith("D:/"));assertTrue(labels.get(d).startsWith("E:/"));
        assertEquals("…/GamePlayPhotos/1001/Videos",SourceFolderLabels.contexts(List.of(c)).get(c));
    }
}
