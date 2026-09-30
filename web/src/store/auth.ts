import { create } from "zustand";
import { api } from "../lib/api";
import { clearLocalUserData } from "../lib/session";
import { applyTheme } from "../lib/theme";
import type { User } from "../lib/types";

interface AuthState {
  me: User | null;
  initialized: boolean;
  init: () => Promise<void>;
  login: (username: string, password: string, totpCode?: string) => Promise<string | null>;
  logout: () => Promise<void>;
  setMe: (me: User | null) => void;
}

export const useAuth = create<AuthState>((set) => ({
  me: null,
  initialized: false,

  init: async () => {
    // Only a 401 means "not signed in". A network blip or a server that is
    // still starting shouldn't bounce a signed-in user to the login page, so
    // retry a few times first.
    for (let attempt = 0; ; attempt++) {
      try {
        const me = await api.me();
        if (me.preferences) {
          applyTheme(me.preferences);
        }
        set({ me, initialized: true });
        return;
      } catch (err: any) {
        if (err?.status === 401 || err?.status === 403 || attempt >= 4) {
          set({ me: null, initialized: true });
          return;
        }
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  },

  login: async (username, password, totpCode) => {
    try {
      const me = await api.login(username, password, totpCode);
      if (me.preferences) {
        applyTheme(me.preferences);
      }
      set({ me });
      return null;
    } catch (err: any) {
      return err?.message ?? "Login failed";
    }
  },

  logout: async () => {
    try {
      await api.logout();
    } catch {
      /* session already gone */
    }
    set({ me: null });
    // This is explicitly a shared/kiosk-friendly LAN app - clear anything
    // that shouldn't linger for the next person to log in on this browser.
    clearLocalUserData();
  },

  setMe: (me) => {
    if (me?.preferences) {
      applyTheme(me.preferences);
    }
    set({ me });
  },
}));
