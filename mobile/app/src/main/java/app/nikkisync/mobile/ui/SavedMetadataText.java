package app.nikkisync.mobile.ui;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** Player-facing outfit copy; raw photo metadata remains in the underlying snapshot. */
public final class SavedMetadataText {
    private SavedMetadataText() {}

    public static String summary(String metadataJson) {
        if (metadataJson == null || metadataJson.isBlank()) return "暂无可展示的穿搭信息";
        try {
            JSONObject metadata = new JSONObject(metadataJson);
            JSONObject dressing = metadata.optJSONObject("dressing");
            JSONArray clothes = dressing == null ? null : dressing.optJSONArray("clothes");
            if (clothes == null) return "暂无可展示的穿搭信息";
            int count = 0;
            for (int i = 0; i < clothes.length(); i++) {
                JSONObject clothing = clothes.optJSONObject(i);
                if (clothing != null && clothing.has("id") && !clothing.isNull("id")
                        && !String.valueOf(clothing.opt("id")).isBlank()) count++;
            }
            return count == 0 ? "暂无可展示的穿搭信息" : "穿搭：" + count + " 件";
        } catch (Exception ignored) {
            return "暂无可展示的穿搭信息";
        }
    }

    public static List<String> clothingLines(String metadataJson) {
        if (metadataJson == null || metadataJson.isBlank()) return List.of();
        try {
            JSONObject metadata = new JSONObject(metadataJson);
            JSONObject dressing = metadata.optJSONObject("dressing");
            JSONArray clothes = dressing == null ? null : dressing.optJSONArray("clothes");
            if (clothes == null || clothes.length() == 0) return List.of();

            List<String> result = new ArrayList<>();
            for (int i = 0; i < clothes.length(); i++) {
                JSONObject clothing = clothes.optJSONObject(i);
                if (clothing == null || !clothing.has("id") || clothing.isNull("id")) continue;
                String id = String.valueOf(clothing.opt("id")).trim();
                if (id.isEmpty()) continue;
                String name = PlayerFacingDetails.clothingName(clothing.optString("name", ""), id);
                String category = clothing.optString("category", "").trim();
                String label = categoryLabel(category);
                result.add(category.isEmpty() || label.equals(category)
                        ? name
                        : name + " · " + label);
            }
            return List.copyOf(result);
        } catch (Exception ignored) {
            return List.of();
        }
    }

    public static String categoryLabel(String category) {
        if (category == null) category = "";
        return switch (category) {
            case "hair" -> "发型";
            case "dresses" -> "连衣裙";
            case "outerwear" -> "外套";
            case "tops" -> "上衣";
            case "bottoms" -> "下装";
            case "socks" -> "袜子";
            case "shoes" -> "鞋子";
            case "hairAccessories" -> "发饰";
            case "headwear" -> "帽子";
            case "earrings" -> "耳饰";
            case "neckwear" -> "颈饰";
            case "bracelets" -> "腕饰";
            case "chokers" -> "项圈";
            case "gloves" -> "手套";
            case "faceDecorations" -> "面饰";
            case "chestAccessories" -> "胸饰";
            case "pendants" -> "挂饰";
            case "backpieces" -> "背饰";
            case "rings" -> "戒指";
            case "armDecorations" -> "臂饰";
            case "handhelds" -> "手持物";
            case "bodyPaint" -> "肤绘";
            case "fullMakeup" -> "全妆";
            case "baseMakeup" -> "底妆";
            case "eyebrows" -> "眉妆";
            case "eyelashes" -> "睫毛";
            case "contacts" -> "美瞳";
            case "lips" -> "唇妆";
            case "skinTones" -> "肤色";
            default -> category.isEmpty() ? "未知部位" : category;
        };
    }

}
