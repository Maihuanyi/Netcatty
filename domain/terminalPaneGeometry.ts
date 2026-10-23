export interface TerminalPaneRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Round shared edges, rather than widths, so adjacent panes meet exactly. */
export function alignTerminalPaneRect(rect: TerminalPaneRect): TerminalPaneRect {
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  return {
    x,
    y,
    w: Math.round(rect.x + rect.w) - x,
    h: Math.round(rect.y + rect.h) - y,
  };
}
