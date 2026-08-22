import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'light' | 'dark';

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
}

/** Apply the theme class that Tailwind's `darkMode: ['class']` reads. */
function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

/**
 * Theme is client-only state, so it lives in Zustand rather than React Query.
 *
 * The storage key `tb-theme` is duplicated in the inline script in index.html,
 * which applies the class before first paint to avoid a flash of the wrong theme.
 * Keep the two in sync.
 */
export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      // Cream is the primary theme in the "Quiet Brutalism" system, so light is the
      // default here. Only this initial value changed — the persistence, storage
      // shape and toggle behaviour are untouched.
      theme: 'light',
      setTheme: (theme) => {
        applyTheme(theme);
        set({ theme });
      },
      toggle: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
    }),
    {
      name: 'tb-theme',
      // Store the bare string so the pre-paint script in index.html can read it
      // without parsing Zustand's persist envelope.
      storage: {
        getItem: (name) => {
          const value = localStorage.getItem(name);
          if (value !== 'light' && value !== 'dark') return null;
          return { state: { theme: value } };
        },
        setItem: (name, value) => {
          localStorage.setItem(name, (value as { state: ThemeState }).state.theme);
        },
        removeItem: (name) => localStorage.removeItem(name),
      },
      onRehydrateStorage: () => (state) => {
        if (state) applyTheme(state.theme);
      },
    }
  )
);
