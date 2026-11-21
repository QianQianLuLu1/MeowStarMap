package app.nikkisync.mobile.privacy;

import android.content.Intent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;
import android.widget.Button;
import android.graphics.drawable.GradientDrawable;
import app.nikkisync.mobile.MainActivity;
import app.nikkisync.mobile.ui.chrome.ChromeHost;
import app.nikkisync.mobile.inspiration.InspirationActivity;
import java.lang.reflect.Field;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@org.robolectric.annotation.Config(sdk={30,31,32,35},shadows=app.nikkisync.mobile.util.LegacyBluetoothDeviceShadow.class)
public final class PrivacyConsentTest {
    @Test public void currentPolicyRequiresExplicitConsentAndWithdrawalInvalidatesIt() {
        var store=new PrivacyConsentStore(RuntimeEnvironment.getApplication());
        assertFalse(store.accepted());store.accept();assertTrue(store.accepted());
        assertTrue(store.acceptedAt()>0);store.withdraw();assertFalse(store.accepted());
        RuntimeEnvironment.getApplication().getSharedPreferences("momo.privacy",0).edit().putString("version","old").commit();
        assertFalse(store.accepted());
    }
    @Test public void freshLauncherDoesNotCreateIdentityOrStartDiscoveryBeforeConsent() throws Exception {
        var controller=Robolectric.buildActivity(MainActivity.class).setup();var activity=controller.get();
        try {
            assertNull(field(activity,"identity"));assertNull(field(activity,"discovery"));assertNull(field(activity,"imageLoader"));
            assertTrue(activity.getSharedPreferences("nikkisync.identity",0).getAll().isEmpty());
            Button agree=(Button)find(activity.navigationHost(),"同意并继续");
            assertNotNull(agree);
            assertEquals(0xfff3b6bf,((GradientDrawable)agree.getBackground()).getColor().getDefaultColor());
            assertEquals(0xfffffbf8,((GradientDrawable)find(activity.navigationHost(),"隐私政策").getBackground()).getColor().getDefaultColor());
            assertEquals(1,findHost(activity.navigationHost()).effectsLayer().getChildCount());
            find(activity.navigationHost(),"隐私政策").performClick();activity.navigationHost().interrupt();
            assertEquals(1,activity.navigationHost().overlayCount());assertNull(field(activity,"identity"));
            activity.navigationHost().commit();activity.navigationHost().interrupt();
            find(activity.navigationHost(),"不同意并退出").performClick();assertTrue(activity.isFinishing());
            assertFalse(new PrivacyConsentStore(activity).accepted());
        } finally {controller.pause().stop().destroy();}
    }
    @Test public void externalShareDoesNotOpenOrCopyContentBeforeConsentAndContinuesAfterAccept() throws Exception {
        Intent share=new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT,"  OUTFIT-123  ");
        var controller=Robolectric.buildActivity(InspirationActivity.class,share).setup();var activity=controller.get();
        try {
            assertNull(field(activity,"page"));assertEquals(0,activity.databaseList().length);
            find(activity.navigationHost(),"同意并继续").performClick();org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();activity.navigationHost().interrupt();
            assertTrue(new PrivacyConsentStore(activity).accepted());assertNotNull(field(activity,"page"));
            assertNotNull(find(activity.navigationHost(),"  OUTFIT-123  "));
        } finally {controller.pause().stop().destroy();}
    }
    @Test public void agreementAndPermissionDocumentsAreOfflineAndContainRealDataDisclosure() throws Exception {
        var activity=Robolectric.buildActivity(MainActivity.class).setup().get();
        try {
            String policy=PrivacyDocuments.read(activity,"privacy");
            assertTrue(policy.contains("NUAN5"));assertTrue(policy.contains("UID"));
            assertTrue(policy.contains("https://github.com/ToStardust/NikkiSync/issues"));
            assertFalse(policy.matches("(?s).*[0-9]+@qq\\.com.*"));
            assertTrue(PrivacyDocuments.read(activity,"terms").contains("https://github.com/ToStardust/NikkiSync/issues"));
            assertTrue(PrivacyDocuments.read(activity,"permissions").contains("CAMERA"));
            assertTrue(PrivacyDocuments.read(activity,"services").contains("nuan5.pro"));
        } finally {activity.finish();((java.util.concurrent.ExecutorService)field(activity,"io")).shutdownNow();activity.navigationHost().close();}
    }
    @Test public void externalShareAlreadyOpenMustExitWhenConsentIsWithdrawnElsewhere() throws Exception {
        new PrivacyConsentStore(RuntimeEnvironment.getApplication()).accept();
        var controller=Robolectric.buildActivity(InspirationActivity.class).setup();var activity=controller.get();
        try {assertNotNull(field(activity,"page"));new PrivacyConsentStore(activity).withdraw();controller.pause().resume();assertTrue(activity.isFinishing());}
        finally {controller.pause().stop().destroy();}
    }
    private static Object field(Object value,String name) throws Exception {Field f=value.getClass().getDeclaredField(name);f.setAccessible(true);return f.get(value);}
    private static View find(View view,String text){
        if(view instanceof TextView label&&label.getText().toString().equals(text))return view;
        if(view instanceof ViewGroup group)for(int i=0;i<group.getChildCount();i++){View found=find(group.getChildAt(i),text);if(found!=null)return found;}
        return null;
    }
    private static ChromeHost findHost(View view){
        if(view instanceof ChromeHost host)return host;
        if(view instanceof ViewGroup group)for(int i=0;i<group.getChildCount();i++){
            ChromeHost found=findHost(group.getChildAt(i));if(found!=null)return found;
        }
        return null;
    }
}
