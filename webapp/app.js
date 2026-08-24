// claude-obsidian vault browser — read-only client-side viewer.
//
// Reads a vault folder chosen via the File System Access API and renders
// notes, wikilinks, backlinks, tags, hot.md/log.md, and provenance ledgers.
// Never writes to the vault: mutations belong to the transaction CLI
// (scripts/claude-obsidian.py), not this viewer.

const state = {
  vaultHandle: null,
  notes: new Map(), // path -> note
  byTitle: new Map(), // lowercase title -> path
  backlinks: new Map(), // path -> Set(path)
  selectedPath: null,
};

const els = {
  openVault: document.getElementById("open-vault"),
  vaultName: document.getElementById("vault-name"),
  vaultStatus: document.getElementById("vault-status"),
  unsupported: document.getElementById("unsupported"),
  app: document.getElementById("app"),
  search: document.getElementById("search"),
  noteList: document.getElementById("note-list"),
  tabs: document.querySelectorAll(".tab"),
  noteView: document.getElementById("note-view"),
  hotView: document.getElementById("hot-view"),
  logView: document.getElementById("log-view"),
  ledgersView: document.getElementById("ledgers-view"),
  properties: document.getElementById("properties"),
  tags: document.getElementById("tags"),
  backlinksEl: document.getElementById("backlinks"),
  outlinksEl: document.getElementById("outlinks"),
  graphCanvas: document.getElementById("graph-canvas"),
};

function supportsFsAccess() {
  return typeof window.showDirectoryPicker === "function";
}

if (!supportsFsAccess()) {
  els.unsupported.classList.remove("hidden");
} else {
  els.openVault.addEventListener("click", openVault);
}

// ---------------------------------------------------------------------
// Vault loading
// ---------------------------------------------------------------------

async function openVault() {
  let handle;
  try {
    handle = await window.showDirectoryPicker();
  } catch (err) {
    return; // user cancelled
  }
  state.vaultHandle = handle;
  els.vaultName.textContent = handle.name;
  els.vaultStatus.textContent = "Reading vault…";
  state.notes.clear();
  state.byTitle.clear();
  state.backlinks.clear();

  try {
    const wikiHandle = await getSubdir(handle, "wiki");
    const root = wikiHandle || handle;
    await walkMarkdown(root, "");
    buildBacklinks();
    els.app.classList.remove("hidden");
    renderNoteList(getAllNotePaths());
    els.vaultStatus.textContent = `${state.notes.size} note${state.notes.size === 1 ? "" : "s"} loaded`;
    await renderHot();
    await renderLog();
    await renderLedgers();
  } catch (err) {
    console.error(err);
    els.vaultStatus.textContent = `Error reading vault: ${err.message}`;
  }
}

async function getSubdir(dirHandle, name) {
  try {
    return await dirHandle.getDirectoryHandle(name);
  } catch {
    return null;
  }
}

async function walkMarkdown(dirHandle, prefix) {
  for await (const [name, handle] of dirHandle.entries()) {
    if (name.startsWith(".")) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "directory") {
      if (name === "meta") continue; // ledgers handled separately
      await walkMarkdown(handle, path);
    } else if (handle.kind === "file" && name.toLowerCase().endsWith(".md")) {
      if (name === "hot.md" || name === "log.md") continue; // special tabs
      const file = await handle.getFile();
      const text = await file.text();
      const note = parseNote(path, text);
      state.notes.set(path, note);
      state.byTitle.set(note.title.toLowerCase(), path);
    }
  }
}

function getAllNotePaths() {
  return Array.from(state.notes.keys()).sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------
// Note parsing: frontmatter, tags, wikilinks
// ---------------------------------------------------------------------

function parseNote(path, raw) {
  const { frontmatter, body } = splitFrontmatter(raw);
  const fileBase = path.split("/").pop().replace(/\.md$/i, "");
  const title = (typeof frontmatter.title === "string" && frontmatter.title.trim())
    ? frontmatter.title.trim()
    : fileBase;
  const links = extractWikilinks(body);
  const tags = extractTags(body, frontmatter);
  return { path, title, frontmatter, body, links, tags };
}

function splitFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: {}, body: raw };
  const yamlBlock = match[1];
  const body = raw.slice(match[0].length);
  return { frontmatter: parseFlatYaml(yamlBlock), body };
}

// Minimal parser for flat Obsidian frontmatter: "key: value" and simple
// "key:\n  - item" lists. Not a general YAML parser — this vault convention
// is documented as flat properties only (see AGENTS.md).
function parseFlatYaml(block) {
  const result = {};
  const lines = block.split(/\r?\n/);
  let currentListKey = null;
  for (const line of lines) {
    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem && currentListKey) {
      result[currentListKey].push(stripQuotes(listItem[1].trim()));
      continue;
    }
    currentListKey = null;
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2].trim();
    if (value === "") {
      result[key] = [];
      currentListKey = key;
    } else if (value.startsWith("[") && value.endsWith("]")) {
      result[key] = value
        .slice(1, -1)
        .split(",")
        .map((v) => stripQuotes(v.trim()))
        .filter(Boolean);
    } else {
      result[key] = stripQuotes(value);
    }
  }
  return result;
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function extractWikilinks(body) {
  const links = new Set();
  const re = /!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  let m;
  while ((m = re.exec(body))) {
    links.add(m[1].trim());
  }
  return Array.from(links);
}

function extractTags(body, frontmatter) {
  const tags = new Set();
  const fmTags = frontmatter.tags;
  if (Array.isArray(fmTags)) fmTags.forEach((t) => tags.add(String(t).replace(/^#/, "")));
  else if (typeof fmTags === "string" && fmTags) tags.add(fmTags.replace(/^#/, ""));
  const re = /(^|\s)#([A-Za-z0-9_/-]+)/g;
  let m;
  while ((m = re.exec(body))) tags.add(m[2]);
  return Array.from(tags);
}

function buildBacklinks() {
  state.backlinks.clear();
  for (const note of state.notes.values()) {
    for (const target of note.links) {
      const targetPath = state.byTitle.get(target.toLowerCase());
      if (!targetPath || targetPath === note.path) continue;
      if (!state.backlinks.has(targetPath)) state.backlinks.set(targetPath, new Set());
      state.backlinks.get(targetPath).add(note.path);
    }
  }
}

// ---------------------------------------------------------------------
// Markdown -> HTML (Obsidian-flavored subset)
// ---------------------------------------------------------------------

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CALLOUT_RE = /^>\s*\[!(\w+)\][+-]?\s*(.*)$/;

function renderMarkdown(body) {
  const lines = body.split(/\r?\n/);
  let html = "";
  let i = 0;
  let inCode = false;
  let codeLang = "";
  let codeBuf = [];
  let listType = null; // 'ul' | 'ol'
  let calloutBuf = null; // { type, title, lines }

  function flushList() {
    if (listType) {
      html += listType === "ul" ? "</ul>" : "</ol>";
      listType = null;
    }
  }

  function flushCallout() {
    if (calloutBuf) {
      html += `<div class="callout callout-${escapeHtml(calloutBuf.type)}">`;
      html += `<div class="callout-title">${escapeHtml(calloutBuf.title || calloutBuf.type)}</div>`;
      html += calloutBuf.lines.map((l) => `<p>${inline(l)}</p>`).join("");
      html += `</div>`;
      calloutBuf = null;
    }
  }

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith("```")) {
      if (!inCode) {
        flushList();
        flushCallout();
        inCode = true;
        codeLang = line.trim().slice(3).trim();
        codeBuf = [];
      } else {
        html += `<pre><code class="lang-${escapeHtml(codeLang)}">${escapeHtml(codeBuf.join("\n"))}</code></pre>`;
        inCode = false;
      }
      i++;
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      i++;
      continue;
    }

    const calloutMatch = line.match(CALLOUT_RE);
    if (calloutMatch) {
      flushList();
      flushCallout();
      calloutBuf = { type: calloutMatch[1].toLowerCase(), title: calloutMatch[2], lines: [] };
      i++;
      continue;
    }
    if (calloutBuf) {
      if (line.startsWith(">")) {
        calloutBuf.lines.push(line.replace(/^>\s?/, ""));
        i++;
        continue;
      }
      flushCallout();
    }

    if (/^\s*$/.test(line)) {
      flushList();
      i++;
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushList();
      const level = h[1].length;
      html += `<h${level}>${inline(h[2])}</h${level}>`;
      i++;
      continue;
    }

    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ul || ol) {
      const kind = ul ? "ul" : "ol";
      if (listType !== kind) {
        flushList();
        html += kind === "ul" ? "<ul>" : "<ol>";
        listType = kind;
      }
      html += `<li>${inline((ul || ol)[1])}</li>`;
      i++;
      continue;
    }

    if (line.startsWith(">")) {
      flushList();
      html += `<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`;
      i++;
      continue;
    }

    if (/^(---|\*\*\*|___)\s*$/.test(line.trim())) {
      flushList();
      html += "<hr>";
      i++;
      continue;
    }

    flushList();
    html += `<p>${inline(line)}</p>`;
    i++;
  }
  flushList();
  flushCallout();
  if (inCode) {
    html += `<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`;
  }
  return html;
}

function inline(text) {
  let out = escapeHtml(text);

  // Embeds ![[Target]]
  out = out.replace(/!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g, (_, target) => {
    const t = target.trim();
    const targetPath = state.byTitle.get(t.toLowerCase());
    const exists = Boolean(targetPath);
    return `<div class="embed"><div class="embed-title">Embed: ${escapeHtml(t)}</div>${
      exists ? escapeHtml(preview(state.notes.get(targetPath).body)) : "(not found)"
    }</div>`;
  });

  // Wikilinks [[Target]] / [[Target|Alias]]
  out = out.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_, target, alias) => {
    const t = target.trim();
    const label = alias ? alias.trim() : t;
    const targetPath = state.byTitle.get(t.toLowerCase());
    const broken = !targetPath ? " broken" : "";
    return `<a class="wikilink${broken}" data-target="${escapeHtml(t)}">${escapeHtml(label)}</a>`;
  });

  // Standard markdown links [text](url)
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Bold, italic, inline code
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");

  // Tags
  out = out.replace(/(^|\s)#([A-Za-z0-9_/-]+)/g, '$1<span class="tag-pill">#$2</span>');

  return out;
}

function preview(body, len = 160) {
  const stripped = body.replace(/\r?\n/g, " ").trim();
  return stripped.length > len ? stripped.slice(0, len) + "…" : stripped;
}

// ---------------------------------------------------------------------
// Rendering: note list, note view, side panels
// ---------------------------------------------------------------------

function renderNoteList(paths) {
  els.noteList.innerHTML = "";
  for (const path of paths) {
    const note = state.notes.get(path);
    const li = document.createElement("li");
    li.textContent = note.title;
    if (note.title !== path) {
      const hint = document.createElement("span");
      hint.className = "path-hint";
      hint.textContent = path;
      li.appendChild(hint);
    }
    li.dataset.path = path;
    if (path === state.selectedPath) li.classList.add("selected");
    li.addEventListener("click", () => selectNote(path));
    els.noteList.appendChild(li);
  }
}

function selectNote(path) {
  const note = state.notes.get(path);
  if (!note) return;
  state.selectedPath = path;
  activateTab("notes");
  document.querySelectorAll(".note-list li").forEach((li) => {
    li.classList.toggle("selected", li.dataset.path === path);
  });

  els.noteView.classList.remove("empty");
  els.noteView.innerHTML = `<h1>${escapeHtml(note.title)}</h1>` + renderMarkdown(note.body);
  els.noteView.querySelectorAll("a.wikilink").forEach((a) => {
    a.addEventListener("click", () => {
      const targetPath = state.byTitle.get(a.dataset.target.toLowerCase());
      if (targetPath) selectNote(targetPath);
    });
  });

  renderProperties(note.frontmatter);
  renderTags(note.tags);
  renderBacklinks(path);
  renderOutlinks(note);
}

function renderProperties(frontmatter) {
  const entries = Object.entries(frontmatter);
  if (!entries.length) {
    els.properties.innerHTML = '<span style="color:var(--text-dim)">None</span>';
    return;
  }
  const rows = entries
    .map(([k, v]) => {
      const val = Array.isArray(v) ? v.join(", ") : String(v);
      return `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(val)}</td></tr>`;
    })
    .join("");
  els.properties.innerHTML = `<table>${rows}</table>`;
}

function renderTags(tags) {
  if (!tags.length) {
    els.tags.innerHTML = '<span style="color:var(--text-dim)">None</span>';
    return;
  }
  els.tags.innerHTML = tags.map((t) => `<span class="tag-pill">#${escapeHtml(t)}</span>`).join("");
}

function renderBacklinks(path) {
  const backset = state.backlinks.get(path);
  els.backlinksEl.innerHTML = "";
  if (!backset || !backset.size) {
    els.backlinksEl.innerHTML = '<li class="none">No backlinks</li>';
    return;
  }
  for (const backPath of backset) {
    const li = document.createElement("li");
    li.textContent = state.notes.get(backPath).title;
    li.addEventListener("click", () => selectNote(backPath));
    els.backlinksEl.appendChild(li);
  }
}

function renderOutlinks(note) {
  els.outlinksEl.innerHTML = "";
  if (!note.links.length) {
    els.outlinksEl.innerHTML = '<li class="none">No outgoing links</li>';
    return;
  }
  for (const target of note.links) {
    const targetPath = state.byTitle.get(target.toLowerCase());
    const li = document.createElement("li");
    li.textContent = target + (targetPath ? "" : " (missing)");
    if (targetPath) li.addEventListener("click", () => selectNote(targetPath));
    else li.classList.add("none");
    els.outlinksEl.appendChild(li);
  }
}

// ---------------------------------------------------------------------
// Special tabs: hot.md, log.md, ledgers
// ---------------------------------------------------------------------

async function readVaultFile(relativePath) {
  const parts = relativePath.split("/");
  let dir = state.vaultHandle;
  try {
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i]);
    }
    const fileHandle = await dir.getFileHandle(parts[parts.length - 1]);
    const file = await fileHandle.getFile();
    return await file.text();
  } catch {
    return null;
  }
}

async function renderHot() {
  const text = await readVaultFile("wiki/hot.md");
  els.hotView.innerHTML = text
    ? renderMarkdown(splitFrontmatter(text).body)
    : '<span style="color:var(--text-dim)">wiki/hot.md not found</span>';
  els.hotView.querySelectorAll("a.wikilink").forEach((a) =>
    a.addEventListener("click", () => {
      const targetPath = state.byTitle.get(a.dataset.target.toLowerCase());
      if (targetPath) selectNote(targetPath);
    })
  );
}

async function renderLog() {
  const text = await readVaultFile("wiki/log.md");
  els.logView.innerHTML = text
    ? renderMarkdown(splitFrontmatter(text).body)
    : '<span style="color:var(--text-dim)">wiki/log.md not found</span>';
}

async function renderLedgers() {
  els.ledgersView.innerHTML = "";
  const ledgerDir = await getSubdir(await getSubdir(state.vaultHandle, "wiki"), "meta");
  const ledgersHandle = ledgerDir ? await getSubdir(ledgerDir, "ledgers") : null;
  if (!ledgersHandle) {
    els.ledgersView.innerHTML = '<span style="color:var(--text-dim)">wiki/meta/ledgers not found</span>';
    return;
  }
  let any = false;
  for await (const [name, handle] of ledgersHandle.entries()) {
    if (handle.kind !== "file" || !name.toLowerCase().endsWith(".json")) continue;
    any = true;
    const file = await handle.getFile();
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      continue;
    }
    els.ledgersView.innerHTML += `<h3>${escapeHtml(name)}</h3>` + renderLedgerTable(data);
  }
  if (!any) {
    els.ledgersView.innerHTML = '<span style="color:var(--text-dim)">No ledger files found</span>';
  }
}

function renderLedgerTable(data) {
  const rows = Array.isArray(data) ? data : Array.isArray(data.entries) ? data.entries : null;
  if (!rows || !rows.length) {
    return `<pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
  }
  const columns = Array.from(
    rows.reduce((set, row) => {
      if (row && typeof row === "object") Object.keys(row).forEach((k) => set.add(k));
      return set;
    }, new Set())
  );
  const header = columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
  const body = rows
    .map((row) => {
      const cells = columns
        .map((c) => {
          const v = row?.[c];
          const s = v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
          return `<td>${escapeHtml(s)}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  return `<table class="ledger-table"><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
}

// ---------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------

els.search.addEventListener("input", () => {
  const q = els.search.value.trim().toLowerCase();
  if (!q) {
    renderNoteList(getAllNotePaths());
    return;
  }
  const matches = getAllNotePaths().filter((path) => {
    const note = state.notes.get(path);
    return (
      note.title.toLowerCase().includes(q) ||
      note.tags.some((t) => t.toLowerCase().includes(q)) ||
      note.body.toLowerCase().includes(q)
    );
  });
  renderNoteList(matches);
});

// ---------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------

function activateTab(name) {
  els.tabs.forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `panel-${name}`);
  });
  if (name === "graph") drawGraph();
}

els.tabs.forEach((btn) => btn.addEventListener("click", () => activateTab(btn.dataset.tab)));

// ---------------------------------------------------------------------
// Graph view: simple force-directed layout on canvas
// ---------------------------------------------------------------------

function drawGraph() {
  const canvas = els.graphCanvas;
  const ctx = canvas.getContext("2d");
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;

  const paths = getAllNotePaths();
  if (!paths.length) return;

  const nodes = paths.map((path, i) => ({
    path,
    x: canvas.width / 2 + Math.cos((i / paths.length) * Math.PI * 2) * 100,
    y: canvas.height / 2 + Math.sin((i / paths.length) * Math.PI * 2) * 100,
    vx: 0,
    vy: 0,
  }));
  const indexOf = new Map(paths.map((p, i) => [p, i]));
  const edges = [];
  for (const note of state.notes.values()) {
    for (const target of note.links) {
      const targetPath = state.byTitle.get(target.toLowerCase());
      if (targetPath && targetPath !== note.path) {
        edges.push([indexOf.get(note.path), indexOf.get(targetPath)]);
      }
    }
  }

  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  for (let iter = 0; iter < 200; iter++) {
    for (const n of nodes) {
      n.vx += (cx - n.x) * 0.001;
      n.vy += (cy - n.y) * 0.001;
      for (const other of nodes) {
        if (other === n) continue;
        const dx = n.x - other.x;
        const dy = n.y - other.y;
        const distSq = Math.max(dx * dx + dy * dy, 1);
        const force = 400 / distSq;
        n.vx += (dx / Math.sqrt(distSq)) * force;
        n.vy += (dy / Math.sqrt(distSq)) * force;
      }
    }
    for (const [a, b] of edges) {
      const na = nodes[a];
      const nb = nodes[b];
      const dx = nb.x - na.x;
      const dy = nb.y - na.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const targetLen = 80;
      const force = (dist - targetLen) * 0.01;
      na.vx += (dx / dist) * force;
      na.vy += (dy / dist) * force;
      nb.vx -= (dx / dist) * force;
      nb.vy -= (dy / dist) * force;
    }
    for (const n of nodes) {
      n.x += n.vx *= 0.85;
      n.y += n.vy *= 0.85;
    }
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "rgba(124,108,240,0.35)";
  ctx.lineWidth = 1;
  for (const [a, b] of edges) {
    ctx.beginPath();
    ctx.moveTo(nodes[a].x, nodes[a].y);
    ctx.lineTo(nodes[b].x, nodes[b].y);
    ctx.stroke();
  }
  ctx.font = "11px sans-serif";
  for (const n of nodes) {
    const isSelected = n.path === state.selectedPath;
    ctx.fillStyle = isSelected ? "#7c6cf0" : "#a9abb3";
    ctx.beginPath();
    ctx.arc(n.x, n.y, isSelected ? 6 : 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#dcddde";
    ctx.fillText(state.notes.get(n.path).title, n.x + 8, n.y + 4);
  }

  canvas.onclick = (evt) => {
    const rect2 = canvas.getBoundingClientRect();
    const x = evt.clientX - rect2.left;
    const y = evt.clientY - rect2.top;
    for (const n of nodes) {
      if (Math.hypot(n.x - x, n.y - y) < 10) {
        selectNote(n.path);
        drawGraph();
        return;
      }
    }
  };
}

window.addEventListener("resize", () => {
  if (document.getElementById("panel-graph").classList.contains("active")) drawGraph();
});
