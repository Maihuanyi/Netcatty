import { useLayoutEffect, useRef } from 'react';
import { useAppBackground } from '../application/state/appBackgroundStore';

/** One image per window; subscribers stay outside the shell's domain bags. */
export function AppBackgroundLayer() {
  const state = useAppBackground();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current?.parentElement;
    if (!root) return;
    if (state.effectiveEnabled) {
      root.dataset.appBackground = 'enabled';
      root.style.setProperty('--app-background-opacity', String(state.settings.surfaceOpacity));
    } else {
      delete root.dataset.appBackground;
      root.style.removeProperty('--app-background-opacity');
    }
    return () => {
      delete root.dataset.appBackground;
      root.style.removeProperty('--app-background-opacity');
    };
  }, [state.effectiveEnabled, state.settings.surfaceOpacity]);
  return <div ref={ref} aria-hidden="true" className="netcatty-app-background"
    style={{ backgroundImage: state.effectiveEnabled ? `url("${state.imageUrl}")` : undefined }} />;
}
