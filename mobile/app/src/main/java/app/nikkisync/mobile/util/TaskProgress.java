package app.nikkisync.mobile.util;

@FunctionalInterface
public interface TaskProgress {
    TaskProgress NONE=(stage,completed,total)->{};
    /** total <= 0 means unknown; completion is reported only after the relevant work succeeds. */
    void update(String stage,long completed,long total);
}
