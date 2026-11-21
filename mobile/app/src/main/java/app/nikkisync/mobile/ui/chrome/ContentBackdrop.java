package app.nikkisync.mobile.ui.chrome;

import android.graphics.Canvas;
import android.graphics.RecordingCanvas;
import android.graphics.RenderNode;
import android.view.View;

/** A hardware display list containing content only. Owned by exactly one ChromeHost. */
public final class ContentBackdrop implements AutoCloseable {
    private final View source;
    private final RenderNode node = new RenderNode("NikkiSync content backdrop");
    private boolean closed;
    public ContentBackdrop(View source){this.source=source; node.setClipToBounds(false);}
    public void record(int width,int height){
        if(closed || width<=0 || height<=0) return;
        node.setPosition(0,0,width,height);
        RecordingCanvas canvas=node.beginRecording(width,height);
        try { source.draw(canvas); } finally { node.endRecording(); }
    }
    public void draw(Canvas canvas){
        if(closed) return;
        if(canvas.isHardwareAccelerated()) {
            if(node.hasDisplayList()) canvas.drawRenderNode(node);
        } else source.draw(canvas);
    }
    @Override public void close(){closed=true;node.discardDisplayList();}
}
