// Browser-side TwelveLabs client. Talks to /tl/* (proxied to api.twelvelabs.io
// by server/proxy.mjs, which holds the api key).

export type KS = {
  _id: string;
  name: string;
  description?: string;
  item_count?: number;
  created_at?: string;
};

export type KSItem = {
  _id: string;
  asset_id?: string;
  status: "queued" | "indexing" | "ready" | "failed" | string;
  filename?: string;
};

export type Asset = {
  _id: string;
  status: string;
  filename?: string;
  file_type?: string;
  duration?: number;
  size?: number;
  created_at?: string;
  hls?: { manifest_url?: string; status?: string };
  thumbnail?: { representative_url?: string; status?: string };
};

import { getAccessToken } from "./auth";

const BASE = "/tl";
const DEMO_PASSWORD = import.meta.env.VITE_DEMO_PASSWORD || "";

async function authHeaders(): Promise<Record<string, string>> {
  // Prefer Cognito JWT when signed in; fall back to legacy password during
  // dev or pre-auth bootstrap. The lambdas accept either.
  const token = await getAccessToken();
  if (token) return { authorization: `Bearer ${token}` };
  return DEMO_PASSWORD ? { "x-demo-password": DEMO_PASSWORD } : {};
}

async function call<T = any>(method: string, path: string, body?: any, isJson = true): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(await authHeaders()),
      ...(isJson && body ? { "content-type": "application/json" } : {}),
    },
    body: body ? (isJson ? JSON.stringify(body) : body) : undefined,
  });
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch {}
  if (!res.ok) {
    const detail = typeof data === "string" ? data : data?.message || JSON.stringify(data);
    throw new Error(`${method} ${path} → ${res.status}: ${detail}`);
  }
  return data as T;
}

// ---- Knowledge stores ----
export const listKnowledgeStores = () =>
  call<{ data?: KS[]; items?: KS[] }>("GET", "/knowledge-stores").then(
    (r) => r.data ?? r.items ?? []
  );

export const createKnowledgeStore = (name: string, description?: string) =>
  call<KS>("POST", "/knowledge-stores", { name, description });

export const getKnowledgeStore = (id: string) =>
  call<KS>("GET", `/knowledge-stores/${id}`);

export const deleteKnowledgeStore = (id: string) =>
  call<void>("DELETE", `/knowledge-stores/${id}`);

export const listItems = (ksId: string) =>
  call<{ data?: KSItem[]; items?: KSItem[] }>("GET", `/knowledge-stores/${ksId}/items`).then(
    (r) => r.data ?? r.items ?? []
  );

export const addItem = (ksId: string, assetId: string) =>
  call<KSItem>("POST", `/knowledge-stores/${ksId}/items`, { asset_id: assetId });

export const getItem = (ksId: string, itemId: string) =>
  call<KSItem>("GET", `/knowledge-stores/${ksId}/items/${itemId}`);

// ---- Assets ----
export const uploadAssetFromUrl = async (url: string): Promise<Asset> => {
  const fd = new FormData();
  fd.append("method", "url");
  fd.append("url", url);
  // Always opt in — without these, the asset has no playback URL or thumbnail
  // and the Assets tab can only render filename + size for it.
  fd.append("enable_hls", "true");
  fd.append("enable_thumbnail", "true");
  const res = await fetch(`${BASE}/assets`, { method: "POST", body: fd, headers: await authHeaders() });
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  return res.json();
};

export const getAsset = (id: string) => call<Asset>("GET", `/assets/${id}`);

export const listAssets = (params: Record<string, string | number> = {}) => {
  const qs = new URLSearchParams(params as Record<string, string>).toString();
  return call<{ data?: Asset[]; items?: Asset[]; page_info?: { total_results?: number } }>(
    "GET",
    `/assets${qs ? `?${qs}` : ""}`,
  ).then((r) => ({
    assets: r.data ?? r.items ?? [],
    total: r.page_info?.total_results ?? (r.data ?? r.items ?? []).length,
  }));
};

export const deleteAsset = (id: string) => call<void>("DELETE", `/assets/${id}`);

// ---- Rights admin (mock rights table CRUD) ----
export type RightsWindow = {
  region: string;
  window_start?: string;
  window_end?: string;
  usage?: string[];
  notes?: string;
};

export type TalentClearance = {
  name: string;
  scope?: string;
  expires?: string;
};

export type RightsRecord = {
  asset_id: string;
  title?: string;
  rights?: RightsWindow[];
  talent_clearances?: TalentClearance[];
};

const RIGHTS_BASE = "/rights";

async function rightsCall<T = any>(method: string, path: string, body?: any): Promise<T> {
  const res = await fetch(`${RIGHTS_BASE}${path}`, {
    method,
    headers: {
      ...(await authHeaders()),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`${method} /rights${path} → ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data as T;
}

export const listRights = () =>
  rightsCall<{ items: RightsRecord[] }>("GET", "").then((r) => r.items || []);
export const getRights = (id: string) => rightsCall<RightsRecord>("GET", `/${encodeURIComponent(id)}`);
export const upsertRights = (id: string, body: Omit<RightsRecord, "asset_id">) =>
  rightsCall<RightsRecord>("PUT", `/${encodeURIComponent(id)}`, body);
export const deleteRights = (id: string) => rightsCall<void>("DELETE", `/${encodeURIComponent(id)}`);

// ---- Audiences (mock audience-intelligence) ----
export type GenreAffinity = { genre: string; index: number };
export type DaypartAffinity = { daypart: string; index: number };
export type AudienceDemographics = {
  gender?: "male" | "female" | "mixed" | string;
  age_min?: number;
  age_max?: number;
  income_quartile?: number[];
  regions?: string[];
};
export type AudienceSegment = {
  segment_id: string;
  name?: string;
  description?: string;
  demographics?: AudienceDemographics;
  genre_affinity?: GenreAffinity[];
  daypart_affinity?: DaypartAffinity[];
  size_estimate?: number;
  notes?: string;
};

const AUDIENCES_BASE = "/audiences";

async function audiencesCall<T = any>(method: string, path: string, body?: any): Promise<T> {
  const res = await fetch(`${AUDIENCES_BASE}${path}`, {
    method,
    headers: {
      ...(await authHeaders()),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`${method} /audiences${path} → ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data as T;
}

export const listAudiences = () =>
  audiencesCall<{ items: AudienceSegment[] }>("GET", "").then((r) => r.items || []);
export const getAudience = (id: string) =>
  audiencesCall<AudienceSegment>("GET", `/${encodeURIComponent(id)}`);
export const upsertAudience = (id: string, body: Omit<AudienceSegment, "segment_id">) =>
  audiencesCall<AudienceSegment>("PUT", `/${encodeURIComponent(id)}`, body);
export const deleteAudience = (id: string) =>
  audiencesCall<void>("DELETE", `/${encodeURIComponent(id)}`);

// ---- Stitch (MediaConvert preview render) ----
export type StitchJob = {
  job_id: string;
  render_id?: string;
  status: "SUBMITTED" | "PROGRESSING" | "COMPLETE" | "ERROR" | "CANCELED" | string;
  percent?: number;
  output_url?: string;
  error?: string;
  clip_count?: number;
};

const STITCH_BASE = "/stitch";

async function stitchCall<T = any>(method: string, path: string, body?: any): Promise<T> {
  const res = await fetch(`${STITCH_BASE}${path}`, {
    method,
    headers: {
      ...(await authHeaders()),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`${method} /stitch${path} → ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data as T;
}

export const startStitch = (plan: unknown) =>
  stitchCall<StitchJob>("POST", "", { plan });
export const getStitch = (jobId: string) =>
  stitchCall<StitchJob>("GET", `/${encodeURIComponent(jobId)}`);

// ---- Channels (FAST channel CRUD, AgentCore-created) ----
export type ChannelProgram = {
  id?: string;
  name: string;
  asset_id: string;
  asset_filename?: string;
  source_start: number;            // seconds within source clip
  source_end: number;
  scheduled_start: string;         // "HH:MM:SS" within the channel timeline
  scheduled_duration_sec?: number;
};

export type ChannelEPGSlot = {
  start_time: string;              // "HH:MM"
  duration_min: number;
  program: string;                 // human-readable label
};

export type ChannelDaypart = {
  daypart: string;                 // morning / afternoon / evening / late-night
  hours: string;                   // "06:00–12:00"
  theme: string;
};

export type Channel = {
  channel_id: string;
  name: string;
  tagline: string;
  audience: string;
  dayparting?: ChannelDaypart[];
  programs: ChannelProgram[];
  epg?: ChannelEPGSlot[];
  total_duration_sec?: number;
  knowledge_store_id?: string;
  rights_window?: { region?: string; expires?: string };
  created_at?: number;
  created_by?: string;
};

const CHANNELS_BASE = "/channels";

async function channelsCall<T = any>(method: string, path: string, body?: any): Promise<T> {
  const res = await fetch(`${CHANNELS_BASE}${path}`, {
    method,
    headers: {
      ...(await authHeaders()),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`${method} /channels${path} → ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data as T;
}

export const listChannels = () =>
  channelsCall<{ items: Channel[] }>("GET", "").then((r) => r.items || []);
export const getChannel = (id: string) =>
  channelsCall<Channel>("GET", `/${encodeURIComponent(id)}`);
export const createChannel = (body: Omit<Channel, "channel_id" | "created_at" | "created_by">) =>
  channelsCall<Channel>("POST", "", body);
export const deleteChannel = (id: string) =>
  channelsCall<void>("DELETE", `/${encodeURIComponent(id)}`);

// ---- Responses (Jockey) ----
export type ResponsePayload = {
  knowledge_store_id: string;
  user_text: string;
  instructions?: string;
  session_id?: string;
  text_format?: object;
  include?: string[];
};

export type JockeyResponse = {
  id: string;
  session_id: string;
  status: string;
  output: Array<{ type: string; content?: Array<{ type: string; text: string }> }>;
  usage?: { input_tokens: number; output_tokens: number };
};

const buildBody = (p: ResponsePayload, stream = false) => {
  const body: any = {
    model: "jockey1.0",
    knowledge_store_id: p.knowledge_store_id,
    input: [{ type: "message", role: "user", content: p.user_text }],
  };
  if (p.instructions) body.instructions = p.instructions;
  if (p.session_id) body.session_id = p.session_id;
  if (p.text_format) body.text = { format: p.text_format };
  if (p.include) body.include = p.include;
  if (stream) body.stream = true;
  return body;
};

export const createResponse = (p: ResponsePayload) =>
  call<JockeyResponse>("POST", "/responses", buildBody(p));

export const extractText = (resp: JockeyResponse): string => {
  const chunks: string[] = [];
  for (const o of resp.output ?? []) {
    if (o.type !== "message") continue;
    for (const c of o.content ?? []) {
      if (c.type === "output_text") chunks.push(c.text);
    }
  }
  return chunks.join("\n");
};

// SSE streamer — yields each parsed event until [DONE].
export async function* streamResponse(p: ResponsePayload): AsyncGenerator<any, void, void> {
  const res = await fetch(`${BASE}/responses`, {
    method: "POST",
    headers: { ...(await authHeaders()), "content-type": "application/json" },
    body: JSON.stringify(buildBody(p, true)),
  });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    throw new Error(`stream failed: ${res.status} ${t}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      if (payload === "[DONE]") return;
      try { yield JSON.parse(payload); } catch {}
    }
  }
}

// ─── Newsroom Vault — endpoints for the unused /v1.3 surface ──────────────
//
// Everything here proxies through tl_proxy with the same bearer/legacy auth
// as the rest of api.ts. We don't introduce new backend infra; we just wrap
// the TL endpoints we hadn't touched yet (entity-collections, tasks/*,
// /assets/{id}/entities, /analyze/tasks, /embed-v2/*, paginated /search).

// ---- Tasks (ingestion telemetry) ----
export type TaskRecord = {
  _id: string;
  index_id: string;
  status: "pending" | "validating" | "queued" | "indexing" | "ready" | "failed" | string;
  process?: { percentage?: number; remain_seconds?: number };
  metadata?: { filename?: string; duration?: number; size?: number; height?: number; width?: number };
  hls?: { manifest_url?: string; status?: string };
  thumbnail?: { representative_url?: string };
  video_id?: string;
  created_at?: string;
  updated_at?: string;
  error?: string | { code?: string; message?: string };
};

export type TaskCounts = {
  ready: number;
  validating: number;
  pending: number;
  queued: number;
  indexing: number;
  failed: number;
};

/** /tasks/counts requires updated_after OR index_id. We default to "30 days
 *  ago" so the dashboard shows a useful slice without forcing a specific
 *  index. Caller can override with an index_id for per-index totals. */
export const getTaskCounts = async (indexId?: string, since?: Date): Promise<TaskCounts> => {
  const params = new URLSearchParams();
  if (indexId) params.set("index_id", indexId);
  else params.set("updated_after", (since || new Date(Date.now() - 30 * 86400_000)).toISOString());
  const r = await call<TaskCounts>("GET", `/tasks/counts?${params.toString()}`);
  return r;
};

export const listTaskUpdates = async (
  since: Date,
  pageLimit = 30,
  indexId?: string,
): Promise<{ data: TaskRecord[]; total?: number }> => {
  const params = new URLSearchParams({
    updated_after: since.toISOString(),
    page_limit: String(pageLimit),
  });
  if (indexId) params.set("index_id", indexId);
  const r = await call<{ data: TaskRecord[]; page_info?: { total_results?: number } }>(
    "GET", `/tasks/updates?${params.toString()}`,
  );
  return { data: r.data || [], total: r.page_info?.total_results };
};

export const getTask = (taskId: string) => call<TaskRecord>("GET", `/tasks/${taskId}`);

// ---- Entity collections (Vault / persons of interest) ----
export type EntityCollection = {
  _id: string;
  name: string;
  description?: string;
  created_at?: string;
  updated_at?: string;
  entity_count?: number;
};

export type Entity = {
  _id: string;
  entity_collection_id: string;
  name: string;
  description?: string;
  status?: "pending" | "ready" | "failed" | string;
  /** Assets where the entity has been recognized. Populated by TL after
   *  ingestion — the source of "where has this person appeared". */
  asset_ids?: string[];
  reference_image_url?: string;
  created_at?: string;
  updated_at?: string;
};

export const listEntityCollections = (pageLimit = 50) =>
  call<{ data: EntityCollection[]; page_info?: { total_results?: number } }>(
    "GET", `/entity-collections?page_limit=${pageLimit}`,
  ).then((r) => r.data || []);

export const createEntityCollection = (name: string, description?: string) =>
  call<EntityCollection>("POST", "/entity-collections", { name, description });

export const getEntityCollection = (id: string) =>
  call<EntityCollection>("GET", `/entity-collections/${id}`);

export const deleteEntityCollection = (id: string) =>
  call<void>("DELETE", `/entity-collections/${id}`);

export const listEntities = (collectionId: string, pageLimit = 50) =>
  call<{ data: Entity[]; page_info?: { total_results?: number } }>(
    "GET", `/entity-collections/${collectionId}/entities?page_limit=${pageLimit}`,
  ).then((r) => r.data || []);

export const getEntity = (collectionId: string, entityId: string) =>
  call<Entity>("GET", `/entity-collections/${collectionId}/entities/${entityId}`);

export const deleteEntity = (collectionId: string, entityId: string) =>
  call<void>("DELETE", `/entity-collections/${collectionId}/entities/${entityId}`);

/** Register an entity. The TL API accepts a JSON body with name + a
 *  reference image URL. For browser-uploaded images, the caller should
 *  first PUT to a TL-presigned URL and pass that here. For the demo we
 *  accept a pre-uploaded image_url (e.g. a wiki/CC-licensed photo). */
export const createEntity = (
  collectionId: string,
  body: { name: string; description?: string; reference_image_url?: string },
) => call<Entity>("POST", `/entity-collections/${collectionId}/entities`, body);

export const bulkCreateEntities = (
  collectionId: string,
  entities: Array<{ name: string; description?: string; reference_image_url?: string }>,
) => call<{ data: Entity[] }>("POST", `/entity-collections/${collectionId}/entities/bulk`, { entities });

/** Where does this entity appear across the corpus? Returns asset hits
 *  with timecodes. Used by `find_appearances` agent tool. */
export const entityAppearances = (
  collectionId: string,
  entityId: string,
  pageLimit = 30,
) =>
  call<{ data: Array<{ asset_id: string; clips?: Array<{ start: number; end: number; confidence: number }> }>; page_info?: any }>(
    "GET", `/entity-collections/${collectionId}/entities/${entityId}/assets?page_limit=${pageLimit}`,
  ).then((r) => r.data || []);

/** Auto-recognized entities present in one asset. Returns full Entity
 *  records (same shape as /entity-collections/{id}/entities). Drives the
 *  entity-chip row on every clip card across the demo. */
export const entitiesInAsset = (assetId: string) =>
  call<{ data: Entity[] }>(
    "GET", `/assets/${assetId}/entities`,
  ).then((r) => r.data || []);

// ---- Paginated Marengo search ----
export type SearchClip = {
  video_id: string;
  start: number;
  end: number;
  score?: number;
  confidence?: string;
  thumbnail_url?: string;
  metadata?: Array<{ type: string; text: string }>;
};

export type SearchPage = {
  data: SearchClip[];
  page_info?: { next_page_token?: string; total_results?: number };
  search_pool?: { index_id: string };
};

export const searchByText = async (
  indexId: string,
  queryText: string,
  searchOptions: string[] = ["visual", "audio"],
  pageLimit = 12,
): Promise<SearchPage> => {
  const fd = new FormData();
  fd.append("index_id", indexId);
  searchOptions.forEach((o) => fd.append("search_options", o));
  fd.append("query_text", queryText);
  fd.append("page_limit", String(pageLimit));
  fd.append("group_by", "clip");
  const res = await fetch(`${BASE}/search`, { method: "POST", body: fd, headers: await authHeaders() });
  if (!res.ok) throw new Error(`/search ${res.status}: ${await res.text()}`);
  return res.json();
};

/** Continue paginating a Marengo search with the next_page_token returned
 *  by `searchByText`. Same shape, different URL. */
export const searchNextPage = (pageToken: string) =>
  call<SearchPage>("GET", `/search/${encodeURIComponent(pageToken)}`);

/** Marengo search FILTERED to a single registered entity. Only clips
 *  containing the entity are returned, ranked by the text query. The
 *  talent-recognition headline pattern: "every clip where Person X is,
 *  ranked by 'context phrase'". */
export const searchByEntity = async (
  indexId: string,
  entityId: string,
  queryText: string,
  pageLimit = 12,
): Promise<SearchPage> => {
  const fd = new FormData();
  fd.append("index_id", indexId);
  fd.append("entity_id", entityId);
  fd.append("query_text", queryText);
  fd.append("search_options", "visual");
  fd.append("page_limit", String(pageLimit));
  fd.append("group_by", "clip");
  const res = await fetch(`${BASE}/search`, { method: "POST", body: fd, headers: await authHeaders() });
  if (!res.ok) throw new Error(`/search ${res.status}: ${await res.text()}`);
  return res.json();
};

// ---- Async analyze (Dossier worker) ----
export type AnalyzeTask = {
  _id: string;
  status: "queued" | "running" | "ready" | "failed" | string;
  prompt?: string;
  result?: { text?: string };
  error?: string | { code?: string; message?: string };
  created_at?: string;
  updated_at?: string;
};

export const createAnalyzeTask = (
  body: { video?: { type: string; asset_id?: string; video_id?: string }; video_id?: string; prompt: string; max_tokens?: number },
) => call<AnalyzeTask>("POST", "/analyze/tasks", body);

export const getAnalyzeTask = (taskId: string) =>
  call<AnalyzeTask>("GET", `/analyze/tasks/${taskId}`);

// ---- Embeddings (export) ----
export type EmbedTask = {
  _id: string;
  status: "queued" | "processing" | "ready" | "failed" | string;
  model_name?: string;
  metadata?: any;
  error?: string | { code?: string; message?: string };
  created_at?: string;
};

/** Async video embedding extraction. The TL API requires `input_type` and
 *  routes the rest of the body based on it ("video" / "audio" / "image"). */
export const createEmbedTask = (body: {
  input_type: "video" | "audio" | "image";
  model_name?: string;
  video_url?: string;
  audio_url?: string;
  image_url?: string;
  video_clip_length?: number;
}) => call<EmbedTask>("POST", "/embed-v2/tasks", body);

/** Sync text embedding via /embed (multipart form). Returns an embedding
 *  vector callers can drop straight into their own vector store. Useful
 *  for live "embed this query" demos that don't need video processing. */
export const embedText = async (
  text: string,
  modelName = "marengo3.0",
): Promise<{ text_embedding?: { segments?: Array<{ float?: number[]; values?: number[]; embedding_option?: string }> }; model_name?: string }> => {
  const fd = new FormData();
  fd.append("text", text);
  fd.append("model_name", modelName);
  const res = await fetch(`${BASE}/embed`, { method: "POST", body: fd, headers: await authHeaders() });
  if (!res.ok) throw new Error(`/embed ${res.status}: ${await res.text()}`);
  return res.json();
};

export const getEmbedTask = (taskId: string) => call<EmbedTask>("GET", `/embed-v2/tasks/${taskId}`);

export const getEmbedTaskStatus = (taskId: string) =>
  call<{ _id: string; status: string }>("GET", `/embed/tasks/${taskId}/status`);

// ---- Index videos (per-index metadata) ----
export type IndexVideo = {
  _id: string;
  asset_id?: string;
  metadata?: { filename?: string; duration?: number };
  hls?: { manifest_url?: string };
  thumbnail?: { representative_url?: string };
  created_at?: string;
};

export const listIndexVideos = (indexId: string, pageLimit = 50, page = 1) =>
  call<{ data: IndexVideo[]; page_info?: { total_results?: number; total_page?: number } }>(
    "GET", `/indexes/${indexId}/videos?page_limit=${pageLimit}&page=${page}`,
  );

export const getIndexVideo = (indexId: string, videoId: string) =>
  call<IndexVideo>("GET", `/indexes/${indexId}/videos/${videoId}`);

// ---- Indexes (list, get) ----
export const listIndexes = (pageLimit = 50) =>
  call<{ data: Array<{ _id: string; index_name: string; video_count?: number; total_duration?: number; models?: Array<{ model_name: string }> }> }>(
    "GET", `/indexes?page_limit=${pageLimit}`,
  ).then((r) => r.data || []);

