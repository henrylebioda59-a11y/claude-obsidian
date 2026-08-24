# claude-obsidian Vault Browser

A read-only, client-side web app for browsing a claude-obsidian vault:
notes, wikilinks, backlinks, tags, `wiki/hot.md`, `wiki/log.md`, provenance
ledgers, and a link graph.

It is intentionally read-only. All vault mutations in this project go
through the reviewed transaction CLI (`scripts/claude-obsidian.py`) — this
viewer never writes to the vault.

## Run it

No build step, no dependencies. Serve this directory over `http://localhost`
(the File System Access API refuses `file://`):

```bash
cd webapp
python3 -m http.server 8000
```

Open `http://localhost:8000` in Chrome, Edge, or another Chromium-based
browser (the File System Access API isn't supported in Firefox/Safari yet).
Click **Open vault…** and pick your vault directory (the folder containing
`.claude-obsidian.json` and `wiki/`) — not this product checkout.

## What it does

- Walks `wiki/` for Markdown notes, parses flat frontmatter properties,
  wikilinks (`[[Target]]`, `[[Target|Alias]]`), embeds (`![[Target]]`), and
  `#tags`.
- Renders headings, lists, code blocks, blockquotes, and Obsidian callouts
  (`> [!note]`).
- Builds a backlinks index and an outgoing-links panel per note.
- Shows `wiki/hot.md` and `wiki/log.md` in their own tabs.
- Renders any `wiki/meta/ledgers/*.json` provenance ledgers as tables.
- Draws a simple force-directed link graph; click a node to open that note.

## What it deliberately doesn't do

- No editing, saving, or vault writes of any kind.
- No network requests — everything runs against the local directory handle
  granted by the browser.
- Not a substitute for `wiki-lint` or `wiki-query`; it's a viewer.
