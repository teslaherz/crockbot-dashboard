# Grokbot Dashboard

Cloudflare Worker that stores every output from René's Grokbot fleet and shows it as a chat. A bot posts Markdown, the API returns a direct URL, and the dashboard groups the messages by bot.

Production: `https://crockbot-dashboard.teslaherz.workers.dev`

The home page is a chat list: bots on the left (avatar, name, preview, Berlin time, unread badge), that bot's history on the right. Each output is a bubble with rendered Markdown, and **Öffnen** goes to the full document at `/r/<id>`. On a phone the list and the chat are two screens; **Zurück** returns to the list. The Tesla browser gets the wide layout.

## Tesla workflow

1. In the car: *„Hey Grok, Bote soll mir eine Übersicht über meine letzten Emails erstellen und ans Dashboard schicken.“*
2. The bot writes Markdown and `POST`s it to `/api/messages` (or the older `/api/results`).
3. The response contains `chat_url` (`/bot/<slug>`) and `url` (`/r/<id>`).
4. Grok can open either link. The home page already shows the newest bot.

Times are `Europe/Berlin`. The page polls `/api/bots` every 8 seconds. Unread counts live in the browser (`localStorage`), not on the server. The chat is read-only for now.

## Deploy

No build step. `src/index.js` is vanilla JavaScript.

```bash
npx wrangler deploy
```

Do not deploy from this repo's automation; production is published separately.

The existing D1 database is bound as `DB`:

| | |
| --- | --- |
| binding | `DB` |
| database_name | `crockbot-dashboard-db` |
| database_id | `dea82dd4-2cbd-4438-a3d5-e2b68cf93255` |

On the first request the Worker creates `results` and `bots` with **one `prepare().run()` per statement**. If `results` already exists without the chat columns, it checks `PRAGMA table_info` and runs a separate `ALTER TABLE` for each missing column (`role`, `task`, `meta`, `bot_slug`), then fills `bot_slug` from `bot_name`. Existing rows stay, and `/r/<id>` keeps working. An empty database still gets the pinned welcome note from **Elon · Programmierer Smarthome**.

`schema.sql` is the same end state for a new database. `npx wrangler d1 execute` with that file is optional; the Worker migrates on its own.

Local UI, using a simulated D1 database (not the production database):

```bash
npx wrangler dev
```

### Optional write key

Reads stay open so the Tesla browser can open a chat with no login. To require a key on `POST`, `PUT`, `PATCH`, and `DELETE`:

```bash
npx wrangler secret put DASHBOARD_API_KEY
```

Send it as `Authorization: Bearer <key>`, `X-API-Key: <key>`, or `?key=<key>`. If the secret is unset, writes are accepted without a key. The full-document page can store a key in **API-Schlüssel** (browser `localStorage` only) for pin, delete, and manual upload.

Reports are world-readable at the Worker URL. Put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/) in front of the hostname if a report should not be public.

## Bot identity

The slug is derived from `bot_name` and does not change when you later edit the display name:

1. Trim and lowercase.
2. `ä→ae`, `ö→oe`, `ü→ue`, `ß→ss`, then strip other accents.
3. Every other character becomes `-`. Collapse and trim hyphens. Max 80 characters.

`Bote · E-Mail-Verwalter` → `bote-e-mail-verwalter`.

Always send the same full `bot_name`. A short alias such as `bote` or `Elon` still finds that bot if it is unique. Two bots that share the short name (`Bote · Alpha` and `Bote · Beta`) must be addressed by the full name or the full slug.

## Bot-Regel

Paste this into each bot's instructions. Replace the name with that bot's exact display name.

```text
Bot-Regel: Schicke jede Ausgabe zusätzlich per POST an das Grokbot-Dashboard.

Nach jeder Antwort, die du für den Nutzer erzeugst, sende den vollständigen Markdown-Text an:

POST https://crockbot-dashboard.teslaherz.workers.dev/api/messages
Content-Type: application/json

{
  "bot_name": "Bote · E-Mail-Verwalter",
  "title": "<kurzer Titel oder weglassen>",
  "category": "<z. B. email>",
  "content": "<dein Markdown>",
  "role": "bot"
}

Wenn du den Auftrag des Nutzers mitschicken willst, sende davor eine zweite Nachricht mit "role": "user" und dem Auftragstext als content.

Verwende immer exakt denselben bot_name, damit dein Chat stabil bleibt.
Die Antwort enthält chat_url (dein Chat) und url (die Gesamtansicht).
Falls das Secret DASHBOARD_API_KEY gesetzt ist, sende es als Header "Authorization: Bearer <key>" oder "X-API-Key".
```

## API

CORS: `Access-Control-Allow-Origin: *`. Methods `GET, POST, PUT, PATCH, DELETE, OPTIONS`. Extra request headers: `X-Title`, `X-Bot-Name`, `X-Bot-Id`, `X-Category`, `X-Role`, `X-Task`, `X-API-Key`.

### Post a chat message

`POST /api/messages` and `POST /api/bots/<slug>/messages` append one bubble and also create a document at `/r/<id>`. `POST /api/results`, `POST /api/publish`, and `POST /api/ingest` stay as they were; those reports show up in the same bot history.

**JSON** (`Content-Type: application/json`):

| Field | Required | Notes |
| --- | --- | --- |
| `content`, `markdown`, `content_md`, `body`, or `text` | yes | Markdown |
| `bot_name`, `bot`, or `author` | on `/api/messages` | Display name. The slug is derived from it. |
| `title` | no | Otherwise the first `# Heading`, otherwise empty |
| `category` or `tag` | no | Default `general` (hidden in the bubble) |
| `role` | no | `bot` (default) or `user` for the prompt that triggered the output |
| `task` | no | Short label stored with the message |
| `meta` | no | Object or string, up to 8000 characters |
| `bot_id` | no | |
| `summary` | no | Plain-text excerpt when omitted |
| `id` | no | Slug. Generated as `20261030-xxxxxx` (Berlin date) when omitted |

```bash
curl -X POST "https://crockbot-dashboard.teslaherz.workers.dev/api/messages" \
  -H "Content-Type: application/json" \
  -d '{
    "bot_name": "Bote · E-Mail-Verwalter",
    "title": "E-Mail-Übersicht",
    "category": "email",
    "role": "bot",
    "content": "# E-Mail-Übersicht\n\nDrei neue Nachrichten."
  }'
```

Same call aimed at the slug. A unique short name works too (`/api/bots/bote/messages`).

```bash
curl -X POST "https://crockbot-dashboard.teslaherz.workers.dev/api/bots/bote-e-mail-verwalter/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $DASHBOARD_API_KEY" \
  -d '{
    "bot_name": "Bote · E-Mail-Verwalter",
    "role": "user",
    "content": "Fasse die letzten Mails zusammen."
  }'
```

**Raw Markdown** (`text/markdown`, `text/plain`, or `application/octet-stream`). Title, bot, category, and role can come from the query string or from `X-Title`, `X-Bot-Name`, `X-Bot-Id`, `X-Category`, and `X-Role`.

```bash
curl -X POST "https://crockbot-dashboard.teslaherz.workers.dev/api/bots/bote-e-mail-verwalter/messages" \
  -H "Content-Type: text/markdown" \
  -H "X-Bot-Name: Bote · E-Mail-Verwalter" \
  -H "X-Title: E-Mail-Übersicht" \
  -H "X-Category: email" \
  --data-binary @bericht.md
```

`201 Created`:

```json
{
  "ok": true,
  "id": "20261030-k3m9qx",
  "title": "E-Mail-Übersicht",
  "bot_name": "Bote · E-Mail-Verwalter",
  "bot_slug": "bote-e-mail-verwalter",
  "role": "bot",
  "summary": "Drei neue Nachrichten.",
  "created_at": "2026-10-30T15:42:00.000Z",
  "url": "https://crockbot-dashboard.teslaherz.workers.dev/r/20261030-k3m9qx",
  "dashboard_url": "https://crockbot-dashboard.teslaherz.workers.dev/?bot=bote-e-mail-verwalter",
  "chat_url": "https://crockbot-dashboard.teslaherz.workers.dev/bot/bote-e-mail-verwalter",
  "raw_url": "https://crockbot-dashboard.teslaherz.workers.dev/api/results/20261030-k3m9qx/raw"
}
```

`POST /api/results` keeps its previous JSON shape (`dashboard_url` is still `/?id=<id>`) and adds `bot_slug` and `chat_url`.

### List bots

`GET /api/bots` returns every bot, newest activity first. `?q=` filters name, slug, and description.

```bash
curl "https://crockbot-dashboard.teslaherz.workers.dev/api/bots"
```

```json
{
  "ok": true,
  "bots": [
    {
      "slug": "bote-e-mail-verwalter",
      "display_name": "Bote · E-Mail-Verwalter",
      "emoji": "",
      "color": "#5b8cff",
      "description": "",
      "count": 2,
      "last_at": "2026-10-30T15:42:00.000Z",
      "last_message": {
        "id": "20261030-k3m9qx",
        "preview": "E-Mail-Übersicht",
        "title": "E-Mail-Übersicht",
        "role": "bot",
        "category": "email",
        "created_at": "2026-10-30T15:42:00.000Z"
      },
      "url": "https://crockbot-dashboard.teslaherz.workers.dev/bot/bote-e-mail-verwalter"
    }
  ]
}
```

`GET /api/bots/<slug>` returns `{ "ok": true, "bot": { ... } }`. `<slug>` may be the canonical slug, the full display name, or a unique short name.

### Read one bot's messages

`GET /api/bots/<slug>/messages` returns a page of bubbles, **oldest first** (newest at the end). Default `limit` is 50, maximum 200. Pass `before` (ISO timestamp) and `before_id` from the previous page to load older messages.

```bash
curl "https://crockbot-dashboard.teslaherz.workers.dev/api/bots/bote-e-mail-verwalter/messages?limit=50"
curl "https://crockbot-dashboard.teslaherz.workers.dev/api/bots/bote-e-mail-verwalter/messages?limit=50&before=2026-10-30T15:42:00.000Z&before_id=20261030-k3m9qx"
```

```json
{
  "ok": true,
  "bot": { "slug": "bote-e-mail-verwalter", "display_name": "Bote · E-Mail-Verwalter" },
  "messages": [
    {
      "id": "20261030-k3m9qx",
      "role": "bot",
      "title": "E-Mail-Übersicht",
      "content_md": "# E-Mail-Übersicht\n\nDrei neue Nachrichten.",
      "created_at": "2026-10-30T15:42:00.000Z",
      "url": "https://crockbot-dashboard.teslaherz.workers.dev/r/20261030-k3m9qx"
    }
  ],
  "has_more": false,
  "next_before": null,
  "next_before_id": null
}
```

When `has_more` is true, call again with `next_before` and `next_before_id`.

### Bot registry

`PUT /api/bots/<slug>` sets the label shown in the list. Later messages do not overwrite a name you set here. Omitted fields stay as they are. `color` is `#rrggbb` or `""`. `emoji` is a short avatar glyph.

```bash
curl -X PUT "https://crockbot-dashboard.teslaherz.workers.dev/api/bots/bote-e-mail-verwalter" \
  -H "Content-Type: application/json" \
  -d '{
    "display_name": "Bote",
    "emoji": "✉️",
    "color": "#5b8cff",
    "description": "Posteingang"
  }'
```

Nothing is pre-seeded except the welcome note when the database is empty.

### Create a report (unchanged)

`POST /api/results`, `POST /api/publish`, and `POST /api/ingest` accept the same body as before.

| Field | Required | Notes |
| --- | --- | --- |
| `content`, `markdown`, `content_md`, `body`, or `text` | yes | Markdown |
| `title` | no | Otherwise the first `# Heading`, otherwise `Ergebnis vom <date>` |
| `bot_name`, `bot`, or `author` | no | Default `Grokbot` |
| `bot_id` | no | |
| `category` or `tag` | no | Default `general` |
| `summary` | no | Plain-text excerpt when omitted |
| `id` | no | Slug. Generated as `20261030-xxxxxx` when omitted |
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

```bash
curl -X POST "https://crockbot-dashboard.teslaherz.workers.dev/api/ingest?bot=Bote%20·%20E-Mail-Verwalter" \
  -H "Content-Type: text/markdown" \
  --data-binary @bericht.md
```

```bash
curl -X POST "https://crockbot-dashboard.teslaherz.workers.dev/api/publish" \
  -F "file=@bericht.md" \
  -F "bot=Bote · E-Mail-Verwalter"
```

### Read a document

| Request | Result |
| --- | --- |
| `GET /api/results` | Metadata, newest pinned first. Filters: `bot`, `category`, `q`, `limit` (max 500). `full=1` includes `content_md`. |
| `GET /api/results/:id` | One report, including `content_md`. |
| `GET /api/results/:id/raw` and `GET /r/:id.md` | `text/markdown` |
| `GET /api/latest` | Newest report. Optional `?bot=`. |
| `GET /` | Chat office. Optional `?bot=<slug>` opens that bot. `?q=` filters the list. |
| `GET /bot/<slug>` | Same office with that bot open. |
| `GET /?id=<id>` and `GET /r/:id` | Full document. History sidebar, pin, delete, **+ Neu**. |
| `GET /latest` | Full document for the newest report. Optional `?bot=`. |

`bot=Bote` on `/api/results` still matches `Bote` and `Bote · E-Mail-Verwalter`.

### Update and delete a document

`PATCH` or `PUT /api/results/:id` with JSON. Any of `title`, `content_md` (aliases `content`, `markdown`, `body`, `text`), `bot_name` (aliases `bot`, `author`), `category` (alias `tag`), `pinned`, `summary`. Changing the bot name moves the row into that bot's history. Changing the Markdown regenerates the summary unless `summary` is sent too.

`DELETE /api/results/:id` removes the row. The bot registry entry stays.

## Pages

- **Chats:** search field, then one row per bot. Avatar circle (initials or emoji, stable colour), short name, role after the `·`, first-line preview with Markdown stripped, short Berlin stamp (`17:42`, `Gestern`, weekday, or `30.10.`). Unread badge from `localStorage`. Rows sort by last activity.
- **Thread:** date separators, bot bubbles on the left, `user` bubbles on the right, title and category when present, time, link to `/r/<id>`. **Ältere Nachrichten** loads the previous page. **A-** / **A+** change the type size.
- **Phone:** list and chat are separate screens. **‹ Zurück** goes home.
- **Gesamtansicht** (`/r/<id>`): the previous reader. Headings, emphasis, code with **Kopieren**, tables, task lists, callouts, links, and images. HTML in the Markdown is escaped.

## Tests

Node 22 or newer. No npm install.

```bash
npm test
```

The tests syntax-check the client script, run the Markdown renderer, exercise the API against an in-memory D1 stand-in, and migrate a legacy `results` table without calling `exec()`.
