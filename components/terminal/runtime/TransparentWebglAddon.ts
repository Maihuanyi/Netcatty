import type { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { getAppBackgroundSnapshot } from '../../../application/state/appBackgroundStore';

type RectangleRenderer = { renderBackgrounds(): void };
type Renderer = {
  _gl: WebGL2RenderingContext;
  _rectangleRenderer: { value?: RectangleRenderer };
  renderRows(start: number, end: number): void;
};

/**
 * The pinned addon uses SRC_ALPHA for the alpha channel too, squaring the
 * background opacity and accumulating previous frames on a transparent canvas.
 * Clear each wallpaper frame and use source-over alpha with premultiplied RGB.
 * Keep this compatibility adapter at the xterm boundary, never in session state.
 */
export class TransparentWebglAddon extends WebglAddon {
  override activate(terminal: Terminal): void {
    super.activate(terminal);
    const renderer = (this as unknown as { _renderer?: Renderer })._renderer;
    if (!renderer?._gl || !renderer._rectangleRenderer || typeof renderer.renderRows !== 'function') {
      // The controller disposes this addon and falls back to DOM on failure.
      throw new Error('Unsupported xterm WebGL transparency adapter');
    }
    const patched = new WeakSet<RectangleRenderer>();
    const install = () => {
      const rectangles = renderer._rectangleRenderer.value;
      if (!rectangles || patched.has(rectangles)) return;
      patched.add(rectangles);
      const renderBackgrounds = rectangles.renderBackgrounds.bind(rectangles);
      rectangles.renderBackgrounds = () => {
        if (getAppBackgroundSnapshot().effectiveEnabled) {
          const gl = renderer._gl;
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.enable(gl.BLEND);
          gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        }
        renderBackgrounds();
      };
    };
    install();
    const renderRows = renderer.renderRows.bind(renderer);
    renderer.renderRows = (start, end) => {
      // Context restoration replaces the rectangle renderer; rebind lazily.
      install();
      renderRows(start, end);
    };
  }
}
