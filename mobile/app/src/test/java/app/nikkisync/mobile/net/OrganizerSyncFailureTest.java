package app.nikkisync.mobile.net;
import org.junit.Test;
import static org.junit.Assert.*;
public class OrganizerSyncFailureTest {
    private String message(Throwable error)throws Exception{
        return (String)Class.forName("app.nikkisync.mobile.net.OrganizerSyncFailure").getMethod("message",Throwable.class).invoke(null,error);
    }
    @Test public void failureMessagesHaveAnActionWithoutLeakingResponseBodiesOrPretendingToDelete()throws Exception{
        String secret="secret-path-and-token";
        assertTrue(message(new SignedHttpClient.HttpStatusException(413,secret)).contains("更新电脑端"));
        assertTrue(message(new SignedHttpClient.HttpStatusException(403,secret)).contains("重新扫码"));
        assertTrue(message(new java.io.IOException(secret)).contains("自动重试"));
        for(Throwable error:new Throwable[]{new SignedHttpClient.HttpStatusException(413,secret),new SignedHttpClient.HttpStatusException(500,secret),new java.io.IOException(secret)}){
            assertFalse(message(error).contains(secret));assertTrue(message(error).contains("整理同步"));
        }
    }
}
