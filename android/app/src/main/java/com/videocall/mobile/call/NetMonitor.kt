package com.videocall.mobile.call

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.suspendCancellableCoroutine
import org.webrtc.PeerConnection
import kotlin.coroutines.resume

/**
 * Polls WebRTC's own inbound-rtp/candidate-pair stats to classify the call's
 * network quality — mirrors web/src/lib/webrtc/netmonitor.ts exactly (same
 * loss-ratio/RTT thresholds) so "poor connection" means the same thing on
 * both platforms. On a LAN/VPN app, a flaky Wi-Fi hop or VPN tunnel is the
 * normal failure mode, not a fluke — a user needs to be able to tell "it's
 * my network" from "the app is broken."
 */
enum class NetQuality { GOOD, FAIR, POOR }

private data class StatSample(val packetsLost: Long, val packetsReceived: Long, val rtt: Double)

private suspend fun sampleInbound(pc: PeerConnection?): StatSample? {
    if (pc == null) return null
    return try {
        suspendCancellableCoroutine { cont ->
            pc.getStats { report ->
                var lost = 0L
                var received = 0L
                var rtt = 0.0
                for (stat in report.statsMap.values) {
                    if (stat.type == "inbound-rtp") {
                        (stat.members["packetsLost"] as? Number)?.let { lost += it.toLong() }
                        (stat.members["packetsReceived"] as? Number)?.let { received += it.toLong() }
                    }
                    if (stat.type == "candidate-pair" && stat.members["state"] == "succeeded") {
                        (stat.members["currentRoundTripTime"] as? Number)?.let { if (it.toDouble() > rtt) rtt = it.toDouble() }
                    }
                }
                if (cont.isActive) cont.resume(StatSample(lost, received, rtt))
            }
        }
    } catch (_: Exception) {
        null
    }
}

private fun scoreQuality(s: StatSample?): NetQuality {
    if (s == null) return NetQuality.GOOD
    val total = s.packetsLost + s.packetsReceived
    val lossRatio = if (total > 0) s.packetsLost.toDouble() / total else 0.0
    return when {
        lossRatio > 0.08 || s.rtt > 0.4 -> NetQuality.POOR
        lossRatio > 0.03 || s.rtt > 0.2 -> NetQuality.FAIR
        else -> NetQuality.GOOD
    }
}

/** Polls whichever PeerConnections [getPCs] currently returns and reports the worst-of quality every [intervalMs]. */
class NetworkMonitor(
    private val scope: CoroutineScope,
    private val getPCs: () -> List<PeerConnection?>,
    private val onQuality: (NetQuality) -> Unit,
    private val intervalMs: Long = 3000,
) {
    private var job: Job? = null

    fun start() {
        if (job != null) return
        job = scope.launch {
            while (isActive) {
                // Re-read each connection right before sampling it: one can be
                // disposed (call rejoin) while an earlier sample is in flight, and
                // a disposed one must never be touched. The timeout covers a
                // stats callback that never arrives.
                val qualities = getPCs().indices.map { i ->
                    scoreQuality(withTimeoutOrNull(2000) { sampleInbound(getPCs().getOrNull(i)) })
                }
                val worst = when {
                    qualities.contains(NetQuality.POOR) -> NetQuality.POOR
                    qualities.contains(NetQuality.FAIR) -> NetQuality.FAIR
                    else -> NetQuality.GOOD
                }
                onQuality(worst)
                delay(intervalMs)
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
    }
}
