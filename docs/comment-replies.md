# Reviewer comment replies

Drop-in responses for comments on the Google Doc. Each block can be pasted directly as a reply to its thread, then the thread marked "Resolved." Comment numbers reference the `id` attribute in the docx export; the anchor text is shown so you can match each reply to the right thread.

> **Update log:** First round of 7 comments came from weteh@amazon.com (mermaid rendering, EDL definition, anchor texts, upstream ingest, Pegasus-at-ingest). Second round added 2 comments from dmstn@amazon.com on the abstract/introduction structure — replies for those are at the bottom.

---

## Comment id=0 · executive summary (anchor: "…the alternates a producer can swap into the EDL…")
*Reviewer:* "This paragraph needs more clarity. Explain what EDL here means for audience not familiar with the term. How EDL is created (e.g. one per scene or final highlight)."

**Reply:**

Good catch — EDL was being used before it was defined. Added an inline definition the first time the term appears in §1 ("the EDL — the Edit Decision List, the ordered run of clips with in/out timecodes that a producer hands to an editor"). On how it's created: the EDL is assembled in one agent turn as a single document containing N scenes (one per beat), each scene holding 3–5 clips with HH:MM:SS in/out times — full schema is in §5 under "OUTPUT CONTRACT." It's the final highlight, not one-per-scene; the producer iterates on it via conversation mode (§3.3).

---

## Comment id=1 · §3.1 component map (anchor: "flowchart TD" — the first mermaid block)
*Reviewer:* "Is there a way to visualize this flowchart? I am only seeing the raw text."

**Reply:**

Confirmed — mermaid doesn't render natively in Google Docs, which is why the block looks like raw text. I've rendered the four diagrams as PNGs and replaced this block with the rendered image; the mermaid source is preserved alongside the doc in `docs/diagrams/component-map.mmd` for future edits.

---

## Comment id=2 · §3.2 anchor texts (anchor: "The weights come from the embedding-space similarity between the query and three short anchor texts…")
*Reviewer:* "If we are proposing this approach, it's good to explain the optimal 'anchor text' for this specific use case."

**Reply:**

Agreed — added a paragraph in §5.1 explaining the anchor strings we ship for the highlight-reel use case, why they're tuned to film vocabulary (shots/framing/action, music score/sound design, dialogue/narration/voice-over) rather than the generic phrasing from the TwelveLabs multi-vector guide, and what to retune for non-cinematic verticals. The new strings are in `agent/tl_agentcore/agent.py:124-128`. Two notes from the implementation: the softmax is stable to wording so the system isn't fragile, but anchors closer to the query domain give tighter routing on borderline phrases like "low-angle hero shot"; and the temperature `α = 10` is the doc-recommended default, which we kept.

---

## Comment id=3 · §3.3 mermaid block (anchor: empty — second mermaid block, conversation-mode)
*Reviewer:* "Is there a better way to visualize the flow here? May be a flowchart here (for some reason I only see the raw text)."

**Reply:**

Same root cause as the other "raw text" comment — mermaid in Google Docs. Replaced this block with a rendered PNG; source kept in `docs/diagrams/conversation-mode.mmd`.

---

## Comment id=4 · §3.3 structural-path edge (anchor: a single arrow in the conversation-mode mermaid block)
*Reviewer:* "Same as above"

**Reply:**

Resolved by the same replacement — the §3.3 mermaid block is now a rendered PNG.

---

## Comment id=5 · §4.3 "Building the index"
*Reviewer:* "Is the ingestion process also done in this agent? Should this be done as an upstream process, given the producer might want to search across the entire movie catalog."

**Reply:**

Sharp question — and yes, ingest is upstream. Added an opening paragraph to §4.3 making this explicit: "Ingest is an upstream process, run once per knowledge store, and is not part of the agent's live-query path. The agent only ever reads the index via `vector_search`; writing the index is the job of the ingest script (or a separate background pipeline in a production deployment). This separation is what makes the agent's per-turn latency a function of retrieval and reasoning only, and lets a single index back any number of agent sessions across a movie catalog." Concretely in the repo: `scripts/ingest_vectors.py` and `scripts/bulk_ingest.py` plus the `embed_clip_start` / `embed_clip_finalize` lambdas are the ingest surface; the agent runtime never calls `PutVectors`.

---

## Comment id=6 · §4 "Embedding-RAG for video clips" (anchor on the section heading area)
*Reviewer:* "Is ingesting the video clip with Marengo sufficient? We also need to consider the scene / shot level segments that detail cinematic elements, emotion tones, characters, relationships so that they could be used in the search downstream."

**Reply:**

This was the most substantive comment and deserved a section of its own — added §4.6 "Why we don't enrich at ingest." Short version: the TwelveLabs reference architectures (Jockey, tl-marengo-bedrock-s3, the Bedrock workshop) all converge on the same pattern — Marengo embed at ingest, Pegasus only at query time on retrieved candidates. None of them pre-extract character lists, emotion tags, or shot/scene taxonomy into structured fields. Most of what the reviewer is asking for is already present in the three-modality embedding signal (visual carries framing and crowd density, audio carries musical tension, transcription carries named characters when narration mentions them); the rare clip that retrieves ambiguously is exactly the case where calling `pegasus_analyze` on the matched candidate at query time is more accurate than relying on an ingest-time inference that was made without the producer's question in mind. The new section also calls out the three real costs of pre-extracting (ingest cost multiplies 100×+, taxonomy gets fixed at ingest, signal duplicates), and the carve-out for non-Pegasus ingest-time metadata (rights, license, language, content rating) which still belongs on the row and which the existing `$and` filter already supports.

---

## Suggested resolution order

1. Reply to id=1, id=3, id=4 first (mermaid rendering) — they're all the same fix; once you've pasted the rendered PNGs into the Doc, resolve all three.
2. Reply to id=0 (EDL definition) — one-line check, the new sentence is right at the top of §1.
3. Reply to id=2 (anchor texts) and id=5 (upstream ingest) — both fully addressed; resolve after the reviewer confirms the new prose.
4. Reply to id=6 (Pegasus-at-ingest) last — this is the only thread that may want a back-and-forth, since §4.6 takes a position rather than just clarifying. The reviewer might push on whether *some* fields should still be enriched; the §4.6 carve-out paragraph anticipates that path.

---

# Second round — dmstn@amazon.com

Two new comments posted 2026-05-20T20:38 on the abstract / executive-summary structure. Both are addressed together by merging the Abstract and §1 into a single "Introduction" section that leads with the value proposition (the docs/whitepaper.md change is already in; re-sync to the Doc before pasting the replies below). The two new threads currently show up as comment id=0 and id=1 in the docx export.

## Comment id=0 (dmstn) · on the Abstract paragraph
*Reviewer:* "I would recommend reframing the abstract to explain why this is valuable (i.e. you can now run Video search agent in AWS on Bedrock)."

**Reply:**

Good call — the abstract was leading with mechanics instead of the engineering value. Rewrote the opening to lead with the pattern: all four heavyweight primitives (Marengo clip embeddings, Pegasus clip analysis, S3 Vectors ANN retrieval, AgentCore agent runtime) run as managed AWS services, the customer-deployed surface is one arm64 container plus two lambdas plus an S3 mirror bucket, `bedrock:InvokeModel` and `s3vectors:QueryVectors` are signed with the runtime's IAM role, and no live-query hop crosses an account boundary or leaves the region. The producer/highlight-reel narrative is now framed as the worked example rather than the headline.

## Comment id=1 (dmstn) · on the §1 Executive summary heading
*Reviewer:* "Typically you have an abstract or an executive summary, not both. Consider merging/rephrasing this into an introduction"

**Reply:**

Agreed — the two sections were saying nearly the same thing in slightly different shapes, which was a tell that the doc had two openers instead of one. Collapsed them into a single §1 Introduction with four paragraphs aimed at a technical audience: (1) the AWS-native pattern and IAM/data-path boundary, (2) the worked example (Rough Cut / Highlight Reel agent) and the verticals the same composition covers, (3) the `vector_search` retrieval primitive with concrete latencies (~300 ms per beat, under 15 s for a six-beat reel without Pegasus, under 60 s with), and (4) conversation mode with the inline `[CURRENT PLAN]` / `[FOLLOWUP]` envelope and the SSE event stream (`tool_call` / `tool_result` / `text_delta`) that surfaces tool execution in wall-clock order. Section numbering downstream is unchanged.
