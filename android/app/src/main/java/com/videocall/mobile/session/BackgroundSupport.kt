package com.videocall.mobile.session

import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import com.videocall.mobile.App
import com.videocall.mobile.MainActivity
import com.videocall.mobile.net.ApiException
import com.videocall.mobile.net.Prefs

/*
 * No push service (FCM etc.) is used: this app has to work on a private
 * network and on the open internet without any third party. Reliability
 * comes from three things, in order:
 *   1. ConnectionService keeps the realtime socket alive (foreground service).
 *   2. BootReceiver starts it again after a reboot or an app update.
 *   3. UnreadPollJob checks the server every ~15 minutes with a plain HTTPS
 *      request when the service was killed by the battery manager, restarts
 *      the service, and posts an "unread messages" notification so nothing
 *      goes unnoticed.
 */

/** Restarts the connection after a reboot or an app update. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        if (!SessionManager.hasServer || Prefs.cachedUser(context) == null) return
        runCatching { ConnectionService.start(context) }
        UnreadPollJob.schedule(context)
    }
}

class UnreadPollJob : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        val ctx = applicationContext
        if (!SessionManager.hasServer || Prefs.cachedUser(ctx) == null) {
            cancel(ctx)
            return false
        }
        CoroutineScope(Dispatchers.IO).launch {
            try {
                // A live socket is already delivering everything in real time.
                if (SessionManager.me.value != null && SessionManager.ws.connected) return@launch
                runCatching { ConnectionService.start(ctx) } // may be refused in the background; the poll below still works
                val summary = SessionManager.api.unreadSummary()
                val total = summary["total"] ?: 0
                if (total == 0) {
                    Prefs.setLastPolledUnread(ctx, 0)
                } else if (total != Prefs.lastPolledUnread(ctx) && !App.isInForeground) {
                    Prefs.setLastPolledUnread(ctx, total)
                    notifyUnread(ctx, total)
                }
            } catch (e: ApiException) {
                if (e.status == 401) {
                    Prefs.setCachedUser(ctx, null)
                    cancel(ctx)
                }
            } catch (_: Exception) {
                // offline: try again next time
            } finally {
                jobFinished(params, false)
            }
        }
        return true
    }

    override fun onStopJob(params: JobParameters) = true

    private fun notifyUnread(ctx: Context, total: Int) {
        val open = PendingIntent.getActivity(
            ctx, 0, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val n = NotificationCompat.Builder(ctx, App.CHANNEL_MESSAGES)
            .setSmallIcon(com.videocall.mobile.R.drawable.ic_launcher_foreground)
            .setContentTitle("Vision Call")
            .setContentText(if (total == 1) "You have 1 unread message" else "You have $total unread messages")
            .setAutoCancel(true)
            .setContentIntent(open)
            .build()
        runCatching { NotificationManagerCompat.from(ctx).notify(NOTIF_ID, n) }
    }

    companion object {
        private const val JOB_ID = 4401
        private const val NOTIF_ID = 4401

        fun schedule(ctx: Context) {
            val js = ctx.getSystemService(JobScheduler::class.java) ?: return
            if (js.getPendingJob(JOB_ID) != null) return
            val info = JobInfo.Builder(JOB_ID, ComponentName(ctx, UnreadPollJob::class.java))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(15 * 60 * 1000L)
                .setPersisted(true)
                .build()
            runCatching { js.schedule(info) }
        }

        fun cancel(ctx: Context) {
            ctx.getSystemService(JobScheduler::class.java)?.cancel(JOB_ID)
            runCatching { NotificationManagerCompat.from(ctx).cancel(NOTIF_ID) }
        }
    }
}
