package app.nikkisync.mobile.net;

import org.junit.Test;
import static org.junit.Assert.*;

public final class ConnectionStateTest {
    @Test public void realtimeFailureDoesNotEraseSuccessfulHttpReachability() {
        ConnectionState state = new ConnectionState();
        long session = state.beginSession();
        state.httpResult(session, true);
        state.realtimeResult(session, false);
        assertTrue(state.isReachable());
        assertFalse(state.isRealtimeConnected());
        state.httpResult(session, false);
        assertFalse(state.isReachable());
    }

    @Test public void realtimeSuccessSurvivesHttpFailureAndReconnectRestoresReachability() {
        ConnectionState state = new ConnectionState();
        long session = state.beginSession();
        state.realtimeResult(session, true);
        state.httpResult(session, false);
        assertTrue(state.isReachable());
        state.realtimeResult(session, false);
        assertFalse(state.isReachable());
        state.realtimeResult(session, true);
        assertTrue(state.isReachable());
        assertTrue(state.isRealtimeConnected());
    }

    @Test public void previousConnectionCallbacksCannotChangeNewSession() {
        ConnectionState state = new ConnectionState();
        long old = state.beginSession();
        state.httpResult(old, true);
        long current = state.beginSession();
        assertFalse(state.isReachable());
        state.realtimeResult(old, true);
        state.httpResult(old, true);
        assertFalse(state.isReachable());
        state.httpResult(current, true);
        state.httpResult(old, false);
        assertTrue(state.isReachable());
    }
}
