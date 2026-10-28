# Grokbot Dashboard

Cloudflare Worker that stores Markdown reports from René's Grokbot fleet and renders them in a Grok-style split view. A bot posts a `.md` result, the API returns a direct URL, and Grok opens that URL in the Tesla browser.

Production: `https://crockbot-dashboard.teslaherz.workers.dev`

## Tesla workflow

1. In the car: *„Hey Grok, Bote soll mir eine Übersicht über meine letzten Emails erstellen und ans Dashboard schicken.“*
2. The bot (`Bote`, `Elon`, `Chef`, `Planer`, or any other) writes Markdown and `POST`s it here.
3. The response contains `url` (`/r/<id>`), `dashboard_url` (`/?id=<id>`), and `raw_url`.
4. Grok opens `url` in the Tesla browser. The home page shows the newest report, with history on the left and the rendered document on the right.

The reader has large touch targets, `A-` / `A+` font controls, a **Vollbild** toggle (collapses the sidebar), and polls `/api/results` every 8 seconds. **Auto-Follow neuester Eintrag** switches to a report as soon as a bot delivers it. Times are `Europe/Berlin`.

## Deploy

No build step. `src/index.js` is vanilla JavaScript and can be published with Wrangler or uploaded as a single Worker module.

```bash
npx wrangler deploy
```

The existing D1 database is bound as `DB`:

| | |
| --- | --- |
| binding | `DB` |
| database_name | `crockbot-dashboard-db` |
| database_id | `dea82dd4-2cbd-4438-a3d5-e2b68cf93255` |

On the first request the Worker runs `CREATE TABLE IF NOT EXISTS results (...)` (see `schema.sql`) and, if the table is empty, inserts a pinned welcome report from **Elon · Programmierer Smarthome**.

Local UI, using a simulated D1 database (not the production database):

```bash
npx wrangler dev
```

`wrangler dev --remote` reads and writes the production D1 database.

### Optional write key

Reads stay open so the Tesla browser can open a report with no login. To require a key on `POST`, `PUT`, `PATCH`, and `DELETE`:

```bash
npx wrangler secret put DASHBOARD_API_KEY
```

Send it as `Authorization: Bearer <key>`, `X-API-Key: <key>`, or `?key=<key>`. If the secret is unset, writes are accepted without a key. The dashboard can store a key in the sidebar field **API-Schlüssel** (browser `localStorage` only) for pin, delete, and manual upload.

Reports are world-readable at the Worker URL. Put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/) in front of the hostname if a report should not be public.

## API

CORS: `Access-Control-Allow-Origin: *` and methods `GET, POST, PUT, PATCH, DELETE, OPTIONS`.

### Create a report

`POST /api/results`, `POST /api/publish`, and `POST /api/ingest` accept the same body.

**JSON** (`Content-Type: application/json`):

| Field | Required | Notes |
| --- | --- | --- |
| `content`, `markdown`, `content_md`, `body`, or `text` | yes | Markdown |
| `title` | no | Otherwise the first `# Heading`, otherwise `Ergebnis vom <date>` |
| `bot_name`, `bot`, or `author` | no | Default `Grokbot` |
| `bot_id` | no | |
| `category` or `tag` | no | Default `general` |
| `summary` | no | Plain-text excerpt when omitted |
| `id` | no | Slug. Generated as `20261028-xxxxxx` (Berlin date) when omitted |
| `pinned` | no | Boolean |

```bash
curl -X POST "https://crockbot-dashboard.teslaherz.workers.dev/api/results" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "E-Mail-Übersicht",
    "bot_name": "Bote · E-Mail-Verwalter",
    "category": "email",
    "content": "# E-Mail-Übersicht\n\nDrei neue Nachrichten."
  }'
```

**Raw Markdown** (`text/markdown`, `text/plain`, or `application/octet-stream`). `curl --data-binary` without a content type is also treated as raw Markdown. Title, bot, category, and id can come from the query string or from `X-Title`, `X-Bot-Name`, `X-Bot-Id`, and `X-Category`.

```bash
curl -X POST "https://crockbot-dashboard.teslaherz.workers.dev/api/ingest?bot=Bote%20·%20E-Mail-Verwalter" \
  -H "Content-Type: text/markdown" \
  --data-binary @bericht.md
```

**Multipart** file field `file`, `md`, `markdown`, or `document`, plus optional `title`, `bot` / `bot_name`, and `category`:

```bash
curl -X POST "https://crockbot-dashboard.teslaherz.workers.dev/api/publish" \
  -F "file=@bericht.md" \
  -F "bot=Bote · E-Mail-Verwalter"
```

`201 Created`:

```json
{
  "ok": true,
  "id": "20261028-k3m9qx",
  "title": "E-Mail-Übersicht",
  "bot_name": "Bote · E-Mail-Verwalter",
  "summary": "Drei neue Nachrichten.",
  "created_at": "2026-10-28T15:42:00.000Z",
  "url": "https://crockbot-dashboard.teslaherz.workers.dev/r/20261028-k3m9qx",
  "dashboard_url": "https://crockbot-dashboard.teslaherz.workers.dev/?id=20261028-k3m9qx",
  "raw_url": "https://crockbot-dashboard.teslaherz.workers.dev/api/results/20261028-k3m9qx/raw"
}
```

### Read

| Request | Result |
| --- | --- |
| `GET /api/results` | Metadata, newest pinned first (`pinned DESC, created_at DESC`). Filters: `bot`, `category`, `q`, `limit` (max 500). `full=1` includes `content_md`. |
| `GET /api/results/:id` | One report, including `content_md`. |
| `GET /api/results/:id/raw` and `GET /r/:id.md` | `text/markdown` |
| `GET /api/latest` | Newest report. Optional `?bot=`. |
| `GET /` | Dashboard. `?id=` selects that report; otherwise the newest. |
| `GET /r/:id` | Dashboard with that report selected. `<title>` and Open Graph use the report title and bot name. |
| `GET /latest` | Dashboard with the newest report. Optional `?bot=`. |

`bot=Bote` matches `Bote` and `Bote · E-Mail-Verwalter`. `q` searches title, summary, bot, category, and Markdown.

### Update and delete

`PATCH` or `PUT /api/results/:id` with JSON. Any of `title`, `content_md` (aliases `content`, `markdown`, `body`, `text`), `bot_name` (aliases `bot`, `author`), `category` (alias `tag`), `pinned`, `summary`. Changing the Markdown regenerates the summary unless `summary` is sent too.

`DELETE /api/results/:id` removes the row. `{ "ok": true, "id": "<id>" }`.

## Pages

- **Verlauf:** search, bot chips (Alle, Bote, Elon, Chef, Planer, …), pinned group, then days. Each row shows the bot badge, title, one-line summary, and a Berlin timestamp such as `Heute, 17:42 Uhr`.
- **Reader:** headings, emphasis, inline code, fenced code with **Kopieren**, tables, task lists, bullet and numbered lists, callouts (`[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`, `[!DANGER]`), links, images, and rules. HTML in the Markdown is escaped.
- **+ Neu** composes or uploads a `.md` file from the browser.

## Tests

Node 22 or newer. No npm install.

```bash
npm test
```

That syntax-checks the client script shipped in the HTML, runs the Markdown renderer (including XSS cases) through the same source the browser receives, and exercises the API against an in-memory D1 stand-in.
