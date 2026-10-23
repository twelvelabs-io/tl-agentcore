// Inline card renderer for a `<distribution_card>` block emitted by the
// agent in Distribution-Readiness mode. Mounted above the response-prose
// in AgentCore.tsx; see also ui/src/lib/distribution-card.ts for the
// parser + types.
//
// Layout:
//   ┌─ Header ────────────────────────────────────────┐
//   │ § Distribution readiness · TERRITORY · as of X  │
//   │ "N of M ready; top blocker is …"                │
//   ├─ Policy ────────────────────────────────────────┤
//   │ applied_policy  requirements chips              │
//   ├─ Audience fit ──────────────────────────────────┤
//   │ top candidates: name · score · reasons          │
//   ├─ Assets ────────────────────────────────────────┤
//   │ per-asset: title · ready pill · have/missing    │
//   │             chips · rights windows · notes      │
//   └─────────────────────────────────────────────────┘

import type { DistributionAsset, DistributionCard as Card } from "../lib/distribution-card";

export function DistributionCard({ card }: { card: Card }) {
  const asOf = formatAsOf(card.as_of);
  return (
    <div
      className="mb-6 rounded-[var(--radius-card)] border overflow-hidden"
      style={{ borderColor: "var(--color-rule)", background: "var(--color-surface)" }}
      data-testid="distribution-card"
    >
      {/* HEADER */}
      <div
        className="px-5 pt-4 pb-3 border-b flex items-start justify-between gap-4"
        style={{ borderColor: "var(--color-rule)" }}
      >
        <div className="min-w-0">
          <div className="label" style={{ color: "var(--color-ink-faint)" }}>
            § Distribution readiness
          </div>
          <div className="mt-1 font-display text-xl tracking-tight flex items-baseline gap-3 flex-wrap">
            <span style={{ color: "var(--color-ink)" }}>{card.territory}</span>
            <span className="font-mono text-xs" style={{ color: "var(--color-ink-faint)" }}>
              as of {asOf}
            </span>
          </div>
          <p className="mt-2 text-sm leading-snug" style={{ color: "var(--color-ink-soft)" }}>
            {card.summary.text}
          </p>
        </div>
        <ReadyBadge
          ready={card.summary.ready_count}
          blocked={card.summary.blocked_count}
        />
      </div>

      {/* POLICY */}
      <Section title="Policy" subtitle={`applied: ${card.policy.applied_policy}`}>
        {card.policy.requirements.length === 0 ? (
          <p className="text-xs" style={{ color: "var(--color-ink-faint)" }}>
            no deliverables required
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {card.policy.requirements.map((r) => (
              <RequirementChip key={r} label={r} tone="neutral" />
            ))}
          </div>
        )}
        {card.policy.notes && (
          <p className="mt-2 text-xs italic" style={{ color: "var(--color-ink-faint)" }}>
            {card.policy.notes}
          </p>
        )}
      </Section>

      {/* AUDIENCE FIT */}
      {card.audience_fit.candidates.length > 0 && (
        <Section
          title="Audience fit"
          subtitle={card.audience_fit.method ? truncate(card.audience_fit.method, 60) : undefined}
        >
          <ul className="space-y-2">
            {card.audience_fit.candidates.slice(0, 5).map((c) => (
              <li key={c.segment_id} className="flex items-start gap-3">
                <div
                  className="shrink-0 font-mono text-xs rounded-[6px] px-2 py-0.5"
                  style={{
                    border: "1px solid var(--color-rule)",
                    color: "var(--color-cue)",
                    background: "var(--color-bg)",
                    minWidth: 42,
                    textAlign: "center",
                  }}
                  title={`fit score ${c.score}`}
                >
                  {c.score.toFixed(2)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm" style={{ color: "var(--color-ink)" }}>
                    {c.name || c.segment_id}
                  </div>
                  {c.reasons.length > 0 && (
                    <div
                      className="mt-0.5 text-xs"
                      style={{ color: "var(--color-ink-faint)" }}
                    >
                      {c.reasons.join(" · ")}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* ASSETS */}
      <Section
        title="Assets"
        subtitle={`${card.assets.length} total`}
      >
        {card.assets.length === 0 ? (
          <p className="text-xs" style={{ color: "var(--color-ink-faint)" }}>
            no assets with rights windows covering this territory
          </p>
        ) : (
          <ul className="space-y-3">
            {card.assets.map((a) => (
              <AssetRow key={a.asset_id} asset={a} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="px-5 py-3 border-b last:border-b-0"
      style={{ borderColor: "var(--color-rule)" }}
    >
      <div className="flex items-baseline justify-between mb-2">
        <span className="label" style={{ color: "var(--color-ink-faint)" }}>
          § {title}
        </span>
        {subtitle && (
          <span
            className="label font-mono"
            style={{ color: "var(--color-ink-faint)" }}
          >
            {subtitle}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function ReadyBadge({ ready, blocked }: { ready: number; blocked: number }) {
  const total = ready + blocked;
  const allReady = total > 0 && blocked === 0;
  const allBlocked = total > 0 && ready === 0;
  const color = allReady
    ? "var(--color-cue)"
    : allBlocked
      ? "var(--color-status-failed)"
      : "var(--color-ink-soft)";
  return (
    <div
      className="shrink-0 text-right font-mono text-xs"
      style={{ color, lineHeight: 1.3 }}
      title={`${ready} ready / ${blocked} blocked`}
    >
      <div className="font-display text-2xl">
        {ready}/{total}
      </div>
      <div
        className="label text-[9px]"
        style={{ color: "var(--color-ink-faint)" }}
      >
        ready
      </div>
    </div>
  );
}

function AssetRow({ asset }: { asset: DistributionAsset }) {
  const readyColor = asset.ready
    ? "var(--color-cue)"
    : "var(--color-status-failed)";
  const topWindow = asset.windows[0];
  return (
    <li
      className="rounded-[8px] border p-3"
      style={{
        borderColor: "var(--color-rule)",
        background: "var(--color-bg)",
      }}
      data-testid="distribution-card-asset"
      data-asset-id={asset.asset_id}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span
              className="font-display text-base tracking-tight"
              style={{ color: "var(--color-ink)" }}
            >
              {asset.title || "untitled"}
            </span>
            <span
              className="font-mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-full shrink-0"
              style={{
                border: `1px solid ${readyColor}`,
                color: readyColor,
              }}
            >
              {asset.ready ? "ready" : "blocked"}
            </span>
          </div>
          {topWindow && (
            <div
              className="mt-0.5 font-mono text-[10px]"
              style={{ color: "var(--color-ink-faint)" }}
              title={asset.windows
                .map((w) => `${w.region}: ${w.window_start} → ${w.window_end}`)
                .join("  ·  ")}
            >
              {topWindow.region} · {formatWindow(topWindow.window_start, topWindow.window_end)}
              {asset.windows.length > 1 && ` · +${asset.windows.length - 1}`}
              {topWindow.usage_type && ` · ${topWindow.usage_type}`}
            </div>
          )}
        </div>
      </div>

      {/* Deliverables status */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {asset.have.map((r) => (
          <RequirementChip key={`h-${r}`} label={r} tone="have" />
        ))}
        {asset.missing.map((r) => (
          <RequirementChip key={`m-${r}`} label={r} tone="missing" />
        ))}
      </div>

      {asset.notes && (
        <p
          className="mt-2 text-xs leading-snug"
          style={{ color: "var(--color-ink-soft)" }}
        >
          {asset.notes}
        </p>
      )}
    </li>
  );
}

function RequirementChip({
  label,
  tone,
}: {
  label: string;
  tone: "have" | "missing" | "neutral";
}) {
  const { bg, color, border, prefix } = chipStyle(tone);
  return (
    <span
      className="font-mono text-[10px] rounded-full px-2 py-0.5 inline-flex items-center gap-1"
      style={{ background: bg, color, border: `1px solid ${border}` }}
      data-testid="deliverable-chip"
      data-tone={tone}
    >
      <span style={{ opacity: 0.65 }}>{prefix}</span>
      {label}
    </span>
  );
}

function chipStyle(tone: "have" | "missing" | "neutral") {
  if (tone === "have") {
    return {
      bg: "var(--color-bg)",
      color: "var(--color-cue)",
      border: "var(--color-cue)",
      prefix: "✓",
    };
  }
  if (tone === "missing") {
    return {
      bg: "var(--color-bg)",
      color: "var(--color-status-failed)",
      border: "var(--color-status-failed)",
      prefix: "✗",
    };
  }
  return {
    bg: "var(--color-surface)",
    color: "var(--color-ink-soft)",
    border: "var(--color-rule)",
    prefix: "·",
  };
}

function formatAsOf(iso: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}

function formatWindow(start: string, end: string): string {
  const s = windowDate(start);
  const e = windowDate(end);
  if (!s && !e) return "—";
  return `${s || "?"} → ${e || "?"}`;
}

function windowDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().slice(0, 10);
  } catch {
    return iso || null;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
