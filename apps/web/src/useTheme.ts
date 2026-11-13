import { useEffect, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CLASSIC_THEME, DEFAULT_THEME_TEXT, pickThemeImage, THEME_PICTURE_STATES, type ActiveThemeWire, type ThemePictureState, type ThemeSlot } from '@asf/shared/ui';
import { api } from './api';
import { accentOf, appTitleOf, backgroundOf, defaultPictureFor, textOf } from './theme-view';
import { getPageSubject, pageTitle, subscribePageSubject } from './page-title';

const KEY = ['theme'];
/** What the app renders with until /api/theme answers (and if it never does): classic, with its placeholder pictures. */
const FALLBACK: ActiveThemeWire = { manifest: CLASSIC_THEME, builtIn: true, images: {}, stateImages: {}, requested: null };

/**
 * The active theme (M12): names, quips and pictures. One fetch,
 * shared by every component through react-query. Pictures are same-origin
 * versioned URLs, cached by the browser until replaced.
 */
export function useTheme() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: KEY, queryFn: api.theme, staleTime: 60_000 });
  const t = data ?? FALLBACK;
  /** A picture the theme stores for the member (uploaded, or copied in by a migration). These beat the placeholders. */
  const ownPicture = (slot: string, state?: ThemePictureState): string | null =>
    pickThemeImage(t.stateImages?.[slot as ThemeSlot], state)?.url ?? t.images[slot as ThemeSlot]?.url ?? null;
  return {
    theme: t.manifest,
    builtIn: t.builtIn,
    /** Set when THEME names a theme that no longer exists (classic is shown instead). */
    missing: t.requested,
    /**
     * A member's picture. With a state (M13), its picture for that state, else
     * its plain one; without, the default one (for thumbnails).
     */
    pictureFor: (slot: string, state?: ThemePictureState): string | null =>
      ownPicture(slot, state) ?? defaultPictureFor(t.manifest.id, t.builtIn, slot),
    /** True when the member shows the built-in placeholder (it has no picture of its own). */
    isDefaultPicture: (slot: string): boolean => !ownPicture(slot) && !!defaultPictureFor(t.manifest.id, t.builtIn, slot),
    /** True when the member has at least one idle / working / done picture of its own. */
    hasStatePictures: (slot: string): boolean => THEME_PICTURE_STATES.some((st) => !!t.stateImages?.[slot as ThemeSlot]?.[st]),
    /** Every picture the theme has, by member and state (`any` = the plain one). */
    stateImages: t.stateImages ?? {},
    /** The theme's page decoration picture; shown in place of its corner pattern. */
    decorImage: t.decorImage?.url ?? null,
    reload: () => qc.invalidateQueries({ queryKey: KEY }),
  };
}

/** The CSS variables a theme's background derives; dropped again when it has none. */
const DERIVED = ['--panel', '--panel2', '--border', '--muted'] as const;

/**
 * Put the theme's look on <html>: the accent as --accent, the page colours as
 * --bg / --text (with the panel, border and muted shades mixed from them when a
 * background is set), and the app title as the document title (led by the
 * ticket key a page names through usePageSubject). Anything the
 * theme leaves out is dropped, so classic looks exactly as the stylesheet says.
 * Mount once, in the layout.
 */
export function useThemeLook(): void {
  const { theme } = useTheme();
  const accent = accentOf(theme);
  const background = backgroundOf(theme);
  const text = textOf(theme);
  const title = appTitleOf(theme);
  const subject = useSyncExternalStore(subscribePageSubject, getPageSubject);
  useEffect(() => {
    const root = document.documentElement;
    const set = (name: string, value: string | null) => {
      if (value) root.style.setProperty(name, value);
      else root.style.removeProperty(name);
    };
    set('--accent', accent);
    set('--bg', background);
    set('--text', text);
    if (background) {
      const fg = text ?? DEFAULT_THEME_TEXT;
      set('--panel', `color-mix(in srgb, ${background} 95%, ${fg})`);
      set('--panel2', `color-mix(in srgb, ${background} 91%, ${fg})`);
      set('--border', `color-mix(in srgb, ${background} 84%, ${fg})`);
      set('--muted', `color-mix(in srgb, ${background} 35%, ${fg})`);
    } else {
      for (const name of DERIVED) set(name, null);
    }
    root.dataset.theme = theme.id;
  }, [accent, background, text, theme.id]);
  useEffect(() => { document.title = pageTitle(title, subject); }, [title, subject]);
}
