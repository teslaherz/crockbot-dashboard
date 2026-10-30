import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import worker, {
  berlinParts,
  botProfile,
  botSlug,
  ensureSeen,
  extractTitle,
  formatChatStamp,
  formatFullStamp,
  formatListStamp,
  generateId,
  keysMatch,
  makeSummary,
  messagePreview,
  normalizeId,
  renderMarkdown,
  unreadCount,
} from "../src/index.js";
import { adaptDb, createMockDb, createRawDb } from "./d1-mock.js";

const ORIGIN = "https://crockbot-dashboard.teslaherz.workers.dev";

function envWith(extra = {}) {
  return { DB: createMockDb(), ...extra };
}

async function call(env, path, opts = {}) {
  const headers = new Headers(opts.headers || {});
  let body = opts.body;
  if (
    body &&
    typeof body === "object" &&
    !(body instanceof FormData) &&
    !(body instanceof Blob) &&
    !(body instanceof Uint8Array)
  ) {
    headers.set("content-type", headers.get("content-type") || "application/json");
    body = JSON.stringify(body);
  }
  const method = opts.method || "GET";
  const request = new Request(ORIGIN + path, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : body,
  });
  return worker.fetch(request, env);
}

async function json(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Expected JSON, got ${response.status}: ${text.slice(0, 300)}`);
  }
}

function bootFrom(html) {
  const match = html.match(/<script type="application\/json" id="boot-data">([\s\S]*?)<\/script>/);
  assert.ok(match, "boot payload missing");
  assert.equal(match[1].includes("<"), false);
  return JSON.parse(match[1]);
}

function articleOf(html) {
  const match = html.match(/<article id="doc" class="markdown">([\s\S]*?)<\/article>/);
  assert.ok(match, "article missing");
  return match[1];
}

test("normalizeId, summaries, titles, and Berlin stamps", () => {
  assert.equal(normalizeId("Mein Bericht"), "mein-bericht");
  assert.equal(normalizeId("Bote · Mail"), "bote-mail");
  assert.equal(normalizeId("../etc/passwd"), "etc-passwd");
  assert.equal(normalizeId("---"), "");
  assert.equal(normalizeId(""), "");
  assert.match(generateId(new Date("2026-10-28T15:42:00.000Z")), /^20261028-[abcdefghjkmnpqrstuvwxyz23456789]{6}$/);
  assert.equal(extractTitle("```\n# Not title\n```\n\n# Real title\n"), "Real title");
  assert.equal(extractTitle("no heading"), "");
  const summary = makeSummary("# Titel\n\nDas ist **fett** und `code` plus [ein Link](https://example.com).");
  assert.equal(summary.includes("**"), false);
  assert.equal(summary.includes("#"), false);
  assert.match(summary, /Das ist fett und code plus ein Link/);
  assert.equal(formatFullStamp("2020-01-15T14:05:00.000Z"), "15.01.2020, 15:05 Uhr");
  assert.equal(formatFullStamp("2026-07-01T15:42:00.000Z"), "01.07.2026, 17:42 Uhr");
  assert.match(formatListStamp(new Date().toISOString()), /^Heute, \d{2}:\d{2} Uhr$/);
  const parts = berlinParts(new Date("2026-10-28T15:42:00.000Z"));
  assert.equal(`${parts.y}-${parts.m}-${parts.d} ${parts.hh}:${parts.mm}`, "2026-10-28 16:42");
  assert.equal(botProfile("Bote · E-Mail-Verwalter").icon, "mail");
  assert.equal(botProfile("Elon · Programmierer Smarthome").short, "Elon");
  assert.equal(botProfile("Händler").icon, "tag");
  assert.equal(botSlug("Bote · E-Mail-Verwalter"), "bote-e-mail-verwalter");
  assert.equal(botSlug("Bote · E-Mail-Verwalter"), botSlug("  bote · e-mail-verwalter  "));
  assert.equal(messagePreview("# Titel\n\n**Erste** Zeile\nZweite"), "Titel");
  assert.equal(messagePreview("Nur `code` und [ein Link](https://example.com)"), "Nur code und ein Link");
  assert.equal(formatChatStamp("2026-10-28T15:42:00.000Z"), "Mi");
  assert.equal(formatChatStamp("2026-10-29T12:00:00.000Z"), "Gestern");
  assert.equal(formatChatStamp("2020-01-15T14:05:00.000Z"), "15.01.20");
  assert.match(formatChatStamp(new Date().toISOString()), /^\d{2}:\d{2}$/);
  const seen = ensureSeen(
    [{ slug: "bote", last_at: "2026-10-30T10:00:00.000Z", count: 2 }],
    {},
    false,
  );
  assert.equal(seen.ready, true);
  assert.equal(unreadCount({ slug: "bote", last_at: "2026-10-30T10:00:00.000Z", count: 2 }, seen.seen, true), 0);
  assert.equal(
    unreadCount({ slug: "bote", last_at: "2026-10-30T11:00:00.000Z", count: 4 }, seen.seen, true),
    2,
  );
  assert.equal(unreadCount({ slug: "neu", last_at: "2026-10-30T11:00:00.000Z", count: 3 }, seen.seen, true), 3);
});

test("keysMatch hashes both sides and ignores length", async () => {
  assert.equal(await keysMatch("secret", "secret"), true);
  assert.equal(await keysMatch("secret", "secret2"), false);
  assert.equal(await keysMatch("a", "secret-value-much-longer"), false);
});

test("markdown renderer is rich and XSS-safe", () => {
  const html = renderMarkdown(`# Titel

**fett** und *kursiv* und ~~weg~~ und \`code\`

***beides***

bot_name bleibt Text

- [x] erledigt
- [ ] offen
  - verschachtelt

1. Erstens
2. Zweitens

> [!WARNING]
> Bitte prüfen

| Name | Zahl |
| :--- | ---: |
| Bote | 3 |

---

[sicher](https://example.com/a)
[böse](javascript:alert(1))

![ok](https://example.com/a.png)
![nein](javascript:alert(1))

<script>alert(1)</script>

\`\`\`js
<script>alert(1)</script>
\`\`\`
`);
  assert.match(html, /<h1>Titel<\/h1>/);
  assert.match(html, /<strong>fett<\/strong>/);
  assert.match(html, /<em>kursiv<\/em>/);
  assert.match(html, /<del>weg<\/del>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<strong><em>beides<\/em><\/strong>/);
  assert.match(html, /bot_name bleibt Text/);
  assert.equal(html.includes("<em>name</em>"), false);
  assert.match(html, /<ul class="tasks">/);
  assert.match(html, /<input type="checkbox" disabled tabindex="-1" checked/);
  assert.match(html, /<input type="checkbox" disabled tabindex="-1" \/>/);
  assert.match(html, /verschachtelt/);
  assert.match(html, /<ol>/);
  assert.match(html, /class="callout callout-warning"/);
  assert.match(html, /Warnung/);
  assert.match(html, /<th style="text-align:left">Name<\/th>/);
  assert.match(html, /<td style="text-align:right">3<\/td>/);
  assert.match(html, /<hr \/>/);
  assert.match(html, /href="https:\/\/example.com\/a"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.equal(html.includes("javascript:"), false);
  assert.match(html, /src="https:\/\/example.com\/a.png"/);
  assert.match(html, /<span class="code-lang">js<\/span>/);
  assert.match(html, /data-copy-code/);
  assert.match(html, /Kopieren/);
  assert.equal(/<script/i.test(html), false);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(renderMarkdown("###### Klein"), /<h6>Klein<\/h6>/);
  assert.match(renderMarkdown("> [!NOTE]\n> Hinweis"), /callout-note/);
  assert.match(renderMarkdown("> [!TIP]\n> Tipp"), /Tipp/);
  assert.match(renderMarkdown("> [!IMPORTANT]\n> Wichtig"), /Wichtig/);
  assert.match(renderMarkdown("> [!CAUTION]\n> Vorsicht"), /Vorsicht/);
  assert.match(renderMarkdown("> [!DANGER]\n> Gefahr"), /Gefahr/);
});

test("empty database seeds the welcome report and renders the chat office", async () => {
  const env = envWith();
  const page = await call(env, "/");
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<title>Grokbot Dashboard<\/title>/);
  assert.match(html, /class="office route-home"/);
  assert.match(html, /Bots suchen/);
  assert.match(html, /Nur lesen/);
  assert.match(html, /aria-label="Schrift kleiner"/);
  assert.match(html, /aria-label="Schrift größer"/);
  assert.match(html, /class="avatar/);
  assert.match(html, /Elon/);
  assert.match(html, /Programmierer Smarthome/);
  assert.match(html, /<h1>Willkommen im Grokbot Dashboard<\/h1>/);
  assert.match(html, /max-width:\s*860px/);
  assert.match(html, /route-home #thread/);
  assert.match(html, /route-chat #sidebar/);
  const boot = bootFrom(html);
  assert.equal(boot.mode, "office");
  assert.equal(boot.explicit, false);
  assert.equal(boot.selectedSlug, "elon-programmierer-smarthome");
  assert.equal(boot.bots.length, 1);
  assert.equal(boot.bots[0].display_name, "Elon · Programmierer Smarthome");
  assert.equal(boot.bots[0].count, 1);
  assert.equal(boot.messages[0].id, "willkommen");
  assert.equal(boot.messages[0].content_md.includes("POST /api/results"), true);

  const reader = await call(env, "/r/willkommen");
  assert.equal(reader.status, 200);
  const readerHtml = await reader.text();
  assert.match(readerHtml, /<title>Willkommen im Grokbot Dashboard · Elon · Programmierer Smarthome<\/title>/);
  assert.match(readerHtml, /property="og:title"/);
  assert.match(readerHtml, /Suche im Verlauf\.\.\./);
  assert.match(readerHtml, /\+ Neu/);
  assert.match(readerHtml, /Auto-Follow neuester Eintrag/);
  assert.match(readerHtml, /Vollbild/);
  assert.match(readerHtml, /Fokus \/ Vollbild/);
  assert.match(readerHtml, />Chat</);
  const article = articleOf(readerHtml);
  assert.match(article, /<table>/);
  assert.match(article, /E-Mail-Verwalter/);
  assert.match(article, /Hey Grok, Bote soll mir eine Übersicht/);
  assert.match(article, /POST \/api\/results/);
  assert.match(article, /callout-note/);
  assert.match(article, /class="tasks"/);
  const readerBoot = bootFrom(readerHtml);
  assert.equal(readerBoot.result.id, "willkommen");
  assert.equal(readerBoot.result.bot_name, "Elon · Programmierer Smarthome");
  assert.equal(readerBoot.result.bot_slug, "elon-programmierer-smarthome");
  assert.equal(readerBoot.result.pinned, true);
  assert.equal(readerBoot.results[0].id, "willkommen");
  assert.equal(readerBoot.results[0].content_md, undefined);

  const again = await json(await call(env, "/api/results"));
  assert.equal(again.results.length, 1);
  assert.equal(again.results[0].bot_slug, "elon-programmierer-smarthome");

  const script = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)[1];
  new Function(script);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(
    `${script.replace(/officeMain\(\);\s*$/, "")}\nglobalThis.__render = renderMarkdown;\nglobalThis.__unread = unreadCount;`,
    sandbox,
  );
  assert.match(sandbox.__render("**x**"), /<strong>x<\/strong>/);
  assert.equal(sandbox.__unread({ slug: "a", count: 3, last_at: "2026-10-30T12:00:00.000Z" }, { a: { at: "2026-10-30T11:00:00.000Z", count: 1 } }, true), 2);
  assert.match(script, /POLL_MS = 8000/);
  assert.match(script, /Europe\/Berlin/);
  assert.match(script, /gd-seen/);

  const readerScript = readerHtml.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)[1];
  new Function(readerScript);
  assert.match(readerScript, /appMain\(\);/);
});

test("JSON, raw markdown, and multipart ingestion", async () => {
  const env = envWith();
  await call(env, "/");
  const created = await call(env, "/api/publish", {
    method: "POST",
    body: {
      markdown: "# E-Mail-Übersicht\n\nDrei **neue** Nachrichten von <script>.",
      author: "Bote · E-Mail-Verwalter",
      tag: "email",
      pinned: false,
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("access-control-allow-origin"), "*");
  const body = await json(created);
  assert.equal(body.ok, true);
  assert.equal(body.title, "E-Mail-Übersicht");
  assert.equal(body.bot_name, "Bote · E-Mail-Verwalter");
  assert.match(body.summary, /Drei neue Nachrichten/);
  assert.match(body.id, /^\d{8}-[abcdefghjkmnpqrstuvwxyz23456789]{6}$/);
  assert.equal(body.url, `${ORIGIN}/r/${body.id}`);
  assert.equal(body.dashboard_url, `${ORIGIN}/?id=${body.id}`);
  assert.equal(body.raw_url, `${ORIGIN}/api/results/${body.id}/raw`);
  assert.equal(created.headers.get("location"), body.url);

  const raw = await call(env, "/api/ingest?bot=Planer%20%C2%B7%20Kalenderplaner", {
    method: "POST",
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "x-title": "Wochenplan",
      "x-category": "kalender",
    },
    body: "# Überschrift im Text\n\nMontag frei.",
  });
  const rawBody = await json(raw);
  assert.equal(raw.status, 201);
  assert.equal(rawBody.title, "Wochenplan");
  assert.equal(rawBody.bot_name, "Planer · Kalenderplaner");

  const plain = await call(env, "/api/results?title=Nur%20Text&bot=Chef%20%C2%B7%20Admin", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "Ohne Überschrift, aber mit Inhalt.",
  });
  const plainBody = await json(plain);
  assert.equal(plainBody.title, "Nur Text");
  assert.equal(plainBody.bot_name, "Chef · Admin");

  const headed = await call(env, "/api/results", {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-bot-name": "Tutor · Studiumsassistent" },
    body: "# Lernplan\n\nKapitel 1.",
  });
  assert.equal((await json(headed)).title, "Lernplan");

  const form = new FormData();
  form.set("file", new Blob(["# Druckstatus\n\nWarteschlange leer."], { type: "text/markdown" }), "druck_status.md");
  form.set("bot", "Druckmanager");
  form.set("category", "druck");
  const uploaded = await call(env, "/api/publish", { method: "POST", body: form });
  const uploadedBody = await json(uploaded);
  assert.equal(uploaded.status, 201);
  assert.equal(uploadedBody.title, "Druckstatus");
  assert.equal(uploadedBody.bot_name, "Druckmanager");

  const named = await call(env, "/api/results", {
    method: "POST",
    body: { id: "Mein Bericht", content: "Hallo Flotte", bot: "Journalist" },
  });
  const namedBody = await json(named);
  assert.equal(namedBody.id, "mein-bericht");

  const duplicate = await call(env, "/api/ingest", {
    method: "POST",
    body: { id: "mein-bericht", text: "Noch einmal" },
  });
  assert.equal(duplicate.status, 409);

  const badId = await call(env, "/api/results", {
    method: "POST",
    body: { id: "---", content: "x" },
  });
  assert.equal(badId.status, 400);

  const empty = await call(env, "/api/results", { method: "POST", body: { title: "Leer" } });
  assert.equal(empty.status, 400);

  const invalid = await call(env, "/api/results", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal(invalid.status, 400);
});

test("list filters, latest, raw, patch, delete, and dashboard routes", async () => {
  const env = envWith();
  const created = await json(await call(env, "/api/results", {
    method: "POST",
    body: {
      id: "bote-mails",
      title: "Posteingang",
      bot_name: "Bote · E-Mail-Verwalter",
      category: "email",
      content: "# Posteingang\n\nGeheimwort Kürbis steht nur im Text.",
    },
  }));
  assert.equal(created.id, "bote-mails");

  const list = await json(await call(env, "/api/results"));
  assert.equal(list.results[0].id, "willkommen");
  assert.equal(list.results[0].content_md, undefined);
  assert.equal(list.results[1].id, "bote-mails");
  assert.ok(list.results[1].url.endsWith("/r/bote-mails"));

  const full = await json(await call(env, "/api/results?full=1&limit=1"));
  assert.equal(full.results.length, 1);
  assert.match(full.results[0].content_md, /Willkommen/);

  const byBot = await json(await call(env, "/api/results?bot=Bote"));
  assert.deepEqual(byBot.results.map((item) => item.id), ["bote-mails"]);
  const byCategory = await json(await call(env, "/api/results?category=email"));
  assert.equal(byCategory.results.length, 1);
  const found = await json(await call(env, "/api/results?q=" + encodeURIComponent("Kürbis")));
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].id, "bote-mails");
  const injected = await json(await call(env, "/api/results?q=" + encodeURIComponent("%' OR '1'='1")));
  assert.equal(injected.results.length, 0);

  const one = await json(await call(env, "/api/results/bote-mails"));
  assert.match(one.content_md, /Kürbis/);
  const raw = await call(env, "/api/results/bote-mails/raw");
  assert.match(raw.headers.get("content-type"), /^text\/markdown/);
  assert.match(await raw.text(), /Geheimwort Kürbis/);
  const rawPage = await call(env, "/r/bote-mails.md");
  assert.match(await rawPage.text(), /Geheimwort Kürbis/);

  const latest = await json(await call(env, "/api/latest"));
  assert.equal(latest.id, "bote-mails");
  const latestBot = await json(await call(env, "/api/latest?bot=Elon"));
  assert.equal(latestBot.id, "willkommen");

  const home = await call(env, "/");
  assert.equal(home.status, 200);
  const homeHtml = await home.text();
  const homeBoot = bootFrom(homeHtml);
  assert.equal(homeBoot.selectedSlug, "bote-e-mail-verwalter");
  assert.equal(homeBoot.explicit, false);
  assert.match(homeHtml, /Geheimwort Kürbis/);
  const pinnedView = await call(env, "/?id=willkommen");
  assert.equal(bootFrom(await pinnedView.text()).selectedId, "willkommen");
  const direct = await call(env, "/r/bote-mails");
  const directHtml = await direct.text();
  assert.match(directHtml, /<title>Posteingang · Bote · E-Mail-Verwalter<\/title>/);
  assert.match(articleOf(directHtml), /Geheimwort Kürbis/);
  assert.equal(/<script/i.test(articleOf(directHtml)), false);
  const latestHtml = await (await call(env, "/latest?bot=Elon")).text();
  const latestBoot = bootFrom(latestHtml);
  assert.equal(latestBoot.result.id, "willkommen");
  assert.equal(latestBoot.bot, "Elon");

  const patched = await call(env, "/api/results/bote-mails", {
    method: "PATCH",
    body: { title: "Posteingang heute", pinned: true, bot: "Bote · E-Mail-Verwalter" },
  });
  const patchedBody = await json(patched);
  assert.equal(patched.status, 200);
  assert.equal(patchedBody.title, "Posteingang heute");
  assert.equal(patchedBody.pinned, true);
  assert.match(patchedBody.content_md, /Kürbis/);

  const replaced = await call(env, "/api/results/bote-mails", {
    method: "PUT",
    body: { content: "# Neu\n\nErsetzt." },
  });
  assert.match((await json(replaced)).summary, /Ersetzt/);

  const removed = await call(env, "/api/results/bote-mails", { method: "DELETE" });
  assert.equal((await json(removed)).ok, true);
  assert.equal((await call(env, "/api/results/bote-mails")).status, 404);
  const missingPage = await call(env, "/r/bote-mails");
  assert.equal(missingPage.status, 404);
  assert.match(await missingPage.text(), /Eintrag nicht gefunden/);
});

test("API key protects writes only, and CORS preflight stays open", async () => {
  const open = envWith();
  assert.equal((await call(open, "/api/results", { method: "POST", body: { content: "Offen" } })).status, 201);

  const locked = envWith({ DASHBOARD_API_KEY: "top-secret" });
  const denied = await call(locked, "/api/results", { method: "POST", body: { content: "Nein", title: "Geheim" } });
  assert.equal(denied.status, 401);
  assert.equal((await denied.text()).includes("top-secret"), false);
  assert.equal((await call(locked, "/api/results?key=wrong", { method: "POST", body: { content: "Nein" } })).status, 401);

  const bearer = await call(locked, "/api/publish", {
    method: "POST",
    headers: { authorization: "Bearer top-secret" },
    body: { content: "# Per Bearer\n\nOk", bot_name: "Astronaut" },
  });
  assert.equal(bearer.status, 201);
  const headerKey = await call(locked, "/api/ingest", {
    method: "POST",
    headers: { "x-api-key": "top-secret" },
    body: { text: "Per Header" },
  });
  assert.equal(headerKey.status, 201);
  const queryKey = await call(locked, "/api/results?key=top-secret", {
    method: "POST",
    body: { body: "Per Query" },
  });
  assert.equal(queryKey.status, 201);

  const readable = await call(locked, "/api/results");
  assert.equal(readable.status, 200);
  const patchDenied = await call(locked, "/api/results/willkommen", { method: "PATCH", body: { title: "Hack" } });
  assert.equal(patchDenied.status, 401);
  const deleteDenied = await call(locked, "/api/results/willkommen", { method: "DELETE" });
  assert.equal(deleteDenied.status, 401);

  const preflight = await call({}, "/api/results", { method: "OPTIONS" });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("access-control-allow-methods"), /POST/);
  assert.match(preflight.headers.get("access-control-allow-methods"), /DELETE/);
  assert.match(preflight.headers.get("access-control-allow-headers"), /X-API-Key/);

  const head = await call(open, "/api/results", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("chat API stores messages, lists bots, and paginates history", async () => {
  const env = envWith();
  const user = await call(env, "/api/messages", {
    method: "POST",
    body: {
      bot_name: "Bote · E-Mail-Verwalter",
      role: "user",
      content: "Fasse die letzten Mails zusammen.",
      task: "posteingang",
    },
  });
  assert.equal(user.status, 201);
  const userBody = await json(user);
  assert.equal(userBody.role, "user");
  assert.equal(userBody.bot_slug, "bote-e-mail-verwalter");
  assert.equal(userBody.chat_url, `${ORIGIN}/bot/bote-e-mail-verwalter`);
  assert.equal(userBody.dashboard_url, `${ORIGIN}/?bot=bote-e-mail-verwalter`);
  assert.equal(user.headers.get("location"), userBody.chat_url);

  const bot = await call(env, "/api/bots/bote/messages", {
    method: "POST",
    headers: { "x-bot-name": "Bote · E-Mail-Verwalter", "x-category": "email" },
    body: {
      title: "Posteingang",
      content: "# Posteingang\n\nDrei **neue** Mails.",
      meta: { source: "gmail", n: 3 },
    },
  });
  assert.equal(bot.status, 201);
  const botBody = await json(bot);
  assert.equal(botBody.bot_slug, "bote-e-mail-verwalter");
  assert.equal(botBody.title, "Posteingang");

  const raw = await call(env, "/api/bots/Planer%20%C2%B7%20Kalenderplaner/messages", {
    method: "POST",
    headers: { "content-type": "text/markdown", "x-title": "Morgen", "x-role": "bot" },
    body: "# Morgen\n\nStandup um neun.",
  });
  assert.equal(raw.status, 201);
  assert.equal((await json(raw)).bot_slug, "planer-kalenderplaner");

  const mismatch = await call(env, "/api/bots/elon-programmierer-smarthome/messages", {
    method: "POST",
    body: { bot_name: "Bote · E-Mail-Verwalter", content: "Falscher Bot" },
  });
  assert.equal(mismatch.status, 400);

  const missingName = await call(env, "/api/messages", { method: "POST", body: { content: "Ohne Namen" } });
  assert.equal(missingName.status, 400);

  const badRole = await call(env, "/api/messages", {
    method: "POST",
    body: { bot_name: "Bote · E-Mail-Verwalter", content: "x", role: "system" },
  });
  assert.equal(badRole.status, 400);

  const bots = await json(await call(env, "/api/bots"));
  const slugs = bots.bots.map((item) => item.slug);
  assert.equal(slugs[0], "planer-kalenderplaner");
  const bote = bots.bots.find((item) => item.slug === "bote-e-mail-verwalter");
  assert.equal(bote.count, 2);
  assert.equal(bote.display_name, "Bote · E-Mail-Verwalter");
  assert.equal(bote.last_message.preview, "Posteingang");
  assert.equal(bote.last_message.role, "bot");
  assert.equal(bote.color, "#5b8cff");

  const filtered = await json(await call(env, "/api/bots?q=plan"));
  assert.deepEqual(filtered.bots.map((item) => item.slug), ["planer-kalenderplaner"]);

  const history = await json(await call(env, "/api/bots/bote-e-mail-verwalter/messages?limit=1"));
  assert.equal(history.messages.length, 1);
  assert.equal(history.messages[0].id, botBody.id);
  assert.equal(history.has_more, true);
  assert.equal(history.bot.slug, "bote-e-mail-verwalter");
  assert.deepEqual(history.messages[0].meta, { source: "gmail", n: 3 });
  const older = await json(await call(
    env,
    `/api/bots/Bote/messages?limit=1&before=${encodeURIComponent(history.next_before)}&before_id=${encodeURIComponent(history.next_before_id)}`,
  ));
  assert.equal(older.messages.length, 1);
  assert.equal(older.messages[0].id, userBody.id);
  assert.equal(older.messages[0].role, "user");
  assert.equal(older.has_more, false);

  const viaResults = await json(await call(env, "/api/results?bot=Bote"));
  assert.equal(viaResults.results.length, 2);

  const office = await call(env, "/bot/bote-e-mail-verwalter");
  assert.equal(office.status, 200);
  const officeHtml = await office.text();
  assert.match(officeHtml, /class="office route-chat"/);
  assert.match(officeHtml, /Zurück/);
  assert.match(officeHtml, /class="bubble role-user"/);
  assert.match(officeHtml, /class="bubble role-bot"/);
  assert.match(officeHtml, /<strong>neue<\/strong>/);
  assert.match(officeHtml, new RegExp(`href="/r/${botBody.id}"`));
  assert.equal(bootFrom(officeHtml).explicit, true);

  const queryLink = await call(env, "/?bot=Elon");
  assert.equal(queryLink.status, 200);
  const queryHtml = await queryLink.text();
  assert.equal(bootFrom(queryHtml).selectedSlug, "elon-programmierer-smarthome");
  assert.match(queryHtml, /class="office route-chat"/);

  const short = await call(env, "/bot/planer");
  assert.equal(short.status, 200);
  assert.equal(bootFrom(await short.text()).selectedSlug, "planer-kalenderplaner");

  const missingBot = await call(env, "/bot/nicht-da");
  assert.equal(missingBot.status, 404);
  assert.match(await missingBot.text(), /Dieser Bot ist nicht im Dashboard/);
  assert.equal((await call(env, "/api/bots/nicht-da/messages")).status, 404);

  const badCursor = await call(env, "/api/bots/bote/messages?before=gestern");
  assert.equal(badCursor.status, 400);
});

test("bot registry keeps a custom name and avatar", async () => {
  const env = envWith();
  await call(env, "/api/results", {
    method: "POST",
    body: { bot_name: "Bote · E-Mail-Verwalter", content: "# Alt\n\nVorher." },
  });
  const created = await call(env, "/api/bots/bote-e-mail-verwalter", {
    method: "PUT",
    body: {
      display_name: "Bote",
      emoji: "✉️",
      color: "#112233",
      description: "Posteingang",
    },
  });
  assert.equal(created.status, 200);
  const createdBody = await json(created);
  assert.equal(createdBody.bot.display_name, "Bote");
  assert.equal(createdBody.bot.emoji, "✉️");
  assert.equal(createdBody.bot.color, "#112233");
  assert.equal(createdBody.bot.description, "Posteingang");

  await call(env, "/api/messages", {
    method: "POST",
    body: { bot_name: "Bote · E-Mail-Verwalter", content: "Nach dem Umbenennen." },
  });
  const again = await json(await call(env, "/api/bots/bote"));
  assert.equal(again.bot.display_name, "Bote");
  assert.equal(again.bot.emoji, "✉️");
  assert.equal(again.bot.count, 2);

  const fresh = await call(env, "/api/bots/reiseleiter", {
    method: "PUT",
    body: { display_name: "Reiseleiter", color: "red" },
  });
  assert.equal(fresh.status, 400);
  const okFresh = await call(env, "/api/bots/reiseleiter", {
    method: "PUT",
    body: { display_name: "Reiseleiter", description: "Unterwegs" },
  });
  assert.equal(okFresh.status, 201);
  const listed = await json(await call(env, "/api/bots"));
  const trip = listed.bots.find((item) => item.slug === "reiseleiter");
  assert.equal(trip.display_name, "Reiseleiter");
  assert.equal(trip.count, 0);
  assert.equal(trip.last_message, null);

  const twinA = await call(env, "/api/messages", {
    method: "POST",
    body: { bot_name: "Bote · Alpha", content: "A" },
  });
  assert.equal(twinA.status, 201);
  await call(env, "/api/messages", {
    method: "POST",
    body: { bot_name: "Bote · Beta", content: "B" },
  });
  const ambiguous = await call(env, "/api/bots/bote/messages");
  assert.equal(ambiguous.status, 409);
  const exact = await json(await call(env, "/api/bots/bote-alpha/messages"));
  assert.equal(exact.messages.length, 1);
});

test("writes stay open unless DASHBOARD_API_KEY is set", async () => {
  const locked = envWith({ DASHBOARD_API_KEY: "top-secret" });
  assert.equal((await call(locked, "/api/messages", { method: "POST", body: { bot_name: "Chef", content: "Nein" } })).status, 401);
  assert.equal((await call(locked, "/api/bots/chef", { method: "PUT", body: { display_name: "Chef" } })).status, 401);
  const allowed = await call(locked, "/api/bots/chef/messages", {
    method: "POST",
    headers: { authorization: "Bearer top-secret" },
    body: { bot_name: "Chef · Admin", content: "# Freigabe\n\nOk." },
  });
  assert.equal(allowed.status, 201);
  assert.equal((await call(locked, "/api/bots")).status, 200);
  const preflight = await call(locked, "/api/messages", { method: "OPTIONS" });
  assert.match(preflight.headers.get("access-control-allow-headers"), /X-Role/);
});

test("legacy results migrate into bot histories without exec()", async () => {
  const raw = createRawDb();
  raw.exec(`CREATE TABLE results (
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
  )`);
  raw.prepare(`INSERT INTO results (
    id, title, bot_name, bot_id, category, summary, content_md, pinned, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "alt-bericht",
    "Alter Bericht",
    "Bote · E-Mail-Verwalter",
    "",
    "email",
    "Kurz",
    "# Alter Bericht\n\nSchon da.",
    0,
    "2026-10-01T10:00:00.000Z",
    "2026-10-01T10:00:00.000Z",
  );
  let execCalls = 0;
  const firstEnv = {
    DB: adaptDb(raw),
  };
  firstEnv.DB.exec = async () => {
    execCalls += 1;
    throw new Error("exec should not be used");
  };
  const bots = await json(await call(firstEnv, "/api/bots"));
  assert.equal(execCalls, 0);
  assert.equal(bots.bots.length, 1);
  assert.equal(bots.bots[0].slug, "bote-e-mail-verwalter");
  assert.equal(bots.bots[0].count, 1);
  assert.equal(bots.bots[0].last_message.id, "alt-bericht");
  const page = await call(firstEnv, "/r/alt-bericht");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Schon da/);

  const second = { DB: adaptDb(raw) };
  second.DB.exec = async () => {
    execCalls += 1;
    throw new Error("exec should not be used");
  };
  const again = await json(await call(second, "/api/bots"));
  assert.equal(execCalls, 0);
  assert.equal(again.bots.length, 1);
  assert.equal(again.bots[0].count, 1);
  const columns = raw.prepare("PRAGMA table_info(results)").all().map((row) => row.name);
  for (const name of ["role", "task", "meta", "bot_slug"]) assert.equal(columns.includes(name), true);
});

test("bot names are escaped in the office shell", async () => {
  const env = envWith();
  await call(env, "/api/messages", {
    method: "POST",
    body: { bot_name: "Bote <script>", content: "Hallo <script>alert(1)</script>" },
  });
  const html = await (await call(env, "/")).text();
  assert.equal(/<script>alert/i.test(html), false);
  assert.match(html, /Bote &lt;script&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  const boot = bootFrom(html);
  assert.equal(boot.bots[0].display_name, "Bote <script>");
});

test("unknown API routes and unsupported media types fail clearly", async () => {
  const env = envWith();
  assert.equal((await call(env, "/api/missing")).status, 404);
  const weird = await call(env, "/api/results", {
    method: "POST",
    headers: { "content-type": "application/xml" },
    body: "<note>nope</note>",
  });
  assert.equal(weird.status, 415);
  const method = await call(env, "/api/latest", { method: "POST", body: { content: "x" } });
  assert.equal(method.status, 405);
});
