// EDL (CMX 3600) generator — the rough-cut interchange format every NLE
// (Premiere, Resolve, AVID, FCPX) imports natively.
//
// Format reference:
//   TITLE: Rough Cut
//   FCM: NON-DROP FRAME
//
//   001  AX       V     C        00:01:22:00 00:01:45:00 00:00:00:00 00:00:23:00
//   * FROM CLIP NAME: marketing_video_03.mp4
//
// Each event is one cut: source IN/OUT (in the original clip) and record
// IN/OUT (in the assembled timeline). Frames are in SMPTE timecode HH:MM:SS:FF.

import type { Asset } from "./api";

export type RoughCutAlternate = {
  video_reference: string;     // asset_id or video_id of the alternate
  start_time: string;
  end_time: string;
  rank?: number;               // Marengo rank (1 = best) from the same query as the primary
  why_alt?: string;            // one-line: what makes this a defensible swap
};

export type RoughCutClip = {
  video_reference: string;     // asset_id
  start_time: string;           // "HH:MM:SS" or "HH:MM:SS.fff" or "MM:SS"
  end_time: string;
  role?: string;
  take_note?: string;
  alternatives?: RoughCutAlternate[];
};

export type RoughCutScene = {
  scene_id: string;
  scene_name: string;
  scene_description?: string;
  clips: RoughCutClip[];
};

export type RoughCutPlan = {
  title?: string;
  scenes: RoughCutScene[];
  total_estimated_duration?: string;
  notes?: string;
};

/** Parse "HH:MM:SS", "HH:MM:SS.fff", "MM:SS", or plain seconds → seconds. */
export function parseTime(s: string | number | undefined): number {
  if (s == null) return 0;
  if (typeof s === "number") return s;
  const t = String(s).trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const parts = t.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, sec] = parts;
  return h * 3600 + m * 60 + sec;
}

/** Format seconds as SMPTE timecode HH:MM:SS:FF at the given fps. */
export function smpte(seconds: number, fps: number): string {
  const total = Math.max(0, Math.round(seconds * fps));
  const f = total % fps;
  const s = Math.floor(total / fps) % 60;
  const m = Math.floor(total / (fps * 60)) % 60;
  const h = Math.floor(total / (fps * 3600));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(f)}`;
}

/** Assets resolved by id, used to populate FROM CLIP NAME comments. */
export type AssetLookup = (id: string) => Asset | undefined;

export function generateEDL(plan: RoughCutPlan, opts: { fps: number; lookup?: AssetLookup }): string {
  const { fps, lookup } = opts;
  const lines: string[] = [];
  lines.push(`TITLE:   ${(plan.title || "Rough Cut").replace(/[\n\r]/g, " ").slice(0, 70)}`);
  lines.push("FCM:     NON-DROP FRAME");
  lines.push("");

  let event = 1;
  let recordSec = 0;
  for (const scene of plan.scenes) {
    if (scene.scene_name) {
      lines.push(`* SCENE ${scene.scene_id || ""}: ${scene.scene_name}`);
    }
    for (const clip of scene.clips || []) {
      const inSec = parseTime(clip.start_time);
      const outSec = parseTime(clip.end_time);
      const dur = Math.max(outSec - inSec, 0);
      if (dur <= 0) continue;
      const recOut = recordSec + dur;
      const reel = "AX      "; // 8-char reel id; AX = auxiliary
      const ev = String(event).padStart(3, "0");
      lines.push(
        `${ev}  ${reel} V     C        ` +
        `${smpte(inSec, fps)} ${smpte(outSec, fps)} ` +
        `${smpte(recordSec, fps)} ${smpte(recOut, fps)}`
      );
      const a = lookup?.(clip.video_reference);
      const filename = a?.filename || clip.video_reference;
      lines.push(`* FROM CLIP NAME: ${filename}`);
      if (clip.role || clip.take_note) {
        const note = [clip.role, clip.take_note].filter(Boolean).join(" — ");
        lines.push(`* COMMENT: ${note}`);
      }
      lines.push("");
      recordSec = recOut;
      event++;
    }
  }

  return lines.join("\n");
}

/** Total duration of the timeline in seconds. */
export function totalDuration(plan: RoughCutPlan): number {
  let s = 0;
  for (const scene of plan.scenes) {
    for (const clip of scene.clips || []) {
      s += Math.max(parseTime(clip.end_time) - parseTime(clip.start_time), 0);
    }
  }
  return s;
}

export function fmtDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.round(secs % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s.toFixed(1)}s`;
}
