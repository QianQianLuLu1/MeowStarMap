package app.nikkisync.mobile.privacy;

import android.content.Context;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/** Bundled legal text is available without a network, paired computer, or consent. */
public final class PrivacyDocuments {
    private PrivacyDocuments(){}
    public static String read(Context context,String kind) throws IOException {
        String file=switch(kind){case "privacy"->"PRIVACY_POLICY.md";case "terms"->"USER_AGREEMENT.md";case "permissions"->"PERMISSIONS_DATA.md";case "services"->"SDK_SERVICES.md";default->throw new IllegalArgumentException("未知文档");};
        try(var input=context.getAssets().open("legal/"+file)){return new String(app.nikkisync.mobile.util.ByteStreams.readAllBytes(input),StandardCharsets.UTF_8);}
    }
    public static String display(String text){return text.replaceAll("(?m)^#{1,6} ","").replace("**","").replace("`","").replaceAll("\\[([^\\]]+)\\]\\((https?://[^)]+)\\)","$1（$2）");}
}
