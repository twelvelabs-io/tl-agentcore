// SignInScreen — local Cognito SRP flow with three sub-states:
//
//   "signin"          — email + password
//   "new_password"    — invited user's first sign-in; choose a new password
//   "forgot"          — request reset code
//   "forgot_confirm"  — enter code + new password
//
// All sub-states render inside the same animated card so transitions are
// continuous instead of full route swaps. Matches the SPA's chrome:
// Fraunces / Geist / JetBrains Mono on a dark filmic background with the
// warm-amber accent.

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import {
  completeNewPassword,
  confirmForgotPassword,
  forgotPassword,
  signInWithPassword,
  type SignInResult,
} from "../lib/auth";
import type { CognitoUser } from "amazon-cognito-identity-js";

type Mode = "signin" | "new_password" | "forgot" | "forgot_confirm";

export function SignInScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [confirmCode, setConfirmCode] = useState("");
  const [forcedUser, setForcedUser] = useState<CognitoUser | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { emailRef.current?.focus(); }, []);

  const doSignIn = async () => {
    if (busy || !email.trim() || !password) return;
    setBusy(true); setErr(null); setNotice(null);
    try {
      const r: SignInResult = await signInWithPassword(email, password);
      if (r.kind === "tokens") {
        onSignedIn();
        return;
      }
      if (r.kind === "new_password_required") {
        setForcedUser(r.user);
        setMode("new_password");
        return;
      }
      // mfa not supported in UI yet
      setErr(`Sign-in needs an MFA step we don't support here yet (${r.kind}).`);
    } catch (e: unknown) {
      setErr(humanizeAuthError(e));
    } finally {
      setBusy(false);
    }
  };

  const doNewPassword = async () => {
    if (busy || !forcedUser || !newPwd) return;
    setBusy(true); setErr(null);
    try {
      await completeNewPassword(forcedUser, newPwd);
      onSignedIn();
    } catch (e: unknown) {
      setErr(humanizeAuthError(e));
    } finally {
      setBusy(false);
    }
  };

  const doForgot = async () => {
    if (busy || !email.trim()) return;
    setBusy(true); setErr(null);
    try {
      await forgotPassword(email);
      setNotice(`Reset code sent to ${email}. Check your inbox.`);
      setMode("forgot_confirm");
    } catch (e: unknown) {
      setErr(humanizeAuthError(e));
    } finally {
      setBusy(false);
    }
  };

  const doConfirmForgot = async () => {
    if (busy || !confirmCode.trim() || !newPwd) return;
    setBusy(true); setErr(null);
    try {
      await confirmForgotPassword(email, confirmCode, newPwd);
      setNotice("Password reset. Signing you in…");
      // Auto-attempt sign-in with the new password so the user doesn't
      // bounce back to the form.
      await signInWithPassword(email, newPwd);
      onSignedIn();
    } catch (e: unknown) {
      setErr(humanizeAuthError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-6" style={{ background: "var(--color-page, #0c0d0e)" }}>
      {/* Faint background grain + subtle warm-amber halo above the card. */}
      <motion.div
        className="absolute inset-0 grain pointer-events-none"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6 }}
      />
      <motion.div
        className="absolute"
        style={{
          top: "8%",
          width: 720,
          height: 320,
          background: "radial-gradient(ellipse at center, rgba(255,122,26,0.16), transparent 65%)",
          pointerEvents: "none",
          filter: "blur(28px)",
        }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1.2 }}
      />

      <motion.div
        className="relative w-full max-w-md"
        initial={{ opacity: 0, y: 8, scale: 0.99 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.4, ease: [0.2, 0, 0, 1] }}
      >
        {/* Wordmark */}
        <motion.div
          className="flex items-center gap-3 mb-7"
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.08 }}
        >
          <TLLogoMark />
          <span style={{ color: "var(--color-ink-faint)", fontSize: 14 }}>×</span>
          <h1 className="font-display text-2xl tracking-tight">
            Rough Cut<span style={{ color: "var(--color-warm, #ff7a1a)" }}>·</span>Lab
          </h1>
        </motion.div>

        {/* Card */}
        <div
          className="grain rounded-[var(--radius-card)] p-6"
          style={{
            background: "var(--color-paper)",
            border: "1px solid var(--color-rule)",
            boxShadow: "0 12px 48px rgba(0,0,0,0.35)",
          }}
        >
          <AnimatePresence mode="wait">
            {mode === "signin" && (
              <PaneSignin
                key="signin"
                email={email} setEmail={setEmail}
                password={password} setPassword={setPassword}
                busy={busy}
                onSubmit={doSignIn}
                onForgot={() => { setErr(null); setNotice(null); setMode("forgot"); }}
                emailRef={emailRef}
              />
            )}
            {mode === "new_password" && (
              <PaneNewPassword
                key="new_password"
                email={email}
                newPwd={newPwd} setNewPwd={setNewPwd}
                busy={busy}
                onSubmit={doNewPassword}
                onCancel={() => { setForcedUser(null); setMode("signin"); }}
              />
            )}
            {mode === "forgot" && (
              <PaneForgot
                key="forgot"
                email={email} setEmail={setEmail}
                busy={busy}
                onSubmit={doForgot}
                onBack={() => { setErr(null); setNotice(null); setMode("signin"); }}
              />
            )}
            {mode === "forgot_confirm" && (
              <PaneForgotConfirm
                key="forgot_confirm"
                email={email}
                code={confirmCode} setCode={setConfirmCode}
                newPwd={newPwd} setNewPwd={setNewPwd}
                busy={busy}
                onSubmit={doConfirmForgot}
                onBack={() => { setMode("signin"); setErr(null); }}
              />
            )}
          </AnimatePresence>

          {notice && (
            <p className="font-mono text-[11px] mt-3" style={{ color: "var(--color-cue, #ff7a1a)" }}>
              {notice}
            </p>
          )}
          {err && (
            <motion.p
              className="font-mono text-xs mt-3 break-words"
              style={{ color: "var(--color-status-failed, #d8665a)" }}
              initial={{ opacity: 0, y: 2 }}
              animate={{ opacity: 1, y: 0 }}
            >
              {err}
            </motion.p>
          )}
        </div>

        {/* Footer */}
        <motion.p
          className="mt-6 text-center font-mono text-[10px]"
          style={{ color: "var(--color-ink-faint)" }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.2 }}
        >
          Cognito SRP — your password stays in this browser
        </motion.p>
      </motion.div>
    </div>
  );
}

// ─── Panes ───────────────────────────────────────────────────────────────────

function paneAnim() {
  return {
    initial: { opacity: 0, x: 8 },
    animate: { opacity: 1, x: 0 },
    exit:    { opacity: 0, x: -8 },
    transition: { duration: 0.25, ease: [0.2, 0, 0, 1] },
  } as const;
}

function PaneSignin({
  email, setEmail, password, setPassword, busy, onSubmit, onForgot, emailRef,
}: {
  email: string; setEmail: (s: string) => void;
  password: string; setPassword: (s: string) => void;
  busy: boolean;
  onSubmit: () => void;
  onForgot: () => void;
  emailRef: React.MutableRefObject<HTMLInputElement | null>;
}) {
  return (
    <motion.form {...paneAnim()} onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      <div className="label" style={{ color: "var(--color-cue)" }}>sign in</div>
      <h2 className="font-display text-xl mt-1 mb-5">Welcome back</h2>

      <Field label="email">
        <input ref={emailRef} type="email" autoComplete="email" required
               value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
      </Field>
      <Field label="password">
        <input type="password" autoComplete="current-password" required
               value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
      </Field>

      <div className="flex items-center justify-between mt-5">
        <button type="button" className="label hover:text-[var(--color-ink)] transition-colors"
                onClick={onForgot} disabled={busy}>
          forgot password
        </button>
        <SubmitBtn busy={busy} disabled={!email.trim() || !password}>sign in →</SubmitBtn>
      </div>
    </motion.form>
  );
}

function PaneNewPassword({
  email, newPwd, setNewPwd, busy, onSubmit, onCancel,
}: {
  email: string; newPwd: string; setNewPwd: (s: string) => void;
  busy: boolean; onSubmit: () => void; onCancel: () => void;
}) {
  return (
    <motion.form {...paneAnim()} onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      <div className="label" style={{ color: "var(--color-cue)" }}>first sign-in</div>
      <h2 className="font-display text-xl mt-1">Choose a new password</h2>
      <p className="text-xs mt-1 mb-5" style={{ color: "var(--color-ink-soft)" }}>
        Signed in as <span className="font-mono">{email}</span>. The temporary
        password from your invite needs to be replaced.
      </p>

      <Field label="new password">
        <input type="password" autoFocus autoComplete="new-password" required minLength={12}
               value={newPwd} onChange={(e) => setNewPwd(e.target.value)} disabled={busy} />
      </Field>
      <p className="font-mono text-[10px] mt-1" style={{ color: "var(--color-ink-faint)" }}>
        12+ chars · upper · lower · number · symbol
      </p>

      <div className="flex items-center justify-between mt-5">
        <button type="button" className="label hover:text-[var(--color-ink)] transition-colors"
                onClick={onCancel} disabled={busy}>
          back
        </button>
        <SubmitBtn busy={busy} disabled={newPwd.length < 12}>set password →</SubmitBtn>
      </div>
    </motion.form>
  );
}

function PaneForgot({
  email, setEmail, busy, onSubmit, onBack,
}: {
  email: string; setEmail: (s: string) => void;
  busy: boolean; onSubmit: () => void; onBack: () => void;
}) {
  return (
    <motion.form {...paneAnim()} onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      <div className="label" style={{ color: "var(--color-cue)" }}>reset</div>
      <h2 className="font-display text-xl mt-1">Forgot your password?</h2>
      <p className="text-xs mt-1 mb-5" style={{ color: "var(--color-ink-soft)" }}>
        We'll email a 6-digit code to reset it.
      </p>

      <Field label="email">
        <input type="email" autoFocus autoComplete="email" required
               value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
      </Field>

      <div className="flex items-center justify-between mt-5">
        <button type="button" className="label hover:text-[var(--color-ink)] transition-colors"
                onClick={onBack} disabled={busy}>
          back
        </button>
        <SubmitBtn busy={busy} disabled={!email.trim()}>send code →</SubmitBtn>
      </div>
    </motion.form>
  );
}

function PaneForgotConfirm({
  email, code, setCode, newPwd, setNewPwd, busy, onSubmit, onBack,
}: {
  email: string;
  code: string; setCode: (s: string) => void;
  newPwd: string; setNewPwd: (s: string) => void;
  busy: boolean; onSubmit: () => void; onBack: () => void;
}) {
  return (
    <motion.form {...paneAnim()} onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      <div className="label" style={{ color: "var(--color-cue)" }}>reset · step 2</div>
      <h2 className="font-display text-xl mt-1">Set your new password</h2>
      <p className="text-xs mt-1 mb-5" style={{ color: "var(--color-ink-soft)" }}>
        Code sent to <span className="font-mono">{email}</span>.
      </p>

      <Field label="reset code">
        <input type="text" autoFocus inputMode="numeric" pattern="[0-9]*" maxLength={10}
               value={code} onChange={(e) => setCode(e.target.value)} disabled={busy} />
      </Field>
      <Field label="new password">
        <input type="password" autoComplete="new-password" required minLength={12}
               value={newPwd} onChange={(e) => setNewPwd(e.target.value)} disabled={busy} />
      </Field>

      <div className="flex items-center justify-between mt-5">
        <button type="button" className="label hover:text-[var(--color-ink)] transition-colors"
                onClick={onBack} disabled={busy}>
          back
        </button>
        <SubmitBtn busy={busy} disabled={!code.trim() || newPwd.length < 12}>reset →</SubmitBtn>
      </div>
    </motion.form>
  );
}

// ─── Atoms ───────────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block mt-3">
      <span className="label block mb-1" style={{ color: "var(--color-ink-faint)" }}>{label}</span>
      <div
        className="signin-input-wrap"
        style={{
          background: "var(--color-surface)",
          border: "1px solid var(--color-rule)",
          borderRadius: "var(--radius-card)",
          padding: "9px 12px",
        }}
      >
        {children}
      </div>
    </label>
  );
}

function SubmitBtn({ busy, disabled, children }: { busy: boolean; disabled: boolean; children: React.ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy || disabled}
      className="rounded-full px-4 py-2 font-mono text-xs"
      style={{
        background: "var(--color-cue, #ff7a1a)",
        color: "var(--color-paper)",
        border: "1px solid var(--color-cue, #ff7a1a)",
        opacity: busy || disabled ? 0.5 : 1,
        cursor: busy || disabled ? "not-allowed" : "pointer",
        transition: "transform 120ms ease",
      }}
    >
      <span className="inline-flex items-center gap-2">
        {busy && <Spinner />}
        {children}
      </span>
    </button>
  );
}

function Spinner() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden
         style={{ animation: "rc-spin 0.9s linear infinite" }}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.3" strokeWidth="3" fill="none" />
      <path d="M21 12a9 9 0 0 1-9 9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" fill="none" />
    </svg>
  );
}

// Inlined here so the sign-in screen doesn't import from App.tsx (App.tsx
// imports this file — would be a cycle).
function TLLogoMark() {
  return (
    <svg width="32" height="32" viewBox="0 0 100 100" aria-hidden style={{ color: "var(--color-ink)" }}>
      <g fill="currentColor">
        <rect x="6"  y="46" width="12" height="8" />
        <rect x="22" y="46" width="12" height="8" />
        <rect x="38" y="38" width="12" height="24" />
        <rect x="54" y="46" width="12" height="8" />
        <rect x="70" y="46" width="12" height="8" />
        <rect x="38" y="22" width="12" height="12" />
        <rect x="38" y="66" width="12" height="12" />
      </g>
    </svg>
  );
}

// ─── error humanisation ─────────────────────────────────────────────────────

function humanizeAuthError(e: unknown): string {
  const err = e as { code?: string; name?: string; message?: string };
  const code = err?.code || err?.name || "";
  const msg = err?.message || String(e);
  switch (code) {
    case "NotAuthorizedException":
      return /incorrect username or password/i.test(msg)
        ? "Incorrect email or password."
        : msg;
    case "UserNotFoundException":
      return "No account for that email.";
    case "InvalidPasswordException":
      return `Password doesn't meet the policy: ${msg.replace(/^[^:]+:\s*/, "")}`;
    case "CodeMismatchException":
      return "That reset code is incorrect.";
    case "ExpiredCodeException":
      return "That reset code has expired. Request a new one.";
    case "LimitExceededException":
      return "Too many attempts. Wait a moment and try again.";
    case "UserNotConfirmedException":
      return "Your account isn't confirmed yet. Ask an admin to resend the invite.";
    case "PasswordResetRequiredException":
      return "Password reset required — use the 'forgot password' link.";
    default:
      return msg;
  }
}
