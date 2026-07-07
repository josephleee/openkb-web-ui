import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "openkb-theme";

function currentTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "dark"
    ? "dark"
    : "light";
}

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // ignore storage failures (private mode, etc.)
  }
}

/**
 * Manual light/dark toggle backed by the `data-theme` attribute on <html>.
 * The initial value is set before first paint by the inline script in
 * index.html (localStorage → prefers-color-scheme), so this hook just mirrors
 * and flips it.
 */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      applyTheme(next);
      return next;
    });
  }, []);
  return { theme, toggle };
}

/**
 * Boolean view of the active theme for imperative renderers (the graph canvas
 * needs literal colors). Re-renders when the theme toggles.
 */
export function useIsDark(): boolean {
  const [dark, setDark] = useState<boolean>(() => currentTheme() === "dark");
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(currentTheme() === "dark"));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  return dark;
}

/** Backwards-compatible alias used by the graph canvas. */
export const usePrefersDark = useIsDark;
