# tl-agentcore · UI

React + Vite SPA for the Rough Cut workflow. Two tabs:

- **Rough Cut** — natural-language brief → AgentCore Strands agent
  assembles a scene-by-scene EDL with Marengo-ranked alternates on every
  clip. Producer can swap any pick for a similarly-ranked alternate
  without re-running the agent.
- **Agent** — free-form chat against the active KB. The right rail shows
  the live architecture diagram lighting up as the agent reasons.

Aesthetic: editorial-meets-edit-suite. Fraunces serif headlines, JetBrains
Mono for timecodes and IDs, one warm amber accent marks every action.

## Architecture

```
ui/
  server/proxy.mjs    # local dev only — Express; holds TL_API_KEY, pipes SSE
  src/App.tsx         # tab shell, masthead, footer
  src/components/     # RoughCut, AgentCore, KSPicker, AssetPlayer, …
  src/lib/api.ts      # browser-side TL client (talks to /tl/*)
  src/lib/agent-api.ts# streams turns from the agent over WebSocket
  src/lib/auth.ts     # Cognito PKCE flow (no SDK)
  src/styles/app.css  # design system (Tailwind v4 @theme + handwritten)
```

### Dev

Browser → `localhost:5173/tl/*` → Vite proxy → `localhost:3001/tl/*` →
`https://api.twelvelabs.io/v1.3/*`. The TL key never reaches the browser;
the proxy reads `TL_API_KEY` from the parent project's `.env`.

### Prod

Browser → CloudFront → `/tl/*` HTTP API → `tl_proxy` Lambda → TwelveLabs.
WebSocket traffic to `/live` goes Browser → CloudFront → API Gateway WS →
`chat` Lambda → AgentCore Runtime. Cognito JWT flows end-to-end.

## Run locally

```bash
cd ui
npm install
npm run dev
# proxy on :3001, Vite on :5173 — open the Vite URL
```

Both come up via `concurrently`. To run them separately: `npm run proxy`
and `vite` in two terminals.

If the masthead status shows `offline`, the proxy can't reach the API.
Check that `../.env` contains a working `TL_API_KEY` (smoke-tested at
`/tl/_health`).

## Build + deploy

```bash
npm run build                          # writes dist/
aws s3 sync dist/ s3://<bucket>/ --delete
aws cloudfront create-invalidation --distribution-id <id> --paths "/*"
```

The bucket name + distribution id come from `terraform output` in `infra/`.

## Design notes

- **Typography**: Fraunces (display, with `opsz 144 / SOFT 30` for
  character) · Geist (UI sans) · JetBrains Mono (technical density).
- **Palette**: filmic warm charcoal `#0c0d0e`, bone text `#ebe6da`, hot
  amber `#ff7a1a` for action / cue. Status pips use muted greens / ambers.
- **Motion**: stagger reveal on tab switches (cubic ease, 280 ms), word
  caret blink during streaming. Powered by `motion/react`.
- **Decoration**: subtle film-perforation pattern down the left edge (CSS
  radial gradient) and a low-opacity SVG noise overlay. Pure CSS.
