export interface AppBackgroundSettings {
  enabled: boolean;
  imageId: string | null;
  surfaceOpacity: number;
}

export const DEFAULT_APP_BACKGROUND: Readonly<AppBackgroundSettings> = Object.freeze({
  enabled: false,
  imageId: null,
  surfaceOpacity: 0.75,
});

export function isAppBackgroundWindow(hash: string): boolean {
  return !['#/session-window', '#/terminal-popup', '#/editor-window', '#/tray']
    .some((route) => hash.startsWith(route));
}

export function normalizeAppBackground(value: unknown): AppBackgroundSettings {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const imageId = typeof raw.imageId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(png|jpg)$/.test(raw.imageId)
    ? raw.imageId : null;
  return {
    enabled: raw.enabled === true && imageId !== null,
    imageId,
    surfaceOpacity: typeof raw.surfaceOpacity === 'number' && Number.isFinite(raw.surfaceOpacity)
      ? Math.max(0, Math.min(1, raw.surfaceOpacity)) : DEFAULT_APP_BACKGROUND.surfaceOpacity,
  };
}

/** Keep the base palette intact; xterm accepts CSS rgba/hsla and hex colors. */
export function resolveTerminalBackgroundColor(
  color: string,
  state: { effectiveEnabled: boolean; settings: AppBackgroundSettings },
): string {
  if (!state.effectiveEnabled) return color;
  const alpha = normalizeAppBackground(state.settings).surfaceOpacity;
  let hex = color.trim().match(/^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i)?.[1];
  if (hex) {
    if (hex.length <= 4) hex = hex.split('').map((part) => part + part).join('');
    return `#${hex.slice(0, 6)}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;
  }
  const functional = color.trim().match(/^(rgb|hsl)a?\(([^)]+)\)$/i);
  if (functional) {
    const channels = functional[2].split('/')[0].trim().split(/[\s,]+/).slice(0, 3);
    if (channels.length === 3) return `${functional[1].toLowerCase()}a(${channels.join(', ')}, ${alpha})`;
  }
  // Named CSS colors are normalized by the renderer adapter before this helper.
  return color;
}
