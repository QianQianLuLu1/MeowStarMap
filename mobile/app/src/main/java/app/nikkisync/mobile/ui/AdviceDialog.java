package app.nikkisync.mobile.ui;

import android.app.Activity;
import android.app.Dialog;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Small, readable app-styled explanation for errors and share-time decisions. */
public final class AdviceDialog {
    private AdviceDialog() {}

    public static void show(Activity activity, String title, String body,
                            String primaryLabel, Runnable primaryAction,
                            String secondaryLabel, Runnable secondaryAction) {
        if (activity.isFinishing() || activity.isDestroyed()) return;
        Dialog dialog = new Dialog(activity);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        LinearLayout panel = new LinearLayout(activity);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(activity,22),dp(activity,22),dp(activity,22),dp(activity,18));
        GradientDrawable surface = new GradientDrawable();surface.setColor(0xfffffbf8);
        surface.setCornerRadius(dp(activity,28));surface.setStroke(dp(activity,1),0xffead8dc);
        panel.setBackground(surface);

        TextView heading = new TextView(activity);heading.setText(title);heading.setTextSize(20);
        heading.setTypeface(Typeface.DEFAULT_BOLD);heading.setTextColor(0xff30282c);
        panel.addView(heading,new LinearLayout.LayoutParams(-1,-2));
        TextView explanation = new TextView(activity);explanation.setText(body);explanation.setTextSize(15);
        explanation.setTextColor(0xff5f5258);explanation.setLineSpacing(dp(activity,4),1f);
        LinearLayout.LayoutParams explanationLayout=new LinearLayout.LayoutParams(-1,-2);
        explanationLayout.topMargin=dp(activity,12);explanationLayout.bottomMargin=dp(activity,20);
        panel.addView(explanation,explanationLayout);

        LinearLayout actions=new LinearLayout(activity);actions.setGravity(Gravity.END);
        if(secondaryLabel!=null&&!secondaryLabel.isBlank()){
            Button secondary=button(activity,secondaryLabel,false);
            secondary.setOnClickListener(v->{dialog.dismiss();if(secondaryAction!=null)secondaryAction.run();});
            actions.addView(secondary,new LinearLayout.LayoutParams(0,dp(activity,48),1));
        }
        Button primary=button(activity,primaryLabel,true);
        primary.setOnClickListener(v->{dialog.dismiss();if(primaryAction!=null)primaryAction.run();});
        LinearLayout.LayoutParams primaryLayout=new LinearLayout.LayoutParams(0,dp(activity,48),1);
        if(actions.getChildCount()>0)primaryLayout.leftMargin=dp(activity,10);
        actions.addView(primary,primaryLayout);panel.addView(actions,new LinearLayout.LayoutParams(-1,-2));

        dialog.setContentView(panel);
        Window window=dialog.getWindow();
        if(window!=null){
            window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);window.setDimAmount(.42f);
            int width=Math.min(activity.getResources().getDisplayMetrics().widthPixels-dp(activity,36),dp(activity,420));
            window.setLayout(width,WindowManager.LayoutParams.WRAP_CONTENT);
        }
        dialog.show();
        if(window!=null){
            int width=Math.min(activity.getResources().getDisplayMetrics().widthPixels-dp(activity,36),dp(activity,420));
            window.setLayout(width,WindowManager.LayoutParams.WRAP_CONTENT);
        }
    }

    private static Button button(Activity activity,String label,boolean primary){
        Button button=new Button(activity,null,0);button.setText(label);button.setAllCaps(false);
        button.setTextSize(14);button.setTextColor(0xff30282c);button.setGravity(Gravity.CENTER);
        GradientDrawable background=new GradientDrawable();background.setColor(primary?0xfff3b6bf:0xfffffbf8);
        background.setCornerRadius(dp(activity,24));background.setStroke(dp(activity,1),primary?0xffdf9eaa:0xffe4d1d5);
        button.setBackground(background);button.setStateListAnimator(null);return button;
    }
    private static int dp(Activity activity,int value){return Math.round(value*activity.getResources().getDisplayMetrics().density);}
}
