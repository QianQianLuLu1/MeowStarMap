package app.nikkisync.mobile.storage;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Pure projection that keeps all Saved originals and user-linked edited variants together. */
public final class SavedPhotoGroups {
    public enum MemberKind { ORIGINAL, EDITED }

    public record Member(
            MemberKind kind,
            SavedPhotoStore.Record original,
            EditedVariantStore.Variant edited
    ) {
        public static Member original(SavedPhotoStore.Record record) {
            return new Member(MemberKind.ORIGINAL, record, null);
        }

        public static Member edited(EditedVariantStore.Variant variant) {
            return new Member(MemberKind.EDITED, null, variant);
        }

        public String uri() {
            return kind == MemberKind.ORIGINAL ? original.uri() : edited.uri();
        }

        public long time() {
            return kind == MemberKind.ORIGINAL ? original.savedAt() : edited.linkedAt();
        }
    }

    public record Group(
            String assetId,
            List<Member> members,
            long activityAt,
            boolean hasMotion,
            String capturedAt,
            String gameVersion
    ) {}

    private static final class MutableGroup {
        final String assetId;
        final List<SavedPhotoStore.Record> originals = new ArrayList<>();
        final List<EditedVariantStore.Variant> edits = new ArrayList<>();
        long activityAt = Long.MIN_VALUE;
        long latestOriginalAt = Long.MIN_VALUE;
        boolean hasMotion;
        boolean hasOriginal;
        String capturedAt;
        String gameVersion;

        MutableGroup(String assetId) {
            this.assetId = assetId;
        }

        void addOriginal(SavedPhotoStore.Record record) {
            originals.add(record);
            hasOriginal = true;
            hasMotion |= record.hasMotion();
            activityAt = Math.max(activityAt, record.savedAt());
            if (record.savedAt() >= latestOriginalAt) {
                latestOriginalAt = record.savedAt();
                if (record.capturedAt() != null && !record.capturedAt().isBlank()) capturedAt = record.capturedAt();
                if (record.gameVersion() != null && !record.gameVersion().isBlank()) gameVersion = record.gameVersion();
            }
        }

        void addEdit(EditedVariantStore.Variant edit) {
            edits.add(edit);
            activityAt = Math.max(activityAt, edit.linkedAt());
        }

        Group freeze() {
            originals.sort(Comparator.comparingLong(SavedPhotoStore.Record::savedAt).reversed()
                    .thenComparing(SavedPhotoStore.Record::uri));
            edits.sort(Comparator.comparingLong(EditedVariantStore.Variant::linkedAt).reversed()
                    .thenComparing(EditedVariantStore.Variant::variantId));
            List<Member> members = new ArrayList<>(originals.size() + edits.size());
            for (SavedPhotoStore.Record record : originals) members.add(Member.original(record));
            for (EditedVariantStore.Variant edit : edits) members.add(Member.edited(edit));
            return new Group(
                    assetId,
                    List.copyOf(members),
                    activityAt == Long.MIN_VALUE ? 0L : activityAt,
                    hasMotion,
                    capturedAt,
                    gameVersion
            );
        }
    }

    private SavedPhotoGroups() {}

    public static List<Group> select(
            List<SavedPhotoStore.Record> originals,
            List<EditedVariantStore.Variant> variants,
            int filter,
            int sortMode
    ) {
        Map<String, MutableGroup> byAsset = new LinkedHashMap<>();

        if (originals != null) {
            for (SavedPhotoStore.Record record : originals) {
                if (record == null || blank(record.assetId())) continue;
                byAsset.computeIfAbsent(record.assetId(), MutableGroup::new).addOriginal(record);
            }
        }
        if (variants != null) {
            for (EditedVariantStore.Variant variant : variants) {
                if (variant == null || blank(variant.assetId())) continue;
                byAsset.computeIfAbsent(variant.assetId(), MutableGroup::new).addEdit(variant);
            }
        }

        List<MutableGroup> selected = new ArrayList<>();
        for (MutableGroup group : byAsset.values()) {
            if (filter == SavedViewState.FILTER_MOTION && (!group.hasOriginal || !group.hasMotion)) continue;
            if (filter == SavedViewState.FILTER_STILL && (!group.hasOriginal || group.hasMotion)) continue;
            selected.add(group);
        }

        Comparator<MutableGroup> ordering;
        if (sortMode == SavedViewState.SORT_CAPTURED) {
            ordering = Comparator
                    .comparingLong((MutableGroup group) -> captureTime(group.capturedAt))
                    .reversed()
                    .thenComparing(Comparator.comparingLong((MutableGroup group) -> group.activityAt).reversed())
                    .thenComparing(group -> group.assetId);
        } else {
            ordering = Comparator
                    .comparingLong((MutableGroup group) -> group.activityAt)
                    .reversed()
                    .thenComparing(group -> group.assetId);
        }
        selected.sort(ordering);

        List<Group> result = new ArrayList<>(selected.size());
        for (MutableGroup group : selected) result.add(group.freeze());
        return List.copyOf(result);
    }

    private static long captureTime(String value) {
        if (value == null || value.isBlank()) return Long.MIN_VALUE;
        try {
            return Instant.parse(value).toEpochMilli();
        } catch (Exception ignored) {
            return Long.MIN_VALUE;
        }
    }

    private static boolean blank(String value) {
        return value == null || value.isBlank();
    }
}
