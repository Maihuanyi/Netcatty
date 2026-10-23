import type { Monaco } from '@monaco-editor/react';
import { useEffect, useState } from 'react';
import { useAppBackground } from '../../application/state/appBackgroundStore';
import {
  buildNetcattyMonacoThemeColors,
  getNetcattyEditorColors,
  getNetcattyMonacoThemeName,
  getNetcattyThemeSignal,
  NETCATTY_MONACO_THEME_DARK,
  NETCATTY_MONACO_THEME_LIGHT,
} from './netcattyMonacoTheme';

export const useNetcattyMonacoTheme = (
  monaco: Monaco | null | undefined,
): string => {
  const { effectiveEnabled } = useAppBackground();
  const [isDarkTheme, setIsDarkTheme] = useState(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  );
  const [themeSignal, setThemeSignal] = useState(() => getNetcattyThemeSignal());
  const themeName = getNetcattyMonacoThemeName(isDarkTheme);

  useEffect(() => {
    if (!monaco) return;

    const colors = getNetcattyEditorColors(isDarkTheme);
    const themeColors = buildNetcattyMonacoThemeColors(colors, effectiveEnabled);

    monaco.editor.defineTheme(NETCATTY_MONACO_THEME_DARK, {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: themeColors,
    });

    monaco.editor.defineTheme(NETCATTY_MONACO_THEME_LIGHT, {
      base: 'vs',
      inherit: true,
      rules: [],
      colors: themeColors,
    });

    monaco.editor.setTheme(themeName);
  }, [monaco, isDarkTheme, themeSignal, themeName, effectiveEnabled]);

  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
    const root = document.documentElement;
    const updateTheme = () => {
      setIsDarkTheme(root.classList.contains('dark'));
      setThemeSignal(getNetcattyThemeSignal());
    };
    const observer = new MutationObserver(updateTheme);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-active-chrome-theme'],
    });
    return () => observer.disconnect();
  }, []);

  return themeName;
};
