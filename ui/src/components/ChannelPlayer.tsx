// Back-to-back HLS playback for a FAST channel — with parallel pre-loading
// and seamless swap.
//
// Two <video> slots stacked on top of each other (absolutely positioned).
// Both are always mounted; visibility toggles via `opacity`, never via
// `display`. The inactive slot has `pointer-events: none` so the visible
// one keeps the native controls.
//
// Per-slot state: we remember which program each slot currently has loaded.
// On program advance we DO NOT reload the slot that already has the right
// program — we just unmute + play it. That's what makes the swap silky:
// hls.js has already buffered ~30s of segments, the first frame is on
// screen, and we're only flipping which slot is visible.
//
// Pre-loaded slots play() → pause() once on manifest-parsed, so the first
// frame paints on the inactive video element. When we swap, the new active
// slot already shows its first frame — no black flash.

import { useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import { getAsset, type Asset, type Channel, type ChannelProgram } from "../lib/api";
import { SmartClipThumb } from "../lib/clip-thumb";

type Slot = "a" | "b";

export function ChannelPlayer({
  channel, autoplay = true, loop = true, stickyMeta = false,
}: {
  channel: Channel;
  autoplay?: boolean;
  loop?: boolean;
  /** When true, the now-playing strip + thumbnail rail pin to the top of
   *  the nearest scrolling ancestor (the video itself still scrolls away).
   *  Use this in views with a long-scrolling list below the player so the
   *  producer can keep the rail visible while picking alternates. */
  stickyMeta?: boolean;
}) {
  const programs = channel.programs || [];

  const wrapRef = useRef<HTMLDivElement>(null);
  const slotARef = useRef<HTMLVideoElement>(null);
  const slotBRef = useRef<HTMLVideoElement>(null);
  const hlsARef = useRef<Hls | null>(null);
  const hlsBRef = useRef<Hls | null>(null);

  // Per-slot state: which program index is currently loaded into each video.
  // Used so we never wastefully reload a slot that already has what we want.
  const slotProgramRef = useRef<{ a: number | null; b: number | null }>({ a: null, b: null });

  const [idx, setIdx] = useState(0);
  const [active, setActive] = useState<Slot>("a");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [assetCache, setAssetCache] = useState<Record<string, Asset>>({});
  const failedRef = useRef<Set<number>>(new Set());

  // Custom control state — replaces native <video controls> so the bar doesn't
  // auto-flash on every program transition.
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [currentSec, setCurrentSec] = useState(0); // seconds inside current program
  // "Intent to play" — flips true on first user-triggered play (or autoplay).
  // Subsequent slot swaps respect this flag so the channel keeps playing
  // back-to-back even when autoplay starts false (Compare mode).
  const [intentToPlay, setIntentToPlay] = useState(autoplay);

  const refFor = (s: Slot) => (s === "a" ? slotARef : slotBRef);
  const hlsFor = (s: Slot) => (s === "a" ? hlsARef : hlsBRef);

  // ---- reset on channel change ----
  useEffect(() => {
    failedRef.current = new Set();
    slotProgramRef.current = { a: null, b: null };
    setErrMsg(null);
    setIdx(0);
    setActive("a");
  }, [channel.channel_id]);

  // ---- prefetch all asset metadata so manifest URLs are ready upfront ----
  // Re-fires whenever the SET of asset_ids in the channel changes — not just
  // on channel_id. Alternates mutate program.asset_id in place (same channel),
  // so without depending on the id-list we'd never fetch the swapped clip's
  // manifest + thumbnail and the rail card would render blank.
  const programAssetIds = useMemo(
    () => [...new Set(programs.map((p) => p.asset_id))].sort().join(","),
    [programs],
  );
  useEffect(() => {
    const ids = programAssetIds ? programAssetIds.split(",") : [];
    const need = ids.filter((id) => id && !assetCache[id]);
    if (!need.length) return;
    Promise.all(need.map((id) => getAsset(id).then((a) => [id, a] as const).catch(() => null))).then((rs) => {
      const next: Record<string, Asset> = {};
      for (const r of rs) if (r) next[r[0]] = r[1];
      if (Object.keys(next).length) setAssetCache((cur) => ({ ...cur, ...next }));
    });
  }, [programAssetIds]);

  // ---- load a program into a slot, paint the first frame, and pause ----
  // Called once per (slot, program) pair. Does NOT play audibly — the
  // active-slot effect handles unmute + resume.
  const loadIntoSlot = (slot: Slot, programIdx: number) => {
    const program = programs[programIdx];
    const video = refFor(slot).current;
    if (!video || !program) return;
    const asset = assetCache[program.asset_id];
    // Distinguish "not in cache yet" (alternate just got swapped in — the
    // prefetch effect is still fetching) from "asset exists but has no HLS"
    // (genuinely unplayable). Only the second case should mark the program
    // failed; the first will re-run loadIntoSlot once the cache catches up.
    if (!asset) {
      console.warn(`channel: program ${programIdx} (${program.asset_id}) — asset not cached yet, waiting`);
      return;
    }
    const url = asset?.hls?.manifest_url;
    if (!url || asset?.hls?.status !== "ready") {
      failedRef.current.add(programIdx);
      console.warn(`channel: skipping program ${programIdx} (${program.asset_id}) — no playable HLS`);
      // If this was for the active slot, walk to the next playable program.
      if (slot === active && programIdx === idx) skipForward(programIdx);
      return;
    }

    // Tear down any prior hls.js instance on this slot.
    const hlsSlot = hlsFor(slot);
    if (hlsSlot.current) { hlsSlot.current.destroy(); hlsSlot.current = null; }

    slotProgramRef.current[slot] = programIdx;

    // Always start muted + paused. The active-slot effect will unmute and
    // play the slot that's actually visible.
    video.muted = true;

    const onReady = () => {
      try { video.currentTime = program.source_start || 0; } catch {}
      // Touch play/pause once so the browser paints the first frame.
      video.play().then(() => {
        video.pause();
      }).catch(() => { /* play may throw if blocked; that's fine */ });
    };

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
      video.addEventListener("loadedmetadata", onReady, { once: true });
    } else if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        maxBufferLength: 30,
        maxBufferSize: 60 * 1000 * 1000,
        autoStartLoad: true,
      });
      hlsSlot.current = hls;
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, onReady);
      hls.on(Hls.Events.ERROR, (_e, d) => {
        if (d.fatal && slot === active && programIdx === idx) {
          setErrMsg(`hls ${d.type}: ${d.details}`);
        }
      });
    } else {
      setErrMsg("no HLS support in this browser");
    }
  };

  const nextIndex = (i: number): number | null => {
    if (i + 1 < programs.length) return i + 1;
    return loop ? 0 : null;
  };

  const skipForward = (fromIdx: number) => {
    let next = nextIndex(fromIdx);
    let safety = programs.length;
    while (next !== null && failedRef.current.has(next) && safety-- > 0) {
      next = nextIndex(next);
    }
    if (next !== null && !failedRef.current.has(next)) {
      setIdx(next);
    } else {
      setErrMsg("No playable programs in this channel — every clip is missing its HLS pipeline.");
    }
  };

  // ---- main controller: keep active slot loaded with idx, idle slot with idx+1 ----
  useEffect(() => {
    if (!programs.length || !Object.keys(assetCache).length) return;

    const idle: Slot = active === "a" ? "b" : "a";

    // Active slot: load if it doesn't already have the current program.
    // Otherwise just resume playback.
    if (slotProgramRef.current[active] !== idx) {
      loadIntoSlot(active, idx);
    }

    // Idle slot: preload next program if not already loaded.
    const ni = nextIndex(idx);
    if (ni !== null && slotProgramRef.current[idle] !== ni) {
      loadIntoSlot(idle, ni);
    }

    // Activate: play whichever slot is now visible. Default is muted — the
    // producer toggles sound on with the speaker icon when they want to hear
    // dialogue. Use intentToPlay (which starts as autoplay and flips true on
    // user click) so the channel keeps rolling on each slot swap without
    // pausing. Mute state itself is driven by the `muted` React state and
    // synced onto both video elements below.
    const activeVideo = refFor(active).current;
    const idleVideo = refFor(idle).current;
    if (activeVideo) {
      activeVideo.muted = muted;
      if (intentToPlay) activeVideo.play().catch(() => {});
      setErrMsg(null);
    }
    if (idleVideo) {
      idleVideo.muted = true;
    }
  }, [idx, active, channel.channel_id, Object.keys(assetCache).length, intentToPlay, muted]);

  // ---- watch active video: end-of-program swap + drive custom control state ----
  useEffect(() => {
    const video = refFor(active).current;
    if (!video) return;
    const program = programs[idx];
    if (!program) return;
    const start = program.source_start || 0;
    const end = program.source_end || 0;

    // Swap logic — fires from either timeupdate (passed the planned end) or
    // ended (asset ran out before the planned end). Guarded so the same swap
    // doesn't fire twice in quick succession.
    let swapped = false;
    const advance = () => {
      if (swapped) return;
      swapped = true;
      const ni = nextIndex(idx);
      if (ni !== null) {
        setActive((cur) => (cur === "a" ? "b" : "a"));
        setIdx(ni);
      } else {
        video.pause();
      }
    };

    const onTime = () => {
      const inProgram = Math.max(video.currentTime - start, 0);
      setCurrentSec(inProgram);
      if (end > 0 && video.currentTime >= end - 0.1) advance();
    };
    const onEnded = () => advance();
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onVol = () => setMuted(video.muted);

    video.addEventListener("timeupdate", onTime);
    video.addEventListener("ended", onEnded);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("volumechange", onVol);
    setMuted(video.muted);
    setPlaying(!video.paused);

    return () => {
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("volumechange", onVol);
    };
  }, [idx, active, programs.length]);

  // ---- custom control actions ----
  const togglePlay = () => {
    const v = refFor(active).current;
    if (!v) return;
    if (v.paused) {
      setIntentToPlay(true);
      v.play().catch(() => {});
    } else {
      setIntentToPlay(false);
      v.pause();
    }
  };
  const toggleMute = () => {
    const v = refFor(active).current;
    if (!v) return;
    v.muted = !v.muted;
  };
  const skipNext = () => {
    const ni = nextIndex(idx);
    if (ni === null) return;
    setActive((cur) => (cur === "a" ? "b" : "a"));
    setIdx(ni);
  };
  const skipPrev = () => {
    const v = refFor(active).current;
    // If we're more than 3s into the program, restart it; otherwise jump prev.
    if (v && currentSec > 3) {
      try { v.currentTime = (programs[idx]?.source_start || 0); } catch {}
      return;
    }
    const pi = idx === 0 ? (loop ? programs.length - 1 : 0) : idx - 1;
    if (pi !== idx) {
      setActive((cur) => (cur === "a" ? "b" : "a"));
      setIdx(pi);
    }
  };
  const toggleFullscreen = () => {
    // Fullscreen the WRAPPER, not the video element. Swapping between two
    // stacked <video>s under the same fullscreened container just works;
    // fullscreening a single video element would leave the next program
    // black on transition.
    const w = wrapRef.current;
    if (!w) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else w.requestFullscreen?.().catch(() => {});
  };

  // ---- cleanup ----
  useEffect(() => () => {
    if (hlsARef.current) hlsARef.current.destroy();
    if (hlsBRef.current) hlsBRef.current.destroy();
  }, []);

  const totalSec = useMemo(
    () => programs.reduce((s, p) => s + Math.max((p.source_end || 0) - (p.source_start || 0), 0), 0),
    [programs]
  );
  const current = programs[idx];

  const jumpTo = (i: number) => { if (i !== idx) setIdx(i); };

  // When stickyMeta is true, the meta strip + rail must be a SIBLING of the
  // scenes list (not nested inside a player wrapper) — otherwise CSS sticky
  // un-pins as soon as the player's bordered box scrolls past the top. So
  // we return a fragment with two top-level blocks and let the parent's
  // layout flow handle them. The non-sticky case keeps the original
  // single-bordered-box look for visual cohesion.
  return (
    <>
      <div className="border" style={{ borderColor: "var(--color-rule)", background: "var(--color-surface)" }}>
      {/* Cap the video so the now-playing info bar + ProgramRail still
          fit above the fold on common laptop screens. Two limits, take
          whichever is tighter:
            (a) 40vh — proportional cap so the video doesn't dominate on
                tall viewports.
            (b) 100vh − 540px — absolute reservation for everything else
                that has to fit: masthead (~130 incl logo+nav) +
                timeline header (~110) + now-playing strip (~115) +
                ProgramRail (~165) + bottom toolbar (~80) + a bit of
                padding (~30). Earlier reservation was 460 and it cut
                the strip on tighter viewports — pinned higher now.
          Sizing by viewport:
            ~768 px (compact laptop) — calc binds, video ≈ 230 px
            ~1080 px (1080p)         — calc binds, video ≈ 432 px
            ~1125 px (your screen)   — calc binds, video ≈ 450 px
            ~1440 px (1440p)         — calc binds, video ≈ 576 px (40vh = 576 ties)
            ~2160 px (4K)            — 40vh binds, video ≈ 864 px
          aspectRatio preserves 16:9; the paired maxWidth applies the
          same dual-cap formula on the width axis so the box stays a
          true rectangle regardless of which limit binds. */}
      <div
        ref={wrapRef}
        className="channel-player-wrap relative mx-auto"
        style={{
          background: "#000",
          aspectRatio: "16 / 9",
          width: "100%",
          maxHeight: "min(55vh, calc(100vh - 430px))",
          maxWidth: "min(calc(55vh * 16 / 9), calc((100vh - 430px) * 16 / 9))",
        }}
      >
        {errMsg && (
          <div
            className="absolute inset-x-0 top-0 px-4 py-2 flex items-center gap-3"
            style={{
              background: "rgba(0,0,0,0.7)",
              borderBottom: "1px solid var(--color-status-failed)",
              zIndex: 20,
            }}
          >
            <span className="label" style={{ color: "var(--color-status-failed)" }}>Player notice</span>
            <span className="text-xs flex-1 truncate" style={{ color: "var(--color-ink-soft)" }}>{errMsg}</span>
            <button
              className="label hover:text-[var(--color-cue)]"
              style={{ color: "var(--color-ink-faint)" }}
              onClick={() => setErrMsg(null)}
            >
              dismiss ✕
            </button>
          </div>
        )}
        {/* Both <video>s are stacked + always mounted. Visibility = opacity,
            interaction = pointer-events. No display: none, no remount,
            no flash. */}
        <video
          ref={slotARef}
          playsInline
          muted
          preload="auto"
          onClick={togglePlay}
          className="absolute inset-0 w-full h-full"
          style={{
            background: "#000",
            opacity: active === "a" ? 1 : 0,
            pointerEvents: active === "a" ? "auto" : "none",
            zIndex: active === "a" ? 2 : 1,
            cursor: "pointer",
          }}
        />
        <video
          ref={slotBRef}
          playsInline
          muted
          preload="auto"
          onClick={togglePlay}
          className="absolute inset-0 w-full h-full"
          style={{
            background: "#000",
            opacity: active === "b" ? 1 : 0,
            pointerEvents: active === "b" ? "auto" : "none",
            zIndex: active === "b" ? 2 : 1,
            cursor: "pointer",
          }}
        />

        {/* Custom hover-only control bar — replaces native <video controls>
            so the bar doesn't auto-flash on program transitions. */}
        <div
          className="channel-controls absolute inset-x-0 bottom-0 px-4 py-3 flex items-center gap-3 transition-opacity duration-200"
          style={{
            background: "linear-gradient(to top, rgba(0,0,0,0.85), rgba(0,0,0,0))",
            zIndex: 10,
            opacity: 0,
          }}
        >
          <button onClick={togglePlay} title={playing ? "pause" : "play"} className="font-mono text-lg" style={{ color: "var(--color-ink)" }}>
            {playing ? "❚❚" : "▶"}
          </button>
          <button onClick={skipPrev} title="previous scene" className="font-mono text-lg" style={{ color: "var(--color-ink-soft)" }}>
            ⏮
          </button>
          <button onClick={skipNext} title="next scene" className="font-mono text-lg" style={{ color: "var(--color-ink-soft)" }}>
            ⏭
          </button>
          <span className="font-mono text-xs flex-1" style={{ color: "var(--color-ink-soft)" }}>
            {fmtClock(currentSec)} / {fmtClock(((programs[idx]?.source_end || 0) - (programs[idx]?.source_start || 0)))} · scene {idx + 1}/{programs.length}
          </span>
          <button onClick={toggleMute} title={muted ? "unmute" : "mute"} className="font-mono text-lg" style={{ color: "var(--color-ink-soft)" }}>
            {muted ? "🔇" : "🔊"}
          </button>
          <button onClick={toggleFullscreen} title="fullscreen" className="font-mono text-base" style={{ color: "var(--color-ink-soft)" }}>
            ⛶
          </button>
        </div>
      </div>

      </div>{/* end video border box */}

      {/* Now-playing strip + thumbnail rail. When stickyMeta is true, this
          block pins to the top of the nearest scrolling ancestor and is
          rendered as a SIBLING of the video (not nested under its border
          div) so it stays pinned for the entire scroll length of whatever
          comes after — the scenes list in the Rough Cut tab. */}
      <div
        className={stickyMeta ? "sticky top-0 z-20 border" : "border border-t-0"}
        style={{
          background: "var(--color-surface)",
          borderColor: "var(--color-rule)",
        }}
      >
        <div className="px-5 py-1.5 flex items-baseline gap-3 min-w-0">
          <span className="label shrink-0" style={{ color: "var(--color-cue)" }}>
            scene {idx + 1}/{programs.length}
          </span>
          <span className="font-display text-sm truncate min-w-0">{current?.name || "—"}</span>
          <span className="font-mono text-[11px] truncate min-w-0" style={{ color: "var(--color-ink-soft)" }}>
            {current?.asset_filename || current?.asset_id?.slice(0, 18)} · {fmtRange(current)}
          </span>
          <span className="ml-auto font-mono text-xs shrink-0" style={{ color: "var(--color-ink)" }}>
            <span className="label mr-2" style={{ color: "var(--color-ink-faint)" }}>total</span>
            {fmtDur(totalSec)}
          </span>
        </div>

        <ProgramRail programs={programs} idx={idx} onPick={jumpTo} assetCache={assetCache} />
      </div>
    </>
  );
}

// Smart per-clip thumb (brightness-aware frame walk) lives in lib/clip-thumb
// so the strip here and the per-clip blocks in RoughCut.tsx always agree on
// which frame represents a given clip.

function ProgramRail({
  programs, idx, onPick, assetCache,
}: {
  programs: ChannelProgram[];
  idx: number;
  onPick: (i: number) => void;
  assetCache: Record<string, Asset>;
}) {
  return (
    <ol className="flex gap-1.5 overflow-x-auto px-3 py-2 border-t" style={{ borderColor: "var(--color-rule)" }}>
      {programs.map((p, i) => {
        const isActive = i === idx;
        const isPreloading = i === idx + 1 || (idx === programs.length - 1 && i === 0);
        const dur = Math.max((p.source_end || 0) - (p.source_start || 0), 0);
        const asset = assetCache[p.asset_id];
        return (
          <li
            key={p.id || i}
            className="shrink-0 cursor-pointer border p-1.5 hover:border-[var(--color-cue-soft)]"
            style={{
              width: 140,
              borderColor: isActive ? "var(--color-cue)" : isPreloading ? "color-mix(in oklch, var(--color-cue) 40%, var(--color-rule))" : "var(--color-rule)",
              background: isActive ? "rgba(255,122,26,0.08)" : "transparent",
            }}
            onClick={() => onPick(i)}
            title={isPreloading ? "pre-buffering" : undefined}
          >
            <SmartClipThumb start={p.source_start} end={p.source_end} asset={asset} />
            <div className="font-mono text-[10px] mt-1.5 flex items-center gap-1" style={{ color: isActive ? "var(--color-cue)" : "var(--color-ink-faint)" }}>
              {String(i + 1).padStart(2, "0")} · {fmtDur(dur)}
              {isPreloading && <span className="ml-auto" style={{ color: "var(--color-cue-soft)" }}>●</span>}
            </div>
            <div className="text-[11px] mt-0.5 truncate leading-tight" style={{ color: "var(--color-ink)" }} title={p.name}>
              {p.name}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function fmtClock(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const r = Math.floor(s - m * 60);
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function fmtRange(p?: ChannelProgram): string {
  if (!p) return "";
  return `${fmtDur(p.source_start || 0)} → ${fmtDur(p.source_end || 0)}`;
}

function fmtDur(s: number): string {
  if (!s) return "0s";
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  if (m < 60) return `${m}:${String(r).padStart(2, "0")}`;
  const h = Math.floor(m / 60);
  return `${h}h ${m - h * 60}m`;
}
