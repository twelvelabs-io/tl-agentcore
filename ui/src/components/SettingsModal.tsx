// Settings modal — tabbed admin surface.
//   - Prompts: view/edit the agent + ingest system prompts (global, DDB).
//   - Users:   admin-only Cognito user management (hidden from non-admins).

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";

import { isAdmin } from "../lib/auth";
import {
  fetchPrompts,
  resetPrompt,
  savePrompt,
  type PromptId,
  type PromptInfo,
  type PromptsResponse,
} from "../lib/settings-api";
import {
  deleteUser as apiDeleteUser,
  disableUser,
  enableUser,
  inviteUser,
  listUsers,
  resendInv,
  resetPwd,
  type User,
} from "../lib/users-api";

type Prompts = Record<PromptId, PromptInfo>;
type TabId = "prompts" | "users";

export default function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <AnimatePresence>
      {open && <SettingsModalContent onClose={onClose} />}
    </AnimatePresence>
  );
}

function SettingsModalContent({ onClose }: { onClose: () => void }) {
  const showUsers = isAdmin();
  const [tab, setTab] = useState<TabId>("prompts");

  // Close on Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
        className="grain w-full"
        style={{
          background: "var(--color-paper)",
          border: "1px solid var(--color-rule)",
          maxWidth: "min(1100px, 95vw)",
          maxHeight: "92vh",
          display: "flex",
          flexDirection: "column",
        }}
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.97 }}
        transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-baseline justify-between p-5 border-b" style={{ borderColor: "var(--color-rule)" }}>
          <div>
            <div className="label" style={{ color: "var(--color-cue)" }}>settings</div>
            <h2 className="font-display text-2xl mt-1">
              {tab === "prompts" ? "System prompts" : "Users"}
            </h2>
            {tab === "prompts" && (
              <p className="font-mono text-[11px] mt-1" style={{ color: "var(--color-ink-faint)" }}>
                edits apply globally · agent picks up on next turn · ingest picks up within ~5 min
              </p>
            )}
          </div>
          <button className="label hover:text-[var(--color-cue)]" onClick={onClose}>close ✕</button>
        </header>

        {/* Tabs row */}
        <div className="flex items-center gap-1 px-5 pt-2 border-b" style={{ borderColor: "var(--color-rule)" }}>
          <TabButton active={tab === "prompts"} onClick={() => setTab("prompts")}>Prompts</TabButton>
          {showUsers && (
            <TabButton active={tab === "users"} onClick={() => setTab("users")}>Users</TabButton>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {tab === "prompts" && <PromptsTab />}
          {tab === "users" && showUsers && <UsersTab />}
        </div>
      </motion.div>
    </motion.div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="px-3 py-1.5 text-sm transition-colors"
      style={{
        background: active ? "var(--color-surface)" : "transparent",
        color: active ? "var(--color-ink)" : "var(--color-ink-soft)",
        borderBottom: active ? "2px solid var(--color-cue)" : "2px solid transparent",
        marginBottom: -1, // overlap the row's border so the underline sits on top
      }}
    >
      {children}
    </button>
  );
}

// ─── Prompts tab ─────────────────────────────────────────────────────────────

function PromptsTab() {
  const [prompts, setPrompts] = useState<Prompts | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r: PromptsResponse = await fetchPrompts();
        if (!cancelled) setPrompts(r.prompts);
      } catch (e: any) {
        if (!cancelled) setLoadErr(String(e?.message || e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loadErr) {
    return (
      <div className="p-8">
        <p className="font-display text-xl" style={{ color: "var(--color-status-failed)" }}>Couldn't load settings</p>
        <p className="font-mono text-xs mt-2 break-all" style={{ color: "var(--color-ink-soft)" }}>{loadErr}</p>
      </div>
    );
  }
  if (!prompts) {
    return (
      <div className="p-8">
        <p className="caret font-display text-lg" style={{ color: "var(--color-ink-soft)" }}>loading</p>
      </div>
    );
  }
  return (
    <>
      {(Object.keys(prompts) as PromptId[]).map((id) => (
        <PromptEditor key={id} id={id} info={prompts[id]} onUpdated={(next) => setPrompts(next)} />
      ))}
    </>
  );
}

function PromptEditor({
  id, info, onUpdated,
}: {
  id: PromptId;
  info: PromptInfo;
  onUpdated: (next: Prompts) => void;
}) {
  const [draft, setDraft] = useState(info.current);
  useEffect(() => { setDraft(info.current); }, [info.current]);

  const [busy, setBusy] = useState<null | "save" | "reset">(null);
  const [err, setErr] = useState<string | null>(null);

  const dirty = draft !== info.current;
  const matchesDefault = draft === info.default;
  const dirtyVsDefault = useMemo(() => draft !== info.default, [draft, info.default]);

  const onSave = async () => {
    if (!dirty || busy) return;
    setBusy("save"); setErr(null);
    try {
      const r = await savePrompt(id, draft);
      onUpdated(r.prompts);
    } catch (e: any) { setErr(String(e?.message || e)); }
    finally { setBusy(null); }
  };

  const onReset = async () => {
    if (busy) return;
    if (!info.overridden && matchesDefault) return;
    setBusy("reset"); setErr(null);
    try {
      const r = await resetPrompt(id);
      onUpdated(r.prompts);
    } catch (e: any) { setErr(String(e?.message || e)); }
    finally { setBusy(null); }
  };

  const onRevertDraft = () => setDraft(info.current);
  const onLoadDefaultIntoDraft = () => setDraft(info.default);

  return (
    <section className="px-5 py-4 border-b" style={{ borderColor: "var(--color-rule)" }}>
      <div className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <div className="label" style={{ color: "var(--color-cue)" }}>{id.replace("_", " · ")}</div>
          <h3 className="font-display text-lg mt-0.5">{info.label}</h3>
          <p className="text-xs mt-1" style={{ color: "var(--color-ink-soft)" }}>{info.description}</p>
          <p className="font-mono text-[10px] mt-1 truncate" style={{ color: "var(--color-ink-faint)" }}>{info.source}</p>
        </div>
        <div className="text-right shrink-0">
          <span
            className="label px-2 py-1 rounded-full"
            style={{
              background: info.overridden ? "var(--color-cue-bg, rgba(255,122,26,0.12))" : "transparent",
              color: info.overridden ? "var(--color-cue)" : "var(--color-ink-faint)",
              border: `1px solid ${info.overridden ? "var(--color-cue)" : "var(--color-rule)"}`,
            }}
          >
            {info.overridden ? "custom" : "default"}
          </span>
          {info.overridden && info.updated_at ? (
            <div className="font-mono text-[10px] mt-1" style={{ color: "var(--color-ink-faint)" }}>
              edited {fmtRelative(info.updated_at)}
              {info.updated_by ? ` · ${info.updated_by}` : ""}
            </div>
          ) : null}
        </div>
      </div>

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        className="w-full mt-3 font-mono text-[12px] leading-snug rounded-[var(--radius-card)] p-3"
        style={{
          background: "var(--color-surface)",
          border: "1px solid var(--color-rule)",
          color: "var(--color-ink)",
          minHeight: id === "agent_system" ? 360 : 220,
          maxHeight: "55vh",
          resize: "vertical",
          tabSize: 2,
        }}
      />

      <div className="flex items-center justify-between mt-3 gap-2 flex-wrap">
        <div className="font-mono text-[10px]" style={{ color: "var(--color-ink-faint)" }}>
          {draft.length.toLocaleString()} chars
          {dirty ? " · unsaved" : ""}
          {!dirty && matchesDefault ? " · matches default" : ""}
        </div>
        <div className="flex items-center gap-2">
          {dirty && (
            <button className="label hover:text-[var(--color-ink)]" onClick={onRevertDraft} disabled={!!busy}>revert</button>
          )}
          {dirtyVsDefault && (
            <button className="label hover:text-[var(--color-ink)]" onClick={onLoadDefaultIntoDraft} disabled={!!busy}>load default into editor</button>
          )}
          <button
            className="label rounded-full px-3 py-1.5"
            style={{
              border: "1px solid var(--color-rule)",
              opacity: !info.overridden ? 0.4 : 1,
              cursor: !info.overridden ? "not-allowed" : "pointer",
            }}
            onClick={onReset}
            disabled={busy === "reset" || !info.overridden}
          >
            {busy === "reset" ? "resetting…" : "reset to default"}
          </button>
          <button
            className="label rounded-full px-3 py-1.5"
            style={{
              background: dirty ? "var(--color-cue)" : "transparent",
              color: dirty ? "var(--color-paper)" : "var(--color-ink-faint)",
              border: `1px solid ${dirty ? "var(--color-cue)" : "var(--color-rule)"}`,
              cursor: dirty ? "pointer" : "not-allowed",
            }}
            onClick={onSave}
            disabled={!dirty || busy === "save"}
          >
            {busy === "save" ? "saving…" : "save"}
          </button>
        </div>
      </div>

      {err && <p className="font-mono text-xs mt-2" style={{ color: "var(--color-status-failed)" }}>{err}</p>}
    </section>
  );
}

// ─── Users tab ───────────────────────────────────────────────────────────────

function UsersTab() {
  const [users, setUsers] = useState<User[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState<Record<string, string>>({});
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteErr, setInviteErr] = useState<string | null>(null);
  // Hold the full User row, not just the username — Cognito's username
  // is the immutable sub UUID, but the operator-facing label is the
  // email attribute. The confirm modal needs both: email for the prompt
  // text, username for the actual API call.
  const [confirmDelete, setConfirmDelete] = useState<User | null>(null);

  const reload = async () => {
    try {
      const r = await listUsers();
      setUsers(r.users);
    } catch (e: any) {
      setLoadErr(String(e?.message || e));
    }
  };
  useEffect(() => { void reload(); }, []);

  const setRow = (username: string, msg: string | null) =>
    setRowErr((cur) => ({ ...cur, [username]: msg ?? "" }));

  const invite = async () => {
    if (!inviteEmail.trim() || inviting) return;
    setInviting(true); setInviteErr(null);
    try {
      await inviteUser(inviteEmail.trim());
      setInviteEmail("");
      await reload();
    } catch (e: any) {
      setInviteErr(String(e?.message || e));
    } finally { setInviting(false); }
  };

  const action = async (kind: string, username: string, fn: () => Promise<unknown>) => {
    const key = `${kind}:${username}`;
    if (busyAction === key) return;
    setBusyAction(key); setRow(username, null);
    try {
      await fn();
      await reload();
    } catch (e: any) {
      setRow(username, String(e?.message || e));
    } finally { setBusyAction(null); }
  };

  if (loadErr) {
    return (
      <div className="p-8">
        <p className="font-display text-xl" style={{ color: "var(--color-status-failed)" }}>Couldn't load users</p>
        <p className="font-mono text-xs mt-2 break-all" style={{ color: "var(--color-ink-soft)" }}>{loadErr}</p>
      </div>
    );
  }
  if (!users) {
    return (
      <div className="p-8">
        <p className="caret font-display text-lg" style={{ color: "var(--color-ink-soft)" }}>loading</p>
      </div>
    );
  }

  return (
    <div className="px-5 py-4">
      {/* Invite row */}
      <section className="mb-5">
        <div className="label mb-2" style={{ color: "var(--color-cue)" }}>invite a new user</div>
        <div className="flex items-center gap-2">
          <input
            type="email"
            placeholder="someone@twelvelabs.io"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void invite(); }}
            disabled={inviting}
            className="flex-1 font-mono text-sm px-3 py-2 rounded-[var(--radius-card)]"
            style={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-rule)",
              color: "var(--color-ink)",
            }}
          />
          <button
            className="btn btn-sm btn-cue"
            onClick={() => void invite()}
            disabled={inviting || !inviteEmail.trim()}
          >
            {inviting ? "sending…" : "send invite"}
          </button>
        </div>
        {inviteErr && (
          <p className="font-mono text-xs mt-2" style={{ color: "var(--color-status-failed)" }}>{inviteErr}</p>
        )}
        <p className="font-mono text-[10px] mt-1" style={{ color: "var(--color-ink-faint)" }}>
          Cognito emails a one-time password; the recipient must set their own on first sign-in.
        </p>
      </section>

      {/* User list */}
      <section>
        <div className="label mb-2" style={{ color: "var(--color-cue)" }}>users · {users.length}</div>
        <ul className="space-y-2">
          {users.map((u) => (
            <li
              key={u.username}
              className="rounded-[var(--radius-card)] p-3"
              style={{
                background: "var(--color-surface)",
                border: "1px solid var(--color-rule)",
                opacity: u.enabled ? 1 : 0.55,
              }}
            >
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="font-display text-base">{u.email}</div>
                  <div className="font-mono text-[10px] mt-0.5" style={{ color: "var(--color-ink-faint)" }}>
                    {u.username}
                    {u.created_at ? ` · created ${fmtRelative(unixOf(u.created_at))}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <StatusChip user={u} />
                  {u.is_admin && (
                    <span
                      className="label px-2 py-0.5 rounded-full"
                      style={{ background: "rgba(255,122,26,0.12)", color: "var(--color-cue)", border: "1px solid var(--color-cue)" }}
                    >
                      admin
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 mt-3 flex-wrap">
                <RowBtn busy={busyAction === `resend:${u.username}`} disabled={u.status !== "FORCE_CHANGE_PASSWORD"} onClick={() => action("resend", u.username, () => resendInv(u.username))}>
                  resend invite
                </RowBtn>
                <RowBtn busy={busyAction === `reset:${u.username}`} onClick={() => action("reset", u.username, () => resetPwd(u.username))}>
                  reset password
                </RowBtn>
                {u.enabled ? (
                  <RowBtn busy={busyAction === `disable:${u.username}`} onClick={() => action("disable", u.username, () => disableUser(u.username))}>
                    disable
                  </RowBtn>
                ) : (
                  <RowBtn busy={busyAction === `enable:${u.username}`} onClick={() => action("enable", u.username, () => enableUser(u.username))}>
                    enable
                  </RowBtn>
                )}
                <RowBtn
                  destructive
                  busy={busyAction === `delete:${u.username}`}
                  onClick={() => setConfirmDelete(u)}
                >
                  delete
                </RowBtn>
              </div>
              {rowErr[u.username] && (
                <p className="font-mono text-xs mt-2" style={{ color: "var(--color-status-failed)" }}>
                  {rowErr[u.username]}
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>

      {confirmDelete && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center" style={{ background: "rgba(0,0,0,0.6)" }} onClick={() => setConfirmDelete(null)}>
          <div className="grain max-w-md w-full p-5" style={{ background: "var(--color-paper)", border: "1px solid var(--color-rule)" }} onClick={(e) => e.stopPropagation()}>
            <div className="label" style={{ color: "var(--color-status-failed)" }}>delete user</div>
            <p className="font-display text-lg mt-2">Delete <span className="font-mono">{confirmDelete.email}</span>?</p>
            <p className="text-xs mt-2" style={{ color: "var(--color-ink-soft)" }}>
              This removes the user from Cognito. Their sessions die immediately. Cannot be undone.
            </p>
            <div className="flex items-center gap-2 justify-end mt-4">
              <button className="btn btn-sm" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button
                className="btn btn-sm"
                style={{ background: "var(--color-status-failed)", color: "var(--color-paper)", borderColor: "var(--color-status-failed)" }}
                onClick={() => {
                  const username = confirmDelete.username;
                  setConfirmDelete(null);
                  void action("delete", username, () => apiDeleteUser(username));
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusChip({ user }: { user: User }) {
  const palette = !user.enabled
    ? { bg: "rgba(255,255,255,0.06)", fg: "var(--color-ink-faint)", border: "var(--color-rule)" }
    : user.status === "CONFIRMED"
      ? { bg: "rgba(102,217,127,0.12)", fg: "#86d99a", border: "#3d7548" }
      : user.status === "FORCE_CHANGE_PASSWORD"
        ? { bg: "rgba(255,200,80,0.12)", fg: "#e5b04c", border: "#7a5e22" }
        : { bg: "rgba(255,122,26,0.10)", fg: "var(--color-cue)", border: "var(--color-cue)" };
  const label = !user.enabled
    ? "disabled"
    : user.status === "FORCE_CHANGE_PASSWORD"
      ? "invited"
      : user.status.toLowerCase().replace(/_/g, " ");
  return (
    <span
      className="label px-2 py-0.5 rounded-full"
      style={{ background: palette.bg, color: palette.fg, border: `1px solid ${palette.border}` }}
    >
      {label}
    </span>
  );
}

function RowBtn({
  busy, disabled, destructive, onClick, children,
}: {
  busy?: boolean;
  disabled?: boolean;
  destructive?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const isDisabled = !!disabled || !!busy;
  return (
    <button
      className="label rounded-full px-2.5 py-1"
      style={{
        background: "transparent",
        color: destructive ? "var(--color-status-failed)" : "var(--color-ink-soft)",
        border: `1px solid ${destructive ? "var(--color-status-failed)" : "var(--color-rule)"}`,
        opacity: isDisabled ? 0.4 : 1,
        cursor: isDisabled ? "not-allowed" : "pointer",
      }}
      onClick={() => { if (!isDisabled) onClick(); }}
      disabled={isDisabled}
    >
      {busy ? "…" : children}
    </button>
  );
}

// ─── shared utils ────────────────────────────────────────────────────────────

function fmtRelative(unixSec: number): string {
  const deltaMs = Date.now() - unixSec * 1000;
  const m = Math.floor(deltaMs / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
function unixOf(iso: string | number): number {
  if (typeof iso === "number") return iso;
  return Math.floor(new Date(iso).getTime() / 1000);
}
