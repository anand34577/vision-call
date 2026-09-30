// Clears everything logging out should clear on a shared/kiosk-style LAN
// device: locally-cached chat/call/directory state (so the next person to
// log in on this browser doesn't see the previous user's messages, group
// list, or call history before fresh data loads) plus localStorage entries
// that are specific to what the previous user was doing (unsent drafts, the
// per-conversation encryption toggle). Deliberately does NOT touch the
// per-device E2E keypair (IndexedDB) or the stable device id (ws.ts) or the
// mic/cam/theme preferences — those describe this browser/device, not the
// account that was just using it, and clearing them would break message
// history decryption or reset preferences unrelated to the account.
import { useChats } from "../store/chats";
import { useCalls } from "../store/calls";
import { useDirectory } from "../store/directory";
import { usePresence } from "../store/presence";
import { clearDecryptCache } from "./crypto";

export function clearLocalUserData() {
  useChats.setState({
    messagesByDm: {},
    messagesByGroup: {},
    groups: [],
    active: null,
    typingDm: {},
    typingGroup: {},
    unread: {},
    sendError: null,
    historyLoading: {},
    convoPrefs: {},
    blocked: [],
    groupReads: {},
    hasMore: {},
    savedIDs: new Set(),
    encryptedConvos: {},
    decryptedContent: {},
  });
  useDirectory.setState({ users: [], loaded: false, error: null });
  useCalls.setState({ history: [], historyLoaded: false, historyError: null });
  usePresence.setState({ myStatus: "online" });
  clearDecryptCache();

  try {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      // vc.theme.prefs is the previous account's theme; the next login
      // applies its own saved preferences.
      if (k && (k.startsWith("vc.draft.") || k.startsWith("vc.e2e.") || k === "vc.theme.prefs")) toRemove.push(k);
    }
    for (const k of toRemove) localStorage.removeItem(k);
  } catch {
    /* private mode / storage unavailable — nothing to clear */
  }
}
