import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { useAuth } from "./store/auth";
import { useDirectory } from "./store/directory";
import { useChats } from "./store/chats";
import { useCalls } from "./store/calls";
import { ws } from "./lib/ws";
import { api, setUnauthorizedHandler } from "./lib/api";
import { clearLocalUserData } from "./lib/session";
import { ensureDeviceRegistered } from "./lib/crypto";
import Login from "./pages/Login";
import ResetPassword from "./pages/ResetPassword";
import Shell from "./pages/Shell";
import ForcePasswordChange from "./components/ForcePasswordChange";
import CallOverlay from "./components/CallOverlay";
import IncomingCallModal from "./components/IncomingCallModal";
import RoomJoinRequests from "./components/RoomJoinRequests";
import { ToastHost } from "./components/ui";

// A password-reset email link (/reset-password?token=...) works whether or
// not the visitor is currently signed in, so App checks for it before the
// regular auth gate. No router needed for one static link shape.
function resetPasswordToken(): string | null {
  if (location.pathname !== "/reset-password") return null;
  return new URLSearchParams(location.search).get("token");
}

export default function App() {
  const { me, initialized, init, setMe } = useAuth();

  useEffect(() => {
    // restore theme before first paint of logged-in app
    const theme = localStorage.getItem("vc.theme");
    document.documentElement.classList.toggle("dark", theme !== "light");
    void init();
  }, [init]);

  // realtime wiring once logged in
  useEffect(() => {
    if (!me) return;

    // Shared by both ways a session can die while the app is open: the
    // server pushing a "force:logout" WS event, or any ordinary API call
    // simply coming back 401 (the session expired by age, or died some
    // other way the server never got to push over the socket). Guarded so
    // a burst of 401s (several in-flight requests failing at once) can't
    // fire this more than once before the reload actually happens.
    let signedOut = false;
    const forceSignOut = (reason: string) => {
      if (signedOut) return;
      signedOut = true;
      useCalls.getState().hangup();
      setMe(null);
      ws.disconnect();
      clearLocalUserData();
      sessionStorage.setItem("vc.logoutReason", reason);
      location.reload();
    };
    const reasons: Record<string, string> = {
      signed_in_elsewhere: "You were signed out because your account was signed in on another device.",
      suspended: "Your account has been suspended by an administrator.",
      deleted: "Your account has been removed by an administrator.",
      password_changed: "Your password was changed. Please sign in with the new password.",
      signed_out: "An administrator signed you out. Please sign in again.",
      signed_out_remotely: "This device was signed out from another device.",
    };
    const onForceLogout = (data: { reason?: string }) => {
      forceSignOut(reasons[data?.reason ?? ""] ?? "You were signed out. Please sign in again.");
    };
    const offForce = ws.on("force:logout", onForceLogout);
    setUnauthorizedHandler(() => forceSignOut("Your session expired. Please sign in again."));

    useDirectory.getState().fetchUsers();
    useChats.getState().registerWs();
    useChats.getState().fetchGroups();
    void useChats.getState().fetchConvoPrefs();
    void useChats.getState().fetchBlocked();
    void useChats.getState().fetchRecent();
    useCalls.getState().registerWs();
    useCalls.getState().fetchHistory();
    void ensureDeviceRegistered(me.id); // publishes this device's E2E public key for this account
    ws.connect();

    // re-sync after reconnect
    const offOpen = ws.on("ws:open", () => {
      useDirectory.getState().fetchUsers();
      useChats.getState().fetchGroups();
      void useChats.getState().fetchConvoPrefs();
      void useChats.getState().fetchRecent();
      useCalls.getState().fetchHistory();
    });
    const offPresence = ws.on("presence:update", (d) => {
      useDirectory.getState().applyPresence(d.user_id, d.status);
    });
    const offSync = ws.on("presence:sync", (d) => {
      useDirectory.getState().presenceSync(d.users ?? []);
    });
    // An admin created, changed, suspended or removed someone.
    const offDirectory = ws.on("directory:changed", () => {
      useDirectory.getState().fetchUsers();
    });
    // An admin changed this account (for example its role); reload it so
    // the app shows or hides admin features right away.
    const offAccount = ws.on("account:updated", async () => {
      try {
        setMe(await api.me());
      } catch {
        /* the next request will sign out if the session is gone */
      }
    });

    return () => {
      offForce();
      setUnauthorizedHandler(null);
      offOpen();
      offPresence();
      offSync();
      offDirectory();
      offAccount();
      // A logout unmounts the call overlay without giving the WebSocket
      // close handler a chance to release local media tracks.
      if (!useAuth.getState().me) useCalls.getState().hangup();
      ws.disconnect();
    };
  }, [me?.id, setMe]);

  const resetToken = resetPasswordToken();
  if (resetToken) return <ResetPassword token={resetToken} />;

  if (!initialized) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-indigo-500" />
      </div>
    );
  }

  const isInsecureContext =
    typeof window !== "undefined" &&
    !window.isSecureContext &&
    location.hostname !== "localhost" &&
    location.hostname !== "127.0.0.1";

  if (!me) return <Login />;
  if (me.must_change_password) return <ForcePasswordChange />;

  return (
    <>
      {isInsecureContext && (
        <div className="bg-amber-500/15 border-b border-amber-500/30 text-amber-800 dark:text-amber-200 text-xs px-4 py-2 flex items-center justify-between z-50 shrink-0">
          <span>
            <strong>LAN HTTP Notice:</strong> Browsers require HTTPS or localhost for microphone, camera, and E2E encryption. Connect via HTTPS or install the server certificate.
          </span>
          <a
            href="/cert.pem"
            download="visioncall-ca.crt"
            className="underline font-semibold ml-3 px-2 py-0.5 rounded bg-amber-200/50 dark:bg-amber-900/50 hover:bg-amber-300/50 text-amber-900 dark:text-amber-100"
          >
            Download CA Certificate
          </a>
        </div>
      )}
      <Shell />
      <CallOverlay />
      <IncomingCallModal />
      <RoomJoinRequests />
      <ToastHost />
    </>
  );
}

