import React, { useLayoutEffect, useRef } from 'react';

/** Fill the terminal margins without adding another tint behind xterm's canvas.
 * The fitted screen can be smaller than its host because of whole cells and
 * the scrollbar, so CSS padding alone cannot describe the uncovered region.
 * During a debounced fit it can also be wider than its clipping viewport.
 */
export function TerminalPaddingBackground({ top }: { top: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const layer = ref.current;
    const host = layer?.parentElement;
    if (!layer || !host) return;
    let screen: HTMLElement | null = null;
    const ancestors: HTMLElement[] = [];
    const update = () => {
      if (!screen) return;
      const outer = layer.getBoundingClientRect();
      const inner = screen.getBoundingClientRect();
      let left = Math.max(inner.left, outer.left);
      let right = Math.min(inner.right, outer.right);
      let top = Math.max(inner.top, outer.top);
      let bottom = Math.min(inner.bottom, outer.bottom);
      // Sidebar expansion clips the old, wide screen before xterm refits.
      // Only punch out pixels the canvas can actually paint; otherwise the
      // old hole also removes the tint from the pane's outer right margin.
      for (const element of ancestors) {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        if (style.overflowX !== 'visible') {
          left = Math.max(left, bounds.left);
          right = Math.min(right, bounds.right);
        }
        if (style.overflowY !== 'visible') {
          top = Math.max(top, bounds.top);
          bottom = Math.min(bottom, bounds.bottom);
        }
      }
      if (right <= left || bottom <= top) {
        layer.style.clipPath = 'none';
        return;
      }
      left -= outer.left;
      right -= outer.left;
      top -= outer.top;
      bottom -= outer.top;
      layer.style.clipPath = `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${left}px ${top}px, ${right}px ${top}px, ${right}px ${bottom}px, ${left}px ${bottom}px, ${left}px ${top}px)`;
    };
    // ResizeObserver runs before paint. Deferring this write to another frame
    // leaves the old hole over the newly fitted screen during sidebar toggles.
    // clip-path does not affect layout, so updating here cannot resize the host.
    const resize = new ResizeObserver(update);
    resize.observe(layer);
    const attach = () => {
      const next = host.querySelector<HTMLElement>('.xterm-screen');
      if (!next) return;
      screen = next;
      resize.observe(screen);
      for (let element = screen.parentElement; element && element !== host; element = element.parentElement) {
        ancestors.push(element);
        resize.observe(element);
      }
      mutation.disconnect();
      update();
    };
    const mutation = new MutationObserver(attach);
    mutation.observe(host, { childList: true, subtree: true });
    attach();
    return () => {
      resize.disconnect();
      mutation.disconnect();
    };
  }, [top]);

  return <div ref={ref} className="terminal-padding-background absolute inset-x-0 bottom-0 pointer-events-none" style={{ top }} aria-hidden="true" />;
}
