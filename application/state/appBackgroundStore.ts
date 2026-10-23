import { useSyncExternalStore } from 'react';
import { DEFAULT_APP_BACKGROUND, type AppBackgroundSettings } from '../../domain/appBackground';

export interface AppBackgroundSnapshot {
  settings: AppBackgroundSettings;
  imageUrl: string | null;
  effectiveEnabled: boolean;
  busy: boolean;
  error: boolean;
}

let snapshot: AppBackgroundSnapshot = {
  settings: DEFAULT_APP_BACKGROUND, imageUrl: null, effectiveEnabled: false, busy: false, error: false,
};
const listeners = new Set<() => void>();
export const getAppBackgroundSnapshot = () => snapshot;
export const subscribeAppBackground = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export function publishAppBackground(next: AppBackgroundSnapshot): void {
  if (Object.keys(next).every((key) => next[key as keyof AppBackgroundSnapshot] === snapshot[key as keyof AppBackgroundSnapshot])) return;
  snapshot = next;
  listeners.forEach((listener) => listener());
}
export function useAppBackground() {
  return useSyncExternalStore(subscribeAppBackground, getAppBackgroundSnapshot, getAppBackgroundSnapshot);
}

export interface AppBackgroundActions {
  update(patch: Partial<Pick<AppBackgroundSettings, 'enabled' | 'surfaceOpacity'>>): void;
  importImage(): Promise<void>;
  removeImage(): Promise<void>;
}
let actions: AppBackgroundActions | null = null;
export function registerAppBackgroundActions(next: AppBackgroundActions): () => void {
  actions = next;
  return () => { if (actions === next) actions = null; };
}
export const getAppBackgroundActions = () => actions;
