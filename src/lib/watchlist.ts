"use client";

import { useSyncExternalStore } from "react";

// Device-local watchlist (§10.16 / Q3: no accounts in v1). The set of starred
// symbols lives in localStorage on this device only — it never touches the
// server, never syncs across devices. Everything reads it through
// useSyncExternalStore so every StarToggle + the /watchlist page stay in lockstep
// (star once, it lights up everywhere and survives reload / other tabs).

const KEY = "bourse:watchlist";

let set = new Set<string>();
let symbols: string[] = []; // cached snapshot — referentially stable until a mutation
let hydrated = false;
let storageBound = false;
const listeners = new Set<() => void>();
const EMPTY: string[] = [];

function load() {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr)) {
      set = new Set(arr.filter((x): x is string => typeof x === "string"));
      symbols = [...set];
    }
  } catch {
    /* corrupt / unavailable storage → start empty, never throw */
  }
  hydrated = true;
}

// Read once, lazily, the first time a snapshot is requested on the client.
function ensure() {
  if (!hydrated) load();
}

function persist() {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(symbols));
  } catch {
    /* private mode / quota → in-memory only for this session */
  }
}

function emit() {
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  ensure();
  if (!storageBound && typeof window !== "undefined") {
    // Cross-tab: another tab wrote localStorage → re-read and notify here.
    window.addEventListener("storage", (e) => {
      if (e.key === KEY) {
        load();
        emit();
      }
    });
    storageBound = true;
  }
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function toggleWatchlist(symbol: string) {
  ensure();
  if (set.has(symbol)) set.delete(symbol);
  else set.add(symbol);
  symbols = [...set];
  persist();
  emit();
}

// Is this one symbol starred? Returns a boolean primitive — always snapshot-stable.
export function useWatchlisted(symbol: string): boolean {
  const get = () => {
    ensure();
    return set.has(symbol);
  };
  return useSyncExternalStore(subscribe, get, () => false);
}

// The full set of starred symbols (insertion order). The cached `symbols` array
// only changes identity on mutation, so this is safe for useSyncExternalStore.
export function useWatchlist(): string[] {
  const get = () => {
    ensure();
    return symbols;
  };
  return useSyncExternalStore(subscribe, get, () => EMPTY);
}
