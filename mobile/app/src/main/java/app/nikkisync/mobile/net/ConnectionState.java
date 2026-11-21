package app.nikkisync.mobile.net;

/** Main-thread connection state. A failed realtime channel is not a failed HTTP API. */
public final class ConnectionState {
    private long session;
    private boolean httpReachable;
    private boolean realtimeConnected;

    public long beginSession() {
        httpReachable = false;
        realtimeConnected = false;
        return ++session;
    }

    public long session() { return session; }
    public boolean isCurrent(long candidate) { return session == candidate; }
    public void httpResult(long candidate, boolean reachable) {
        if (isCurrent(candidate)) httpReachable = reachable;
    }
    public void realtimeResult(long candidate, boolean connected) {
        if (isCurrent(candidate)) realtimeConnected = connected;
    }
    public boolean isReachable() { return httpReachable || realtimeConnected; }
    public boolean isRealtimeConnected() { return realtimeConnected; }
}
