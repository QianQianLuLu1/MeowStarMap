package app.nikkisync.mobile.media.live;

import java.util.Locale;

/** Container candidates, NOT a table of certified device models. SDK-only routes are not faked. */
public enum LivePhotoProfile {
    STANDARD("google_motion_v1", "标准 Motion Photo / Pixel", false, false),
    XIAOMI("xiaomi_compat", "小米 / Redmi / POCO 兼容", false, false),
    OPLUS("oplus_olive", "OPPO / 一加 / realme（实验）", true, false),
    VIVO_LEGACY_PAIR("vivo_legacy_pair", "vivo / iQOO 旧双文件（实验）", true, true),
    VIVO_SINGLE_XMP("vivo_single_xmp", "vivo / iQOO 新单文件（实验）", true, false),
    SAMSUNG_SEF("samsung_sef_legacy", "三星 SEF（实验）", true, false),
    HUAWEI_LEGACY("huawei_legacy_tail", "华为动态照片兼容", true, false),
    HONOR_COMPAT("honor_moving_compat", "荣耀动态照片兼容（实验）", true, false);

    public final String id, label;
    public final boolean experimental, paired;
    LivePhotoProfile(String id,String label,boolean experimental,boolean paired) {
        this.id=id;this.label=label;this.experimental=experimental;this.paired=paired;
    }
    public static LivePhotoProfile fromId(String id) {
        for (LivePhotoProfile p : values()) if (p.id.equals(id)) return p;
        throw new IllegalArgumentException("未知 Live 封装配置：" + id);
    }
    public String guidance() {
        return switch(this) {
            case STANDARD -> "标准单文件 Motion Photo；相册是否识别取决于相册应用及版本，不能由封装校验推断播放通过。";
            case XIAOMI -> "标准单文件加小米兼容字段；历史成功只覆盖当时单台设备，当前机型仍需检查动态、声音及重新打开后的播放。";
            case OPLUS -> "Oplus 单文件实验格式；OPPO、一加、realme 的系统、地区和相册需分别测试，不能相互继承兼容结论。";
            case VIVO_LEGACY_PAIR -> "旧式双文件实验格式，会同时保存封面与视频。请保留两者；若相册不识别，可尝试新单文件候选，不能仅按 Android 版本自动判断。";
            case VIVO_SINGLE_XMP -> "新单文件实验候选；适用边界尚未实机验证。旧双文件不识别时可手动尝试，本配置不代表所有新 vivo / iQOO 已支持。";
            case SAMSUNG_SEF -> "三星旧式 SEF 实验格式；尚未覆盖所有现代格式变体，不能保证新系统相册识别。";
            case HUAWEI_LEGACY -> "华为设备自动使用动态照片兼容格式，已有鸿蒙 4.2 单机用户反馈可用；其他系统与图库版本仍需确认。适用于 Android 兼容环境。";
            case HONOR_COMPAT -> "荣耀设备自动使用独立兼容配置；系统图库识别、完整动态和声音仍需实机确认，当前未接入荣耀官方 SDK。";
        };
    }
    /** Shared legacy container layout, with independent device routes and acceptance records. */
    public boolean usesHuaweiTail() { return this==HUAWEI_LEGACY || this==HONOR_COMPAT; }
    public static LivePhotoProfile defaultFor(String manufacturer,String brand) {
        String v=((manufacturer==null?"":manufacturer)+" "+(brand==null?"":brand)).toLowerCase(Locale.ROOT);
        // Honor can report HUAWEI as manufacturer; its brand takes priority.
        // Compatibility packaging is not an integration of Honor's official SDK.
        if(v.contains("honor")) return HONOR_COMPAT;
        if(v.contains("huawei")) return HUAWEI_LEGACY;
        if(v.contains("xiaomi") || v.contains("redmi") || v.contains("poco")) return XIAOMI;
        if(v.contains("oppo") || v.contains("oneplus") || v.contains("realme")) return OPLUS;
        if(v.contains("vivo") || v.contains("iqoo")) return VIVO_LEGACY_PAIR;
        if(v.contains("samsung")) return SAMSUNG_SEF;
        return STANDARD;
    }
}
