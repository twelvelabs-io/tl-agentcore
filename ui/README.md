# Jockey · Lab

A demo UI for the four user-shaped scenarios in `../tests/scenarios/`:

- **Conversation** — multi-turn streaming chat against a knowledge store (test_chat_session)
- **Reel** — natural-language brief → structured-output highlight assembly with refinement turn (test_highlight_reel_pipeline)
- **Lens** — same prompt routed through different `instructions` personas, side-by-side (test_instructions_persona)
- **Library** — pick or create knowledge stores, ingest videos by URL, watch indexing status

The aesthetic is editorial-meets-edit-suite: Fraunces serif headlines treat your prompt as the hero, JetBrains Mono carries timecodes and IDs, one warm amber accent marks every action.

## Architecture

```
demo-ui/
  server/proxy.mjs        # Express; holds TL_API_KEY, pipes SSE through
  src/App.tsx             # tab shell, masthead, footer
  src/components/         # Conversation, Reel, Lens, Library, KSPicker
  src/lib/api.ts          # browser-side TL client, SSE streamer, structured output
  src/lib/store.ts        # tiny shared state — KS selection only
  src/styles/app.css      # the design system (Tailwind v4 @theme + handwritten)
```

Browser → `localhost:5173/tl/*` → Vite proxy → `localhost:3001/tl/*` → `https://api.twelvelabs.io/v1.3/*`. The key never reaches the browser; the proxy reads `TL_API_KEY` from the parent project's `.env`.

## Run

```bash
cd demo-ui
npm install
npm run dev
# → proxy on :3001, Vite on :5173, open the Vite URL
```

`npm run dev` runs both via `concurrently`. To run them separately: `npm run proxy` and `vite` in two terminals.

If the masthead status shows `offline`, the proxy can't reach the API — check that `../.env` contains a `TL_API_KEY` with Jockey beta access (smoke-tested at `/tl/_health`).

## First-run workflow

1. **Library** tab → `+ new` → name it (e.g. "Sports archive Q3").
2. Paste a public `.mp4` URL → `ingest`. The default URL in the input is a TwelveLabs sample.
3. Wait until the item status flips from *indexing* to *ready* (status auto-refreshes every 8 s; it's a long wait, often 5–15 min for the first video).
4. Switch to **Conversation** → ask. Streaming text appears as soon as the first delta arrives.
5. Try a follow-up to see session continuity. The right rail shows the `session_id` the API issued.
6. **Reel** → describe what you want, hit `assemble`. You get back structured clips with timecodes ready for ffmpeg. Use the *refine* field to do a multi-turn adjustment.
7. **Lens** → same prompt, multiple personas in parallel, render side-by-side.

## Design notes

- **Typography**: Fraunces (display, with `opsz 144 / SOFT 30` for character) · Geist (UI sans) · JetBrains Mono (technical density). Loaded from Google Fonts.
- **Palette**: filmic warm charcoal `#0c0d0e`, bone text `#ebe6da`, hot amber `#ff7a1a` for action / cue. Status pips use muted greens / ambers to match.
- **Motion**: stagger reveal on tab switches (cubic ease, 280 ms), word caret blink during streaming, persona-output column entrance with 80 ms offset. Powered by `motion/react`.
- **Decoration**: a subtle film-perforation pattern down the left edge (CSS radial gradient) and a low-opacity SVG noise overlay (`grain` class) to keep the surfaces from looking flat. Both are pure CSS — no images.

## Limits / known sharp edges

- Indexing is genuinely slow. The Library tab shows status, but if you're demoing live, ingest the asset *before* the meeting.
- Streaming uses native `fetch` + `ReadableStream`. If you front the proxy with a buffering reverse proxy in production (nginx with default settings, etc.), set `proxy_buffering off` so SSE flushes per chunk.
- Only Jockey/Agents endpoints are wired (no Models surface — search/analyze/embed). Adding them is a copy-paste of the existing client pattern in `src/lib/api.ts`.
- The KS named *"Demo · Q3 review"* in your org was created during the build's smoke test. Delete it from the Library tab if you don't want it.
