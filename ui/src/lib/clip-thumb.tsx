// Shared thumbnail picker used by both the channel player's program rail
// (ChannelPlayer.tsx) and the per-clip blocks (RoughCut.tsx). Two surfaces
// looking at the same clip should always show the same frame.
//
// Two-tier strategy:
//
// 1. **Captured-frame chain (fast, always available).** MediaConvert
//    captured one frame every 5 s per asset (up to 180 frames). We pick
//    the captured frame closest to `source_start` and render it
//    immediately. For long assets (>15 min) where the start time falls
//    past the captured window, we fall back to the asset's
//    representative thumb. Brightness-aware fallback walks the chain if
//    the picked frame is essentially-black.
//
// 2. **Client-side HLS extraction (slow, frame-accurate).** In parallel
//    with (1), we load the HLS manifest into a hidden video element via
//    hls.js, seek to the exact `source_start`, and capture the frame to
//    a canvas → dataURL. This takes 1-3 s per clip (HLS segment fetch +
//    decode) but is frame-accurate to any timestamp regardless of asset
//    duration. Result is cached in-process keyed on (asset_id,
//    source_start) so swapping alternates doesn't re-decode.
//
// The captured frame paints first. Once the extracted dataURL is ready,
// it replaces the captured frame (visually a quick crossfade). A small
// spinner sits over the captured frame while extraction is pending so
// producers know a better preview is on the way.

import { useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";

import type { Asset } from "./api";

const THUMB_CADENCE_SEC = 5;
const THUMB_MAX_IDX = 179;
const DARK_LUMA_THRESHOLD = 22; // 0-255 mean luma; below this we treat as essentially black

/** Convert HH:MM:SS (or MM:SS, or plain seconds) to a numeric second count.
 *  Defined here so callers can pass either the RoughCutPlan's string fields
 *  or raw seconds from the ChannelPlayer's program objects. */
function toSeconds(t: string | number | undefined): number {
  if (t == null) return 0;
  if (typeof t === "number") return Math.max(0, t);
  const parts = t.split(":").map((s) => parseFloat(s));
  if (parts.some((n) => isNaN(n))) return 0;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

/** Build the candidate URL list. Order matters — the first one renders
 *  immediately; the rest are fallbacks only if the first comes up too dark.
 *
 *  The first probe is the captured frame closest to `start` so the rail
 *  thumbnail matches the actual first painted frame of the clip when it
 *  begins playing in the channel. Producers expect those to match: a
 *  midpoint sample makes the strip preview disagree with the player.
 *
 *  Coverage caveat: MediaConvert captures up to 180 frames at 5 s cadence
 *  per asset — that's only 900 s (15 min). Clips whose start time is past
 *  the captured window would otherwise all clamp to the same final frame,
 *  making different scenes from one long asset display identical
 *  thumbnails. We detect that case and fall back to the asset's
 *  representative thumb instead of the clamped-and-misleading per-clip thumb.
 */
export function clipThumbCandidates(
  start: string | number | undefined,
  end: string | number | undefined,
  asset: Asset | undefined,
): string[] {
  const base = asset?.thumbnail?.representative_url;
  if (!base) return [];
  if (!/_thumb\.\d{7}\.jpg$/.test(base)) return [base];
  const s = toSeconds(start);
  const e = toSeconds(end);
  const COVERAGE_END_SEC = THUMB_MAX_IDX * THUMB_CADENCE_SEC; // 895s
  // If the clip starts past the captured window, any computed index would
  // clamp to the last frame. Return only the representative thumb.
  if (s > COVERAGE_END_SEC) return [base];
  // Probe order: clip START first (matches the player), then progressive
  // forward steps as brightness fallbacks for clips that fade in from
  // black, finally the asset's representative thumb. We deliberately do
  // NOT seed with the midpoint anymore — a darker-but-correct start frame
  // is preferable to a brighter-but-wrong midpoint.
  const mid = e > s ? (s + e) / 2 : s;
  const probeSeconds: number[] = e > s
    ? [s, s + 1, s + THUMB_CADENCE_SEC, mid, e - 1]
    : [s, s + 1];
  const inRange = probeSeconds.filter((sec) => sec >= 0 && sec <= COVERAGE_END_SEC);
  const indices = Array.from(new Set(inRange.map((sec) =>
    Math.max(0, Math.min(THUMB_MAX_IDX, Math.floor(sec / THUMB_CADENCE_SEC)))
  )));
  const urls = indices.map((i) =>
    base.replace(/_thumb\.\d{7}\.jpg$/, `_thumb.${String(i).padStart(7, "0")}.jpg`)
  );
  if (!urls.includes(base)) urls.push(base);
  return urls;
}

function meanLuma(img: HTMLImageElement): number | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 9;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, 16, 9);
    const data = ctx.getImageData(0, 0, 16, 9).data;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      count++;
    }
    return count ? sum / count : null;
  } catch {
    return null;
  }
}

// ─── Client-side HLS frame extraction ────────────────────────────────────────
// Frame-accurate to any timestamp, regardless of MediaConvert's capture
// cadence. Uses ONE shared hidden <video> serialized through a queue
// (the element can only handle one src at a time) and ONE hls.js
// instance recycled per extraction. Results live in a module-level
// LRU-ish Map keyed on (asset_id, rounded source_start).

const EXTRACT_CACHE = new Map<string, string>();
const EXTRACT_IN_FLIGHT = new Map<string, Promise<string | null>>();
const EXTRACT_FAILED = new Set<string>();
let extractQueue: Promise<unknown> = Promise.resolve();

let _hiddenVideo: HTMLVideoElement | null = null;
let _activeHls: Hls | null = null;

function getHiddenVideo(): HTMLVideoElement {
  if (_hiddenVideo) return _hiddenVideo;
  const v = document.createElement("video");
  v.muted = true;
  v.defaultMuted = true;
  v.playsInline = true;
  v.preload = "auto";
  // Same-origin in production (UI + HLS both on CloudFront), so the
  // canvas stays untainted without explicit CORS gymnastics.
  v.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;";
  document.body.appendChild(v);
  _hiddenVideo = v;
  return v;
}

function destroyActiveHls() {
  if (_activeHls) {
    try { _activeHls.destroy(); } catch { /* */ }
    _activeHls = null;
  }
}

const cacheKey = (assetId: string, atSec: number) => `${assetId}#${Math.round(atSec)}`;

/** Synchronous accessor — returns the cached dataURL if extraction has
 *  already completed for this (asset_id, atSec). Lets components paint
 *  the frame-accurate thumb on first render without waiting for the
 *  async path to start over. */
export function getCachedClipFrame(asset: Asset | undefined, atSec: number): string | null {
  const aid = asset?._id;
  if (!aid) return null;
  return EXTRACT_CACHE.get(cacheKey(aid, atSec)) ?? null;
}

/** Kick off (or join) a client-side extraction for one clip. Returns a
 *  dataURL on success, null on any failure. Subsequent calls with the
 *  same (asset_id, atSec) hit the cache or join the in-flight promise. */
export function extractClipFrame(asset: Asset | undefined, atSec: number): Promise<string | null> {
  const aid = asset?._id;
  const manifestUrl = asset?.hls?.manifest_url;
  if (!aid || !manifestUrl || asset?.hls?.status !== "ready") return Promise.resolve(null);
  const key = cacheKey(aid, atSec);
  const cached = EXTRACT_CACHE.get(key);
  if (cached) return Promise.resolve(cached);
  if (EXTRACT_FAILED.has(key)) return Promise.resolve(null);
  const inFlight = EXTRACT_IN_FLIGHT.get(key);
  if (inFlight) return inFlight;

  const work = new Promise<string | null>((resolve) => {
    extractQueue = extractQueue.then(async () => {
      const video = getHiddenVideo();
      destroyActiveHls();

      let settled = false;
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        video.removeEventListener("seeked", onSeeked);
        video.removeEventListener("loadedmetadata", onNativeReady);
        video.removeEventListener("error", onError);
        if (value) EXTRACT_CACHE.set(key, value);
        else EXTRACT_FAILED.add(key);
        destroyActiveHls();
        resolve(value);
      };

      const onSeeked = () => {
        try {
          const c = document.createElement("canvas");
          c.width = 320; c.height = 180;
          const ctx = c.getContext("2d");
          if (!ctx) return finish(null);
          ctx.drawImage(video, 0, 0, 320, 180);
          finish(c.toDataURL("image/jpeg", 0.78));
        } catch {
          finish(null);
        }
      };
      const onError = () => finish(null);
      const onNativeReady = () => { try { video.currentTime = atSec; } catch { finish(null); } };

      video.addEventListener("seeked", onSeeked, { once: true });
      video.addEventListener("error", onError, { once: true });

      // 8s hard cap — slow networks / dead segments shouldn't block the queue.
      const timeout = setTimeout(() => finish(null), 8_000);

      try {
        if (video.canPlayType("application/vnd.apple.mpegurl")) {
          // Safari: native HLS.
          video.src = manifestUrl;
          video.addEventListener("loadedmetadata", onNativeReady, { once: true });
        } else if (Hls.isSupported()) {
          // Chrome/Firefox/Edge: hls.js bridges to MediaSource.
          const hls = new Hls({ maxBufferLength: 10, enableWorker: true });
          _activeHls = hls;
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            try { video.currentTime = atSec; } catch { finish(null); }
          });
          hls.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal) finish(null); });
          hls.loadSource(manifestUrl);
          hls.attachMedia(video);
        } else {
          finish(null);
        }
      } catch {
        finish(null);
      }

      // Wait until this extraction finishes before letting the queue
      // advance — otherwise the next call would clobber video.src mid-flight.
      await new Promise<void>((res) => {
        const tick = () => settled ? res() : setTimeout(tick, 50);
        tick();
      });
    });
    extractQueue.catch(() => { /* keep the queue alive on errors */ });
  });

  EXTRACT_IN_FLIGHT.set(key, work);
  work.finally(() => EXTRACT_IN_FLIGHT.delete(key));
  return work;
}

/** Renders a clip thumbnail. Paints the captured-frame fallback
 *  immediately (fast), then upgrades to the frame-accurate HLS-extracted
 *  dataURL once the async extraction completes (1-3 s typical). A small
 *  spinner sits over the captured frame while the upgrade is in flight. */
export function SmartClipThumb({
  start, end, asset, className = "", style,
}: {
  start: string | number | undefined;
  end?: string | number | undefined;
  asset: Asset | undefined;
  className?: string;
  style?: React.CSSProperties;
}) {
  const startSec = toSeconds(start);

  // Stage 1 — captured-frame fallback chain (fast, brightness-aware).
  const candidates = useMemo(() => clipThumbCandidates(start, end, asset), [start, end, asset]);
  const [acceptedSrc, setAcceptedSrc] = useState<string | null>(candidates[0] || null);
  const stateRef = useRef<{ tried: number; bestSrc: string | null; bestLuma: number }>({
    tried: 0, bestSrc: null, bestLuma: -1,
  });

  // Stage 2 — client-side HLS extraction (frame-accurate).
  const initialCached = asset ? getCachedClipFrame(asset, startSec) : null;
  const [extracted, setExtracted] = useState<string | null>(initialCached);
  const [extracting, setExtracting] = useState<boolean>(false);

  // Reset captured-fallback walker on input change.
  useEffect(() => {
    stateRef.current = { tried: 0, bestSrc: null, bestLuma: -1 };
    setAcceptedSrc(candidates[0] || null);
  }, [candidates.join("|")]);

  // Kick off (or join) the extraction whenever the clip identity changes.
  useEffect(() => {
    const cached = asset ? getCachedClipFrame(asset, startSec) : null;
    if (cached) {
      setExtracted(cached);
      setExtracting(false);
      return;
    }
    setExtracted(null);
    if (!asset?._id || !asset?.hls?.manifest_url || asset?.hls?.status !== "ready") {
      setExtracting(false);
      return;
    }
    setExtracting(true);
    let cancelled = false;
    extractClipFrame(asset, startSec).then((url) => {
      if (cancelled) return;
      setExtracting(false);
      if (url) setExtracted(url);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset?._id, asset?.hls?.manifest_url, asset?.hls?.status, startSec]);

  const onLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    if (extracted) return; // brightness walk only applies to the captured chain
    const img = e.currentTarget;
    const luma = meanLuma(img);
    const src = img.src;
    const s = stateRef.current;
    if (luma != null && luma > s.bestLuma) {
      s.bestLuma = luma;
      s.bestSrc = src;
    }
    if (luma == null || luma >= DARK_LUMA_THRESHOLD) return;
    s.tried += 1;
    if (s.tried < candidates.length) {
      setAcceptedSrc(candidates[s.tried]);
    } else if (s.bestSrc && s.bestSrc !== src) {
      setAcceptedSrc(s.bestSrc);
    }
  };

  const onError = () => {
    const s = stateRef.current;
    s.tried += 1;
    if (s.tried < candidates.length) {
      setAcceptedSrc(candidates[s.tried]);
    } else if (s.bestSrc) {
      setAcceptedSrc(s.bestSrc);
    } else {
      setAcceptedSrc(null);
    }
  };

  // Prefer the extracted frame (exact); fall back to the captured chain.
  const displaySrc = extracted ?? acceptedSrc;

  return (
    <div
      className={`aspect-video relative ${className}`}
      style={{ background: "var(--color-surface-2)", overflow: "hidden", ...style }}
    >
      {displaySrc && (
        <img
          key={displaySrc}
          src={displaySrc}
          alt=""
          loading="lazy"
          className="w-full h-full object-cover"
          style={{
            // Soften the captured→extracted swap so the change isn't a hard pop.
            opacity: extracting && !extracted ? 0.55 : 1,
            transition: "opacity 200ms ease-out",
          }}
          onLoad={onLoad}
          onError={onError}
        />
      )}
      {extracting && !extracted && (
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none"
          aria-label="generating frame-accurate thumbnail"
          style={{ background: "rgba(12,13,14,0.18)" }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            aria-hidden
            style={{ animation: "rc-spin 0.9s linear infinite", color: "#ebe6da", filter: "drop-shadow(0 0 4px rgba(0,0,0,0.6))" }}
          >
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" fill="none" />
            <path d="M21 12a9 9 0 0 1-9 9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" fill="none" />
          </svg>
        </div>
      )}
    </div>
  );
}
