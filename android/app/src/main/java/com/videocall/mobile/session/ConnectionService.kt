package com.videocall.mobile.session

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.launch
import com.videocall.mobile.App
import com.videocall.mobile.MainActivity

/**
 * Keeps the process alive (and the realtime WebSocket connected) while the
 * app is logged in but not on an active call. This is a LAN/VPN-only
 * intranet app with no push service (deliberately no FCM/third-party
 * dependency) — the only way to still receive an incoming call while the
 * app is backgrounded is for the process itself to stay alive, which on
 * modern Android means running as a foreground service. Without this,
 * Doze/App Standby (and aggressive OEM battery managers) eventually freeze
 * network access for a backgrounded app and incoming calls silently never
 * arrive.
 *
 * CallService (a separate foreground service) takes over showing the
 * incoming/ongoing-call notification once a call actually starts; this one
 * just needs to exist so the process doesn't get killed in the meantime.
 */
class ConnectionService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    // Reconnect as soon as the phone changes networks (Wi-Fi to mobile data,
    // back in range, VPN up) instead of waiting for the old socket to time out.
    private var lastNetwork: android.net.Network? = null
    private val networkCallback = object : android.net.ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: android.net.Network) {
            val changed = lastNetwork != null && lastNetwork != network
            lastNetwork = network
            if (SessionManager.hasServer) SessionManager.ws.reconnectNow(force = changed)
        }

        // No default network left (airplane mode, Wi-Fi off): we are not reachable.
        override fun onLost(network: android.net.Network) = setOnline(false)
    }

    // Notification text follows the real socket state instead of always claiming "Connected".
    private var online = false
    private val unsubs = mutableListOf<() -> Unit>()

    private fun setOnline(value: Boolean) {
        if (online == value) return
        online = value
        getSystemService(android.app.NotificationManager::class.java).notify(NOTIF_ID, buildNotification())
    }

    override fun onCreate() {
        super.onCreate()
        runCatching {
            getSystemService(android.net.ConnectivityManager::class.java).registerDefaultNetworkCallback(networkCallback)
        }
        runCatching {
            val ws = SessionManager.ws
            online = ws.connected
            unsubs += ws.on("ws:open") { setOnline(true) }
            unsubs += ws.on("ws:close") { setOnline(false) }
        }
    }

    override fun onDestroy() {
        unsubs.forEach { it() }
        runCatching { getSystemService(android.net.ConnectivityManager::class.java).unregisterNetworkCallback(networkCallback) }
        super.onDestroy()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = buildNotification()
        // specialUse (Android 14+) has no time limit; older versions use the manifest's type.
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIF_ID, notification)
        }
        // START_STICKY means Android may restart this service after killing
        // the app. Nothing else signs back in then (that normally happens on
        // the app's first screen), so without this no calls would arrive.
        if (SessionManager.me.value == null && SessionManager.hasServer) {
            MainScope().launch {
                if (!SessionManager.tryResume()) stopSelf()
            }
        }
        return START_STICKY
    }

    private fun buildNotification(): Notification {
        val openApp = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, App.CHANNEL_CONNECTION)
            .setSmallIcon(com.videocall.mobile.R.drawable.ic_launcher_foreground)
            .setContentTitle("Vision Call")
            .setContentText(if (online) "Connected and ready to receive calls" else "Offline – waiting for connection")
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setContentIntent(openApp)
            .build()
    }

    companion object {
        const val NOTIF_ID = 43

        fun start(context: Context) {
            val intent = Intent(context, ConnectionService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
            else context.startService(intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, ConnectionService::class.java))
        }
    }
}
