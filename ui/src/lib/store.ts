// Tiny shared state — KS selection plus persona prefs. Vanilla event emitter
// avoids dragging in a state library for one demo.
import { useEffect, useState } from "react";
import type { KS } from "./api";

type State = {
  ks?: KS;
  ksList: KS[];
  ready: boolean;
  // Globally-rendered asset player modal — any chip in any tab can open it.
  activeAssetId?: string;
};

const initial: State = { ksList: [], ready: false };

const listeners = new Set<() => void>();
let state: State = initial;

export const setState = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

export const getState = () => state;

export function useStore<T>(selector: (s: State) => T): T {
  const [v, setV] = useState<T>(() => selector(state));
  useEffect(() => {
    const sub = () => setV(selector(state));
    listeners.add(sub);
    sub();
    return () => { listeners.delete(sub); };
  }, [selector]);
  return v;
}
