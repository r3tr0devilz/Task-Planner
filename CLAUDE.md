# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running & Developing

This is a static PWA deployed to Netlify — there is no build step for the frontend. Open `index.html` directly in a browser, or serve locally:

```
npx serve .          # or python -m http.server 8000
```

To develop with live Netlify Functions (sync, config endpoints):

```
npx netlify dev      # serves on http://localhost:8888 with functions at /.netlify/functions/
```

Requires a `.env` file at root with:
```
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
SUPABASE_JWT_SECRET=...
```

### Running Tests

```
cd test-agent
npm install
BASE_URL=http://localhost:8888 npm test
```

The test agent is a Claude-powered E2E runner — it uses Playwright + the Anthropic SDK to drive a browser and assert UI behavior via vision.

## Architecture

**The entire frontend lives in two files: `index.html` and `login.html`.** There is no bundler, no framework, no component system. All JS, CSS, and HTML is inline. `index.html` is ~340KB.

### Data Flow

```
localStorage (wt-auth, wt-tabs, wt-ci)
      ↕
  in-memory JS arrays (tasks[], buckets[], commTasks[])
      ↕  debounced push (1.5s), periodic pull (30s)
  Netlify Functions → Supabase PostgreSQL (table: task_planner)
```

- Tasks are stored as a single JSON blob per user in the `task_planner` table.
- Sync uses `/.netlify/functions/sync` (GET to pull, POST to push). Auth token from localStorage is sent as a Bearer header; the function validates it against Supabase Auth before any DB operation.
- Merge conflicts are resolved with a "merge-duplicates" strategy on push.

### View Modes

The app has five main views, toggled via tab state (persisted in `localStorage['wt-tabs']`):
- **Planner** — daily task list with drag-and-drop
- **Calendar** — date-based task view
- **Kanban** — bucket-based columns (buckets[])
- **Stats** — completion analytics
- **Check-in** — routine/habit tracker (stored separately in `localStorage['wt-ci']`)

### Theming

10 CSS themes defined via `--` CSS custom properties inside `index.html`. Light themes: `light-default`, `slate`, `sand`, `mint`, `lavender`, `light-paper`. Dark themes: `dark-default`, `obsidian`, `amber-dark`. The active theme class is set on `<body>`. Design tokens are documented in [design-system/task-planner/MASTER.md](design-system/task-planner/MASTER.md).

### Backend Functions

`netlify/functions/sync.js` — bidirectional sync endpoint. Validates JWT, then reads/writes to Supabase. All user identity comes from the verified token; the client cannot supply a different `user_id`.

`netlify/functions/config.js` — exposes public Supabase config to the client.

### Service Worker

`sw.js` uses network-first for `index.html` (always tries fresh), cache-first for all other static assets. PWA install precaches: `index.html`, icons, `manifest.json`.

### Test Agent

`test-agent/agent.ts` — TypeScript E2E agent using `claude-sonnet-4-6` + Playwright. Claude receives base64 screenshots and controls the browser via registered tools (navigate, click, type, assert, etc.). Not a traditional test suite — it's an AI agent that reasons about UI state.
