package __PACKAGE__;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.style.StrikethroughSpan;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/** Supplies the rows of the widget's list: today's tasks from the list the app last handed over. */
public class TodayWidgetService extends RemoteViewsService {

    public static final String PREFS = "cheqlist_widget";
    public static final String KEY_TASKS = "tasks";

    public static class Item {
        public String text;
        public boolean done;
    }

    /** Today's tasks (by the phone's own date), not-ticked first, then ticked, each group in the app's order. */
    public static List<Item> loadToday(Context context) {
        List<Item> open = new ArrayList<Item>();
        List<Item> closed = new ArrayList<Item>();
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            JSONArray all = new JSONArray(prefs.getString(KEY_TASKS, "[]"));
            String today = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
            for (int i = 0; i < all.length(); i++) {
                JSONObject o = all.optJSONObject(i);
                if (o == null || !today.equals(o.optString("d"))) continue;
                Item item = new Item();
                item.text = o.optString("t");
                item.done = o.optInt("x", 0) == 1;
                if (item.text.length() == 0) continue;
                if (item.done) closed.add(item); else open.add(item);
            }
        } catch (Exception ignored) {
            // unreadable data: show an empty list rather than crash
        }
        open.addAll(closed);
        return open;
    }

    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new Factory(getApplicationContext());
    }

    private static class Factory implements RemoteViewsFactory {
        private final Context context;
        private List<Item> items = new ArrayList<Item>();

        Factory(Context context) {
            this.context = context;
        }

        @Override public void onCreate() { items = loadToday(context); }
        @Override public void onDataSetChanged() { items = loadToday(context); }
        @Override public void onDestroy() { items.clear(); }
        @Override public int getCount() { return items.size(); }

        @Override
        public RemoteViews getViewAt(int position) {
            if (position < 0 || position >= items.size()) return null;
            Item item = items.get(position);
            RemoteViews row = new RemoteViews(context.getPackageName(), R.layout.today_widget_item);
            row.setImageViewResource(R.id.widget_item_check, item.done ? R.drawable.widget_checked : R.drawable.widget_unchecked);
            if (item.done) {
                SpannableString struck = new SpannableString(item.text);
                struck.setSpan(new StrikethroughSpan(), 0, struck.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                row.setTextViewText(R.id.widget_item_text, struck);
                row.setTextColor(R.id.widget_item_text, context.getColor(R.color.widget_muted));
            } else {
                row.setTextViewText(R.id.widget_item_text, item.text);
                row.setTextColor(R.id.widget_item_text, context.getColor(R.color.widget_ink));
            }
            row.setOnClickFillInIntent(R.id.widget_item_root, new Intent());
            return row;
        }

        @Override public RemoteViews getLoadingView() { return null; }
        @Override public int getViewTypeCount() { return 1; }
        @Override public long getItemId(int position) { return position; }
        @Override public boolean hasStableIds() { return false; }
    }
}
