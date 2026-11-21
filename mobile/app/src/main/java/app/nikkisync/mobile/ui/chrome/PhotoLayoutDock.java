package app.nikkisync.mobile.ui.chrome;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.*;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.view.animation.PathInterpolator;
import android.widget.*;
import java.util.function.IntConsumer;

/** View implementation of PhotoLayout PLFloatingBottomDock geometry and selection motion. */
public final class PhotoLayoutDock extends FrameLayout {
    private final View indicator;
    private final LinearLayout row;
    private float position;
    private int selected;
    private ValueAnimator animator;
    public PhotoLayoutDock(Context context,IntConsumer onSelect){
        super(context);
        indicator=new View(context);
        GradientDrawable shape=new GradientDrawable();shape.setColor(0x18ffffff);shape.setCornerRadius(dp(20));shape.setStroke(dp(.75f),0x55ffffff);
        indicator.setBackground(shape);
        indicator.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        LayoutParams indicatorParams=new LayoutParams(0,dp(56));indicatorParams.leftMargin=dp(6);indicatorParams.topMargin=dp(6);
        addView(indicator,indicatorParams);
        row=new LinearLayout(context);row.setGravity(Gravity.CENTER_VERTICAL);
        LayoutParams rowParams=new LayoutParams(-1,dp(56));rowParams.setMargins(dp(6),dp(6),dp(6),dp(6));addView(row,rowParams);
        String[] labels={"图库","已保存","我的"};
        for(int i=0;i<labels.length;i++){
            final int tab=i;
            FrameLayout item=new FrameLayout(context);
            item.setContentDescription(labels[i]);item.setClickable(true);item.setFocusable(true);
            item.setBackground(null);
            item.setOutlineProvider(new android.view.ViewOutlineProvider(){
                @Override public void getOutline(View view,android.graphics.Outline outline){
                    outline.setRoundRect(0,0,view.getWidth(),view.getHeight(),dp(20));
                }
            });
            item.setClipToOutline(true);
            LinearLayout contents=new LinearLayout(context);
            contents.setOrientation(LinearLayout.HORIZONTAL);
            contents.setGravity(Gravity.CENTER_VERTICAL);
            contents.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
            ImageView icon=new ImageView(context);icon.setImageDrawable(new DockIcon(i));
            contents.addView(icon,new LinearLayout.LayoutParams(dp(24),dp(24)));
            TextView label=new TextView(context);label.setText(labels[i]);label.setTextSize(14);
            label.setTypeface(Typeface.create("sans-serif-medium",Typeface.NORMAL));
            label.setSingleLine(true);label.setIncludeFontPadding(false);
            LinearLayout.LayoutParams textParams=new LinearLayout.LayoutParams(-2,-2);textParams.leftMargin=dp(7);
            contents.addView(label,textParams);
            item.addView(contents,new FrameLayout.LayoutParams(-2,-2,Gravity.CENTER));
            item.setOnClickListener(v->onSelect.accept(tab));
            LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(0,dp(56),1);if(i>0)lp.leftMargin=dp(4);
            row.addView(item,lp);
        }
        updateColors();
    }
    public void select(int tab){
        if(tab<0 || tab>=row.getChildCount())return;
        selected=tab;updateColors();
        if(animator!=null)animator.cancel();
        animator=ValueAnimator.ofFloat(position,tab);animator.setDuration(260);
        animator.setInterpolator(new PathInterpolator(.4f,0,.2f,1));
        animator.addUpdateListener(a->{position=(float)a.getAnimatedValue();placeIndicator();});animator.start();
    }
    private void updateColors(){
        for(int i=0;i<row.getChildCount();i++){
            View item=row.getChildAt(i);item.setSelected(i==selected);
            LinearLayout contents=(LinearLayout)((FrameLayout)item).getChildAt(0);
            int color=i==selected?0xff171717:0xff49454f;
            ((TextView)contents.getChildAt(1)).setTextColor(color);
            ((ImageView)contents.getChildAt(0)).getDrawable().setTint(color);
        }
    }
    @Override protected void onLayout(boolean changed,int l,int t,int r,int b){
        super.onLayout(changed,l,t,r,b);
        int width=row.getChildAt(0).getWidth();
        indicator.layout(dp(6),dp(6),dp(6)+width,dp(62));placeIndicator();
    }
    private void placeIndicator(){
        int lo=(int)Math.floor(position),hi=Math.min(lo+1,row.getChildCount()-1);
        float x=row.getChildAt(lo).getLeft()+(row.getChildAt(hi).getLeft()-row.getChildAt(lo).getLeft())*(position-lo);
        indicator.setTranslationX(x);
    }
    @Override protected void onDetachedFromWindow(){if(animator!=null)animator.cancel();position=selected;super.onDetachedFromWindow();}
    private int dp(float x){return Math.round(x*getResources().getDisplayMetrics().density);}
    private static final class DockIcon extends Drawable {
        private final int kind;private final Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG);
        DockIcon(int kind){this.kind=kind;paint.setStyle(Paint.Style.STROKE);paint.setStrokeWidth(1.8f);paint.setStrokeJoin(Paint.Join.ROUND);paint.setStrokeCap(Paint.Cap.ROUND);}
        @Override public void draw(Canvas c){int save=c.save();c.translate(getBounds().left,getBounds().top);c.scale(getBounds().width()/24f,getBounds().height()/24f);
            if(kind==0){c.drawRoundRect(3,3,21,21,2,2,paint);c.drawCircle(8,8,1.5f,paint);Path p=new Path();p.moveTo(3,17);p.lineTo(9,11);p.lineTo(13,15);p.lineTo(16,12);p.lineTo(21,17);c.drawPath(p,paint);}
            else if(kind==1){Path p=new Path();p.moveTo(6,3);p.lineTo(18,3);p.lineTo(18,21);p.lineTo(12,17);p.lineTo(6,21);p.close();c.drawPath(p,paint);}
            else {c.drawCircle(12,7,4,paint);c.drawRoundRect(4,14,20,21,5,5,paint);}c.restoreToCount(save);
        }
        @Override public void setTint(int color){paint.setColor(color);invalidateSelf();}
        @Override public void setAlpha(int alpha){paint.setAlpha(alpha);}
        @Override public void setColorFilter(ColorFilter filter){paint.setColorFilter(filter);}
        @Override public int getOpacity(){return PixelFormat.TRANSLUCENT;}
    }
}
