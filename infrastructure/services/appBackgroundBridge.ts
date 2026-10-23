import { netcattyBridge } from './netcattyBridge';

export const appBackgroundBridge = {
  async importImage() {
    const bridge = netcattyBridge.require();
    if (!bridge.importAppBackground) throw new Error('Background import unavailable');
    return bridge.importAppBackground();
  },
  async load(imageId: string): Promise<string | null> {
    return await netcattyBridge.get()?.loadAppBackground?.(imageId) ?? null;
  },
  async remove(imageId: string): Promise<void> {
    await netcattyBridge.get()?.removeAppBackground?.(imageId);
  },
  async decode(url: string): Promise<void> {
    const image = new Image();
    image.src = url;
    await image.decode();
  },
};
