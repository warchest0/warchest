"use client";

import { useSyncExternalStore } from "react";

/**
 * Shared 1 Hz clock (unix seconds). One interval for the whole app; returns 0 during static prerender so the
 * server HTML never embeds a build-time timestamp (components render a placeholder until hydrated).
 */
let current = Math.floor(Date.now() / 1000);
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!timer) {
    current = Math.floor(Date.now() / 1000);
    timer = setInterval(() => {
      current = Math.floor(Date.now() / 1000);
      listeners.forEach((l) => l());
    }, 1000);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

export function useNow(): number {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => 0,
  );
}
