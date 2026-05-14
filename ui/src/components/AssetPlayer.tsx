// Shared asset-player modal — used by the Assets tab grid AND by inline
// chips in agent / lens / conversation prose. Driven by store.activeAssetId
// so any chip click opens it from anywhere in the UI.

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import Hls from "hls.js";
import { deleteAsset, getAsset, type Asset } from "../lib/api";
import { setState, useStore } from "../lib/store";

export function GlobalAssetPlayer() {
  const id = useStore((s) => s.activeAssetId);
  const [asset, setAsset] = useState<Asset | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!id) { setAsset(null); setErr(null); return; }
    let alive = true;
    getAsset(id)
      .then((a) => alive && setAsset(a))
      .catch((e) => alive && setErr(String(e)));
    return () => { alive = false; };
  }, [id]);

  const close = () => setState({ activeAssetId: undefined });
  const onDelete = async () => {
    if (!asset) return;
    if (!confirm(`Delete ${asset.filename || asset._id}? This is permanent.`)) return;
    try { await deleteAsset(asset._id); close(); }
    catch (e) { alert(String(e)); }
  };

  return (
    <AnimatePresence>
      {id && <PlayerModal asset={asset} loadErr={err} onClose={close} onDelete={onDelete} />}
    </AnimatePresence>
  );
}

function PlayerModal({
  asset, loadErr, onClose, onDelete,
}: { asset: Asset | null; loadErr: string | null; onClose: () => void; onDelete: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hlsStatus, setHlsStatus] = useState<"playing" | "loading" | "noplay" | "err">("loading");

  useEffect(() => {
    if (!asset) return;
    const video = videoRef.current;
    if (!video) return;
    const url = asset.hls?.manifest_url;
    if (!url || asset.hls?.status !== "ready") {
      setHlsStatus("noplay");
      return;
    }

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
      video.play().catch(() => setHlsStatus("err"));
      setHlsStatus("playing");
      return;
    }
    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true });
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
        setHlsStatus("playing");
      });
      hls.on(Hls.Events.ERROR, (_e, d) => {
        if (d.fatal) setHlsStatus("err");
      });
      return () => hls.destroy();
    }
    setHlsStatus("err");
  }, [asset]);

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center px-6"
      style={{ background: "rgba(0,0,0,0.78)" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      onClick={onClose}
    >
      <motion.div
        className="grain max-w-4xl w-full"
        style={{ background: "var(--color-paper)", border: "1px solid var(--color-rule)" }}
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.97 }}
        transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-baseline justify-between p-5 border-b" style={{ borderColor: "var(--color-rule)" }}>
          <div>
            <div className="label" style={{ color: "var(--color-cue)" }}>asset</div>
            <h2 className="font-display text-2xl mt-1">{asset?.filename || (asset ? "(unnamed)" : "loading…")}</h2>
            <div className="font-mono text-[11px] mt-1" style={{ color: "var(--color-ink-faint)" }}>{asset?._id}</div>
          </div>
          <button className="label hover:text-[var(--color-cue)]" onClick={onClose}>close ✕</button>
        </header>

        <div className="aspect-video grain" style={{ background: "var(--color-surface)" }}>
          {loadErr ? (
            <div className="h-full flex flex-col items-center justify-center px-8 text-center">
              <p className="font-display text-2xl" style={{ color: "var(--color-status-failed)" }}>Asset not found</p>
              <p className="font-mono text-xs mt-3 break-all" style={{ color: "var(--color-ink-soft)" }}>{loadErr}</p>
            </div>
          ) : !asset ? (
            <div className="h-full flex items-center justify-center">
              <p className="caret font-display text-xl" style={{ color: "var(--color-ink-soft)" }}>loading</p>
            </div>
          ) : hlsStatus === "noplay" ? (
            <div className="h-full flex flex-col items-center justify-center px-8 text-center">
              <div className="font-mono text-3xl mb-4" style={{ color: "var(--color-ink-faint)" }}>▣</div>
              <p className="font-display text-2xl">No preview available</p>
              <p className="text-sm mt-2 max-w-md" style={{ color: "var(--color-ink-soft)" }}>
                This asset was uploaded without <span className="font-mono">enable_hls</span> /
                <span className="font-mono"> enable_thumbnail</span>. Re-upload from the Library tab to generate one.
              </p>
            </div>
          ) : hlsStatus === "err" ? (
            <div className="h-full flex flex-col items-center justify-center px-8 text-center">
              <p className="font-display text-2xl" style={{ color: "var(--color-status-failed)" }}>Player error</p>
              <p className="font-mono text-xs mt-3 break-all" style={{ color: "var(--color-ink-soft)" }}>{asset.hls?.manifest_url}</p>
            </div>
          ) : (
            <video ref={videoRef} controls playsInline className="w-full h-full" style={{ background: "#000" }} />
          )}
        </div>

        {asset && (
          <>
            <dl className="grid grid-cols-2 lg:grid-cols-4 gap-4 p-5 text-sm">
              <Field label="Status">{asset.status}</Field>
              <Field label="Duration">{asset.duration ? fmtDur(asset.duration) : "—"}</Field>
              <Field label="Size">{fmtSize(asset.size) || "—"}</Field>
              <Field label="File type">{asset.file_type || "—"}</Field>
              {asset.hls?.manifest_url && (
                <Field label="HLS manifest" full>
                  <a href={asset.hls.manifest_url} target="_blank" rel="noreferrer" className="font-mono text-[10px] break-all" style={{ color: "var(--color-cue)" }}>
                    {asset.hls.manifest_url}
                  </a>
                </Field>
              )}
            </dl>
            <footer className="flex justify-end p-4 border-t" style={{ borderColor: "var(--color-rule)" }}>
              <button className="label hover:text-[var(--color-status-failed)]" onClick={onDelete}>
                delete asset
              </button>
            </footer>
          </>
        )}
      </motion.div>
    </motion.div>
  );
}

function Field({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <div className={full ? "col-span-full" : ""}>
      <dt className="label" style={{ color: "var(--color-ink-faint)" }}>{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

function fmtDur(s: number): string {
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}
function fmtSize(b?: number): string {
  if (!b) return "";
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)}KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)}MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)}GB`;
}
