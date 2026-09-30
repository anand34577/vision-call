package com.videocall.mobile

import android.Manifest
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.videocall.mobile.chat.Convo
import com.videocall.mobile.session.SessionManager
import com.videocall.mobile.ui.screens.*
import com.videocall.mobile.ui.theme.VisionCallTheme
import com.videocall.mobile.ui.theme.isAppInDarkTheme

class MainActivity : ComponentActivity() {
    private val notifPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onResume() {
        super.onResume()
        // A call may be ringing from a notification the user didn't tap;
        // opening the app from the launcher should still show it.
        val call = com.videocall.mobile.call.CallRepository.state.value
        if (call.incoming != null || call.roomInvite != null) {
            startActivity(android.content.Intent(this, com.videocall.mobile.call.CallActivity::class.java))
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        setContent {
            val dark = isAppInDarkTheme()
            // Draw behind the system bars; icon contrast follows the app theme,
            // not the system one (the account can pick a dark theme on a light system).
            LaunchedEffect(dark) {
                val style = if (dark) SystemBarStyle.dark(android.graphics.Color.TRANSPARENT)
                else SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT)
                enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
            }
            VisionCallTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    AppRoot()
                }
            }
        }
    }
}

private const val NAV_ANIM_MS = 260

@Composable
fun AppRoot() {
    var booted by remember { mutableStateOf(false) }
    val me by SessionManager.me.collectAsState()

    LaunchedEffect(Unit) {
        if (SessionManager.hasServer) SessionManager.tryResume()
        booted = true
    }

    if (!booted) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        return
    }

    if (me?.must_change_password == true) {
        ForcePasswordScreen()
        return
    }

    val nav = rememberNavController()
    val startDestination = remember { if (me != null) "home" else "login" }

    // The session can end from anywhere — sign-out, an expired session (401),
    // an admin disabling the account, a password change, sign-in on another
    // device. Whenever it does, go back to Login instead of leaving a dead
    // home screen up.
    LaunchedEffect(me == null) {
        if (me == null && nav.currentDestination?.route !in setOf("login", "oidc", "password-reset", null)) {
            nav.navigate("login") { popUpTo(0) }
        }
    }

    NavHost(
        navController = nav,
        startDestination = startDestination,
        enterTransition = { slideInHorizontally(tween(NAV_ANIM_MS)) { it / 4 } + fadeIn(tween(NAV_ANIM_MS)) },
        exitTransition = { fadeOut(tween(NAV_ANIM_MS / 2)) },
        popEnterTransition = { fadeIn(tween(NAV_ANIM_MS)) },
        popExitTransition = { slideOutHorizontally(tween(NAV_ANIM_MS)) { it / 4 } + fadeOut(tween(NAV_ANIM_MS)) },
    ) {
        composable("login") {
            LoginScreen(
                onLoggedIn = { nav.navigate("home") { popUpTo("login") { inclusive = true } } },
                onOidcLogin = { nav.navigate("oidc") },
                onForgotPassword = { nav.navigate("password-reset") },
            )
        }
        composable("oidc") {
            OidcLoginScreen(
                onLoggedIn = { nav.navigate("home") { popUpTo("login") { inclusive = true } } },
                onCancel = { nav.popBackStack() },
            )
        }
        composable("password-reset") {
            PasswordResetScreen(onBack = { nav.popBackStack() }, onReset = { nav.popBackStack() })
        }
        composable("home") {
            HomeScreen(
                onOpenDm = { userId -> nav.navigate("chat/dm/$userId") },
                onOpenGroup = { groupId -> nav.navigate("chat/group/$groupId") },
                onOpenAdmin = { nav.navigate("admin") },
                onOpenSearch = { nav.navigate("search") },
                onOpenSaved = { nav.navigate("saved") },
                onLoggedOut = { nav.navigate("login") { popUpTo(0) } },
            )
        }
        composable(
            "chat/dm/{peerId}",
            arguments = listOf(navArgument("peerId") { type = NavType.LongType }),
        ) { backStackEntry ->
            val peerId = backStackEntry.arguments?.getLong("peerId") ?: 0L
            ChatScreen(convo = Convo.Dm(peerId), onBack = { nav.popBackStack() }, onOpenPinned = { nav.navigate("pinned/dm/$peerId") })
        }
        composable(
            "chat/group/{groupId}",
            arguments = listOf(navArgument("groupId") { type = NavType.LongType }),
        ) { backStackEntry ->
            val groupId = backStackEntry.arguments?.getLong("groupId") ?: 0L
            ChatScreen(
                convo = Convo.GroupChat(groupId), onBack = { nav.popBackStack() },
                onOpenPinned = { nav.navigate("pinned/group/$groupId") },
                onOpenGroupInfo = { nav.navigate("group-info/$groupId") },
            )
        }
        composable(
            "group-info/{groupId}",
            arguments = listOf(navArgument("groupId") { type = NavType.LongType }),
        ) { backStackEntry ->
            val groupId = backStackEntry.arguments?.getLong("groupId") ?: 0L
            GroupInfoScreen(groupId, onBack = { nav.popBackStack() }, onLeft = { nav.popBackStack("home", inclusive = false) })
        }
        composable(
            "pinned/dm/{peerId}",
            arguments = listOf(navArgument("peerId") { type = NavType.LongType }),
        ) { backStackEntry ->
            PinnedMessagesScreen(Convo.Dm(backStackEntry.arguments?.getLong("peerId") ?: 0L), onBack = { nav.popBackStack() })
        }
        composable(
            "pinned/group/{groupId}",
            arguments = listOf(navArgument("groupId") { type = NavType.LongType }),
        ) { backStackEntry ->
            PinnedMessagesScreen(Convo.GroupChat(backStackEntry.arguments?.getLong("groupId") ?: 0L), onBack = { nav.popBackStack() })
        }
        composable("saved") { SavedMessagesScreen(onBack = { nav.popBackStack() }) }
        composable("search") { SearchMessagesScreen(onBack = { nav.popBackStack() }) }
        composable("admin") { AdminScreen(onBack = { nav.popBackStack() }) }
    }
}
