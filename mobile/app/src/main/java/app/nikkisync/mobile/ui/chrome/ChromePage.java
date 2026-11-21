package app.nikkisync.mobile.ui.chrome;

import android.app.Activity;
import android.view.View;
import android.widget.*;
import app.nikkisync.mobile.model.Models.AssetSummary;
import app.nikkisync.mobile.net.NikkiSyncClient;

/** App-owned page, not a second Window: preserves its exact views during back preview. */
public final class ChromePage {
    public interface Owner {ChromeNavigationHost navigationHost();}
    private final Activity activity;
    private final ChromeHost chrome;
    private final MonetBackgroundController monet=new MonetBackgroundController();
    private final MonetBackgroundView background;
    public ChromePage(Activity activity){
        this.activity=activity;chrome=new ChromeHost(activity);background=new MonetBackgroundView(activity);
        background.setPhotoMode(true);
        chrome.contentLayer().addView(background,new FrameLayout.LayoutParams(-1,-1));monet.restore(activity,background);
    }
    public void photo(NikkiSyncClient client,AssetSummary asset){if(asset!=null)monet.updatePhoto(activity,client,asset,background);}
    public void useAmbientBackground(){background.setVisibility(View.GONE);chrome.contentLayer().setBackgroundResource(app.nikkisync.mobile.R.drawable.bg_gallery_ambient);chrome.limitTopBlurToHeader();}
    public void setContentView(View content){
        LinearLayout body=content instanceof ScrollView scroll?(LinearLayout)scroll.getChildAt(0):(LinearLayout)content;
        View header=body.getChildAt(0);body.removeView(header);
        content.setBackgroundColor(android.graphics.Color.TRANSPARENT);
        if(content instanceof ScrollView scroll){body.setPadding(0,0,0,0);scroll.setClipToPadding(false);scroll.setOnScrollChangeListener((v,x,y,ox,oy)->background.moveBy(y-oy));}
        chrome.contentLayer().addView(content,new FrameLayout.LayoutParams(-1,-1));
        chrome.installChrome(header,new FrameLayout(activity),content);
    }
    public void addGlassControl(View control){control.setBackgroundColor(android.graphics.Color.TRANSPARENT);chrome.addDockEffect(control);}
    public void show(){((Owner)activity).navigationHost().push(chrome,monet::close);}
    public boolean isShowing(){return chrome.getParent()!=null;}
    public void dismiss(){((Owner)activity).navigationHost().dismiss(chrome);}
}
