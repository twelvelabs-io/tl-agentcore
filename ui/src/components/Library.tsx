// § III · Library — manage the items attached to the active knowledge base.
//
// Same three-pane chassis as the studio:
//   ┌─ Left rail ──────────┬─ Center ─────────────────┬─ Right rail ─┐
//   │ Search + filters     │ Upload zone + item grid  │ Selected     │
//   │ Upload status        │                          │ item details │
//   │                      │                          │ + actions    │
//   └──────────────────────┴──────────────────────────┴──────────────┘
//
// Upload path: browser → POST /upload/presign → S3 PUT (presigned) →
// POST /tl/assets {method=url, url=<presigned GET>} → POST
// /tl/knowledge-stores/{ks}/items {asset_id}. TL kicks off Marengo
// indexing automatically. The operator still re-runs ingest_vectors.py
// for the Bedrock-native S3 Vectors embedding step.

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useStore, setState as setGlobal } from "../lib/store";
import {
  addItem,
  deleteAsset,
  getAsset,
  listItems,
  presignUpload,
  removeItem,
  s3PutWithProgress,
  startAutoEmbed,
  type Asset,
  type KSItem,
} from "../lib/api";

type UploadJob = {
  id: string;
  file: File;
  status: "presigning" | "uploading" | "creating-asset" | "attaching" | "embedding" | "done" | "failed";
  progress: number; // 0-100
  error?: string;
  asset_id?: string;
};

type StatusFilter = "all" | "ready" | "indexing" | "failed";

export function Library() {
  const ks = useStore((s) => s.ks);
  const [items, setItems] = useState<KSItem[]>([]);
  const [details, setDetails] = useState<Record<string, Asset>>({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadJob[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<KSItem | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load items whenever the active KS changes.
  useEffect(() => {
    if (!ks) return;
    setLoading(true); setErr(null); setItems([]); setDetails({}); setSelectedId(null);
    listItems(ks._id)
      .then((rows) => setItems(rows))
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [ks?._id]);

  // Lazy-fetch asset details for visible items, throttled to 6 concurrent.
  useEffect(() => {
    if (!items.length) return;
    const need = items.filter((it) => it.asset_id && !details[it.asset_id]).slice(0, 60);
    if (!need.length) return;
    let cancelled = false;
    const queue = [...need];
    const workers = Array.from({ length: 6 }, async () => {
      while (queue.length && !cancelled) {
        const it = queue.shift();
        if (!it?.asset_id) continue;
        try {
          const asset = await getAsset(it.asset_id);
          if (!cancelled) setDetails((d) => ({ ...d, [it.asset_id!]: asset }));
        } catch { /* asset detail failures are non-fatal */ }
      }
    });
    Promise.all(workers);
    return () => { cancelled = true; };
  }, [items]);

  // Poll non-terminal assets until HLS is ready (or failed). Without this
  // the detail panel's `transcoding…` overlay stays stuck when the user
  // opens a card mid-transcode — MediaConvert finishes 5-10 min later
  // but nothing re-fetches getAsset() to pick up hls.status="ready".
  useEffect(() => {
    if (!items.length) return;
    const isTerminal = (a?: Asset) => {
      const hls = a?.hls?.status;
      const overall = (a?.status || "").toLowerCase();
      return (hls === "ready" || hls === "failed")
          && (overall === "ready" || overall === "failed");
    };
    const pending = items.filter((it) => it.asset_id && details[it.asset_id] && !isTerminal(details[it.asset_id]));
    if (!pending.length) return;
    let cancelled = false;
    const id = window.setInterval(async () => {
      for (const it of pending) {
        if (cancelled || !it.asset_id) continue;
        try {
          const asset = await getAsset(it.asset_id);
          if (!cancelled) setDetails((d) => ({ ...d, [it.asset_id!]: asset }));
        } catch { /* transient failures — next tick retries */ }
      }
    }, 8000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [items, details]);

  // Filter + sort items for display.
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return items.filter((it) => {
      if (statusFilter !== "all" && (it.status || "").toLowerCase() !== statusFilter) return false;
      if (!q) return true;
      const a = it.asset_id ? details[it.asset_id] : undefined;
      const name = (it.filename || a?.filename || it.asset_id || "").toLowerCase();
      return name.includes(q);
    });
  }, [items, filter, statusFilter, details]);

  const selected = useMemo(() => {
    if (!selectedId) return null;
    const it = items.find((i) => i._id === selectedId);
    if (!it) return null;
    const asset = it.asset_id ? details[it.asset_id] : undefined;
    return { item: it, asset };
  }, [selectedId, items, details]);

  // ── Upload pipeline ───────────────────────────────────────────────────
  const handleFiles = async (files: FileList | null) => {
    if (!files || !ks) return;
    for (const file of Array.from(files)) {
      const jobId = Math.random().toString(36).slice(2, 10);
      const job: UploadJob = { id: jobId, file, status: "presigning", progress: 0 };
      setUploads((u) => [job, ...u]);
      void runUpload(job, ks._id);
    }
  };

  const runUpload = async (job: UploadJob, ksId: string) => {
    const upd = (patch: Partial<UploadJob>) =>
      setUploads((u) => u.map((j) => (j.id === job.id ? { ...j, ...patch } : j)));
    try {
      const presigned = await presignUpload(job.file.name, job.file.type || "video/mp4");
      upd({ status: "uploading" });
      await s3PutWithProgress(presigned.put_url, job.file, (loaded, total) =>
        upd({ progress: Math.round((loaded / total) * 100) }),
      );
      // One server call now does asset-row creation, KS attach, the
      // canonical S3 copy, MediaConvert HLS kick-off, and Marengo. The
      // browser stops here — finalization runs asynchronously.
      upd({ status: "embedding", progress: 100 });
      const out = await startAutoEmbed(presigned.key, ksId, job.file.name);
      upd({ status: "done", asset_id: out.asset_id });

      // Refresh the item list so the new item shows up.
      const rows = await listItems(ksId);
      setItems(rows);
    } catch (e) {
      upd({ status: "failed", error: String(e) });
    }
  };

  // ── Detach + delete ────────────────────────────────────────────────────
  const handleDetach = async (item: KSItem) => {
    if (!ks) return;
    const prev = items;
    setItems((rows) => rows.filter((r) => r._id !== item._id));
    if (selectedId === item._id) setSelectedId(null);
    try {
      await removeItem(ks._id, item._id);
    } catch (e) {
      setErr(`detach failed: ${e}`);
      setItems(prev);
    }
  };

  const handleDelete = async (item: KSItem) => {
    if (!item.asset_id) return;
    const prev = items;
    setItems((rows) => rows.filter((r) => r._id !== item._id));
    if (selectedId === item._id) setSelectedId(null);
    setConfirmDelete(null);
    try {
      await deleteAsset(item.asset_id);
    } catch (e) {
      setErr(`delete failed: ${e}`);
      setItems(prev);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="grid h-full min-h-0" style={{ gridTemplateColumns: "320px 1fr 320px" }}>
      {/* LEFT — search + filters + upload status */}
      <aside className="flex flex-col min-h-0 border-r" style={{ borderColor: "var(--color-rule)" }}>
        <div className="px-5 pt-5 pb-4 border-b" style={{ borderColor: "var(--color-rule)" }}>
          <div className="label">§ Library</div>
          <div className="text-xs mt-1" style={{ color: "var(--color-ink-soft)" }}>
            {loading ? "loading…" : `${items.length} item${items.length === 1 ? "" : "s"} in ${ks?.name || "—"}`}
          </div>
          <input
            type="search"
            placeholder="Filter by name…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="bg-transparent border w-full p-2 mt-3 outline-none text-sm rounded-[var(--radius-card)]"
            style={{ borderColor: "var(--color-rule)" }}
          />
          <div className="flex gap-1 mt-3">
            {(["all", "ready", "indexing", "failed"] as StatusFilter[]).map((s) => (
              <button
                key={s}
                className="text-xs px-2 py-1 rounded-[var(--radius-btn)] transition-colors"
                style={{
                  background: statusFilter === s ? "var(--color-surface-2)" : "transparent",
                  color: statusFilter === s ? "var(--color-ink)" : "var(--color-ink-soft)",
                  border: `1px solid ${statusFilter === s ? "var(--color-ink-soft)" : "var(--color-rule)"}`,
                }}
                onClick={() => setStatusFilter(s)}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* Upload status */}
        {uploads.length > 0 && (
          <div className="flex flex-col min-h-0 flex-1">
            <div className="px-5 pt-3 pb-2 flex items-baseline justify-between">
              <span className="label">§ Uploads</span>
              <button
                className="label hover:text-[var(--color-ink)] transition-colors"
                onClick={() => setUploads((u) => u.filter((j) => j.status !== "done" && j.status !== "failed"))}
                title="dismiss completed + failed uploads"
              >
                clear done
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-4 space-y-2">
              {uploads.map((j) => <UploadRow key={j.id} job={j} />)}
            </div>
          </div>
        )}

        {err && (
          <div className="mt-auto px-5 pb-4">
            <pre className="font-mono text-[11px] p-2 whitespace-pre-wrap rounded-[var(--radius-card)]" style={{ background: "var(--color-surface)", color: "var(--color-status-failed)" }}>{err}</pre>
          </div>
        )}
      </aside>

      {/* CENTER — upload zone + grid */}
      <section className="flex flex-col min-h-0 overflow-hidden">
        <DropZone
          onFiles={handleFiles}
          onPick={() => fileInputRef.current?.click()}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          multiple
          className="hidden"
          onChange={(e) => { void handleFiles(e.target.files); e.target.value = ""; }}
        />
        <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-6">
          {!loading && visible.length === 0 && (
            <p className="text-sm py-12" style={{ color: "var(--color-ink-soft)" }}>
              {items.length === 0 ? "No items in this knowledge base yet. Drop a video above to add one."
                                  : "No items match the current filter."}
            </p>
          )}
          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {visible.map((it) => {
              const asset = it.asset_id ? details[it.asset_id] : undefined;
              const isSelected = it._id === selectedId;
              return (
                <ItemCard
                  key={it._id}
                  item={it}
                  asset={asset}
                  selected={isSelected}
                  onClick={() => {
                    setSelectedId(it._id);
                    // Double-click semantics: clicking an already-selected
                    // playable card opens the player; first click just
                    // selects it.
                    if (isSelected && asset?.hls?.status === "ready" && asset?._id) {
                      setGlobal({ activeAssetId: asset._id });
                    }
                  }}
                />
              );
            })}
          </div>
        </div>
      </section>

      {/* RIGHT — selected item details + actions */}
      <aside className="flex flex-col min-h-0 border-l" style={{ borderColor: "var(--color-rule)" }}>
        <div className="px-5 py-4 border-b" style={{ borderColor: "var(--color-rule)" }}>
          <div className="label">§ Item details</div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
          {!selected ? (
            <p className="text-sm" style={{ color: "var(--color-ink-soft)" }}>
              Select an item to view its details.
            </p>
          ) : (
            <ItemDetails
              item={selected.item}
              asset={selected.asset}
              onDetach={() => handleDetach(selected.item)}
              onDelete={() => setConfirmDelete(selected.item)}
            />
          )}
        </div>
      </aside>

      {/* Delete-confirm modal */}
      <AnimatePresence>
        {confirmDelete && (
          <>
            <motion.div
              className="fixed inset-0 z-40"
              style={{ background: "rgba(0,0,0,0.6)" }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              onClick={() => setConfirmDelete(null)}
            />
            <motion.div
              className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-[420px] p-6 border rounded-[var(--radius-card)]"
              style={{ background: "var(--color-paper)", borderColor: "var(--color-rule)" }}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.18 }}
            >
              <div className="label" style={{ color: "var(--color-status-failed)" }}>Delete asset?</div>
              <p className="font-display text-xl mt-2">
                "{confirmDelete.filename || confirmDelete.asset_id}"
              </p>
              <p className="text-sm mt-3" style={{ color: "var(--color-ink-soft)" }}>
                This removes the asset from TwelveLabs entirely. The bytes,
                embeddings, and any other knowledge bases referencing it
                will lose access. Irreversible.
              </p>
              <div className="flex justify-end gap-2 mt-5">
                <button className="btn" onClick={() => setConfirmDelete(null)}>Cancel</button>
                <button
                  className="btn"
                  style={{ borderColor: "var(--color-status-failed)", color: "var(--color-status-failed)" }}
                  onClick={() => handleDelete(confirmDelete)}
                >
                  Delete forever
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Subcomponents ────────────────────────────────────────────────────────

function DropZone({ onFiles, onPick }: { onFiles: (f: FileList | null) => void; onPick: () => void }) {
  const [drag, setDrag] = useState(false);
  return (
    <div
      className="m-6 mb-3 border-2 border-dashed rounded-[var(--radius-card)] px-6 py-7 text-center transition-colors cursor-pointer"
      style={{
        borderColor: drag ? "var(--color-cue)" : "var(--color-rule)",
        background: drag ? "var(--color-surface)" : "transparent",
      }}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); onFiles(e.dataTransfer.files); }}
      onClick={onPick}
    >
      <div className="label">Upload</div>
      <p className="font-display text-lg mt-1">
        Drop a video here, or click to choose
      </p>
      <p className="text-xs mt-1" style={{ color: "var(--color-ink-faint)" }}>
        Streams to S3 via a presigned URL, then TwelveLabs ingests it for Marengo indexing.
      </p>
    </div>
  );
}

function ItemCard({ item, asset, selected, onClick }: {
  item: KSItem;
  asset?: Asset;
  selected: boolean;
  onClick: () => void;
}) {
  const filename = item.filename || asset?.filename || (item.asset_id ? item.asset_id.slice(0, 12) + "…" : "(unknown)");
  const thumb = asset?.thumbnail?.representative_url;
  const dur = asset?.duration ? formatDuration(asset.duration) : null;
  const status = item.status || asset?.status || "—";
  return (
    <button
      className="text-left clip-card flex flex-col overflow-hidden"
      style={{
        borderColor: selected ? "var(--color-cue)" : "var(--color-rule)",
        background: selected ? "var(--color-surface-2)" : "var(--color-surface)",
      }}
      onClick={onClick}
    >
      <div
        className="aspect-video w-full relative group/thumb"
        style={{
          background: thumb ? `center/cover no-repeat url('${thumb}')` : "var(--color-surface-2)",
        }}
      >
        {/* Subtle play hint on hover when the asset is playable. */}
        {asset?.hls?.status === "ready" && (
          <div
            className="absolute inset-0 flex items-center justify-center opacity-0 group-hover/thumb:opacity-100 transition-opacity"
            style={{ background: "linear-gradient(180deg, rgba(0,0,0,0) 30%, rgba(0,0,0,0.45) 100%)" }}
          >
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center"
              style={{
                background: "rgba(0,0,0,0.55)",
                border: "1.5px solid rgba(255,255,255,0.9)",
                color: "white",
              }}
            >
              <span style={{ fontSize: 16, lineHeight: 1, marginLeft: 2 }}>▶</span>
            </div>
          </div>
        )}
      </div>
      <div className="px-3 py-2.5">
        <div className="font-display text-sm leading-tight truncate" title={filename}>
          {filename}
        </div>
        <div className="flex items-center justify-between mt-1 text-[10px] font-mono" style={{ color: "var(--color-ink-soft)" }}>
          <span>{dur || "—"}</span>
          <StatusPill status={status} />
        </div>
      </div>
    </button>
  );
}

function ItemDetails({
  item, asset, onDetach, onDelete,
}: {
  item: KSItem;
  asset?: Asset;
  onDetach: () => void;
  onDelete: () => void;
}) {
  const filename = item.filename || asset?.filename || "(unknown)";
  const playable = asset?.hls?.status === "ready" && !!asset?.hls?.manifest_url;
  const open = () => {
    if (playable && asset?._id) setGlobal({ activeAssetId: asset._id });
  };
  return (
    <div className="space-y-4 text-sm">
      <button
        type="button"
        onClick={open}
        disabled={!playable}
        className="group relative block aspect-video w-full rounded-[var(--radius-card)] overflow-hidden"
        style={{
          background: asset?.thumbnail?.representative_url
            ? `center/cover no-repeat url('${asset.thumbnail.representative_url}')`
            : "var(--color-surface)",
          cursor: playable ? "pointer" : "default",
        }}
        title={playable ? "Click to play" : "Not playable yet — HLS transcode pending"}
      >
        {/* Play overlay */}
        <div
          className="absolute inset-0 flex items-center justify-center transition-opacity"
          style={{
            background: "linear-gradient(180deg, rgba(0,0,0,0.05) 0%, rgba(0,0,0,0.45) 100%)",
            opacity: playable ? 0.85 : 0.55,
          }}
        >
          {playable ? (
            <div
              className="w-14 h-14 rounded-full flex items-center justify-center transition-transform group-hover:scale-110"
              style={{
                background: "rgba(0,0,0,0.55)",
                border: "1.5px solid rgba(255,255,255,0.9)",
                color: "white",
              }}
            >
              <span style={{ fontSize: 22, lineHeight: 1, marginLeft: 3 }}>▶</span>
            </div>
          ) : (
            <span className="label" style={{ color: "white", letterSpacing: "0.08em" }}>
              transcoding…
            </span>
          )}
        </div>
      </button>
      <div>
        <div className="label">Filename</div>
        <div className="font-mono text-xs break-all mt-0.5">{filename}</div>
      </div>
      <Field label="Duration" value={asset?.duration ? formatDuration(asset.duration) : "—"} />
      <Field label="Size" value={asset?.size ? formatSize(asset.size) : "—"} />
      <Field label="File type" value={asset?.file_type || "—"} />
      <Field label="Status" value={<StatusPill status={item.status || asset?.status || "—"} />} />
      <Field label="Asset ID" value={item.asset_id || "—"} mono />
      <Field label="Item ID"  value={item._id} mono />
      <div className="pt-3 border-t flex flex-col gap-2" style={{ borderColor: "var(--color-rule)" }}>
        {playable && (
          <button className="btn btn-cue" onClick={open}>Play ▶</button>
        )}
        <button className="btn" onClick={onDetach}>Detach from KB</button>
        <button
          className="btn"
          style={{ borderColor: "var(--color-status-failed)", color: "var(--color-status-failed)" }}
          onClick={onDelete}
        >
          Delete asset entirely
        </button>
      </div>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className={`mt-0.5 ${mono ? "font-mono text-xs break-all" : ""}`}>{value}</div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const s = status.toLowerCase();
  const tone =
    s === "ready"    ? "var(--color-status-ready)" :
    s === "failed"   ? "var(--color-status-failed)" :
    s === "indexing" || s === "queued" || s === "processing" ? "var(--color-status-pending)" :
    "var(--color-ink-faint)";
  return (
    <span style={{ color: tone }}>
      ● {status}
    </span>
  );
}

function UploadRow({ job }: { job: UploadJob }) {
  const labelMap: Record<UploadJob["status"], string> = {
    "presigning":     "signing url…",
    "uploading":      `uploading · ${job.progress}%`,
    "creating-asset": "creating asset…",
    "attaching":      "attaching to kb…",
    "embedding":      "starting bedrock embed…",
    "done":           "✓ added · indexing in background",
    "failed":         "failed",
  };
  const tone = job.status === "failed" ? "var(--color-status-failed)"
             : job.status === "done"   ? "var(--color-status-ready)"
             :                            "var(--color-ink-soft)";
  return (
    <div className="border p-2 rounded-[10px]" style={{ borderColor: "var(--color-rule)" }}>
      <div className="text-xs font-mono truncate" title={job.file.name}>{job.file.name}</div>
      <div className="text-[10px] mt-1" style={{ color: tone }}>{labelMap[job.status]}</div>
      {job.status === "uploading" && (
        <div className="h-0.5 mt-1 w-full" style={{ background: "var(--color-rule)" }}>
          <div className="h-full" style={{ width: `${job.progress}%`, background: "var(--color-cue)" }} />
        </div>
      )}
      {job.error && (
        <div className="text-[10px] mt-1 font-mono whitespace-pre-wrap" style={{ color: "var(--color-status-failed)" }}>
          {job.error.slice(0, 200)}
        </div>
      )}
    </div>
  );
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
