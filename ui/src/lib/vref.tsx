// Render free-form agent responses as markdown with inline reference tags.
//
// The agent may emit reference tag types in prose:
//   <vref id="<uuid>"></vref>                                 — KS item
//   <vref id="<uuid>" start="00:00" end="00:05"></vref>      — KS item w/ clip
//   <tref id="<token>"></tref>                                — text snippet
//
// We use react-markdown with rehype-raw so authors get **bold**, lists,
// numbered steps, etc. — and override the unknown vref/tref elements with
// our chip components.

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import { getAsset, getItem, type Asset, type KSItem } from "./api";
import { setState } from "./store";

type Resolved = { item: KSItem; asset?: Asset };

const cache = new Map<string, Promise<Resolved>>();

function resolveVref(ksId: string, vrefId: string): Promise<Resolved> {
  const key = `${ksId}::${vrefId}`;
  if (!cache.has(key)) {
    cache.set(
      key,
      (async () => {
        const item = await getItem(ksId, `ksi_${vrefId}`);
        let asset: Asset | undefined;
        if (item.asset_id) {
          try { asset = await getAsset(item.asset_id); } catch { /* asset gone */ }
        }
        return { item, asset };
      })()
    );
  }
  return cache.get(key)!;
}

function fmtDuration(s: number | undefined): string {
  if (s == null) return "";
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

function fmtSize(b: number | undefined): string {
  if (!b) return "";
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)}KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)}MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

function shortId(id: string) {
  return id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

function Vref({ id, ksId, start, end }: { id: string; ksId: string; start?: string; end?: string }) {
  const [r, setR] = useState<Resolved | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    resolveVref(ksId, id)
      .then((res) => alive && setR(res))
      .catch(() => alive && setErr(true));
    return () => { alive = false; };
  }, [ksId, id]);

  const label = err
    ? shortId(id)
    : r?.asset?.filename || (r ? shortId(id) : "loading…");
  const meta = r?.asset
    ? [r.asset.duration ? fmtDuration(r.asset.duration) : "", fmtSize(r.asset.size)]
        .filter(Boolean).join(" · ")
    : "";
  const range = start && end ? `${start}–${end}` : start || end || "";

  const cls = err ? "vref vref-missing" : "vref";
  return (
    <span
      className={cls}
      title={
        err
          ? `not in this knowledge store\nitem ksi_${id}`
          : `${r?.asset?.filename || id}${meta ? "  ·  " + meta : ""}\nitem ksi_${id}${r?.item?.asset_id ? "\nasset " + r.item.asset_id : ""}${range ? "\nclip " + range : ""}`
      }
    >
      <span className="vref-glyph" aria-hidden>{err ? "⌀" : "▣"}</span>
      <span className="vref-name">{label}</span>
      {range && <span className="vref-range font-mono">{range}</span>}
      {meta && !range && <span className="vref-meta"> · {meta}</span>}
    </span>
  );
}

function Tref({ id }: { id: string }) {
  return (
    <span className="vref vref-text" title={`tref ${id}`}>
      <span className="vref-glyph" aria-hidden>※</span>
      <span className="vref-name">{shortId(id)}</span>
    </span>
  );
}

// Mongo-style ObjectId — what TwelveLabs uses for asset_ids. 24 lowercase hex.
const ASSET_ID_RE = /(?<![0-9a-f])`?([0-9a-f]{24})`?(?![0-9a-f])/gi;

/** Wrap bare 24-hex asset IDs (with or without surrounding backticks) in
 * `<aref id="…"></aref>` tags so react-markdown renders them as our chip. */
function wrapAssetIds(text: string): string {
  return text.replace(ASSET_ID_RE, (_, id) => `<aref id="${id}"></aref>`);
}

export function ResponseMarkdown({ text, ksId }: { text: string; ksId?: string }) {
  if (!text) return null;
  const prepared = wrapAssetIds(text);
  return (
    <div className="response-md">
      <ReactMarkdown
        rehypePlugins={[rehypeRaw]}
        components={{
          vref: ({ id, start, end }: { id?: string; start?: string; end?: string }) =>
            id && ksId ? <Vref id={id} ksId={ksId} start={start} end={end} /> :
            id ? <Tref id={id} /> :
            null,
          tref: ({ id }: { id?: string }) => (id ? <Tref id={id} /> : null),
          aref: ({ id }: { id?: string }) => (id ? <AssetChip id={id} /> : null),
        } as never}
      >
        {prepared}
      </ReactMarkdown>
    </div>
  );
}

/** Inline chip for a TL asset_id. Resolves filename + thumbnail; click opens
 * the global player modal. Falls back to short-id text if resolution fails. */
function AssetChip({ id }: { id: string }) {
  const [a, setA] = useState<Asset | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    getAsset(id)
      .then((res) => alive && setA(res))
      .catch(() => alive && setErr(true));
    return () => { alive = false; };
  }, [id]);

  const open = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setState({ activeAssetId: id });
  };

  const label = err ? shortId(id) : a?.filename || (a ? shortId(id) : "loading…");
  const title = err
    ? `not found\n${id}`
    : `${a?.filename || id}\n${id}\n(click to play)`;

  return (
    <span
      role="button"
      onClick={open}
      className={err ? "vref vref-missing" : "vref"}
      style={{ cursor: "pointer" }}
      title={title}
    >
      <span className="vref-glyph" aria-hidden>{err ? "⌀" : "▶"}</span>
      <span className="vref-name">{label}</span>
    </span>
  );
}

// Backward-compat alias so existing call sites keep working.
export const renderWithVrefs = (text: string, ksId: string | undefined) =>
  <ResponseMarkdown text={text} ksId={ksId} />;
