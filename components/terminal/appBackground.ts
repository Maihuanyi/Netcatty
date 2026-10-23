import { getAppBackgroundSnapshot } from '../../application/state/appBackgroundStore';
import { isAppBackgroundWindow, resolveTerminalBackgroundColor } from '../../domain/appBackground';

let colorContext: CanvasRenderingContext2D | null | undefined;

/** Normalize named/browser-supported CSS colors using the browser's color parser. */
export function resolveAppTerminalBackground(color: string): string {
  const state = getAppBackgroundSnapshot();
  if (!state.effectiveEnabled
    || (typeof window !== 'undefined' && !isAppBackgroundWindow(window.location.hash))) return color;
  let normalized = color;
  if (typeof document !== 'undefined') {
    colorContext ??= document.createElement('canvas').getContext('2d');
    if (colorContext) {
      colorContext.fillStyle = '#000000';
      colorContext.fillStyle = color;
      normalized = colorContext.fillStyle;
    }
  }
  return resolveTerminalBackgroundColor(normalized, state);
}
