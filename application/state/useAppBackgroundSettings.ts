import { useLayoutEffect } from 'react';
import { isAppBackgroundWindow, normalizeAppBackground, type AppBackgroundSettings } from '../../domain/appBackground';
import { STORAGE_KEY_APP_BACKGROUND } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import { appBackgroundBridge } from '../../infrastructure/services/appBackgroundBridge';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import { publishAppBackground, registerAppBackgroundActions } from './appBackgroundStore';

/** Own persistence without subscribing the settings/AppShell owner to slider changes. */
export function useAppBackgroundSettings(enabled: boolean) {
  useLayoutEffect(() => {
    if (!enabled || (typeof window !== 'undefined' && !isAppBackgroundWindow(window.location.hash))) return;
    let settings = normalizeAppBackground(localStorageAdapter.read(STORAGE_KEY_APP_BACKGROUND));
    let loaded: { id: string; url: string } | null = null;
    let busy = false;
    let error = false;
    let mounted = true;
    let loadVersion = 0;
    const publish = () => {
      if (!mounted) return;
      const imageUrl = loaded?.id === settings.imageId ? loaded.url : null;
      publishAppBackground({ settings, imageUrl, effectiveEnabled: settings.enabled && imageUrl !== null, busy, error });
    };
    const commit = (next: AppBackgroundSettings) => {
      if (!localStorageAdapter.write(STORAGE_KEY_APP_BACKGROUND, next)) throw new Error('Background settings could not be saved');
      settings = next;
      // Persistence is the commit point; a closed peer window must not roll it back.
      try { netcattyBridge.get()?.notifySettingsChanged?.({ key: STORAGE_KEY_APP_BACKGROUND, value: next }); }
      catch { /* The storage event still reaches other windows on this origin. */ }
    };
    const load = async () => {
      const version = ++loadVersion;
      const id = settings.imageId;
      loaded = null;
      error = false;
      publish();
      if (!id) return;
      try {
        const url = await appBackgroundBridge.load(id);
        if (!url) throw new Error('Background image unavailable');
        await appBackgroundBridge.decode(url);
        if (!mounted || version !== loadVersion) return;
        loaded = { id, url };
      } catch {
        if (!mounted || version !== loadVersion) return;
        error = true;
      }
      publish();
    };
    const receive = (value: unknown) => {
      const previousId = settings.imageId;
      settings = normalizeAppBackground(value);
      if (settings.imageId !== previousId) void load();
      else publish();
    };
    const unsubscribe = netcattyBridge.get()?.onSettingsChanged?.(({ key, value }) => {
      if (key === STORAGE_KEY_APP_BACKGROUND) receive(value);
    });
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY_APP_BACKGROUND || event.key === null) {
        receive(localStorageAdapter.read(STORAGE_KEY_APP_BACKGROUND));
      }
    };
    window.addEventListener('storage', onStorage);
    const unregister = registerAppBackgroundActions({
      update(patch) {
        if (!mounted) return;
        try { commit(normalizeAppBackground({ ...settings, ...patch })); error = false; }
        catch { error = true; }
        publish();
      },
      async importImage() {
        if (!mounted || busy) return;
        busy = true;
        error = false;
        publish();
        let importedId: string | null = null;
        let committed = false;
        try {
          const result = await appBackgroundBridge.importImage();
          if (!result) return;
          importedId = result.imageId;
          const url = await appBackgroundBridge.load(importedId);
          if (!url) throw new Error('Background image unavailable');
          await appBackgroundBridge.decode(url);
          if (!mounted) return;
          const previousId = settings.imageId;
          commit({ ...settings, enabled: true, imageId: importedId });
          committed = true;
          ++loadVersion;
          loaded = { id: importedId, url };
          publish();
          if (previousId && previousId !== importedId) await appBackgroundBridge.remove(previousId);
        } catch { error = true; }
        finally {
          if (importedId && !committed) await appBackgroundBridge.remove(importedId).catch(() => {});
          busy = false;
          publish();
        }
      },
      async removeImage() {
        if (!mounted || busy) return;
        busy = true;
        publish();
        try {
          const previousId = settings.imageId;
          commit({ ...settings, enabled: false, imageId: null });
          ++loadVersion;
          loaded = null;
          error = false;
          publish();
          if (previousId) await appBackgroundBridge.remove(previousId);
        } catch { error = true; }
        finally { busy = false; publish(); }
      },
    });
    void load();
    return () => {
      mounted = false;
      ++loadVersion;
      unsubscribe?.();
      window.removeEventListener('storage', onStorage);
      unregister();
    };
  }, [enabled]);
}
