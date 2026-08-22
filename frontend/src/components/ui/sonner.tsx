import { Toaster as SonnerToaster } from 'sonner';

import { useThemeStore } from '@/store/theme';

/**
 * Toast host. Sonner is shadcn/ui's current recommended toast implementation.
 * Themed from our own store rather than next-themes, which this app does not use.
 */
export function Toaster() {
  const theme = useThemeStore((s) => s.theme);

  return (
    <SonnerToaster
      theme={theme}
      // Top-right, not bottom-right: the seat map's checkout bar is now fixed to the
      // bottom of the viewport, and a bottom-anchored toast lands directly on top of
      // "Confirm booking" — covering the primary action at the exact moment the user
      // is being told their seats are held.
      position="top-right"
      closeButton
      richColors={false}
      toastOptions={{
        /*
         * Inline, not a utility class.
         *
         * Sonner injects its own stylesheet at runtime, after Tailwind's, and its
         * `[data-sonner-toast]` rule has equal specificity — so it wins on order and
         * `shadow-none` silently loses. The toast was the last drop shadow left
         * anywhere in the app. An inline style outranks both stylesheets without
         * needing !important.
         */
        style: { boxShadow: 'none', borderRadius: 0 },
        classNames: {
          // `shadow-none` is load-bearing: Sonner ships its own box-shadow in its
          // stylesheet, so leaving it off is the one thing that still puts a drop
          // shadow on screen in a system that has none. It has a 1px ink border
          // instead, which is how this system draws a discrete boundary.
          toast:
            'group toast group-[.toaster]:bg-card group-[.toaster]:text-card-foreground group-[.toaster]:border-border-strong group-[.toaster]:border group-[.toaster]:shadow-none group-[.toaster]:rounded-none',
          description: 'group-[.toast]:text-muted-foreground',
          actionButton: 'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
          cancelButton: 'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
          error: 'group-[.toaster]:border-destructive/40',
          success: 'group-[.toaster]:border-success/40',
          warning: 'group-[.toaster]:border-warning/40',
        },
      }}
    />
  );
}
