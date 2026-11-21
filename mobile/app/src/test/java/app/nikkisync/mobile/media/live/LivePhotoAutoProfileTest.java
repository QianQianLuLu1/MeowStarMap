package app.nikkisync.mobile.media.live;

import android.content.Context;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowBuild;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk={30,31,35})
public class LivePhotoAutoProfileTest {
    private Context context;
    @Before public void setup() {
        context=RuntimeEnvironment.getApplication();
        context.getSharedPreferences("nikkisync_live_export",Context.MODE_PRIVATE).edit().clear().commit();
    }
    private void device(String manufacturer,String brand) {
        ShadowBuild.setManufacturer(manufacturer);ShadowBuild.setBrand(brand);
    }
    @Test public void huaweiAutomaticallyUsesTheReportedWorkingContainer() {
        device("HUAWEI","HUAWEI");
        assertEquals("huawei_legacy_tail",LivePhotoControls.selectedProfile(context).id);
        device("huawei","Huawei");
        assertEquals("huawei_legacy_tail",LivePhotoControls.selectedProfile(context).id);
    }
    @Test public void honorHasAnIndependentAutomaticCompatibilityRoute() {
        device("HONOR","HONOR");
        assertEquals("honor_moving_compat",LivePhotoControls.selectedProfile(context).id);
        device("HUAWEI","HONOR");
        assertEquals("Honor brand must win on older Huawei-manufactured devices",
                "honor_moving_compat",LivePhotoControls.selectedProfile(context).id);
    }
    @Test public void explicitUserChoiceSurvivesUpgradeAndInvalidChoiceUsesCurrentDefault() {
        for(String manufacturer:new String[]{"HUAWEI","HONOR"}) {
            device(manufacturer,manufacturer);
            for(var profile:LivePhotoProfile.values()) {
                context.getSharedPreferences("nikkisync_live_export",Context.MODE_PRIVATE)
                        .edit().putString("profile_override",profile.id).commit();
                assertEquals(profile,LivePhotoControls.selectedProfile(context));
            }
            context.getSharedPreferences("nikkisync_live_export",Context.MODE_PRIVATE)
                    .edit().putString("profile_override","retired-profile").commit();
            assertEquals(manufacturer.equals("HONOR")?"honor_moving_compat":"huawei_legacy_tail",
                    LivePhotoControls.selectedProfile(context).id);
        }
    }
    @Test public void otherManufacturersKeepTheirExistingDefaults() {
        for(String[] pair:new String[][]{{"Xiaomi","xiaomi_compat"},{"OnePlus","oplus_olive"},
                {"vivo","vivo_legacy_pair"},{"Samsung","samsung_sef_legacy"},{"unknown","google_motion_v1"}}) {
            device(pair[0],pair[0]);assertEquals(pair[1],LivePhotoControls.selectedProfile(context).id);
        }
        assertEquals(LivePhotoProfile.STANDARD,LivePhotoProfile.defaultFor(null,null));
    }
}
