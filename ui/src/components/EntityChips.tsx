// EntityChips — shared little component that fetches /assets/{id}/entities
// for a given asset and renders the recognized entities as small chips.
// In-memory cache shared across all uses so the same asset's entity list
// is fetched once per page-load.
//
// Drop in next to any clip card to get an instant "who's in this" surface.

import { useEffect, useState } from "react";
import { entitiesInAsset } from "../lib/api";
import type { Entity } from "../lib/api";

const cache = new Map<string, Entity[] | "loading" | "error">();
const subscribers = new Map<string, Set<(state: Entity[] | "loading" | "error") => void>>();

function notify(assetId: string, state: Entity[] | "loading" | "error") {
  cache.set(assetId, state);
  subscribers.get(assetId)?.forEach((s) => s(state));
}

async function fetchOnce(assetId: string) {
  if (cache.get(assetId) === "loading") return;
  if (Array.isArray(cache.get(assetId))) return;
  notify(assetId, "loading");
  try {
    const arr = await entitiesInAsset(assetId);
    notify(assetId, arr);
  } catch {
    notify(assetId, "error");
  }
}

export function EntityChips({
  assetId,
  size = "sm",
  max = 6,
  onPick,
}: {
  assetId: string | undefined | null;
  size?: "sm" | "md";
  max?: number;
  onPick?: (entity: Entity) => void;
}) {
  const [state, setState] = useState<Entity[] | "loading" | "error">(
    () => (assetId ? (cache.get(assetId) ?? "loading") : "loading"),
  );

  useEffect(() => {
    if (!assetId) return;
    const cur = cache.get(assetId);
    if (Array.isArray(cur)) { setState(cur); return; }
    let subs = subscribers.get(assetId);
    if (!subs) { subs = new Set(); subscribers.set(assetId, subs); }
    subs.add(setState);
    fetchOnce(assetId);
    return () => { subs!.delete(setState); };
  }, [assetId]);

  if (!assetId) return null;
  if (state === "loading") return null;
  if (state === "error") return null;
  if (state.length === 0) return null;

  const visible = state.slice(0, max);
  const overflow = state.length - visible.length;
  const padX = size === "sm" ? "px-2" : "px-2.5";
  const padY = size === "sm" ? "py-0.5" : "py-1";
  const text = size === "sm" ? "text-[10px]" : "text-xs";

  return (
    <div className="flex flex-wrap gap-1 mt-2">
      {visible.map((e) => (
        <button
          key={e._id}
          className={`font-mono ${text} ${padX} ${padY} border whitespace-nowrap`}
          style={{
            borderColor: "var(--color-rule)",
            background: "var(--color-surface)",
            color: "var(--color-cue)",
          }}
          onClick={onPick ? () => onPick(e) : undefined}
          title={`${e.name}${e.asset_ids?.length ? ` · ${e.asset_ids.length} appearances` : ""}`}
        >
          {e.name}
        </button>
      ))}
      {overflow > 0 && (
        <span className={`font-mono ${text} ${padX} ${padY}`} style={{ color: "var(--color-ink-faint)" }}>
          +{overflow}
        </span>
      )}
    </div>
  );
}
