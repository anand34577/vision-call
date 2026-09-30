package com.videocall.mobile.ui.screens

import android.media.MediaPlayer
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.File
import com.videocall.mobile.net.FileBrief
import com.videocall.mobile.session.SessionManager

/**
 * Play/pause row for an audio attachment (voice messages). The file is
 * downloaded once with the session cookie, then played from the cache.
 */
@Composable
fun AudioMessage(file: FileBrief, fg: Color, meta: Color, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var player by remember { mutableStateOf<MediaPlayer?>(null) }
    var playing by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    var position by remember { mutableIntStateOf(0) }
    var duration by remember { mutableIntStateOf(0) }

    DisposableEffect(file.id) { onDispose { runCatching { player?.release() }; player = null } }
    LaunchedEffect(playing) {
        while (playing) {
            position = player?.currentPosition ?: 0
            delay(200)
        }
    }

    fun toggle() {
        val p = player
        if (p != null) {
            if (playing) { p.pause(); playing = false } else { p.start(); playing = true }
            return
        }
        if (loading) return
        loading = true
        failed = false
        scope.launch {
            runCatching {
                val dest = File(context.cacheDir, "audio").apply { mkdirs() }.resolve("${file.id}.m4a")
                if (!dest.exists() || dest.length() == 0L) SessionManager.api.downloadToFile(SessionManager.api.fileUrl(file.id), dest)
                val mp = MediaPlayer()
                mp.setDataSource(dest.path)
                mp.setOnCompletionListener { playing = false; position = 0; it.seekTo(0) }
                mp.prepare()
                duration = mp.duration
                player = mp
                mp.start()
                playing = true
            }.onFailure { failed = true }
            loading = false
        }
    }

    Row(modifier.padding(start = 8.dp, end = 8.dp, top = 6.dp).widthIn(min = 200.dp), verticalAlignment = Alignment.CenterVertically) {
        FilledIconButton(
            onClick = { toggle() },
            modifier = Modifier.size(40.dp),
            colors = IconButtonDefaults.filledIconButtonColors(containerColor = fg.copy(alpha = 0.18f), contentColor = fg),
        ) {
            if (loading) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = fg)
            else Icon(if (playing) Icons.Default.Pause else Icons.Default.PlayArrow, if (playing) "Pause voice message" else "Play voice message")
        }
        Column(Modifier.padding(start = 10.dp).weight(1f)) {
            LinearProgressIndicator(
                progress = { if (duration > 0) position.toFloat() / duration else 0f },
                modifier = Modifier.fillMaxWidth(),
                color = fg,
                trackColor = fg.copy(alpha = 0.25f),
            )
            Text(
                if (failed) "Couldn't play" else "Voice message" + if (duration > 0) " · ${formatMs(if (playing) position else duration)}" else "",
                style = MaterialTheme.typography.labelSmall, color = meta, modifier = Modifier.padding(top = 4.dp),
            )
        }
    }
}

private fun formatMs(ms: Int): String {
    val s = ms / 1000
    return "%d:%02d".format(s / 60, s % 60)
}
