package __PACKAGE__;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.widget.RemoteViews;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/** Home-screen widget: today's tasks, ticked and not ticked. The app hands it the task list; it only displays it. */
public class TodayWidgetProvider extends AppWidgetProvider {

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) {
            draw(context, manager, id);
        }
        manager.notifyAppWidgetViewDataChanged(ids, R.id.widget_list);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        String action = intent == null ? null : intent.getAction();
        // A new day (or a changed clock / time zone): show the new day's tasks.
        if (Intent.ACTION_DATE_CHANGED.equals(action) || Intent.ACTION_TIME_CHANGED.equals(action)
                || Intent.ACTION_TIMEZONE_CHANGED.equals(action)) {
            refreshAll(context);
        }
    }

    /** Redraws every placed copy of the widget. Safe to call when none is placed. */
    public static void refreshAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, TodayWidgetProvider.class));
        if (ids == null || ids.length == 0) return;
        for (int id : ids) {
            draw(context, manager, id);
        }
        manager.notifyAppWidgetViewDataChanged(ids, R.id.widget_list);
    }

    private static void draw(Context context, AppWidgetManager manager, int id) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.today_widget);

        List<TodayWidgetService.Item> items = TodayWidgetService.loadToday(context);
        int done = 0;
        for (TodayWidgetService.Item item : items) {
            if (item.done) done++;
        }
        views.setTextViewText(R.id.widget_date, new SimpleDateFormat("EEE, MMM d", Locale.getDefault()).format(new Date()));
        views.setTextViewText(R.id.widget_count, items.isEmpty() ? "" : done + " of " + items.size() + " done");

        Intent service = new Intent(context, TodayWidgetService.class);
        service.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id);
        service.setData(Uri.parse(service.toUri(Intent.URI_INTENT_SCHEME)));
        views.setRemoteAdapter(R.id.widget_list, service);
        views.setEmptyView(R.id.widget_list, R.id.widget_empty);

        Intent open = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (open != null) {
            PendingIntent pending = PendingIntent.getActivity(context, 0, open,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            views.setOnClickPendingIntent(R.id.widget_header, pending);
            views.setOnClickPendingIntent(R.id.widget_empty, pending);
            views.setPendingIntentTemplate(R.id.widget_list, pending);
        }
        manager.updateAppWidget(id, views);
    }
}
