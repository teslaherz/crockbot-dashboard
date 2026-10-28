/**
 * Grokbot Dashboard — one dependency-free Cloudflare Worker.
 * Bots POST Markdown; D1 stores it; the Tesla browser renders it.
 */

const MAX_MARKDOWN = 500_000;
const MAX_BODY = 600_000;
const DEFAULT_LIMIT = 200;

const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  bot_name TEXT NOT NULL DEFAULT 'Grokbot',
  bot_id TEXT DEFAULT '',
  category TEXT DEFAULT 'general',
  summary TEXT DEFAULT '',
  content_md TEXT NOT NULL,
  pinned INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`;

const CREATE_INDEXES_SQL = `CREATE INDEX IF NOT EXISTS idx_results_pinned_created ON results (pinned DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_results_bot ON results (bot_name);`;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization, X-API-Key, X-Title, X-Bot-Name, X-Bot-Id, X-Category",
  "access-control-max-age": "86400",
};

const BASE_HEADERS = {
  ...CORS_HEADERS,
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

const readyDatabases = new WeakMap();
let lastEpochMs = 0;

function nowIso() {
  const current = Date.now();
  lastEpochMs = current > lastEpochMs ? current : lastEpochMs + 1;
  return new Date(lastEpochMs).toISOString();
}

const WELCOME_MD = [
  "# Willkommen im Grokbot Dashboard",
  "",
  "Deine Grokbot-Flotte legt Berichte hier ab. Im Tesla, auf dem iPhone oder am Desktop öffnest du den Verlauf links und liest das Ergebnis rechts.",
  "",
  "> [!NOTE]",
  "> Im Tesla reicht ein Satz: **„Hey Grok, Bote soll mir eine Übersicht über meine letzten Emails erstellen und ans Dashboard schicken.“**",
  "> Bote schreibt Markdown, dieses Dashboard speichert den Bericht, und Grok öffnet den direkten Link im Browser.",
  "",
  "## Ablauf",
  "",
  "1. Du sprichst mit Grok.",
  "2. Der angesprochene Bot erzeugt ein `.md`-Ergebnis.",
  "3. Der Bot sendet es an `POST /api/results`.",
  "4. Die Antwort enthält `url` — genau die Seite, die im Tesla-Browser aufgeht.",
  "",
  "## Flotte",
  "",
  "| Bot | Rolle | Wofür |",
  "| --- | --- | --- |",
  "| Bote | E-Mail-Verwalter | Posteingang zusammenfassen |",
  "| Elon | Programmierer Smarthome | Licht, Klima, Szenen |",
  "| Chef | Admin | Freigaben und Überblick |",
  "| Planer | Kalenderplaner | Tag und Termine ordnen |",
  "| Tutor | Studiumsassistent | Lernpläne und Erklärungen |",
  "| Betreuer | Betreuung | Erinnerungen und Check-ins |",
  "| Astronaut | Astronaut | Missionen und Status |",
  "| Journalist | Journalist | Recherche-Briefings |",
  "| Reiseleiter | Reiseleiter | Routen und Stopps |",
  "| Händler | Händler | Angebote und Bestände |",
  "| Weggefährte | Weggefährte | Notizen unterwegs |",
  "| Druckmanager | Druckmanager | Druckaufträge |",
  "",
  "## Erste Schritte",
  "",
  "- [x] Dashboard ist erreichbar",
  "- [x] Berichte bleiben in D1 gespeichert",
  "- [ ] Ersten echten Bericht von Bote schicken",
  "- [ ] Den Direktlink im Tesla-Browser öffnen",
  "",
  "## Bericht senden",
  "",
  "JSON:",
  "",
  "```bash",
  "curl -X POST \"https://crockbot-dashboard.teslaherz.workers.dev/api/results\" \\",
  "  -H \"Content-Type: application/json\" \\",
  "  -d '{\"title\":\"E-Mail-Übersicht\",\"bot_name\":\"Bote · E-Mail-Verwalter\",\"category\":\"email\",\"content\":\"# E-Mail-Übersicht\\n\\nDrei neue Nachrichten.\"}'",
  "```",
  "",
  "Datei direkt:",
  "",
  "```bash",
  "curl -X POST \"https://crockbot-dashboard.teslaherz.workers.dev/api/ingest?bot=Bote%20·%20E-Mail-Verwalter\" \\",
  "  -H \"Content-Type: text/markdown\" \\",
  "  --data-binary @bericht.md",
  "```",
  "",
  "Oder als Upload:",
  "",
  "```bash",
  "curl -X POST \"https://crockbot-dashboard.teslaherz.workers.dev/api/publish\" \\",
  "  -F \"file=@bericht.md\" \\",
  "  -F \"bot=Bote · E-Mail-Verwalter\"",
  "```",
  "",
  "> [!TIP]",
  "> Schick deinem Bot die `url` aus der JSON-Antwort. [Roh-Markdown dieses Eintrags](https://crockbot-dashboard.teslaherz.workers.dev/api/results/willkommen/raw) liegt unter `raw_url`.",
  "",
  "> [!WARNING]",
  "> Lesen ist absichtlich ohne Schlüssel, damit der Tesla-Browser die Seite öffnen kann. Schreibzugriffe schützt du mit dem Secret `DASHBOARD_API_KEY`.",
  "",
  "---",
  "",
  "*Gebaut für die 16:9-Anzeige im Tesla: großer Text, Vollbild und ein Verlauf wie bei Grok.*",
].join("\n");

function httpError(status, message, options = {}) {
  const error = new Error(message);
  error.status = status;
  error.publicMessage = message;
  error.expose = options.expose ?? status < 500;
  return error;
}

function logEvent(level, event, fields = {}) {
  const payload = JSON.stringify({
    level,
    event,
    ...fields,
    ts: new Date().toISOString(),
  });
  if (level === "error") console.error(payload);
  else console.log(payload);
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...BASE_HEADERS,
      "content-type": "application/json; charset=utf-8",
      ...extra,
    },
  });
}

function noContent() {
  return new Response(null, { status: 204, headers: BASE_HEADERS });
}

function textResponse(body, status, contentType, extra = {}) {
  return new Response(body, {
    status,
    headers: {
      ...BASE_HEADERS,
      "content-type": contentType,
      ...extra,
    },
  });
}

function originOf(request) {
  return new URL(request.url).origin;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cleanText(value, max) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length > max ? text.slice(0, max).trim() : text;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function firstMarkdown(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.replace(/^\uFEFF/, "");
  }
  return "";
}

function cleanMarkdown(value) {
  const text = String(value ?? "").replace(/^\uFEFF/, "").replace(/\u0000/g, "");
  if (!text.trim()) return "";
  if (text.length > MAX_MARKDOWN) throw httpError(413, "Markdown exceeds 500000 characters");
  return text;
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function normalizeId(input) {
  if (input == null) return "";
  let text = String(input).trim().toLowerCase();
  if (!text) return "";
  text = text
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss");
  text = text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  text = text.replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^[-_]+|[-_]+$/g, "");
  if (text.length > 80) text = text.slice(0, 80).replace(/[-_]+$/g, "");
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(text)) return "";
  return text;
}

function parseRouteId(raw) {
  let text = String(raw ?? "");
  try {
    text = decodeURIComponent(text);
  } catch (error) {
    return "";
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(text)) return "";
  return text;
}

function randomSuffix(length = 6) {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  const chars = [];
  while (chars.length < length) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= limit) continue;
      chars.push(alphabet[byte % alphabet.length]);
      if (chars.length === length) break;
    }
  }
  return chars.join("");
}

function generateId(now = new Date()) {
  const parts = berlinParts(now);
  return `${parts.y}${parts.m}${parts.d}-${randomSuffix(6)}`;
}

function parsePinned(value, fallback = 0) {
  if (value == null || value === "") return fallback;
  if (value === true || value === 1 || value === "1" || value === "true" || value === "on") return 1;
  if (value === false || value === 0 || value === "0" || value === "false" || value === "off") return 0;
  return null;
}

function clampLimit(raw) {
  if (raw == null || raw === "") return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.min(500, Math.floor(value));
}

function berlinParts(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const read = (type) => parts.find((part) => part.type === type)?.value || "";
  return {
    y: read("year"),
    m: read("month").padStart(2, "0"),
    d: read("day").padStart(2, "0"),
    hh: read("hour").padStart(2, "0"),
    mm: read("minute").padStart(2, "0"),
  };
}

function berlinKey(date) {
  const parts = berlinParts(date);
  return `${parts.y}-${parts.m}-${parts.d}`;
}

function shiftBerlinDays(date, days) {
  const parts = berlinParts(date);
  return new Date(Date.UTC(Number(parts.y), Number(parts.m) - 1, Number(parts.d) + days, 12, 0, 0));
}

function formatFullStamp(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = berlinParts(date);
  return `${parts.d}.${parts.m}.${parts.y}, ${parts.hh}:${parts.mm} Uhr`;
}

function formatListStamp(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const key = berlinKey(date);
  const today = berlinKey(new Date());
  const yesterday = berlinKey(shiftBerlinDays(new Date(), -1));
  const parts = berlinParts(date);
  const clock = `${parts.hh}:${parts.mm}`;
  if (key === today) return `Heute, ${clock} Uhr`;
  if (key === yesterday) return `Gestern, ${clock} Uhr`;
  return `${parts.d}.${parts.m}.${parts.y}, ${clock} Uhr`;
}

function dayLabel(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unbekannt";
  const key = berlinKey(date);
  if (key === berlinKey(new Date())) return "Heute";
  if (key === berlinKey(shiftBerlinDays(new Date(), -1))) return "Gestern";
  const parts = berlinParts(date);
  const months = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
  return `${Number(parts.d)}. ${months[Number(parts.m) - 1] || ""} ${parts.y}`.trim();
}

function extractTitle(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  let inFence = false;
  for (const line of lines) {
    if (/^\s{0,3}(```+|~~~+)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (match) return match[1].trim();
  }
  return "";
}

function makeSummary(markdown) {
  let text = String(markdown ?? "");
  text = text.replace(/```[\s\S]*?```/g, " ");
  text = text.replace(/~~~[\s\S]*?~~~/g, " ");
  text = text.replace(/!\[[^\]]*]\([^)]*\)/g, " ");
  text = text.replace(/\[([^\]]+)]\([^)]*\)/g, "$1");
  text = text.replace(/^\s{0,3}#{1,6}[^\n]*$/gm, " ");
  text = text.replace(/^\s*\|.*\|\s*$/gm, " ");
  text = text.replace(/^\s{0,3}>\s?/gm, "");
  text = text.replace(/\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION|DANGER|ERROR)\]/gi, " ");
  text = text.replace(/^\s*[-*+]\s+\[[ xX]]\s+/gm, "");
  text = text.replace(/^\s*([-*+]|\d+[.)])\s+/gm, "");
  text = text.replace(/(\*\*|__|~~|`)/g, "");
  text = text.replace(/[*_]/g, "");
  text = text.replace(/\s+/g, " ").trim();
  if (text.length <= 180) return text;
  const cut = text.slice(0, 180);
  const space = cut.lastIndexOf(" ");
  return `${(space > 80 ? cut.slice(0, space) : cut).trim()}…`;
}

function filenameStem(name) {
  const base = String(name || "").split(/[/\\]/).pop() || "";
  if (!base || base.toLowerCase() === "blob") return "";
  return base.replace(/\.(md|markdown|txt)$/i, "").replace(/_+/g, " ").trim();
}

async function keysMatch(provided, expected) {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(String(provided))),
    crypto.subtle.digest("SHA-256", encoder.encode(String(expected))),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(a, b);
  }
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

function presentedKeys(request) {
  const keys = [];
  const auth = request.headers.get("authorization") || "";
  const bearer = auth.match(/^Bearer\s+(\S.*)$/i);
  if (bearer) keys.push(bearer[1].trim());
  const header = request.headers.get("x-api-key");
  if (header && header.trim()) keys.push(header.trim());
  const query = new URL(request.url).searchParams.get("key");
  if (query && query.trim()) keys.push(query.trim());
  return keys;
}

async function authorized(request, env) {
  const expected = env?.DASHBOARD_API_KEY;
  if (expected == null || expected === "") return true;
  const presented = presentedKeys(request);
  if (!presented.length) return false;
  let ok = false;
  for (const key of presented) {
    if (await keysMatch(key, String(expected))) ok = true;
  }
  return ok;
}

async function first(db, sql, params = []) {
  const row = await db.prepare(sql).bind(...params).first();
  return row == null ? null : row;
}

async function all(db, sql, params = []) {
  const out = await db.prepare(sql).bind(...params).all();
  if (Array.isArray(out)) return out;
  return out?.results || [];
}

async function run(db, sql, params = []) {
  const out = await db.prepare(sql).bind(...params).run();
  const changes = out?.meta?.changes ?? out?.changes ?? 0;
  return { changes: Number(changes) || 0 };
}

function ensureReady(env) {
  if (!env?.DB || typeof env.DB.prepare !== "function" || typeof env.DB.exec !== "function") {
    throw httpError(500, "D1 binding DB is not configured", { expose: true });
  }
  let pending = readyDatabases.get(env.DB);
  if (!pending) {
    pending = initDatabase(env).catch((error) => {
      readyDatabases.delete(env.DB);
      throw error;
    });
    readyDatabases.set(env.DB, pending);
  }
  return pending;
}

async function initDatabase(env) {
  await env.DB.exec(CREATE_TABLE_SQL);
  try {
    await env.DB.exec(CREATE_INDEXES_SQL);
  } catch (error) {
    logEvent("error", "schema.index_failed", { message: error?.message || "index failed" });
  }
  const row = await first(env.DB, "SELECT COUNT(*) AS n FROM results");
  if (Number(row?.n || 0) === 0) {
    await insertWelcome(env.DB);
    logEvent("info", "schema.ready", { seeded: true });
    return;
  }
  logEvent("info", "schema.ready", { seeded: false });
}

async function insertWelcome(db) {
  const now = nowIso();
  const summary = makeSummary(WELCOME_MD);
  await run(
    db,
    `INSERT OR IGNORE INTO results (
      id, title, bot_name, bot_id, category, summary, content_md, pinned, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "willkommen",
      "Willkommen im Grokbot Dashboard",
      "Elon · Programmierer Smarthome",
      "elon",
      "system",
      summary,
      WELCOME_MD,
      1,
      now,
      now,
    ],
  );
}

function present(row, origin, { full = false } = {}) {
  const id = row.id;
  const item = {
    id,
    title: row.title,
    bot_name: row.bot_name,
    bot_id: row.bot_id || "",
    category: row.category || "general",
    summary: row.summary || "",
    pinned: Number(row.pinned) === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
    url: `${origin}/r/${encodeURIComponent(id)}`,
    dashboard_url: `${origin}/?id=${encodeURIComponent(id)}`,
    raw_url: `${origin}/api/results/${encodeURIComponent(id)}/raw`,
  };
  if (full) item.content_md = row.content_md;
  return item;
}

function buildFilters(filters = {}) {
  const where = [];
  const params = [];
  const bot = cleanText(filters.bot, 120);
  if (bot) {
    where.push("(lower(bot_name) = lower(?) OR lower(bot_name) LIKE ? ESCAPE '\\')");
    params.push(bot, `${escapeLike(bot.toLowerCase())} · %`);
  }
  const category = cleanText(filters.category, 60);
  if (category) {
    where.push("lower(category) = lower(?)");
    params.push(category);
  }
  const q = String(filters.q ?? "").trim().slice(0, 200);
  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    where.push("(title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR bot_name LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\' OR content_md LIKE ? ESCAPE '\\')");
    params.push(pattern, pattern, pattern, pattern, pattern);
  }
  return { where, params };
}

async function queryResults(db, filters = {}) {
  const { where, params } = buildFilters(filters);
  const cols = filters.full
    ? "id, title, bot_name, bot_id, category, summary, content_md, pinned, created_at, updated_at"
    : "id, title, bot_name, bot_id, category, summary, pinned, created_at, updated_at";
  let sql = `SELECT ${cols} FROM results`;
  if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
  sql += " ORDER BY pinned DESC, created_at DESC, rowid DESC LIMIT ?";
  params.push(clampLimit(filters.limit));
  return all(db, sql, params);
}

async function queryLatest(db, bot) {
  const { where, params } = buildFilters({ bot });
  let sql = "SELECT * FROM results";
  if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
  sql += " ORDER BY created_at DESC, rowid DESC LIMIT 1";
  return first(db, sql, params);
}

async function getRow(db, id) {
  return first(db, "SELECT * FROM results WHERE id = ?", [id]);
}

function filtersFromUrl(url) {
  return {
    bot: url.searchParams.get("bot") || url.searchParams.get("bot_name") || "",
    category: url.searchParams.get("category") || url.searchParams.get("tag") || "",
    q: url.searchParams.get("q") || "",
    limit: url.searchParams.get("limit"),
    full: url.searchParams.get("full") === "1" || url.searchParams.get("full") === "true",
  };
}

async function listResults(request, env) {
  const url = new URL(request.url);
  const filters = filtersFromUrl(url);
  const rows = await queryResults(env.DB, filters);
  const origin = url.origin;
  return json({
    ok: true,
    results: rows.map((row) => present(row, origin, { full: filters.full })),
  });
}

async function readResult(request, env, id) {
  const parsed = parseRouteId(id);
  if (!parsed) return json({ ok: false, error: "Not found" }, 404);
  const row = await getRow(env.DB, parsed);
  if (!row) return json({ ok: false, error: "Not found" }, 404);
  return json({ ok: true, ...present(row, originOf(request), { full: true }) });
}

async function readRaw(request, env, id) {
  const parsed = parseRouteId(id);
  if (!parsed) return json({ ok: false, error: "Not found" }, 404);
  const row = await getRow(env.DB, parsed);
  if (!row) return json({ ok: false, error: "Not found" }, 404);
  const filename = `${parsed.replace(/[^A-Za-z0-9_-]/g, "") || "bericht"}.md`;
  return textResponse(row.content_md, 200, "text/markdown; charset=utf-8", {
    "content-disposition": `inline; filename="${filename}"`,
  });
}

async function readLatest(request, env) {
  const url = new URL(request.url);
  const row = await queryLatest(env.DB, url.searchParams.get("bot") || "");
  if (!row) return json({ ok: false, error: "Not found" }, 404);
  return json({ ok: true, ...present(row, url.origin, { full: true }) });
}

function mediaType(request) {
  return (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
}

function queryMeta(url) {
  return {
    title: url.searchParams.get("title"),
    botName: url.searchParams.get("bot_name") || url.searchParams.get("bot") || url.searchParams.get("author"),
    botId: url.searchParams.get("bot_id"),
    category: url.searchParams.get("category") || url.searchParams.get("tag"),
    id: url.searchParams.get("id"),
    summary: url.searchParams.get("summary"),
    pinned: url.searchParams.get("pinned"),
  };
}

function headerMeta(request) {
  return {
    title: request.headers.get("x-title"),
    botName: request.headers.get("x-bot-name"),
    botId: request.headers.get("x-bot-id"),
    category: request.headers.get("x-category"),
  };
}

async function readLimitedText(request, max) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > max) throw httpError(413, "Payload too large");
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      try {
        await reader.cancel();
      } catch (error) {
        /* ignore cancel failure */
      }
      throw httpError(413, "Payload too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

async function readMultipart(request, query, headers) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY + 100_000) throw httpError(413, "Payload too large");
  let form;
  try {
    form = await request.formData();
  } catch (error) {
    throw httpError(400, "Invalid form data");
  }
  let markdown = "";
  let filename = "";
  for (const key of ["file", "md", "markdown", "document"]) {
    const value = form.get(key);
    if (value == null || value === "") continue;
    if (typeof value === "string") {
      markdown = value;
      break;
    }
    if (typeof value.text === "function") {
      markdown = await value.text();
      filename = filenameStem(value.name || "");
      break;
    }
  }
  if (!markdown.trim()) {
    markdown = firstMarkdown(form.get("content"), form.get("content_md"), form.get("body"), form.get("text"));
  }
  return {
    markdown,
    filename,
    title: firstString(form.get("title"), query.title, headers.title),
    botName: firstString(form.get("bot_name"), form.get("bot"), form.get("author"), query.botName, headers.botName),
    botId: firstString(form.get("bot_id"), query.botId, headers.botId),
    category: firstString(form.get("category"), form.get("tag"), query.category, headers.category),
    summary: firstString(form.get("summary"), query.summary),
    id: firstString(form.get("id"), query.id),
    pinned: firstString(form.get("pinned"), query.pinned),
  };
}

async function readPayload(request) {
  const type = mediaType(request);
  const url = new URL(request.url);
  const query = queryMeta(url);
  const headers = headerMeta(request);
  if (type === "multipart/form-data") return readMultipart(request, query, headers);

  const raw = await readLimitedText(request, MAX_BODY);
  const explicitJson = type === "application/json";
  const trimmed = raw.trim();
  const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  const forceRaw = type === "text/markdown" || type === "text/plain" || type === "text/x-markdown";
  if (explicitJson || (looksJson && !forceRaw)) {
    let data;
    try {
      data = JSON.parse(trimmed || "null");
    } catch (error) {
      if (explicitJson) throw httpError(400, "Invalid JSON");
      return rawDocument(raw, query, headers);
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw httpError(400, "JSON body must be an object");
    return {
      markdown: firstMarkdown(data.content, data.markdown, data.content_md, data.body, data.text),
      filename: "",
      title: firstString(data.title, query.title, headers.title),
      botName: firstString(data.bot_name, data.bot, data.author, query.botName, headers.botName),
      botId: firstString(data.bot_id, query.botId, headers.botId),
      category: firstString(data.category, data.tag, query.category, headers.category),
      summary: firstString(data.summary, query.summary),
      id: firstString(data.id, query.id),
      pinned: data.pinned != null && data.pinned !== "" ? data.pinned : query.pinned,
    };
  }
  if (type && !forceRaw && type !== "application/octet-stream" && type !== "application/x-www-form-urlencoded") {
    throw httpError(415, "Unsupported content type");
  }
  return rawDocument(raw, query, headers);
}

function rawDocument(raw, query, headers) {
  return {
    markdown: raw,
    filename: "",
    title: firstString(query.title, headers.title),
    botName: firstString(query.botName, headers.botName),
    botId: firstString(query.botId, headers.botId),
    category: firstString(query.category, headers.category),
    summary: firstString(query.summary),
    id: firstString(query.id),
    pinned: query.pinned,
  };
}

async function createResult(request, env) {
  if (!(await authorized(request, env))) return json({ ok: false, error: "Unauthorized" }, 401);
  const payload = await readPayload(request);
  const markdown = cleanMarkdown(payload.markdown);
  if (!markdown) return json({ ok: false, error: "Markdown content is required" }, 400);
  const createdAt = nowIso();
  const now = new Date(createdAt);
  const title = cleanText(payload.title, 200)
    || cleanText(extractTitle(markdown), 200)
    || cleanText(payload.filename, 200)
    || `Ergebnis vom ${formatFullStamp(createdAt)}`;
  const botName = cleanText(payload.botName, 120) || "Grokbot";
  const botId = cleanText(payload.botId, 80).replace(/\s+/g, "");
  const category = cleanText(payload.category, 60) || "general";
  const summary = cleanText(payload.summary, 400) || makeSummary(markdown);
  const pinnedValue = parsePinned(payload.pinned, 0);
  if (pinnedValue == null) return json({ ok: false, error: "Invalid pinned value" }, 400);
  const explicit = Boolean(payload.id);
  let id = "";
  if (explicit) {
    id = normalizeId(payload.id);
    if (!id) return json({ ok: false, error: "Invalid id" }, 400);
    const existing = await getRow(env.DB, id);
    if (existing) return json({ ok: false, error: "ID already exists" }, 409);
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = explicit ? id : generateId(now);
    try {
      await run(
        env.DB,
        `INSERT INTO results (
          id, title, bot_name, bot_id, category, summary, content_md, pinned, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [candidate, title, botName, botId, category, summary, markdown, pinnedValue, createdAt, createdAt],
      );
      id = candidate;
      break;
    } catch (error) {
      const message = String(error?.message || "");
      if (!/unique/i.test(message)) throw error;
      if (explicit) return json({ ok: false, error: "ID already exists" }, 409);
      if (attempt === 4) throw httpError(500, "Could not allocate id", { expose: true });
    }
  }
  const origin = originOf(request);
  const url = `${origin}/r/${encodeURIComponent(id)}`;
  logEvent("info", "result.created", { id, bot_name: botName, bytes: markdown.length });
  return json(
    {
      ok: true,
      id,
      title,
      bot_name: botName,
      summary,
      created_at: createdAt,
      url,
      dashboard_url: `${origin}/?id=${encodeURIComponent(id)}`,
      raw_url: `${origin}/api/results/${encodeURIComponent(id)}/raw`,
    },
    201,
    { location: url },
  );
}

function patchValue(data, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(data, key)) return { present: true, value: data[key] };
  }
  return { present: false, value: undefined };
}

async function updateResult(request, env, id) {
  if (!(await authorized(request, env))) return json({ ok: false, error: "Unauthorized" }, 401);
  const parsed = parseRouteId(id);
  if (!parsed) return json({ ok: false, error: "Not found" }, 404);
  const existing = await getRow(env.DB, parsed);
  if (!existing) return json({ ok: false, error: "Not found" }, 404);
  const type = mediaType(request);
  if (type && type !== "application/json") return json({ ok: false, error: "JSON body required" }, 415);
  let data;
  try {
    data = JSON.parse((await readLimitedText(request, MAX_BODY)) || "null");
  } catch (error) {
    if (error?.status) throw error;
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return json({ ok: false, error: "JSON body must be an object" }, 400);

  const sets = [];
  const params = [];
  const title = patchValue(data, ["title"]);
  const content = patchValue(data, ["content_md", "content", "markdown", "body", "text"]);
  const bot = patchValue(data, ["bot_name", "bot", "author"]);
  const category = patchValue(data, ["category", "tag"]);
  const pinned = patchValue(data, ["pinned"]);
  const summary = patchValue(data, ["summary"]);
  let nextMarkdown = existing.content_md;

  if (title.present) {
    const value = cleanText(title.value, 200);
    if (!value) return json({ ok: false, error: "Title is required" }, 400);
    sets.push("title = ?");
    params.push(value);
  }
  if (content.present) {
    nextMarkdown = cleanMarkdown(content.value);
    if (!nextMarkdown) return json({ ok: false, error: "Markdown content is required" }, 400);
    sets.push("content_md = ?");
    params.push(nextMarkdown);
  }
  if (bot.present) {
    const value = cleanText(bot.value, 120) || "Grokbot";
    sets.push("bot_name = ?");
    params.push(value);
  }
  if (category.present) {
    const value = cleanText(category.value, 60) || "general";
    sets.push("category = ?");
    params.push(value);
  }
  if (pinned.present) {
    const value = parsePinned(pinned.value, null);
    if (value == null) return json({ ok: false, error: "Invalid pinned value" }, 400);
    sets.push("pinned = ?");
    params.push(value);
  }
  if (summary.present) {
    sets.push("summary = ?");
    params.push(cleanText(summary.value, 400));
  } else if (content.present) {
    sets.push("summary = ?");
    params.push(makeSummary(nextMarkdown));
  }
  if (!sets.length) return json({ ok: false, error: "No fields to update" }, 400);
  const updatedAt = nowIso();
  sets.push("updated_at = ?");
  params.push(updatedAt, parsed);
  await run(env.DB, `UPDATE results SET ${sets.join(", ")} WHERE id = ?`, params);
  const row = await getRow(env.DB, parsed);
  logEvent("info", "result.updated", { id: parsed });
  return json({ ok: true, ...present(row, originOf(request), { full: true }) });
}

async function deleteResult(request, env, id) {
  if (!(await authorized(request, env))) return json({ ok: false, error: "Unauthorized" }, 401);
  const parsed = parseRouteId(id);
  if (!parsed) return json({ ok: false, error: "Not found" }, 404);
  const existing = await getRow(env.DB, parsed);
  if (!existing) return json({ ok: false, error: "Not found" }, 404);
  await run(env.DB, "DELETE FROM results WHERE id = ?", [parsed]);
  logEvent("info", "result.deleted", { id: parsed });
  return json({ ok: true, id: parsed });
}

function isWordChar(ch) {
  return !!ch && /[A-Za-z0-9]/.test(ch);
}

function safeUrl(url) {
  const value = String(url ?? "").trim().replace(/[\u0000-\u001F\u007F]/g, "");
  if (!value || value.length > 2000 || value.startsWith("//") || value.includes("\\")) return "";
  if (value.startsWith("#") || value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || value.startsWith("?")) {
    return value;
  }
  const match = value.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!match) {
    return /^[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/.test(value) ? value : "";
  }
  const scheme = match[1].toLowerCase();
  if (scheme === "http" || scheme === "https" || scheme === "mailto") return value;
  return "";
}

function imageSrc(url) {
  const compact = String(url ?? "").trim().replace(/[\u0000-\u001F\u007F\s]/g, "");
  if (/^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(compact) && compact.length <= 200_000) {
    return compact;
  }
  return safeUrl(url);
}

function readLink(src, start) {
  if (src[start] !== "[") return null;
  let index = start + 1;
  let label = "";
  while (index < src.length && src[index] !== "]") {
    if (src[index] === "\\") {
      label += src[index + 1] || "";
      index += 2;
      continue;
    }
    if (src[index] === "[") return null;
    label += src[index];
    index += 1;
  }
  if (src[index] !== "]" || src[index + 1] !== "(") return null;
  index += 2;
  let url = "";
  if (src[index] === "<") {
    index += 1;
    while (index < src.length && src[index] !== ">") {
      url += src[index];
      index += 1;
    }
    if (src[index] !== ">") return null;
    index += 1;
  } else {
    let depth = 0;
    while (index < src.length) {
      if (src[index] === "\\") {
        url += src[index + 1] || "";
        index += 2;
        continue;
      }
      if (src[index] === "(") depth += 1;
      if (src[index] === ")") {
        if (depth === 0) break;
        depth -= 1;
      }
      if (src[index] === " " && depth === 0) break;
      url += src[index];
      index += 1;
    }
  }
  if (src[index] === " ") {
    while (src[index] === " ") index += 1;
    const quote = src[index];
    if (quote === '"' || quote === "'") {
      index += 1;
      while (index < src.length && src[index] !== quote) index += 1;
      if (src[index] === quote) index += 1;
    }
  }
  if (src[index] !== ")") return null;
  return { label, url: url.trim(), end: index + 1 };
}

function findMarker(src, from, marker) {
  let index = from;
  while (index < src.length) {
    if (src[index] === "\\") {
      index += 2;
      continue;
    }
    if (src[index] === "`") {
      const ticks = (src.slice(index).match(/^`+/) || [""])[0].length;
      const end = src.indexOf("`".repeat(ticks), index + ticks);
      if (end === -1) return -1;
      index = end + ticks;
      continue;
    }
    if (src.startsWith(marker, index)) return index;
    index += 1;
  }
  return -1;
}

function findSingleEmphasis(src, from, ch) {
  let index = from;
  while (index < src.length) {
    if (src[index] === "\\") {
      index += 2;
      continue;
    }
    if (src[index] === "`") {
      const ticks = (src.slice(index).match(/^`+/) || [""])[0].length;
      const end = src.indexOf("`".repeat(ticks), index + ticks);
      if (end === -1) return -1;
      index = end + ticks;
      continue;
    }
    if (src[index] === ch) {
      if (src[index + 1] === ch) {
        index += 2;
        continue;
      }
      if (ch === "_" && isWordChar(src[index + 1])) {
        index += 1;
        continue;
      }
      if (index === from) return -1;
      return index;
    }
    index += 1;
  }
  return -1;
}

function linkHtml(href, labelHtml) {
  const safe = escapeHtml(href);
  if (/^https?:\/\//i.test(href)) {
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${labelHtml}</a>`;
  }
  return `<a href="${safe}">${labelHtml}</a>`;
}

function parseInline(src, depth = 0) {
  if (depth > 12) return escapeHtml(src);
  let index = 0;
  let html = "";
  while (index < src.length) {
    const ch = src[index];
    if (ch === "\\" && index + 1 < src.length) {
      html += escapeHtml(src[index + 1]);
      index += 2;
      continue;
    }
    if (ch === "`") {
      const ticks = (src.slice(index).match(/^`+/) || [""])[0].length;
      const marker = "`".repeat(ticks);
      const end = src.indexOf(marker, index + ticks);
      if (end !== -1) {
        let code = src.slice(index + ticks, end);
        if (code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
        html += `<code>${escapeHtml(code)}</code>`;
        index = end + ticks;
        continue;
      }
    }
    if ((src.startsWith("https://", index) || src.startsWith("http://", index)) && (index === 0 || /\s|\(/.test(src[index - 1] || ""))) {
      const match = src.slice(index).match(/^https?:\/\/[^\s<]+/);
      if (match) {
        let url = match[0].replace(/[),.;:!?]+$/g, "");
        const safe = safeUrl(url);
        if (safe) {
          html += linkHtml(safe, escapeHtml(safe));
          index += url.length;
          continue;
        }
      }
    }
    if (ch === "!" && src[index + 1] === "[") {
      const link = readLink(src, index + 1);
      if (link) {
        const srcUrl = imageSrc(link.url);
        if (srcUrl) html += `<img src="${escapeHtml(srcUrl)}" alt="${escapeHtml(link.label)}" loading="lazy" />`;
        else if (link.label) html += escapeHtml(link.label);
        index = link.end;
        continue;
      }
    }
    if (ch === "[") {
      const link = readLink(src, index);
      if (link) {
        const href = safeUrl(link.url);
        const labelHtml = parseInline(link.label, depth + 1);
        html += href ? linkHtml(href, labelHtml) : labelHtml;
        index = link.end;
        continue;
      }
    }
    if (ch === "~" && src[index + 1] === "~") {
      const end = findMarker(src, index + 2, "~~");
      if (end !== -1 && end > index + 2) {
        html += `<del>${parseInline(src.slice(index + 2, end), depth + 1)}</del>`;
        index = end + 2;
        continue;
      }
    }
    if ((ch === "*" || ch === "_") && src[index + 1] === ch && src[index + 2] === ch) {
      const marker = ch + ch + ch;
      const end = findMarker(src, index + 3, marker);
      if (end !== -1 && end > index + 3) {
        html += `<strong><em>${parseInline(src.slice(index + 3, end), depth + 1)}</em></strong>`;
        index = end + 3;
        continue;
      }
    }
    if ((ch === "*" || ch === "_") && src[index + 1] === ch) {
      const marker = ch + ch;
      const end = findMarker(src, index + 2, marker);
      if (end !== -1 && end > index + 2) {
        html += `<strong>${parseInline(src.slice(index + 2, end), depth + 1)}</strong>`;
        index = end + 2;
        continue;
      }
    }
    if (ch === "*" || ch === "_") {
      if (ch === "_" && isWordChar(src[index - 1])) {
        html += escapeHtml(ch);
        index += 1;
        continue;
      }
      const end = findSingleEmphasis(src, index + 1, ch);
      if (end !== -1) {
        html += `<em>${parseInline(src.slice(index + 1, end), depth + 1)}</em>`;
        index = end + 1;
        continue;
      }
    }
    html += escapeHtml(ch);
    index += 1;
  }
  return html;
}

function sanitizeLang(raw) {
  const token = String(raw || "").trim().split(/\s+/)[0] || "";
  return /^[A-Za-z0-9_+#.-]{1,32}$/.test(token) ? token : "";
}

function codeBlockHtml(lang, code) {
  const label = lang || "Text";
  return `<div class="codeblock"><div class="code-toolbar"><span class="code-lang">${escapeHtml(label)}</span><button type="button" class="code-copy" data-copy-code>Kopieren</button></div><pre><code>${escapeHtml(code)}</code></pre></div>`;
}

function splitRow(line) {
  let value = String(line || "").trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|")) value = value.slice(0, -1);
  const cells = [];
  let current = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\\") {
      current += value[index + 1] || "";
      index += 1;
      continue;
    }
    if (value[index] === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += value[index];
  }
  cells.push(current.trim());
  return cells;
}

function isDelimRow(line) {
  if (!line || !String(line).includes("|")) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function alignAttr(align) {
  if (align === "center" || align === "right" || align === "left") return ` style="text-align:${align}"`;
  return "";
}

function parseTable(lines, start) {
  if (!isDelimRow(lines[start + 1] || "")) return null;
  if (!String(lines[start] || "").includes("|")) return null;
  const header = splitRow(lines[start]);
  const delim = splitRow(lines[start + 1]);
  const width = Math.max(header.length, delim.length);
  const align = delim.map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return "";
  });
  let index = start + 2;
  const rows = [];
  while (index < lines.length && String(lines[index]).trim() && String(lines[index]).includes("|") && !isBlockStart(lines, index, true)) {
    rows.push(splitRow(lines[index]));
    index += 1;
  }
  const head = Array.from({ length: width }, (_, cell) => `<th${alignAttr(align[cell])}>${parseInline(header[cell] || "")}</th>`).join("");
  const body = rows.map((row) => {
    const cells = Array.from({ length: width }, (_, cell) => `<td${alignAttr(align[cell])}>${parseInline(row[cell] || "")}</td>`).join("");
    return `<tr>${cells}</tr>`;
  }).join("");
  return {
    html: `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`,
    next: index,
  };
}

function parseQuote(lines, start, depth) {
  const collected = [];
  let index = start;
  while (index < lines.length && /^\s{0,3}>\s?/.test(lines[index])) {
    collected.push(lines[index].replace(/^\s{0,3}>\s?/, ""));
    index += 1;
  }
  let kind = "";
  if (collected.length) {
    const match = collected[0].match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION|DANGER|ERROR)]\s*(.*)$/i);
    if (match) {
      kind = match[1].toLowerCase() === "error" ? "danger" : match[1].toLowerCase();
      if (match[2]) collected[0] = match[2];
      else collected.shift();
    }
  }
  const inner = renderMarkdown(collected.join("\n"), depth + 1);
  const labels = {
    note: "Hinweis",
    tip: "Tipp",
    important: "Wichtig",
    warning: "Warnung",
    caution: "Vorsicht",
    danger: "Gefahr",
  };
  if (kind) {
    return {
      html: `<blockquote class="callout callout-${kind}"><div class="callout-label">${labels[kind] || kind}</div>${inner}</blockquote>`,
      next: index,
    };
  }
  return { html: `<blockquote>${inner}</blockquote>`, next: index };
}

function lineIndent(line) {
  const match = String(line || "").match(/^[ ]*/);
  return match ? match[0].length : 0;
}

function listMarker(line) {
  const match = String(line || "").match(/^([ ]*)([-*+]|\d+[.)])[ ]+(.*)$/);
  if (!match) return null;
  return {
    indent: match[1].length,
    marker: match[2],
    ordered: /\d/.test(match[2]),
    text: match[3],
  };
}

function dedentLines(lines, spaces) {
  return lines
    .map((line) => {
      if (!line.trim()) return "";
      let count = 0;
      while (count < spaces && line[count] === " ") count += 1;
      return line.slice(count);
    })
    .join("\n");
}

function parseList(lines, start, depth) {
  const first = listMarker(lines[start]);
  if (!first) return null;
  const indent = first.indent;
  const ordered = first.ordered;
  const items = [];
  let index = start;
  let anyTask = false;
  while (index < lines.length) {
    if (!lines[index].trim()) {
      let look = index + 1;
      while (look < lines.length && !lines[look].trim()) look += 1;
      const next = listMarker(lines[look] || "");
      if (next && next.indent === indent && next.ordered === ordered) {
        index = look;
        continue;
      }
      break;
    }
    const mark = listMarker(lines[index]);
    if (!mark || mark.indent !== indent || mark.ordered !== ordered) break;
    let text = mark.text;
    let checked = null;
    if (!ordered) {
      const task = text.match(/^\[([ xX])]\s+(.*)$/);
      if (task) {
        checked = task[1].toLowerCase() === "x";
        text = task[2];
        anyTask = true;
      }
    }
    index += 1;
    const nested = [];
    while (index < lines.length) {
      if (!lines[index].trim()) {
        let look = index + 1;
        while (look < lines.length && !lines[look].trim()) look += 1;
        const next = listMarker(lines[look] || "");
        if (next && next.indent === indent && next.ordered === ordered) break;
        if (look < lines.length && lineIndent(lines[look]) > indent) {
          nested.push(lines[index]);
          index += 1;
          continue;
        }
        break;
      }
      if (lineIndent(lines[index]) > indent) {
        nested.push(lines[index]);
        index += 1;
        continue;
      }
      break;
    }
    let inner = `<span class="li-text">${parseInline(text)}</span>`;
    if (nested.length) inner += renderMarkdown(dedentLines(nested, indent + 2), depth + 1);
    items.push({ checked, inner });
  }
  const tag = ordered ? "ol" : "ul";
  const cls = !ordered && anyTask ? ' class="tasks"' : "";
  const body = items
    .map((item) => {
      if (item.checked == null) return `<li>${item.inner}</li>`;
      const attr = item.checked ? " checked" : "";
      return `<li class="task"><label><input type="checkbox" disabled tabindex="-1"${attr} /><span>${item.inner}</span></label></li>`;
    })
    .join("");
  return { html: `<${tag}${cls}>${body}</${tag}>`, next: index };
}

function isHr(line) {
  const value = String(line || "").replace(/\s+$/, "");
  return /^ {0,3}((\*( *)){3,}|(-( *)){3,}|(_( *)){3,})$/.test(value);
}

function isBlockStart(lines, index, insideTable = false) {
  const line = lines[index];
  if (!line || !line.trim()) return false;
  if (/^\s{0,3}(```+|~~~+)/.test(line)) return true;
  if (/^\s{0,3}#{1,6}\s+/.test(line)) return true;
  if (isHr(line)) return true;
  if (/^\s{0,3}>\s?/.test(line)) return true;
  if (listMarker(line)) return true;
  if (!insideTable && String(line).includes("|") && isDelimRow(lines[index + 1] || "")) return true;
  return false;
}

function renderMarkdown(markdown, depth = 0) {
  const source = String(markdown ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
  if (depth > 12) return `<p>${escapeHtml(source)}</p>`;
  const lines = source.split("\n");
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = line.match(/^\s{0,3}(```+|~~~+)(.*)$/);
    if (fence) {
      const markerChar = fence[1][0];
      const markerLen = fence[1].length;
      const lang = sanitizeLang(fence[2]);
      const buf = [];
      index += 1;
      while (index < lines.length) {
        const close = lines[index].match(/^\s{0,3}(```+|~~~+)\s*$/);
        if (close && close[1][0] === markerChar && close[1].length >= markerLen) break;
        buf.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(codeBlockHtml(lang, buf.join("\n")));
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${parseInline(heading[2].trim())}</h${level}>`);
      index += 1;
      continue;
    }
    if (isHr(line)) {
      blocks.push("<hr />");
      index += 1;
      continue;
    }
    if (String(line).includes("|") && isDelimRow(lines[index + 1] || "")) {
      const table = parseTable(lines, index);
      if (table) {
        blocks.push(table.html);
        index = table.next;
        continue;
      }
    }
    if (/^\s{0,3}>\s?/.test(line)) {
      const quote = parseQuote(lines, index, depth);
      blocks.push(quote.html);
      index = quote.next;
      continue;
    }
    if (listMarker(line)) {
      const list = parseList(lines, index, depth);
      if (list) {
        blocks.push(list.html);
        index = list.next;
        continue;
      }
    }
    const buf = [];
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines, index)) {
      buf.push(lines[index]);
      index += 1;
    }
    if (!buf.length) {
      blocks.push(`<p>${parseInline(line)}</p>`);
      index += 1;
      continue;
    }
    const html = buf
      .map((part, partIndex) => {
        const hard = /[ ]{2}$/.test(part);
        const text = parseInline(part.replace(/[ ]{2}$/, ""));
        if (partIndex < buf.length - 1) return text + (hard ? "<br />" : " ");
        return text;
      })
      .join("");
    blocks.push(`<p>${html}</p>`);
  }
  return blocks.join("\n");
}

function botProfile(name) {
  const raw = String(name || "Grokbot");
  const short = raw.split("·")[0].trim() || "Grokbot";
  const key = short.toLowerCase();
  const table = {
    bote: ["#5b8cff", "mail"],
    elon: ["#e7c15a", "bolt"],
    chef: ["#ef6d5c", "crown"],
    planer: ["#3dbe8c", "calendar"],
    tutor: ["#b07cff", "book"],
    betreuer: ["#ff8fab", "heart"],
    astronaut: ["#7ecbff", "rocket"],
    journalist: ["#ffb020", "news"],
    reiseleiter: ["#2ec4b6", "map"],
    händler: ["#f4a261", "tag"],
    haendler: ["#f4a261", "tag"],
    weggefährte: ["#9bde7e", "compass"],
    weggefaehrte: ["#9bde7e", "compass"],
    druckmanager: ["#c5cad6", "printer"],
    grokbot: ["#d6f25c", "spark"],
  };
  const hit = table[key];
  if (hit) return { short, color: hit[0], icon: hit[1], full: raw };
  const palette = ["#5b8cff", "#e7c15a", "#ef6d5c", "#3dbe8c", "#b07cff", "#7ecbff", "#ffb020", "#2ec4b6", "#f4a261", "#9bde7e"];
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  return { short, color: palette[hash % palette.length], icon: "spark", full: raw };
}

function iconSvg(name) {
  const paths = {
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M3 7l9 7 9-7"></path>',
    bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"></path>',
    crown: '<path d="M3 17l2.2-9 4.3 5L12 5l2.5 8 4.3-5L21 17H3z"></path>',
    calendar: '<rect x="4" y="5" width="16" height="15" rx="2"></rect><path d="M8 3v4M16 3v4M4 10h16"></path>',
    book: '<path d="M5 5.5A3.5 3.5 0 0 1 8.5 4H19v15H8.5A3.5 3.5 0 0 0 5 22.5z"></path>',
    heart: '<path d="M12 20s-7-4.4-7-9a4 4 0 0 1 7-2 4 4 0 0 1 7 2c0 4.6-7 9-7 9z"></path>',
    rocket: '<path d="M12 19s-4-1.2-4-6c0-4.5 4-9 4-9s4 4.5 4 9c0 4.8-4 6-4 6z"></path><path d="M9 14.5c-1.8.4-3 2-3 2s1.8-.1 3-.8M15 14.5c1.8.4 3 2 3 2s-1.8-.1-3-.8"></path>',
    news: '<path d="M5 5h11v14H5z"></path><path d="M16 8h3v11a2 2 0 0 1-2 2H8"></path><path d="M8 9h6M8 12h6M8 15h4"></path>',
    map: '<path d="M9 4l-5 2v14l5-2 6 2 5-2V4l-5 2-6-2z"></path><path d="M9 4v14M15 6v14"></path>',
    tag: '<path d="M20 13l-7 7-9-9V4h7l9 9z"></path><circle cx="8.5" cy="8.5" r="1"></circle>',
    compass: '<circle cx="12" cy="12" r="8"></circle><path d="M14.8 9.2l-1.3 4.3-4.3 1.3 1.3-4.3 4.3-1.3z"></path>',
    printer: '<path d="M7 8V4h10v4"></path><path d="M6 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-1"></path><rect x="7" y="14" width="10" height="6"></rect>',
    spark: '<path d="M12 3l1.5 5.2L19 10l-5.5 1.8L12 17l-1.5-5.2L5 10l5.5-1.8L12 3z"></path>',
  };
  const body = paths[name] || paths.spark;
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;
}

function pageCss() {
  return `
    :root { color-scheme: dark; --bg:#090a0f; --side:#0c0e14; --surface:#12141c; --text:#f4f6fb; --muted:#9aa3b5; --line:rgba(255,255,255,.08); --lime:#d6f25c; --read:18px; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    html, body { height: 100%; }
    body { margin: 0; background: var(--bg); color: var(--text); font-family: "Segoe UI", "SF Pro Text", "Helvetica Neue", Inter, Roboto, system-ui, sans-serif; overflow: hidden; }
    body::before { content: ""; position: fixed; left: 0; right: 0; top: 0; height: 2px; background: linear-gradient(90deg, transparent, var(--lime), #8eaaef, transparent); z-index: 80; }
    button, a, input, textarea, label { touch-action: manipulation; }
    button, input, textarea { font: inherit; color: inherit; }
    button { cursor: pointer; }
    :focus-visible { outline: 2px solid var(--lime); outline-offset: 2px; }
    #app { height: 100vh; height: 100dvh; display: flex; min-width: 0; }
    #sidebar { width: 340px; min-width: 340px; flex: none; display: flex; flex-direction: column; min-height: 0; background: var(--side); border-right: 1px solid var(--line); overflow: hidden; }
    body.side-closed #sidebar { width: 0; min-width: 0; visibility: hidden; border-right: 0; padding: 0; }
    #reader { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; background: var(--bg); }
    .brand-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 18px 16px 8px; }
    .brand { display: flex; gap: 12px; align-items: center; min-width: 0; }
    .logo { width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; background: #171a24; color: var(--lime); flex: none; }
    .logo svg { width: 22px; height: 22px; }
    .brand h1 { margin: 0; font-size: 16px; letter-spacing: -.02em; font-weight: 600; }
    .brand p { margin: 2px 0 0; color: var(--muted); font-size: 12px; }
    .live { display: inline-flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; min-height: 32px; }
    .dot { width: 8px; height: 8px; border-radius: 99px; background: #3dbe8c; box-shadow: 0 0 0 4px rgba(61,190,140,.16); }
    .live.offline .dot { background: #ef6d5c; box-shadow: none; }
    .side-tools, .search-wrap { padding: 8px 16px; }
    .search-wrap { position: relative; }
    .search-wrap svg { position: absolute; left: 28px; top: 50%; transform: translateY(-50%); width: 16px; height: 16px; color: var(--muted); }
    #search { width: 100%; height: 46px; border-radius: 12px; border: 1px solid var(--line); background: #090a0f; padding: 0 12px 0 38px; }
    #search::placeholder { color: #727b8e; }
    .chips { display: flex; gap: 8px; overflow-x: auto; padding: 2px 16px 10px; scrollbar-width: none; }
    .chips::-webkit-scrollbar { display: none; }
    .chip { flex: 0 0 auto; min-height: 36px; display: inline-flex; align-items: center; gap: 6px; padding: 0 12px; border-radius: 999px; border: 1px solid var(--line); background: transparent; color: #d5d8e2; }
    .chip svg { width: 14px; height: 14px; }
    .chip.active { background: #f4f6fb; color: #12141a; border-color: transparent; }
    .history { flex: 1; overflow: auto; min-height: 0; padding-bottom: 12px; }
    .group-label { position: sticky; top: 0; z-index: 1; padding: 12px 16px 6px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #8b93a7; background: var(--side); }
    .entry { display: block; width: calc(100% - 16px); margin: 0 8px 6px; text-align: left; border-radius: 14px; border: 0; border-left: 3px solid transparent; background: transparent; padding: 10px 10px 10px 12px; min-height: 76px; }
    .entry:hover { background: rgba(255,255,255,.04); }
    .entry.active { background: #171b27; border-left-color: var(--bot, var(--lime)); }
    .entry-top { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
    .entry-title { font-weight: 600; font-size: 14.5px; line-height: 1.35; margin: 6px 0 2px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .entry-summary { color: var(--muted); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .entry-time { color: #8b93a7; font-size: 12px; flex: none; }
    .badge { display: inline-flex; align-items: center; gap: 6px; min-height: 26px; padding: 0 8px 0 6px; border-radius: 999px; background: color-mix(in srgb, var(--bot) 18%, transparent); color: var(--bot); font-size: 12px; font-weight: 700; }
    .badge svg { width: 14px; height: 14px; }
    .badge-lg { min-height: 32px; font-size: 13px; padding: 0 10px 0 8px; }
    .badge-lg svg { width: 16px; height: 16px; }
    .side-foot { border-top: 1px solid var(--line); padding: 12px 16px 16px; display: grid; gap: 10px; }
    .follow { display: flex; gap: 10px; align-items: flex-start; color: #d5d8e2; font-size: 13px; line-height: 1.35; }
    .follow input { width: 18px; height: 18px; margin-top: 1px; accent-color: var(--lime); }
    .key-label, .sheet label { display: grid; gap: 6px; font-size: 12px; color: var(--muted); }
    .key-label input, .sheet input, .sheet textarea { width: 100%; border-radius: 12px; border: 1px solid var(--line); background: #090a0f; padding: 12px; }
    .key-label input { height: 42px; padding: 0 12px; }
    .foot-meta { color: #727b8e; font-size: 12px; }
    .empty-side, .muted { color: var(--muted); }
    .empty-side { padding: 24px 16px; }
    .reader-bar { display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap; padding: 14px 18px; position: sticky; top: 0; z-index: 5; background: rgba(9,10,15,.92); backdrop-filter: blur(16px); border-bottom: 1px solid var(--line); }
    .reader-id { flex: 1 1 280px; min-width: 0; display: flex; gap: 12px; align-items: flex-start; }
    .reader-titles { min-width: 0; }
    .doc-title { margin: 0; font-size: 20px; letter-spacing: -.02em; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .doc-meta, .bot-full { color: var(--muted); font-size: 13px; margin: 4px 0 0; }
    #bot-slot { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; flex: none; }
    .reader-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
    .btn { min-height: 44px; border-radius: 12px; border: 1px solid var(--line); background: #1a1e2a; color: var(--text); padding: 0 12px; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; }
    .btn:hover { background: #232838; }
    .btn-primary { background: #f4f6fb; color: #141820; border-color: transparent; font-weight: 700; }
    .btn-danger { background: #3a1d22; color: #ffb4ab; border-color: #5c2a32; }
    #doc-scroll { flex: 1; overflow: auto; padding: 22px 28px 72px; }
    .markdown { width: min(980px, 100%); margin: 0 auto; font-size: var(--read); line-height: 1.65; overflow-wrap: break-word; }
    body.side-closed .markdown { width: min(1100px, 100%); }
    .markdown > :first-child { margin-top: 0; }
    .markdown h1, .markdown h2, .markdown h3, .markdown h4, .markdown h5, .markdown h6 { line-height: 1.25; letter-spacing: -.03em; font-weight: 700; }
    .markdown h1 { font-size: 1.7em; margin: 0 0 .55em; }
    .markdown h2 { font-size: 1.35em; margin: 1.35em 0 .45em; }
    .markdown h3 { font-size: 1.15em; margin: 1.2em 0 .4em; }
    .markdown p { margin: .75em 0; }
    .markdown a { color: #b7c7ff; }
    .markdown code { font-family: "SFMono-Regular", ui-monospace, "Cascadia Code", Consolas, monospace; font-size: .88em; background: rgba(255,255,255,.06); padding: .1em .38em; border-radius: 6px; }
    .markdown pre { margin: 0; padding: 14px 16px; overflow: auto; }
    .markdown pre code { background: none; padding: 0; font-size: .84em; }
    .codeblock { margin: 1em 0; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; background: #0c0e14; }
    .code-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 6px 10px; background: #151823; color: var(--muted); font-size: 12px; }
    .code-copy { min-height: 36px; }
    .table-wrap { overflow-x: auto; margin: 1em 0; border: 1px solid var(--line); border-radius: 12px; }
    table { width: 100%; border-collapse: collapse; min-width: 520px; }
    th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid rgba(255,255,255,.06); vertical-align: top; }
    th { font-size: .75em; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); background: #161924; }
    tbody tr:nth-child(even) { background: rgba(255,255,255,.03); }
    .markdown ul, .markdown ol { padding-left: 1.25em; margin: .6em 0; }
    .markdown li { margin: .28em 0; }
    ul.tasks { list-style: none; padding-left: 0; }
    ul.tasks label { display: flex; gap: 10px; align-items: flex-start; }
    ul.tasks input { width: 1.15em; height: 1.15em; margin-top: .28em; accent-color: var(--lime); }
    .markdown blockquote { margin: 1em 0; padding: 2px 0 2px 14px; border-left: 3px solid rgba(255,255,255,.2); color: #d7dbe6; }
    .markdown blockquote.callout { color: inherit; border: 1px solid var(--line); border-left-width: 3px; border-radius: 12px; padding: 12px 14px; background: rgba(255,255,255,.03); }
    .callout-note { border-left-color: #5b8cff; }
    .callout-tip { border-left-color: #3dbe8c; }
    .callout-important { border-left-color: #b07cff; }
    .callout-warning { border-left-color: #ffb020; }
    .callout-caution { border-left-color: #f4a261; }
    .callout-danger { border-left-color: #ef6d5c; }
    .callout-label { font-size: .72em; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; margin-bottom: .35em; }
    .markdown hr { border: 0; border-top: 1px solid var(--line); margin: 1.6em 0; }
    .markdown img { max-width: 100%; border-radius: 12px; }
    .markdown del { opacity: .75; }
    .scrim { display: none; }
    .toast { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); z-index: 60; display: flex; gap: 16px; align-items: center; width: min(520px, calc(100vw - 24px)); background: #1c2030; border: 1px solid var(--line); border-radius: 16px; padding: 12px 12px 12px 16px; box-shadow: 0 18px 50px rgba(0,0,0,.45); }
    .toast-kicker { color: var(--lime); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; font-weight: 700; }
    .toast strong { display: block; margin-top: 2px; }
    .toast p { margin: 2px 0 0; color: var(--muted); font-size: 13px; }
    dialog { width: min(760px, calc(100vw - 28px)); max-height: min(92vh, 900px); overflow: auto; border: 1px solid var(--line); border-radius: 18px; background: #12141c; color: inherit; padding: 0; }
    dialog::backdrop { background: rgba(0,0,0,.64); }
    .sheet { padding: 18px; display: grid; gap: 12px; }
    .sheet-head, .sheet-actions { display: flex; justify-content: space-between; gap: 10px; align-items: center; }
    .sheet h2, .sheet p { margin: 0; }
    .sheet textarea { min-height: 240px; resize: vertical; line-height: 1.5; }
    .split { display: grid; grid-template-columns: 1.4fr .8fr; gap: 12px; }
    .file-label input { padding: 10px; }
    @media (max-width: 860px) {
      #sidebar { position: fixed; z-index: 30; inset: 0 auto 0 0; height: 100dvh; width: min(92vw, 400px); min-width: 0; visibility: visible; transform: translateX(-105%); transition: transform .18s ease; }
      body:not(.side-closed) #sidebar { transform: none; visibility: visible; }
      body.side-closed #sidebar { width: min(92vw, 400px); min-width: 0; visibility: hidden; transform: translateX(-105%); }
      body:not(.side-closed) .scrim { display: block; position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 25; }
      #doc-scroll { padding: 16px 16px 88px; }
      .split { grid-template-columns: 1fr; }
      .doc-title { white-space: normal; }
    }
    @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  `;
}

function badgeHtml(name, large) {
  const profile = botProfile(name);
  const cls = large ? "badge badge-lg" : "badge";
  return `<span class="${cls}" style="--bot:${profile.color};color:${profile.color};background:${profile.color}22">${iconSvg(profile.icon)}<span>${escapeHtml(profile.short)}</span></span>`;
}

function readerChrome(result, missing) {
  if (!result && missing) {
    return {
      title: "Eintrag nicht gefunden",
      meta: "",
      slot: "",
      article: `<p class="muted">Dieser Bericht ist nicht im Dashboard.</p>`,
      pin: "☆ Anheften",
      href: "#",
      download: "bericht.md",
    };
  }
  const title = result ? result.title : "Kein Bericht ausgewählt";
  const meta = result ? `${formatFullStamp(result.created_at)} · ${result.category || "general"}` : "";
  const slot = result ? `${badgeHtml(result.bot_name, true)}<span class="bot-full">${escapeHtml(result.bot_name)}</span>` : "";
  const article = result ? renderMarkdown(result.content_md || "") : `<p class="muted">Wähle einen Eintrag aus dem Verlauf.</p>`;
  const pin = result?.pinned ? "★ Angeheftet" : "☆ Anheften";
  const href = result ? `/api/results/${encodeURIComponent(result.id)}/raw` : "#";
  const download = result ? `${result.id}.md` : "bericht.md";
  return { title, meta, slot, article, pin, href, download };
}

function serializeBoot(data) {
  return JSON.stringify(data).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function appMain() {
  const POLL_MS = 8000;
  const boot = JSON.parse(document.getElementById("boot-data").textContent || "{}");
  const state = {
    results: [],
    byId: new Map(),
    selectedId: boot.selectedId || "",
    bot: boot.bot || "",
    query: "",
    sidebar: true,
    font: 18,
    follow: false,
    apiKey: "",
    known: new Set(),
    ready: false,
    polling: false,
  };

  function storageGet(key) {
    try { return localStorage.getItem(key); } catch (error) { return null; }
  }
  function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (error) { /* private mode */ }
  }
  const el = (id) => document.getElementById(id);

  state.font = Number(storageGet("gd-font") || "18");
  state.follow = storageGet("gd-follow") === "1";
  state.apiKey = storageGet("gd-key") || "";
  const mobile = window.matchMedia("(max-width: 860px)").matches;
  const storedClosed = storageGet("gd-focus") === "1";
  state.sidebar = mobile ? !boot.result : !storedClosed;

  function applyFont() {
    const size = Math.min(26, Math.max(15, Number(state.font) || 18));
    state.font = size;
    document.documentElement.style.setProperty("--read", `${size}px`);
    storageSet("gd-font", String(size));
  }
  function setSidebar(open, persist) {
    state.sidebar = open;
    document.body.classList.toggle("side-closed", !open);
    const button = el("btn-focus");
    button.textContent = open ? "Vollbild" : "Verlauf";
    button.setAttribute("aria-label", open ? "Vollbild" : "Verlauf anzeigen");
    button.title = "Fokus / Vollbild";
    if (persist && !window.matchMedia("(max-width: 860px)").matches) storageSet("gd-focus", open ? "0" : "1");
  }
  function setLive(ok) {
    el("live").classList.toggle("offline", !ok);
    el("live-label").textContent = ok ? "Live" : "Offline";
  }
  function cacheResult(item) {
    const prev = state.byId.get(item.id) || {};
    const merged = Object.assign({}, prev, item);
    if (item.content_md == null && prev.content_md != null) merged.content_md = prev.content_md;
    state.byId.set(item.id, merged);
    return merged;
  }
  function sortResults(items) {
    return items.slice().sort((a, b) => {
      const pin = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
      if (pin) return pin;
      return String(b.created_at).localeCompare(String(a.created_at));
    });
  }
  function newestOf(items) {
    return items.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
  }
  function matchBot(name, filter) {
    if (!filter) return true;
    const profile = botProfile(name);
    const raw = String(name || "").toLowerCase();
    const wanted = filter.toLowerCase();
    return profile.short.toLowerCase() === wanted || raw === wanted;
  }
  function setActions(enabled) {
    for (const id of ["btn-copy", "btn-download", "btn-pin", "btn-delete"]) {
      const node = el(id);
      if ("disabled" in node) node.disabled = !enabled;
      if (node.tagName === "A") node.setAttribute("aria-disabled", enabled ? "false" : "true");
    }
  }
  function renderDoc(item) {
    el("doc-title").textContent = item.title || "Bericht";
    el("doc-meta").textContent = `${formatFullStamp(item.created_at)} · ${item.category || "general"}`;
    el("bot-slot").innerHTML = `${badgeHtml(item.bot_name, true)}<span class="bot-full">${escapeHtml(item.bot_name || "")}</span>`;
    el("doc").innerHTML = renderMarkdown(item.content_md || "");
    document.title = `${item.title} · ${item.bot_name}`;
    const download = el("btn-download");
    download.href = `/api/results/${encodeURIComponent(item.id)}/raw`;
    download.setAttribute("download", `${item.id}.md`);
    const pin = el("btn-pin");
    pin.textContent = item.pinned ? "★ Angeheftet" : "☆ Anheften";
    pin.setAttribute("aria-pressed", item.pinned ? "true" : "false");
    setActions(true);
  }
  function renderMissing() {
    el("doc-title").textContent = "Eintrag nicht gefunden";
    el("doc-meta").textContent = "";
    el("bot-slot").innerHTML = "";
    el("doc").innerHTML = `<p class="muted">Dieser Bericht ist nicht im Dashboard.</p>`;
    document.title = "Eintrag nicht gefunden · Grokbot Dashboard";
    setActions(false);
  }
  function renderEmpty(message) {
    el("doc-title").textContent = "Grokbot Dashboard";
    el("doc-meta").textContent = "";
    el("bot-slot").innerHTML = "";
    el("doc").innerHTML = `<p class="muted">${escapeHtml(message || "Wähle einen Eintrag aus dem Verlauf.")}</p>`;
    setActions(false);
  }
  function renderChips() {
    const preferred = ["Bote", "Elon", "Chef", "Planer", "Tutor", "Betreuer", "Astronaut", "Journalist", "Reiseleiter", "Händler", "Weggefährte", "Druckmanager"];
    const present = new Map();
    for (const item of state.results) present.set(botProfile(item.bot_name).short.toLowerCase(), botProfile(item.bot_name).short);
    const names = [];
    const seen = new Set();
    for (const name of preferred) {
      const found = present.get(name.toLowerCase());
      if (found) {
        names.push(found);
        seen.add(name.toLowerCase());
      }
    }
    for (const [key, name] of present) {
      if (!seen.has(key)) names.push(name);
    }
    const allActive = state.bot ? "" : " active";
    let html = `<button type="button" class="chip${allActive}" data-bot="">Alle</button>`;
    for (const name of names) {
      const profile = botProfile(name);
      const active = state.bot.toLowerCase() === name.toLowerCase() ? " active" : "";
      html += `<button type="button" class="chip${active}" data-bot="${escapeHtml(name)}" style="--bot:${profile.color}">${iconSvg(profile.icon)}<span>${escapeHtml(name)}</span></button>`;
    }
    el("chips").innerHTML = html;
  }
  function renderHistory() {
    const query = state.query.trim().toLowerCase();
    const filtered = sortResults(state.results).filter((item) => {
      if (!matchBot(item.bot_name, state.bot)) return false;
      if (!query) return true;
      return [item.title, item.summary, item.bot_name, item.category].join(" ").toLowerCase().includes(query);
    });
    renderChips();
    const root = el("history");
    if (!filtered.length) {
      root.innerHTML = `<div class="empty-side">Keine Einträge</div>`;
      el("count").textContent = "0 Einträge";
      return;
    }
    const pinned = filtered.filter((item) => item.pinned);
    const rest = filtered.filter((item) => !item.pinned);
    let html = "";
    const draw = (item) => {
      const profile = botProfile(item.bot_name);
      const active = item.id === state.selectedId ? " active" : "";
      return `<button type="button" class="entry${active}" data-id="${escapeHtml(item.id)}" style="--bot:${profile.color}" aria-current="${active ? "true" : "false"}"><div class="entry-top">${badgeHtml(item.bot_name, false)}<time class="entry-time">${escapeHtml(formatListStamp(item.created_at))}</time></div><div class="entry-title">${escapeHtml(item.title || "")}</div><div class="entry-summary">${escapeHtml(item.summary || "")}</div></button>`;
    };
    if (pinned.length) {
      html += `<div class="group-label">Angepinnt</div>${pinned.map(draw).join("")}`;
    }
    let lastDay = "";
    for (const item of rest) {
      const day = dayLabel(item.created_at);
      if (day !== lastDay) {
        html += `<div class="group-label">${escapeHtml(day)}</div>`;
        lastDay = day;
      }
      html += draw(item);
    }
    root.innerHTML = html;
    el("count").textContent = `${filtered.length} ${filtered.length === 1 ? "Eintrag" : "Einträge"}`;
  }
  async function openResult(id, opts = {}) {
    if (!id) return;
    state.selectedId = id;
    const nextUrl = `/r/${encodeURIComponent(id)}`;
    if (opts.history === "push" && location.pathname !== nextUrl) history.pushState({ id }, "", nextUrl);
    if (opts.history === "replace") history.replaceState({ id }, "", nextUrl);
    renderHistory();
    if (opts.history === "push" && window.matchMedia("(max-width: 860px)").matches) setSidebar(false, false);
    try {
      let item = state.byId.get(id);
      if (!item || item.content_md == null) {
        el("doc").innerHTML = `<p class="muted">Lade Bericht…</p>`;
        const response = await fetch(`/api/results/${encodeURIComponent(id)}`);
        if (!response.ok) {
          renderMissing();
          return;
        }
        item = cacheResult(await response.json());
      }
      renderDoc(item);
      const esc = window.CSS && CSS.escape ? CSS.escape(id) : id;
      const node = document.querySelector(`[data-id="${esc}"]`);
      if (node && node.scrollIntoView) node.scrollIntoView({ block: "nearest" });
      if (opts.history === "push") el("doc-scroll").scrollTop = 0;
    } catch (error) {
      showError("Bericht konnte nicht geladen werden");
    }
  }
  let toastTimer = 0;
  function hideToast() { el("toast").hidden = true; }
  function showToast(item, auto) {
    el("toast-kicker").textContent = auto ? "Neues Ergebnis geöffnet" : "Neues Ergebnis";
    el("toast-title").textContent = item.title || "Bericht";
    el("toast-body").textContent = `${item.bot_name || "Grokbot"} · ${formatListStamp(item.created_at)}`;
    const open = el("toast-open");
    open.hidden = false;
    open.onclick = () => {
      hideToast();
      openResult(item.id, { history: "push" });
    };
    el("toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 7000);
  }
  function showError(message) {
    el("toast-kicker").textContent = "Hinweis";
    el("toast-title").textContent = message;
    el("toast-body").textContent = "";
    el("toast-open").hidden = true;
    el("toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 5200);
  }
  function writeHeaders() {
    const headers = { "content-type": "application/json" };
    if (state.apiKey) headers["x-api-key"] = state.apiKey;
    return headers;
  }
  async function refreshList() {
    const response = await fetch("/api/results?limit=200");
    if (!response.ok) throw new Error("list failed");
    const data = await response.json();
    const items = data.results || [];
    const fresh = state.ready ? items.filter((item) => !state.known.has(item.id)) : [];
    state.results = items;
    for (const item of items) cacheResult(item);
    state.known = new Set(items.map((item) => item.id));
    state.ready = true;
    renderHistory();
    setLive(true);
    if (!fresh.length) return;
    const top = fresh.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    if (state.follow) {
      showToast(top, true);
      await openResult(top.id, { history: "push" });
    } else {
      showToast(top, false);
    }
  }
  async function poll() {
    if (document.hidden || state.polling) return;
    state.polling = true;
    try { await refreshList(); } catch (error) { setLive(false); } finally { state.polling = false; }
  }
  function openComposer() {
    el("composer-form").reset();
    const names = [];
    const seen = new Set();
    for (const item of state.results) {
      if (item.bot_name && !seen.has(item.bot_name)) {
        seen.add(item.bot_name);
        names.push(item.bot_name);
      }
    }
    el("bot-list").innerHTML = names.map((name) => `<option value="${escapeHtml(name)}"></option>`).join("");
    el("composer").showModal();
  }
  function confirmBox(title, text) {
    el("confirm-title").textContent = title;
    el("confirm-text").textContent = text;
    const dialog = el("confirm-dialog");
    dialog.showModal();
    return new Promise((resolve) => {
      const onClose = () => {
        dialog.removeEventListener("close", onClose);
        resolve(dialog.returnValue === "ok");
      };
      dialog.addEventListener("close", onClose);
    });
  }

  applyFont();
  setSidebar(state.sidebar, false);
  el("follow").checked = state.follow;
  el("api-key").value = state.apiKey;
  if (Array.isArray(boot.results)) {
    state.results = boot.results;
    for (const item of boot.results) cacheResult(item);
    if (boot.result) cacheResult(boot.result);
    state.known = new Set(state.results.map((item) => item.id));
    state.ready = true;
  }
  renderHistory();
  setLive(true);
  if (boot.result && boot.result.content_md != null) renderDoc(boot.result);
  else if (boot.missing) renderMissing();
  else if (state.results.length) {
    const newest = newestOf(state.results);
    if (newest) openResult(newest.id, { history: "none" });
  } else renderEmpty("Noch keine Berichte.");

  el("btn-focus").addEventListener("click", () => setSidebar(!state.sidebar, true));
  el("scrim").addEventListener("click", () => setSidebar(false, false));
  el("search").addEventListener("input", () => {
    state.query = el("search").value;
    renderHistory();
  });
  el("chips").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-bot]");
    if (!chip) return;
    state.bot = chip.getAttribute("data-bot") || "";
    renderHistory();
  });
  el("history").addEventListener("click", (event) => {
    const button = event.target.closest("[data-id]");
    if (!button) return;
    openResult(button.getAttribute("data-id"), { history: "push" });
  });
  el("font-down").addEventListener("click", () => { state.font -= 1; applyFont(); });
  el("font-up").addEventListener("click", () => { state.font += 1; applyFont(); });
  el("btn-copy").addEventListener("click", async () => {
    if (!state.selectedId) return;
    const url = `${location.origin}/r/${encodeURIComponent(state.selectedId)}`;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(url);
      else throw new Error("clipboard");
    } catch (error) {
      const area = document.createElement("textarea");
      area.value = url;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    const button = el("btn-copy");
    const previous = button.textContent;
    button.textContent = "Kopiert";
    setTimeout(() => { button.textContent = previous; }, 1400);
  });
  el("btn-download").addEventListener("click", (event) => {
    if (!state.selectedId) event.preventDefault();
  });
  el("btn-pin").addEventListener("click", async () => {
    const item = state.byId.get(state.selectedId);
    if (!item) return;
    const response = await fetch(`/api/results/${encodeURIComponent(item.id)}`, {
      method: "PATCH",
      headers: writeHeaders(),
      body: JSON.stringify({ pinned: !item.pinned }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      showError(data.error || "Konnte nicht anheften");
      return;
    }
    cacheResult(data);
    const index = state.results.findIndex((entry) => entry.id === data.id);
    if (index >= 0) state.results[index] = Object.assign({}, state.results[index], data);
    renderHistory();
    renderDoc(state.byId.get(data.id));
  });
  el("btn-delete").addEventListener("click", async () => {
    const id = state.selectedId;
    if (!id) return;
    const ok = await confirmBox("Eintrag löschen?", "Der Bericht wird dauerhaft aus dem Dashboard entfernt.");
    if (!ok) return;
    const response = await fetch(`/api/results/${encodeURIComponent(id)}`, { method: "DELETE", headers: writeHeaders() });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      showError(data.error || "Löschen fehlgeschlagen");
      return;
    }
    state.results = state.results.filter((item) => item.id !== id);
    state.byId.delete(id);
    state.known.delete(id);
    const newest = newestOf(state.results);
    if (newest) openResult(newest.id, { history: "replace" });
    else {
      state.selectedId = "";
      renderHistory();
      renderEmpty("Keine Einträge");
      history.replaceState({}, "", "/");
    }
  });
  el("btn-new").addEventListener("click", () => openComposer());
  el("composer-close").addEventListener("click", () => el("composer").close());
  el("composer-cancel").addEventListener("click", () => el("composer").close());
  el("c-file").addEventListener("change", async () => {
    const file = el("c-file").files && el("c-file").files[0];
    if (!file) return;
    if (file.size > 500000) {
      showError("Datei ist zu groß");
      return;
    }
    const text = await file.text();
    el("c-md").value = text;
    if (!el("c-title").value.trim()) {
      const heading = extractTitle(text);
      if (heading) el("c-title").value = heading;
    }
  });
  el("composer-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const content = el("c-md").value;
    if (!content.trim()) {
      showError("Markdown fehlt");
      return;
    }
    const payload = { content };
    if (el("c-title").value.trim()) payload.title = el("c-title").value.trim();
    if (el("c-bot").value.trim()) payload.bot_name = el("c-bot").value.trim();
    if (el("c-cat").value.trim()) payload.category = el("c-cat").value.trim();
    const button = el("composer-submit");
    button.disabled = true;
    try {
      const response = await fetch("/api/results", { method: "POST", headers: writeHeaders(), body: JSON.stringify(payload) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        showError(data.error || "Senden fehlgeschlagen");
        return;
      }
      state.known.add(data.id);
      el("composer").close();
      await refreshList();
      await openResult(data.id, { history: "push" });
    } catch (error) {
      showError("Netzwerkfehler");
    } finally {
      button.disabled = false;
    }
  });
  el("follow").addEventListener("change", () => {
    state.follow = el("follow").checked;
    storageSet("gd-follow", state.follow ? "1" : "0");
  });
  el("api-key").addEventListener("change", () => {
    state.apiKey = el("api-key").value.trim();
    storageSet("gd-key", state.apiKey);
  });
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-copy-code]");
    if (!button) return;
    const code = button.closest(".codeblock")?.querySelector("code");
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.textContent || "");
      const previous = button.textContent;
      button.textContent = "Kopiert";
      setTimeout(() => { button.textContent = previous; }, 1400);
    } catch (error) {
      button.textContent = "Kopieren";
    }
  });
  window.addEventListener("popstate", () => {
    const match = location.pathname.match(/^\/r\/([^/]+)$/);
    const queryId = new URLSearchParams(location.search).get("id");
    const id = (history.state && history.state.id) || (match ? decodeURIComponent(match[1]) : queryId || "");
    if (id) openResult(id, { history: "none" });
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") poll();
  });
  window.addEventListener("focus", () => { poll(); });
  setInterval(poll, POLL_MS);
}

const CLIENT_FNS = [
  escapeHtml,
  isWordChar,
  safeUrl,
  imageSrc,
  readLink,
  findMarker,
  findSingleEmphasis,
  linkHtml,
  parseInline,
  sanitizeLang,
  codeBlockHtml,
  splitRow,
  isDelimRow,
  alignAttr,
  parseTable,
  parseQuote,
  lineIndent,
  listMarker,
  dedentLines,
  parseList,
  isHr,
  isBlockStart,
  renderMarkdown,
  botProfile,
  iconSvg,
  berlinParts,
  berlinKey,
  shiftBerlinDays,
  formatFullStamp,
  formatListStamp,
  dayLabel,
  extractTitle,
  badgeHtml,
  appMain,
];

function pageScript() {
  return `${CLIENT_FNS.map((fn) => fn.toString()).join("\n\n")}\nappMain();\n`;
}

function renderPage({ status = 200, title, description, boot, result }) {
  const chrome = readerChrome(result, boot?.missing);
  const js = pageScript().replace(/<\/(script)/gi, "<\\/$1");
  const html = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="dark" />
<meta name="theme-color" content="#090a0f" />
<meta name="description" content="${escapeHtml(description)}" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:type" content="article" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<title>${escapeHtml(title)}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23090a0f'/%3E%3Cpath d='M8 23 L16 8 L24 23' fill='none' stroke='%23d6f25c' stroke-width='2'/%3E%3C/svg%3E" />
<style>${pageCss()}</style>
</head>
<body>
<div id="app">
  <aside id="sidebar" aria-label="Verlauf">
    <div class="brand-row">
      <div class="brand">
        <div class="logo" aria-hidden="true">${iconSvg("spark")}</div>
        <div>
          <h1>Grokbot Dashboard</h1>
          <p>Berichte der Flotte</p>
        </div>
      </div>
      <div id="live" class="live"><span class="dot"></span><span id="live-label">Live</span></div>
    </div>
    <div class="side-tools">
      <button id="btn-new" class="btn btn-primary" type="button">+ Neu</button>
    </div>
    <div class="search-wrap">
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="6"></circle><path d="M16 16l4 4"></path></svg>
      <input id="search" type="search" placeholder="Suche im Verlauf..." autocomplete="off" spellcheck="false" aria-label="Suche im Verlauf" />
    </div>
    <div id="chips" class="chips" role="tablist" aria-label="Bots"></div>
    <nav id="history" class="history" aria-label="Ergebnisse"></nav>
    <footer class="side-foot">
      <label class="follow"><input id="follow" type="checkbox" /><span>Auto-Follow neuester Eintrag</span></label>
      <label class="key-label">API-Schlüssel<input id="api-key" type="password" autocomplete="off" spellcheck="false" placeholder="nur wenn gesetzt" /></label>
      <div class="foot-meta"><span id="count">0 Einträge</span></div>
    </footer>
  </aside>
  <main id="reader">
    <header class="reader-bar">
      <button id="btn-focus" class="btn" type="button" title="Fokus / Vollbild">Vollbild</button>
      <div class="reader-id">
        <div id="bot-slot">${chrome.slot}</div>
        <div class="reader-titles">
          <p id="doc-title" class="doc-title">${escapeHtml(chrome.title)}</p>
          <p id="doc-meta" class="doc-meta">${escapeHtml(chrome.meta)}</p>
        </div>
      </div>
      <div class="reader-actions">
        <button id="font-down" class="btn" type="button" aria-label="Schrift kleiner">A-</button>
        <button id="font-up" class="btn" type="button" aria-label="Schrift größer">A+</button>
        <button id="btn-copy" class="btn" type="button">Link</button>
        <a id="btn-download" class="btn" href="${escapeHtml(chrome.href)}" download="${escapeHtml(chrome.download)}">.md</a>
        <button id="btn-pin" class="btn" type="button" aria-pressed="${result?.pinned ? "true" : "false"}">${escapeHtml(chrome.pin)}</button>
        <button id="btn-delete" class="btn btn-danger" type="button" aria-label="Löschen">Löschen</button>
      </div>
    </header>
    <div id="doc-scroll"><article id="doc" class="markdown">${chrome.article}</article></div>
  </main>
</div>
<div id="scrim" class="scrim"></div>
<div id="toast" class="toast" hidden role="status">
  <div>
    <div id="toast-kicker" class="toast-kicker"></div>
    <strong id="toast-title"></strong>
    <p id="toast-body"></p>
  </div>
  <button id="toast-open" class="btn btn-primary" type="button">Öffnen</button>
</div>
<dialog id="composer">
  <form id="composer-form" class="sheet">
    <div class="sheet-head"><h2>Neues Ergebnis</h2><button id="composer-close" class="btn" type="button">Schließen</button></div>
    <label>Bot<input id="c-bot" list="bot-list" placeholder="Bote · E-Mail-Verwalter" /></label>
    <datalist id="bot-list"></datalist>
    <div class="split">
      <label>Titel<input id="c-title" placeholder="Aus der ersten Überschrift, wenn leer" /></label>
      <label>Kategorie<input id="c-cat" placeholder="general" /></label>
    </div>
    <label class="file-label">Markdown-Datei<input id="c-file" type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" /></label>
    <label>Inhalt<textarea id="c-md" placeholder="Markdown hier einfügen"></textarea></label>
    <div class="sheet-actions"><button id="composer-cancel" class="btn" type="button">Abbrechen</button><button id="composer-submit" class="btn btn-primary" type="submit">Ans Dashboard senden</button></div>
  </form>
</dialog>
<dialog id="confirm-dialog">
  <form method="dialog" class="sheet">
    <h2 id="confirm-title">Eintrag löschen?</h2>
    <p id="confirm-text"></p>
    <div class="sheet-actions"><button class="btn" value="cancel">Abbrechen</button><button class="btn btn-danger" value="ok">Löschen</button></div>
  </form>
</dialog>
<script type="application/json" id="boot-data">${serializeBoot(boot)}</script>
<script>${js}</script>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      ...BASE_HEADERS,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      "x-frame-options": "DENY",
    },
  });
}

async function renderDashboard(request, env, spec) {
  const url = new URL(request.url);
  const origin = url.origin;
  const listRows = await queryResults(env.DB, { limit: 200 });
  const list = listRows.map((row) => present(row, origin, { full: false }));
  let status = 200;
  let row = null;
  let missing = false;
  let selectedId = "";
  const bot = spec.bot || "";

  if (spec.kind === "id") {
    const id = parseRouteId(spec.id);
    selectedId = id || String(spec.id || "");
    if (!id) missing = true;
    else {
      row = await getRow(env.DB, id);
      if (!row) missing = true;
    }
    if (missing) status = 404;
  } else if (spec.kind === "latest") {
    row = await queryLatest(env.DB, bot);
    if (row) selectedId = row.id;
    else missing = true;
  } else {
    const wanted = url.searchParams.get("id");
    if (wanted) {
      const id = parseRouteId(wanted);
      selectedId = id || wanted;
      if (!id) missing = true;
      else {
        row = await getRow(env.DB, id);
        if (!row) missing = true;
      }
      if (missing) status = 404;
    } else {
      row = await queryLatest(env.DB, "");
      if (row) selectedId = row.id;
    }
  }

  const full = row ? present(row, origin, { full: true }) : null;
  const title = full
    ? `${full.title} · ${full.bot_name}`
    : missing
      ? "Eintrag nicht gefunden · Grokbot Dashboard"
      : "Grokbot Dashboard";
  const description = full?.summary || "Ergebnisse der Grokbot-Flotte, lesbar im Tesla-Browser.";
  return renderPage({
    status,
    title,
    description,
    result: full,
    boot: {
      selectedId: selectedId || null,
      bot,
      missing,
      result: full,
      results: list,
    },
  });
}

function methodNotAllowed(allow) {
  return json({ ok: false, error: "Method not allowed" }, 405, { allow: allow.join(", ") });
}

async function dispatch(request, env, method) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const rawPage = path.match(/^\/r\/([^/]+)\.md$/);
  const rawApi = path.match(/^\/api\/results\/([^/]+)\/raw$/);
  const oneApi = path.match(/^\/api\/results\/([^/]+)$/);
  const pageReport = path.match(/^\/r\/([^/]+)$/);

  if (path === "/api/publish" || path === "/api/ingest") {
    if (method === "POST") return createResult(request, env);
    return methodNotAllowed(["POST"]);
  }
  if (path === "/api/results") {
    if (method === "GET") return listResults(request, env);
    if (method === "POST") return createResult(request, env);
    return methodNotAllowed(["GET", "POST"]);
  }
  if (path === "/api/latest") {
    if (method === "GET") return readLatest(request, env);
    return methodNotAllowed(["GET"]);
  }
  if (rawApi) {
    if (method === "GET") return readRaw(request, env, rawApi[1]);
    return methodNotAllowed(["GET"]);
  }
  if (oneApi) {
    if (method === "GET") return readResult(request, env, oneApi[1]);
    if (method === "PATCH" || method === "PUT") return updateResult(request, env, oneApi[1]);
    if (method === "DELETE") return deleteResult(request, env, oneApi[1]);
    return methodNotAllowed(["GET", "PUT", "PATCH", "DELETE"]);
  }
  if (rawPage) {
    if (method === "GET") return readRaw(request, env, rawPage[1]);
    return methodNotAllowed(["GET"]);
  }
  if (pageReport) {
    if (method === "GET") return renderDashboard(request, env, { kind: "id", id: pageReport[1] });
    return methodNotAllowed(["GET"]);
  }
  if (path === "/latest") {
    if (method === "GET") return renderDashboard(request, env, { kind: "latest", bot: url.searchParams.get("bot") || "" });
    return methodNotAllowed(["GET"]);
  }
  if (path === "/") {
    if (method === "GET") return renderDashboard(request, env, { kind: "home" });
    return methodNotAllowed(["GET"]);
  }
  if (path.startsWith("/api/")) return json({ ok: false, error: "Not found" }, 404);
  if (method !== "GET") return methodNotAllowed(["GET"]);
  return renderPage({
    status: 404,
    title: "Nicht gefunden · Grokbot Dashboard",
    description: "Diese Seite gibt es nicht.",
    result: null,
    boot: { selectedId: null, bot: "", missing: true, result: null, results: [] },
  });
}

async function handle(request, env) {
  if (request.method === "OPTIONS") return noContent();
  const head = request.method === "HEAD";
  const method = head ? "GET" : request.method;
  try {
    await ensureReady(env);
    const response = await dispatch(request, env, method);
    if (!head) return response;
    return new Response(null, { status: response.status, headers: response.headers });
  } catch (error) {
    const status = Number(error?.status) || 500;
    const path = new URL(request.url).pathname;
    if (status >= 500) {
      logEvent("error", "request.failed", {
        status,
        path,
        message: error?.message || "unknown",
      });
    }
    const message = error?.expose ? error.publicMessage : "Internal error";
    if (path.startsWith("/api/")) return json({ ok: false, error: message }, status);
    return textResponse(message, status, "text/plain; charset=utf-8");
  }
}

const worker = {
  async fetch(request, env) {
    return handle(request, env);
  },
};

export default worker;

export {
  renderMarkdown,
  extractTitle,
  makeSummary,
  normalizeId,
  generateId,
  formatListStamp,
  formatFullStamp,
  keysMatch,
  botProfile,
  berlinParts,
};
