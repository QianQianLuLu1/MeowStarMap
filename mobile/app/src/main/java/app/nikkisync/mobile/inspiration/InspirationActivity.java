package app.nikkisync.mobile.inspiration;

import android.os.Bundle;
import android.widget.FrameLayout;
import androidx.activity.ComponentActivity;
import app.nikkisync.mobile.R;
import app.nikkisync.mobile.ui.chrome.ChromeNavigationHost;
import app.nikkisync.mobile.ui.chrome.ChromePage;

/** External Android shares use the same page and editor as the in-app inspiration library. */
public final class InspirationActivity extends ComponentActivity implements ChromePage.Owner {
    private ChromeNavigationHost navigation;
    private InspirationPage page;
    @Override public ChromeNavigationHost navigationHost(){return navigation;}
    @Override protected void onCreate(Bundle state){
        super.onCreate(state);
        getWindow().setDecorFitsSystemWindows(false);
        getWindow().setStatusBarColor(android.graphics.Color.TRANSPARENT);
        getWindow().setNavigationBarColor(android.graphics.Color.TRANSPARENT);
        getWindow().setNavigationBarContrastEnforced(false);
        navigation=new ChromeNavigationHost(this);navigation.bind(this);
        if(!new app.nikkisync.mobile.privacy.PrivacyConsentStore(this).accepted()){
            app.nikkisync.mobile.privacy.PrivacyUi.showConsent(this,navigation,this::openSharedInspiration);return;
        }
        openSharedInspiration();
    }
    private void openSharedInspiration(){
        if(isFinishing()||isDestroyed()||!new app.nikkisync.mobile.privacy.PrivacyConsentStore(this).accepted())return;
        FrameLayout root=new FrameLayout(this);root.setBackgroundResource(R.drawable.bg_gallery_ambient);
        navigation.setRoot(root);setContentView(navigation);
        page=InspirationPage.show(this,()->{if(!isFinishing())finish();});page.receiveIntent(getIntent());
    }
    @Override protected void onStop(){if(navigation!=null)navigation.interrupt();super.onStop();}
    @Override protected void onResume(){super.onResume();if(page!=null&&!new app.nikkisync.mobile.privacy.PrivacyConsentStore(this).accepted())finish();}
    @Override protected void onDestroy(){if(navigation!=null)navigation.close();if(page!=null)page.close();super.onDestroy();}
}
