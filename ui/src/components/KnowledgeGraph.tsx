// Knowledge-graph view — renders kb_cache as a 3D force-directed graph
// (drag the canvas to rotate, scroll to zoom, drag a node to reposition).
//
// Data flow: GET /kb-graph?ks_id=... → kb_graph lambda → DDB → three.js.
// Thumbnails for asset nodes are fetched in parallel from /tl/assets/<id>
// (TL's CDN — public after the GET) and applied as sprite textures.

import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph3D, { type ForceGraphMethods } from "react-force-graph-3d";
import * as THREE from "three";

import { fetchKbGraph, getAsset, type GraphPayload, type GraphNode } from "../lib/api";
import { useStore, setState as setGlobalStore } from "../lib/store";

// ─── 3D node factories ──────────────────────────────────────────────────────
// One per node kind. The library passes whatever Three.js Object3D we return
// and runs the force simulation against the node's `__threeObj` size. We
// keep object scales reasonable so the collision/repulsion forces produce a
// non-overlapping layout.

const TEX_LOADER = new THREE.TextureLoader();
TEX_LOADER.crossOrigin = "anonymous";

const SPHERE_CACHE = new Map<string, THREE.Mesh>();

function sphere(color: number, radius: number, emissive = 0): THREE.Mesh {
  const key = `${color}-${radius.toFixed(1)}-${emissive}`;
  const cached = SPHERE_CACHE.get(key);
  if (cached) return cached.clone();
  const geo = new THREE.SphereGeometry(radius, 24, 16);
  const mat = new THREE.MeshLambertMaterial({
    color,
    emissive: emissive || 0,
    emissiveIntensity: emissive ? 0.6 : 0,
  });
  const m = new THREE.Mesh(geo, mat);
  SPHERE_CACHE.set(key, m);
  return m.clone();
}

// Single 1×1 transparent texture used as a "no image yet" stand-in. The
// sprite is created invisible (visible=false) so this is effectively never
// painted — but the material needs *some* texture to be valid Three.js.
function makeEmptyTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 1; c.height = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const EMPTY_THUMB = makeEmptyTexture();

/** Build an asset sprite. Always invisible at first — only revealed once
 *  the real thumbnail texture has finished decoding (via updateSpriteThumb's
 *  TEX_LOADER.load onLoad callback). Avoids the placeholder→real flicker. */
function assetThumbSprite(): THREE.Sprite {
  const mat = new THREE.SpriteMaterial({ map: EMPTY_THUMB, transparent: true });
  const s = new THREE.Sprite(mat);
  s.scale.set(16, 9, 1);
  s.visible = false; // off-screen until we have a real image
  return s;
}

/** Resolve a thumbnail URL into an actual image, then atomically swap it
 *  onto the sprite's material AND turn the sprite visible. Using the
 *  TEX_LOADER.load onLoad callback means the sprite is hidden right up to
 *  the moment the real pixels are ready — no placeholder visible in between.
 *  Fires onSettled (success OR failure) so the caller can tick a "all
 *  decoded" counter regardless of which pixels actually showed up. */
function updateSpriteThumb(sprite: THREE.Sprite, thumbUrl: string, onSettled?: () => void) {
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    try { onSettled?.(); } catch { /* */ }
  };
  TEX_LOADER.load(
    thumbUrl,
    (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = sprite.material as THREE.SpriteMaterial;
      // Dispose the prior texture (if any non-shared) to release GPU memory.
      if (mat.map && mat.map !== EMPTY_THUMB) {
        try { mat.map.dispose(); } catch { /* */ }
      }
      mat.map = tex;
      mat.needsUpdate = true;
      sprite.visible = true;
      settle();
    },
    undefined,
    () => {
      // Decode failed (404, CORS, etc) — leave the sprite hidden but
      // still tick the counter so the loader can finish.
      settle();
    },
  );
}

const ENTITY_KIND_COLOR: Record<string, number> = {
  person:  0xff7a1a, // hot amber
  animal:  0xe5b04c,
  brand:   0x4c8de5,
  object:  0xa3a195,
  place:   0x6ec27a,
  unknown: 0x808080,
};

function entitySphere(kind: string, count: number): THREE.Object3D {
  const color = ENTITY_KIND_COLOR[kind?.toLowerCase()] ?? ENTITY_KIND_COLOR.unknown;
  // Size: log-scaled by appearance count. Floor at 3, cap so a single
  // mega-entity doesn't dominate the scene.
  const r = Math.min(8, 3 + Math.log2(1 + count) * 1.6);
  return sphere(color, r);
}

function eventSphere(clusterSize: number): THREE.Object3D {
  // Glowing amber sphere, sized by cluster.
  const r = 5 + Math.min(8, clusterSize * 0.3);
  return sphere(0xff7a1a, r, 0xff5500);
}

// ─── Component ──────────────────────────────────────────────────────────────
type Node3D = {
  id: string;
  kind: "asset" | "entity" | "event";
  label: string;
  data: any;
  thumbUrl?: string | null;
};

type Link3D = {
  source: string;
  target: string;
  kind: "appears_in" | "participates_in";
};

function GraphInner({ payload }: { payload: GraphPayload }) {
  const fgRef = useRef<ForceGraphMethods<Node3D, Link3D> | undefined>(undefined);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [thumbs, setThumbs] = useState<Map<string, string>>(new Map());

  // The graph is hidden under a loading overlay until ALL of these are true:
  //   1. simReady           — force sim has stopped (layout is final)
  //   2. thumbsFetchDone    — every /kb/assets/<id> URL fetch has returned
  //   3. allThumbsDecoded   — every TEX_LOADER.load callback has fired
  // Together they mean: when the canvas appears, every node is already in
  // its final position AND every thumbnail texture is on screen — no
  // movement, no pop-in, no placeholder gaps.
  const [simReady, setSimReady] = useState(false);
  const [thumbsFetchDone, setThumbsFetchDone] = useState(false);
  // Decoded count — incremented inside the TEX_LOADER.load onLoad
  // callback. Throttled to setState every DECODE_FLUSH so we don't
  // re-render the parent 1400 times during ingest.
  const [decodedCount, setDecodedCount] = useState(0);
  const decodedRef = useRef(0);
  const DECODE_FLUSH = 16;
  const bumpDecoded = () => {
    decodedRef.current += 1;
    // Flush at intervals plus final tail (we don't know in advance when
    // the last decode lands, so flush whenever we're near a multiple).
    if (decodedRef.current % DECODE_FLUSH === 0) {
      setDecodedCount(decodedRef.current);
    }
  };
  // Tail flush: a short interval keeps the visible counter accurate
  // between DECODE_FLUSH ticks and lets the gate close when the last
  // texture finishes between flushes.
  useEffect(() => {
    const id = setInterval(() => {
      if (decodedRef.current !== decodedCount) setDecodedCount(decodedRef.current);
    }, 400);
    return () => clearInterval(id);
  }, [decodedCount]);

  // Reset both gates whenever the payload changes (KS switch).
  useEffect(() => {
    setSimReady(false);
    setThumbsFetchDone(false);
    setDecodedCount(0);
    decodedRef.current = 0;
  }, [payload]);

  // Hard ceiling — guarantee reveal eventually, even if some thumbs 404
  // or the sim never stops. Scales with graph size; capped at 30s.
  useEffect(() => {
    const baseMs = 4000;
    const perAsset = 12; // ms — generous, covers slow PNG decodes
    const ceiling = Math.min(30_000, baseMs + payload.nodes.length * perAsset);
    const t = setTimeout(() => {
      setSimReady(true);
      setThumbsFetchDone(true);
      setDecodedCount(decodedRef.current); // promote whatever count we have
    }, ceiling);
    return () => clearTimeout(t);
  }, [payload]);

  const totalAssets = useMemo(
    () => payload.nodes.filter((n) => n.kind === "asset").length,
    [payload],
  );
  // The number of thumbs we actually expect to decode = assets that
  // returned a representative_url. Computed once thumbsFetchDone flips.
  const expectedDecodes = thumbsFetchDone ? thumbs.size : totalAssets;
  const allDecoded = decodedCount >= expectedDecodes && thumbsFetchDone;
  const fullyReady = simReady && allDecoded;

  // Total node count drives a few performance trade-offs: simulation tick
  // budget, edge embellishments (arrows + particles), and how aggressively
  // we throttle thumbnail fetching.
  const nodeCount = payload.nodes.length;
  const edgeCount = payload.edges.length;
  const isLargeGraph = nodeCount > 500 || edgeCount > 800;
  const isHugeGraph  = nodeCount > 1500 || edgeCount > 2500;

  // Fetch asset thumbnails client-side. With ~1.4k assets in some KBs,
  // firing N parallel /kb/assets/<id> GETs would slam the API gateway and
  // pin the browser's HTTP queue. We throttle to CONCURRENCY parallel
  // requests and stream results into `thumbs` in batches so the graph
  // can light up progressively instead of blocking until all 1,400 thumbs
  // resolve.
  useEffect(() => {
    const assetNodes = payload.nodes.filter((n) => n.kind === "asset");
    if (!assetNodes.length) return;
    let cancelled = false;
    const CONCURRENCY = 8;
    const BATCH_FLUSH = 24; // setState every N successful fetches

    (async () => {
      const queue = [...assetNodes];
      const pending = new Map<string, string>();
      const flush = () => {
        if (cancelled || !pending.size) return;
        const snap = new Map(pending);
        setThumbs((prev) => {
          const next = new Map(prev);
          for (const [k, v] of snap) next.set(k, v);
          return next;
        });
        pending.clear();
      };

      const workers = Array.from({ length: CONCURRENCY }, async () => {
        while (queue.length && !cancelled) {
          const n = queue.shift();
          if (!n) break;
          const aid = (n.data as any).asset_id;
          if (!aid) continue;
          try {
            const a = await getAsset(aid);
            const url = (a as any).thumbnail?.representative_url;
            if (url) pending.set(aid, url);
            if (pending.size >= BATCH_FLUSH) flush();
          } catch { /* best-effort */ }
        }
      });
      await Promise.all(workers);
      flush(); // final batch
      // Mark the URL-fetch phase complete so the loader-gate can move on
      // to waiting for decodes.
      if (!cancelled) setThumbsFetchDone(true);
    })();

    return () => { cancelled = true; };
  }, [payload]);

  // CRITICAL: this useMemo depends ONLY on `payload`, NOT on `thumbs`. If
  // `thumbs` were in the dep list, every batched thumbnail flush would
  // rebuild the array → the library would re-run `nodeThreeObject` for every
  // node and recreate every Object3D → the user would see waves of pop-in.
  // Instead, sprites are created ONCE with placeholder textures and have
  // their `.material.map` swapped in place when URLs arrive (see the
  // texture-swap effect below).
  const { nodes, links } = useMemo(() => {
    const ns: Node3D[] = payload.nodes.map((n) => {
      if (n.kind === "asset") {
        return {
          id:       n.id,
          kind:     "asset",
          label:    n.data.title,
          data:     n.data,
          thumbUrl: null, // resolved later; not used by nodeThreeObject anymore
        };
      }
      if (n.kind === "entity") {
        return {
          id:    n.id,
          kind:  "entity",
          label: `${n.data.name} (×${n.data.appearance_count})`,
          data:  n.data,
        };
      }
      return {
        id:    n.id,
        kind:  "event",
        label: `${n.data.event_id} · ${n.data.cluster_size} clips`,
        data:  n.data,
      };
    });
    const ls: Link3D[] = payload.edges.map((e) => ({
      source: e.source,
      target: e.target,
      kind:   e.kind,
    }));
    return { nodes: ns, links: ls };
  }, [payload]);

  // CRITICAL: memoize the graphData object identity. Without this, the
  // inline `{nodes, links}` in JSX is a fresh reference every parent
  // re-render — and the parent re-renders on every thumbnail batch
  // (setThumbs updates state). react-force-graph would then reprocess
  // the whole graph each batch, recreating Object3Ds and re-running the
  // force sim, which is the "moves each tick / thumbnails reappear" the
  // user is reporting. With this memo, `graphData` stays the same
  // reference across thumb updates and the library does nothing.
  const graphData = useMemo(() => ({ nodes, links }), [nodes, links]);

  const nodeById = useMemo(
    () => new Map(payload.nodes.map((n) => [n.id, n])),
    [payload],
  );

  // Texture-swap path: sprites register themselves into `spriteByAssetIdRef`
  // when nodeThreeObject builds them. When new thumbnail URLs arrive we
  // look up the sprite by asset_id and replace its `.material.map` in
  // place — no reheat, no Object3D recreation, no graph-data reference
  // change. Net effect: thumbnails fade in *under* the layout without
  // disturbing any node positions.
  const spriteByAssetIdRef = useRef<Map<string, THREE.Sprite>>(new Map());
  const appliedThumbsRef = useRef<Map<string, string>>(new Map());
  // Reset the sprite cache + applied-thumb cache when the underlying
  // payload changes (KS switch). Without this, sprites + textures from
  // the previous KS would stick around in memory and the cache lookup
  // in nodeThreeObject might return a sprite that's no longer in the scene.
  useEffect(() => {
    spriteByAssetIdRef.current = new Map();
    appliedThumbsRef.current = new Map();
  }, [payload]);
  useEffect(() => {
    if (!thumbs.size) return;
    for (const [assetId, url] of thumbs) {
      if (appliedThumbsRef.current.get(assetId) === url) continue;
      const sprite = spriteByAssetIdRef.current.get(assetId);
      if (sprite) {
        updateSpriteThumb(sprite, url, bumpDecoded);
        appliedThumbsRef.current.set(assetId, url);
      }
      // Sprite not registered yet — its nodeThreeObject will read the
      // current thumb URL from the closure below when it's first called.
    }
  }, [thumbs]);

  // Stable ref to the latest `thumbs` map for nodeThreeObject to read at
  // sprite-creation time. Avoids stale closures when the graph mounts
  // after thumbs have already started arriving.
  const thumbsRef = useRef(thumbs);
  thumbsRef.current = thumbs;

  // Camera fly-to a specific Node3D — shared by node clicks and the
  // search picker. Computes a position along the node's vector from the
  // origin so the target sits in frame. Pure focus action; opening the
  // asset player is a second click on the already-focused node (see
  // handleNodeClick).
  const flyTo = (n: any) => {
    const resolved = nodeById.get(n.id) || null;
    setSelected(resolved);
    if (n.x == null || n.y == null || n.z == null) return;
    const dist = Math.hypot(n.x, n.y, n.z) || 80;
    const r = (dist + 60) / dist;
    try {
      fgRef.current?.cameraPosition?.(
        { x: n.x * r, y: n.y * r, z: n.z * r },
        { x: n.x, y: n.y, z: n.z },
        1200,
      );
    } catch { /* */ }
  };

  // Click handler that disambiguates focus vs. play. First click on a
  // node flies the camera there. A second click on the SAME asset node
  // (one that's already selected) opens the GlobalAssetPlayer. Entity /
  // event nodes only ever focus — there's no player for those.
  const handleNodeClick = (n: any) => {
    const resolved = nodeById.get(n.id) || null;
    const alreadyFocused = selected?.id === n.id;
    if (resolved?.kind === "asset" && alreadyFocused) {
      const aid = (resolved.data as any).asset_id;
      if (aid) {
        setGlobalStore({ activeAssetId: aid });
        return; // skip the fly-to; we're opening the modal instead
      }
    }
    flyTo(n);
  };

  // Resolve a node id to its live force-graph node (positions live on
  // the mutated graph state, not our static `nodes` input) and fly to it.
  const onJumpById = (id: string) => {
    const fg = fgRef.current as any;
    const liveNode = fg?.graphData?.()?.nodes?.find?.((m: any) => m.id === id);
    const target = liveNode || nodes.find((n) => n.id === id);
    if (target) flyTo(target);
  };

  // Neighbor index — for each node, the list of node ids reachable by
  // one edge. Used by `[ / ]` keyboard shortcuts to walk the graph.
  const neighborsByNode = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const e of payload.edges) {
      if (!m.has(e.source)) m.set(e.source, []);
      if (!m.has(e.target)) m.set(e.target, []);
      m.get(e.source)!.push(e.target);
      m.get(e.target)!.push(e.source);
    }
    return m;
  }, [payload]);

  return (
    <div className="h-full flex">
      <div className="flex-1 min-w-0 relative" style={{ background: "#0c0d0e" }}>
        {/* Canvas hides under opacity:0 until the layout is settled AND
            every thumbnail texture has finished decoding. Producers see
            a single clean reveal of the fully-painted graph instead of
            placeholders + pop-in. */}
        <div
          className="absolute inset-0"
          style={{
            opacity: fullyReady ? 1 : 0,
            transition: "opacity 300ms ease-out",
            pointerEvents: fullyReady ? "auto" : "none",
          }}
        >
        <ForceGraph3D
          ref={fgRef as any}
          graphData={graphData}
          backgroundColor="#0c0d0e"
          showNavInfo={false}
          onEngineStop={() => setSimReady(true)}
          nodeThreeObject={(n: any) => {
            if (n.kind === "asset") {
              const aid = n.data.asset_id;
              // Return the EXISTING sprite if we've already built one for
              // this asset. react-force-graph can call nodeThreeObject more
              // than once per node (on graph data changes, on re-mount,
              // etc); without this cache each call would mint a fresh
              // sprite with a fresh placeholder texture, which is what the
              // user was seeing as "thumbnails keep flickering 5-ish times".
              if (aid) {
                const existing = spriteByAssetIdRef.current.get(aid);
                if (existing) return existing;
              }
              // First time for this asset — build an invisible sprite.
              // If we already have a thumb URL cached for this asset
              // (thumbs arrived before the graph mounted), apply it
              // immediately so the sprite reveals on first paint.
              const sprite = assetThumbSprite();
              const url = aid ? thumbsRef.current.get(aid) || null : null;
              if (aid) {
                spriteByAssetIdRef.current.set(aid, sprite);
                if (url) {
                  updateSpriteThumb(sprite, url, bumpDecoded);
                  appliedThumbsRef.current.set(aid, url);
                }
              }
              return sprite;
            }
            if (n.kind === "entity") return entitySphere(n.data.kind_label, n.data.appearance_count);
            return eventSphere(n.data.cluster_size);
          }}
          nodeLabel={(n: any) => `<div style="font-family: 'Geist', system-ui; font-size:11px; padding:4px 8px; background:#171819; color:#ebe6da; border:1px solid #2a2b2e">${escapeHtml(n.label)}</div>`}
          linkColor={(l: any) =>
            l.kind === "participates_in"
              ? "rgba(255, 122, 26, 0.75)"
              : "rgba(255, 122, 26, 0.30)"
          }
          linkWidth={(l: any) => (l.kind === "participates_in" ? 1.4 : 0.6)}
          // Arrows + animated particles eat GPU/CPU on huge graphs. Strip
          // them off above 500 nodes — the directional info gets lost in
          // the visual density anyway.
          linkDirectionalArrowLength={isLargeGraph ? 0 : 3.2}
          linkDirectionalArrowRelPos={0.92}
          linkDirectionalParticles={isLargeGraph ? 0 : (l: any) => (l.kind === "participates_in" ? 1 : 0)}
          linkDirectionalParticleSpeed={0.006}
          linkDirectionalParticleColor={() => "#ff7a1a"}
          // Force-graph defaults already do collision; nudge spacing so
          // node bodies don't kiss.
          nodeRelSize={5}
          // Force-sim tick budget scales with size. Small graphs get the
          // luxury 150/80 settle. Huge graphs (>1.5k nodes) get a much
          // tighter budget — the sim is O(N log N) per tick on Barnes-Hut
          // but the per-frame cost still adds up. Faster alpha decay
          // makes the warmup phase end sooner.
          d3AlphaDecay={isHugeGraph ? 0.04 : isLargeGraph ? 0.025 : 0.012}
          d3VelocityDecay={isHugeGraph ? 0.5 : 0.32}
          warmupTicks={isHugeGraph ? 30 : isLargeGraph ? 60 : 150}
          cooldownTicks={isHugeGraph ? 20 : isLargeGraph ? 40 : 80}
          onNodeClick={handleNodeClick}
        />
        </div>{/* end opacity wrapper */}

        {/* Loader overlay — visible until the layout settles AND every
            thumbnail texture has decoded. Shows a two-line progress
            indicator so producers know it's actively working (not stuck)
            even on the big trailers KB where it can take 10-20s. */}
        {!fullyReady && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none"
            style={{ background: "#0c0d0e", color: "var(--color-ink-soft)" }}
          >
            <div className="font-mono text-[11px] tracking-wide">
              {!simReady ? "computing layout…" : "loading thumbnails…"}
            </div>
            <div className="font-mono text-[9px] mt-1.5" style={{ color: "#7a7975" }}>
              {!simReady
                ? `${payload.nodes.length} nodes · settling forces`
                : `${decodedCount}/${expectedDecodes} thumbnails ready`}
            </div>
          </div>
        )}

        <div
          className="absolute top-4 left-4 px-3 py-2 border"
          style={{
            borderColor: "rgba(235, 230, 218, 0.18)",
            background: "rgba(12, 13, 14, 0.85)",
            backdropFilter: "blur(8px)",
            color: "var(--color-ink)",
          }}
        >
          <div className="label">knowledge graph · 3D · live</div>
          <div className="font-mono text-[11px] mt-1" style={{ color: "#a3a195" }}>
            {payload.counts.assets} assets · {payload.counts.entities} entities · {payload.counts.events} events · {payload.counts.edges} edges
          </div>
          <div className="font-mono text-[9px] mt-1.5" style={{ color: "#7a7975" }}>
            drag = rotate · scroll = zoom · click = focus · click again = play (assets)
          </div>
        </div>

        {/* Search + nav controls always float on the canvas. The earlier
            "embed inside side panel" mode was removed when the panel was
            retired — the controls now have a stable home in the corners
            and stay reachable regardless of selection. */}
        <NavControls fgRef={fgRef} />
        <NodeSearch
          nodes={nodes}
          fgRef={fgRef}
          selectedId={selected ? (selected as GraphNode).id : null}
          neighborsByNode={neighborsByNode}
          onJump={onJumpById}
        />

        <Legend />
      </div>
    </div>
  );
}

/** 3D navigation overlay — orbit, zoom, fit-all, top view.
 *
 *  - Orbit (↑ ↓ ← →) rotates the camera around the current target by
 *    ±15° per click via OrbitControls.rotateLeft / rotateUp.
 *  - Zoom (+ / −) dollies the camera along its current axis ±15 %.
 *  - Fit (⛶) recenters the whole graph in frame.
 *  - Top (⌖) snaps to a bird's-eye view looking straight down.
 *
 *  Lives outside the side-panel column, so when SidePanel returns null
 *  the canvas spans full viewport width and these chips dock against the
 *  actual right edge. */
function NavControls({ fgRef, embedded = false }: { fgRef: React.MutableRefObject<ForceGraphMethods<Node3D, Link3D> | undefined>; embedded?: boolean }) {
  // Read the current camera position. The lib exposes a no-args getter
  // overload that TS doesn't capture, so we route through `any`.
  const camPos = (): { x: number; y: number; z: number } | null => {
    const fg = fgRef.current as any;
    if (!fg?.cameraPosition) return null;
    try {
      const p = fg.cameraPosition();
      if (!p || typeof p.x !== "number") return null;
      return { x: p.x, y: p.y, z: p.z };
    } catch { return null; }
  };

  const dolly = (factor: number) => {
    const fg = fgRef.current as any;
    const pos = camPos();
    if (!pos || !fg?.cameraPosition) return;
    fg.cameraPosition(
      { x: pos.x * factor, y: pos.y * factor, z: pos.z * factor },
      undefined,
      300,
    );
  };

  const orbit = (deltaAz: number, deltaPolar: number) => {
    // Use the underlying OrbitControls when available (rotateLeft +
    // rotateUp in radians, then update). Falls back to a manual rotation
    // about the world origin if controls() isn't exposed.
    const fg = fgRef.current as any;
    try {
      const ctrls = fg?.controls?.();
      if (ctrls?.rotateLeft) {
        ctrls.rotateLeft(deltaAz);
        ctrls.rotateUp?.(deltaPolar);
        ctrls.update?.();
        return;
      }
    } catch { /* fall through */ }
    // Manual fallback: spherical rotation of the camera vector about
    // the origin. Less accurate vs the OrbitControls target, but
    // visually close enough for one-shot navigation.
    const pos = camPos();
    if (!pos || !fg?.cameraPosition) return;
    const r  = Math.hypot(pos.x, pos.y, pos.z) || 1;
    const az0 = Math.atan2(pos.x, pos.z);
    const po0 = Math.acos(Math.max(-1, Math.min(1, pos.y / r)));
    const az = az0 + deltaAz;
    const po = Math.max(0.01, Math.min(Math.PI - 0.01, po0 + deltaPolar));
    fg.cameraPosition(
      {
        x: r * Math.sin(po) * Math.sin(az),
        y: r * Math.cos(po),
        z: r * Math.sin(po) * Math.cos(az),
      },
      undefined,
      300,
    );
  };

  const fit = () => { try { fgRef.current?.zoomToFit?.(700, 80); } catch { /* */ } };

  const topView = () => {
    const pos = camPos();
    if (!pos) return;
    const r = Math.max(150, Math.hypot(pos.x, pos.y, pos.z));
    try {
      fgRef.current?.cameraPosition?.(
        { x: 0, y: r, z: 0.01 }, // tiny z so up-vector resolves cleanly
        { x: 0, y: 0, z: 0 },
        700,
      );
    } catch { /* */ }
  };

  const STEP = Math.PI / 12; // 15° per click

  // Two visual variants. Floating (overlay on the canvas) uses the
  // blur-glass treatment; embedded (inside the side panel) uses the
  // panel-native surface tokens so it blends with the rest of the
  // panel chrome.
  const btn = (
    onClick: () => void,
    label: string,
    title: string,
    extra: React.CSSProperties = {},
  ) => (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        width: embedded ? 30 : 32,
        height: embedded ? 30 : 32,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        border: `1px solid ${embedded ? "var(--color-rule)" : "rgba(235, 230, 218, 0.18)"}`,
        background: embedded ? "var(--color-surface)" : "rgba(12, 13, 14, 0.85)",
        color: "var(--color-ink)",
        fontFamily: "var(--font-mono)",
        fontSize: 13,
        cursor: "pointer",
        ...extra,
      }}
    >
      {label}
    </button>
  );

  // When embedded the controls render in a single horizontal row (saves
  // panel vertical real estate). When floating they keep the original
  // 4-arrow pad + zoom column.
  if (embedded) {
    return (
      <div className="flex items-center justify-between gap-1">
        <div className="flex gap-1">
          {btn(() => orbit(-STEP, 0), "←", "Orbit left")}
          {btn(() => orbit(0, -STEP), "↑", "Orbit up")}
          {btn(() => orbit(0, STEP),  "↓", "Orbit down")}
          {btn(() => orbit(STEP, 0),  "→", "Orbit right")}
        </div>
        <div className="flex gap-1">
          {btn(() => dolly(0.85), "+", "Zoom in")}
          {btn(() => dolly(1.18), "−", "Zoom out")}
          {btn(fit, "⛶", "Fit all to view", { fontSize: 11 })}
          {btn(topView, "⌖", "Top-down view")}
        </div>
      </div>
    );
  }

  return (
    <div className="absolute right-4 bottom-4 flex flex-col items-end gap-2" style={{ backdropFilter: "blur(8px)" }}>
      {/* Orbit pad — 4-arrow rotate. Center button is fit-all. */}
      <div className="grid grid-cols-3 gap-1">
        <span />
        {btn(() => orbit(0, -STEP), "↑", "Orbit up")}
        <span />
        {btn(() => orbit(-STEP, 0), "←", "Orbit left")}
        {btn(fit, "⛶", "Fit all to view", { fontSize: 11 })}
        {btn(() => orbit(STEP, 0), "→", "Orbit right")}
        <span />
        {btn(() => orbit(0, STEP), "↓", "Orbit down")}
        <span />
      </div>
      {/* Zoom + top-view, stacked. */}
      <div className="flex flex-col gap-1">
        {btn(() => dolly(0.85), "+", "Zoom in")}
        {btn(() => dolly(1.18), "−", "Zoom out")}
        {btn(topView, "⌖", "Top-down view", { fontSize: 13 })}
      </div>
    </div>
  );
}

function Legend() {
  const items: { color: string; label: string }[] = [
    { color: "#ebe6da", label: "asset (thumbnail or cube)" },
    { color: "#ff7a1a", label: "person · brand" },
    { color: "#e5b04c", label: "animal" },
    { color: "#4c8de5", label: "brand" },
    { color: "#6ec27a", label: "place" },
    { color: "#a3a195", label: "object" },
    { color: "#ff7a1a", label: "event (glowing)" },
  ];
  return (
    <div
      className="absolute bottom-4 left-4 px-3 py-2 border space-y-1"
      style={{
        borderColor: "rgba(235, 230, 218, 0.18)",
        background: "rgba(12, 13, 14, 0.85)",
        backdropFilter: "blur(8px)",
      }}
    >
      <div className="label" style={{ color: "var(--color-ink)" }}>legend</div>
      {items.map((it, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="inline-block w-3 h-3 rounded-full" style={{ background: it.color }} />
          <span className="font-mono text-[10px]" style={{ color: "#a3a195" }}>{it.label}</span>
        </div>
      ))}
    </div>
  );
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"
  ));
}

/** Searchable node picker + keyboard-driven graph traversal.
 *
 *  Always-visible search input at the top-right of the canvas:
 *    type → filter by node label (assets, entities, events)
 *    ↑ / ↓ → move highlight through the filtered list
 *    Enter → fly the camera to the highlighted node
 *    Esc → close the dropdown
 *
 *  Global keyboard shortcuts (active whenever no input is focused):
 *    /  → focus the search input
 *    [  → jump to the previous neighbor of the currently-selected node
 *    ]  → jump to the next neighbor of the currently-selected node
 *    +  → zoom in       -  → zoom out
 *    ←↑→↓ → orbit       f  → fit-all       t  → top view
 */
function NodeSearch({
  nodes, fgRef, selectedId, neighborsByNode, onJump, embedded = false,
}: {
  nodes: Node3D[];
  fgRef: React.MutableRefObject<ForceGraphMethods<Node3D, Link3D> | undefined>;
  selectedId: string | null;
  neighborsByNode: Map<string, string[]>;
  onJump: (id: string) => void;
  embedded?: boolean;
}) {
  const [q, setQ] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Filtered candidates — label substring match, capped to keep the list
  // navigable by keyboard.
  const matches = useMemo(() => {
    if (!q.trim()) return nodes.slice(0, 12);
    const lc = q.trim().toLowerCase();
    return nodes
      .filter((n) => n.label.toLowerCase().includes(lc) || n.id.toLowerCase().includes(lc))
      .slice(0, 12);
  }, [q, nodes]);

  // Reset highlight when the filter changes.
  useEffect(() => { setHighlight(0); }, [q]);

  // Global keyboard shortcuts. Active only when focus isn't in another
  // text input — otherwise we'd intercept the user's typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      const inField = tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || (tgt as any).isContentEditable);
      // Search-focus shortcut. `/` works anywhere except inside another
      // text input.
      if (e.key === "/" && !inField) {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
        return;
      }
      if (inField) return; // every other shortcut respects focus

      const fg = fgRef.current as any;
      const camPos = () => {
        try { const p = fg?.cameraPosition?.(); return p && typeof p.x === "number" ? p : null; }
        catch { return null; }
      };
      const dolly = (factor: number) => {
        const p = camPos(); if (!p) return;
        fg?.cameraPosition?.({ x: p.x * factor, y: p.y * factor, z: p.z * factor }, undefined, 250);
      };
      const orbit = (daz: number, dpolar: number) => {
        const ctrls = fg?.controls?.();
        if (ctrls?.rotateLeft) {
          ctrls.rotateLeft(daz); ctrls.rotateUp?.(dpolar); ctrls.update?.();
          return;
        }
        const p = camPos(); if (!p) return;
        const r = Math.hypot(p.x, p.y, p.z) || 1;
        const az0 = Math.atan2(p.x, p.z);
        const po0 = Math.acos(Math.max(-1, Math.min(1, p.y / r)));
        const az = az0 + daz;
        const po = Math.max(0.01, Math.min(Math.PI - 0.01, po0 + dpolar));
        fg?.cameraPosition?.(
          {
            x: r * Math.sin(po) * Math.sin(az),
            y: r * Math.cos(po),
            z: r * Math.sin(po) * Math.cos(az),
          },
          undefined, 250,
        );
      };
      const STEP = Math.PI / 12;

      // Neighbor traversal. [ goes to previous, ] to next, in the
      // adjacency list order for the currently-selected node. If nothing
      // is selected and the user hits one of these, pick the first node
      // as an entry point.
      const stepNeighbor = (delta: 1 | -1) => {
        if (!selectedId) {
          if (nodes[0]) onJump(nodes[0].id);
          return;
        }
        const ns = neighborsByNode.get(selectedId) || [];
        if (!ns.length) return;
        // If selectedId itself isn't tracked yet, jump to the first
        // neighbor. Otherwise step through the neighbor list cyclically.
        const cur = (window as any).__lastNeighborIdx?.[selectedId] ?? -1;
        const next = ((cur + delta) % ns.length + ns.length) % ns.length;
        (window as any).__lastNeighborIdx = { ...((window as any).__lastNeighborIdx || {}), [selectedId]: next };
        onJump(ns[next]);
      };

      switch (e.key) {
        case "+": case "=": dolly(0.85); break;
        case "-": case "_": dolly(1.18); break;
        case "ArrowUp":    orbit(0, -STEP); e.preventDefault(); break;
        case "ArrowDown":  orbit(0,  STEP); e.preventDefault(); break;
        case "ArrowLeft":  orbit(-STEP, 0); e.preventDefault(); break;
        case "ArrowRight": orbit( STEP, 0); e.preventDefault(); break;
        case "f": case "F":
          try { fgRef.current?.zoomToFit?.(700, 80); } catch { /* */ }
          break;
        case "t": case "T": {
          const p = camPos(); if (!p) break;
          const r = Math.max(150, Math.hypot(p.x, p.y, p.z));
          try { fg?.cameraPosition?.({ x: 0, y: r, z: 0.01 }, { x: 0, y: 0, z: 0 }, 700); }
          catch { /* */ }
          break;
        }
        case "[": stepNeighbor(-1); e.preventDefault(); break;
        case "]": stepNeighbor(1);  e.preventDefault(); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fgRef, nodes, selectedId, neighborsByNode, onJump]);

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setOpen(false); (e.target as HTMLInputElement).blur();
      return;
    }
    if (!matches.length) return;
    if (e.key === "ArrowDown") {
      setHighlight((h) => Math.min(matches.length - 1, h + 1));
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      setHighlight((h) => Math.max(0, h - 1));
      e.preventDefault();
    } else if (e.key === "Enter") {
      const pick = matches[highlight];
      if (pick) {
        onJump(pick.id);
        setOpen(false);
        (e.target as HTMLInputElement).blur();
      }
    }
  };

  const kindGlyph = (k: Node3D["kind"]) => k === "asset" ? "▢" : k === "event" ? "✦" : "●";
  const kindColor = (k: Node3D["kind"]) => k === "asset" ? "#a3a195" : k === "event" ? "#ff7a1a" : "#e5b04c";

  // Wrapper + input chrome differs between floating (canvas overlay) and
  // embedded (inside the side panel). Functionally identical.
  const wrapperClass = embedded ? "w-full" : "absolute top-4 right-4 w-72";
  const wrapperStyle: React.CSSProperties = embedded ? {} : { zIndex: 5 };
  const inputBoxStyle: React.CSSProperties = embedded
    ? { background: "var(--color-surface)", border: "1px solid var(--color-rule)" }
    : {
        borderColor: "rgba(235, 230, 218, 0.18)",
        background: "rgba(12, 13, 14, 0.85)",
        backdropFilter: "blur(8px)",
        borderWidth: 1, borderStyle: "solid",
      };
  const dropdownStyle: React.CSSProperties = embedded
    ? { background: "var(--color-surface)", border: "1px solid var(--color-rule)" }
    : {
        borderColor: "rgba(235, 230, 218, 0.18)",
        background: "rgba(12, 13, 14, 0.92)",
        backdropFilter: "blur(8px)",
        borderWidth: 1, borderStyle: "solid",
      };

  return (
    <div className={wrapperClass} style={wrapperStyle}>
      <div className="px-3 py-2 flex items-center gap-2" style={inputBoxStyle}>
        <span className="font-mono text-[11px]" style={{ color: "#7a7975" }}>⌕</span>
        <input
          ref={inputRef}
          type="text"
          value={q}
          placeholder="Find a node…  ( / )"
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onInputKey}
          className="bg-transparent outline-none w-full font-mono text-[12px]"
          style={{ color: "var(--color-ink)" }}
        />
        {q && (
          <button
            type="button"
            onClick={() => { setQ(""); inputRef.current?.focus(); }}
            className="font-mono text-[11px]"
            style={{ color: "#7a7975" }}
            title="Clear"
          >
            ✕
          </button>
        )}
      </div>

      {open && matches.length > 0 && (
        <div className="mt-1 max-h-80 overflow-y-auto" style={dropdownStyle}>
          {matches.map((n, i) => (
            <button
              key={n.id}
              type="button"
              onClick={() => { onJump(n.id); setOpen(false); }}
              onMouseEnter={() => setHighlight(i)}
              className="w-full text-left px-3 py-1.5 flex items-center gap-2 font-mono text-[11px]"
              style={{
                background: i === highlight ? "rgba(255, 122, 26, 0.10)" : "transparent",
                color: i === highlight ? "var(--color-ink)" : "#a3a195",
              }}
            >
              <span style={{ color: kindColor(n.kind), fontSize: 11 }}>{kindGlyph(n.kind)}</span>
              <span className="truncate">{n.label}</span>
              <span className="ml-auto shrink-0" style={{ color: "#5a5a55", fontSize: 9 }}>{n.kind}</span>
            </button>
          ))}
        </div>
      )}

      {!open && !embedded && (
        <div className="mt-1.5 font-mono text-[9px]" style={{ color: "#7a7975" }}>
          / search · [ / ] neighbors · ←↑→↓ orbit · +/− zoom · f fit · t top
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="label" style={{ color: "var(--color-ink-faint)" }}>{label}</div>
      <div className="text-sm mt-0.5" style={{ color: "var(--color-ink)" }}>{children}</div>
    </div>
  );
}

function Chip({ children, accent }: { children: React.ReactNode; accent?: boolean }) {
  return (
    <span
      className="inline-block px-2 py-0.5 mr-1 mb-1 text-[10px] font-mono"
      style={{
        border: `1px solid ${accent ? "var(--color-cue)" : "var(--color-rule)"}`,
        color: accent ? "var(--color-cue)" : "var(--color-ink-soft)",
        background: accent ? "rgba(255, 122, 26, 0.06)" : "transparent",
      }}
    >
      {children}
    </span>
  );
}

function AssetDetail({ data }: { data: any }) {
  return (
    <>
      <Field label="asset_id"><span className="font-mono text-[11px]">{data.asset_id}</span></Field>
      {data.one_liner && <Field label="one-liner">{data.one_liner}</Field>}
      {data.role_hint && <Field label="role hint">{data.role_hint}</Field>}
      {data.visual_style && <Field label="visual style">{data.visual_style}</Field>}
      {data.mood_tags?.length > 0 && (
        <Field label="mood tags"><div className="flex flex-wrap mt-1">{data.mood_tags.map((m: string) => <Chip key={m}>{m}</Chip>)}</div></Field>
      )}
    </>
  );
}

function EntityDetail({ data }: { data: any }) {
  return (
    <>
      <Field label="kind"><Chip accent>{data.kind_label}</Chip></Field>
      <Field label="appearance count">
        <span className="font-mono">× {data.appearance_count}</span>
      </Field>
      {data.aliases?.length > 0 && (
        <Field label="aliases">{data.aliases.join(" · ")}</Field>
      )}
      {data.asset_ids?.length > 0 && (
        <Field label="appears in">
          <div className="space-y-0.5 mt-1 font-mono text-[10px]" style={{ color: "var(--color-ink-soft)" }}>
            {data.asset_ids.map((aid: string) => (
              <div key={aid}>· {aid}</div>
            ))}
          </div>
        </Field>
      )}
    </>
  );
}

function EventDetail({ data }: { data: any }) {
  return (
    <>
      {data.description && <Field label="description">{data.description}</Field>}
      <Field label="cluster size"><span className="font-mono">{data.cluster_size} clips</span></Field>
      <Field label="confidence"><span className="font-mono">{Math.round(data.confidence * 100)}%</span></Field>
      {data.mood_signature?.length > 0 && (
        <Field label="mood signature"><div className="flex flex-wrap mt-1">{data.mood_signature.map((m: string) => <Chip key={m} accent>{m}</Chip>)}</div></Field>
      )}
      {data.participating_assets?.length > 0 && (
        <Field label="participating assets">
          <div className="space-y-0.5 mt-1 font-mono text-[10px]" style={{ color: "var(--color-ink-soft)" }}>
            {data.participating_assets.map((aid: string) => (
              <div key={aid}>· {aid}</div>
            ))}
          </div>
        </Field>
      )}
    </>
  );
}

// ─── Top-level: fetch wrapper ────────────────────────────────────────────────
export function KnowledgeGraph() {
  const ks = useStore((s) => s.ks);
  const [payload, setPayload] = useState<GraphPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seenKs = useRef<string | null>(null);

  useEffect(() => {
    if (!ks || seenKs.current === ks._id) return;
    seenKs.current = ks._id;
    setLoading(true);
    setErr(null);
    setPayload(null);
    fetchKbGraph(ks._id)
      .then(setPayload)
      .catch((e) => setErr(String(e?.message || e)))
      .finally(() => setLoading(false));
  }, [ks]);

  if (!ks)         return <Pad>Pick a knowledge base to render its graph.</Pad>;
  if (loading)    return <Pad>Loading graph for {ks.name}…</Pad>;
  if (err)        return <Pad cue>kb-graph error: {err}</Pad>;
  if (!payload || payload.nodes.length === 0) {
    return (
      <Pad>
        <div className="max-w-md text-center">
          <div className="label">empty knowledge graph</div>
          <p className="mt-3 text-sm">
            No kb_cache records for <span className="font-mono">{ks._id.slice(0, 12)}…</span>. Run{" "}
            <span className="font-mono">scripts/ingest_kb_cache.py {ks._id}</span> to populate
            asset profiles + entities, then <span className="font-mono">scripts/build_event_groups.py {ks._id}</span> for event clusters.
          </p>
        </div>
      </Pad>
    );
  }

  return <GraphInner payload={payload} />;
}

function Pad({ children, cue }: { children: React.ReactNode; cue?: boolean }) {
  return (
    <div className="h-full flex items-center justify-center text-sm" style={{ color: cue ? "var(--color-cue)" : "var(--color-ink-faint)" }}>
      {children}
    </div>
  );
}
