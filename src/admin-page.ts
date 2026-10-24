/**
 * The /admin page: one HTML page and its script, served by the Worker,
 * talking to /admin/api. Plain DOM, no framework and no build step. Text from
 * posts is only ever set with textContent - never innerHTML - so a post can't
 * inject markup into the page that edits it.
 */

export const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ash news</title>
<style>
  :root { color-scheme: dark; --bg:#0d0d0f; --fill:#18181c; --line:#2a2a30; --text:#f2f2f2; --text2:#a8a8b0; --green:#2fbf71; --red:#e5484d; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--text); }
  header { padding: 14px 20px; border-bottom: 1px solid var(--line); display: flex; gap: 12px; align-items: center; }
  header h1 { font-size: 16px; margin: 0; flex: 1; }
  main { display: grid; grid-template-columns: 280px 1fr 1fr; min-height: calc(100vh - 53px); }
  aside { border-right: 1px solid var(--line); padding: 12px; overflow: auto; }
  section { padding: 16px 20px; overflow: auto; }
  section + section { border-left: 1px solid var(--line); }
  button, select, input, textarea { font: inherit; color: inherit; background: var(--fill); border: 1px solid var(--line); border-radius: 8px; padding: 7px 10px; }
  button { cursor: pointer; }
  button.primary { background: var(--green); border-color: var(--green); color: #000; font-weight: 600; }
  button.danger { color: var(--red); }
  .post { display: block; width: 100%; text-align: left; margin-bottom: 6px; }
  .post.selected { border-color: var(--text2); }
  .post small { display: block; color: var(--text2); }
  label { display: block; margin: 0 0 12px; color: var(--text2); }
  label > * { display: block; width: 100%; margin-top: 4px; color: var(--text); }
  textarea { min-height: 360px; resize: vertical; font-family: ui-monospace, monospace; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0 16px; }
  .chip { display: inline-block; padding: 2px 8px; border-radius: 6px; background: var(--fill); color: var(--text2); font-size: 12px; }
  #preview img { max-width: 100%; border-radius: 10px; }
  #status { color: var(--text2); }
</style>
</head>
<body>
<header><h1>ash news</h1><span id="status"></span>
  <input id="feedback" placeholder="Feedback link: https://discord.gg/..." size="34" title="The Discord invite behind the launcher's Send feedback">
  <button id="saveFeedback">Save link</button>
  <button id="new" class="primary">New post</button></header>
<main>
  <aside id="list"></aside>
  <section id="editor" hidden>
    <label>Kind <select id="kind"><option value="news">News</option><option value="patch_notes">Patch notes</option></select></label>
    <label>Title <input id="title" maxlength="120"></label>
    <label>Body (headings with ##, **bold**, *italic*, - lists, 1. lists, [links](https://...)) <textarea id="body"></textarea></label>
    <label>Cover image (PNG, JPEG or WebP, up to 2 MB) <input id="cover" type="file" accept="image/png,image/jpeg,image/webp"></label>
    <div class="row">
      <button id="save" class="primary">Save</button>
      <button id="publish">Publish</button>
      <button id="removeCover">Remove cover</button>
      <button id="delete" class="danger">Delete post</button>
    </div>
  </section>
  <section><div class="chip">Preview</div><div id="preview"></div></section>
</main>
<script src="/admin/app.js"></script>
</body>
</html>`;

export const ADMIN_JS = `"use strict";
const $ = (id) => document.getElementById(id);
let posts = [];
let current = null;

function status(text) { $("status").textContent = text; }

async function api(method, path, body, contentType) {
  const response = await fetch("/admin/api" + path, {
    method,
    headers: body === undefined ? {} : { "content-type": contentType || "application/json" },
    body: body === undefined ? undefined : contentType ? body : JSON.stringify(body),
  });
  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ? data.error.message : response.statusText);
  return data;
}

function el(tag, text, cls) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}

// The same subset the launcher renders: headings, paragraphs, lists,
// **bold**, *italic*, [links](https://...). Built as DOM, never as HTML.
function inline(parent, text) {
  const pattern = /(\\*\\*[^*]+\\*\\*|\\*[^*]+\\*|_[^_]+_|\\[[^\\]]+\\]\\(https:\\/\\/[^)\\s]+\\))/;
  for (const part of text.split(pattern)) {
    if (!part) continue;
    let m;
    if ((m = /^\\*\\*([^*]+)\\*\\*$/.exec(part))) parent.append(el("strong", m[1]));
    else if ((m = /^(?:\\*([^*]+)\\*|_([^_]+)_)$/.exec(part))) parent.append(el("em", m[1] || m[2]));
    else if ((m = /^\\[([^\\]]+)\\]\\((https:\\/\\/[^)\\s]+)\\)$/.exec(part))) {
      const a = el("a", m[1]); a.href = m[2]; a.target = "_blank"; a.rel = "noopener"; parent.append(a);
    } else parent.append(document.createTextNode(part));
  }
}

function render(markdown, into) {
  into.replaceChildren();
  const lines = markdown.replace(/\\r/g, "").split("\\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = /^(#{1,3})\\s+(.*)$/.exec(line))) { const h = el(m[1].length === 3 ? "h4" : "h3"); inline(h, m[2]); into.append(h); i++; continue; }
    if (/^\\s*([-*]|\\d+\\.)\\s+/.test(line)) {
      const ordered = /^\\s*\\d+\\./.test(line);
      const list = el(ordered ? "ol" : "ul");
      while (i < lines.length && /^\\s*([-*]|\\d+\\.)\\s+/.test(lines[i])) {
        const li = el("li"); inline(li, lines[i].replace(/^\\s*([-*]|\\d+\\.)\\s+/, "")); list.append(li); i++;
      }
      into.append(list); continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3})\\s|^\\s*([-*]|\\d+\\.)\\s+/.test(lines[i])) { para.push(lines[i].trim()); i++; }
    const p = el("p"); inline(p, para.join(" ")); into.append(p);
  }
}

function preview() {
  const box = $("preview");
  box.replaceChildren();
  if (!current) return;
  if (current.cover_url) { const img = el("img"); img.src = current.cover_url; box.append(img); }
  box.append(el("div", $("kind").value === "news" ? "News" : "Patch notes", "chip"));
  box.append(el("h2", $("title").value));
  const body = el("div"); render($("body").value, body); box.append(body);
}

function show() {
  const list = $("list");
  list.replaceChildren();
  for (const post of posts) {
    const b = el("button", post.title, "post" + (current && current.id === post.id ? " selected" : ""));
    b.append(el("small", (post.kind === "news" ? "News" : "Patch notes") + " · " + (post.published_at ? "published " + new Date(post.published_at).toLocaleString() : "draft")));
    b.onclick = () => open(post);
    list.append(b);
  }
  $("editor").hidden = !current;
  if (current) $("publish").textContent = current.published_at ? "Unpublish" : "Publish";
  preview();
}

function open(post) {
  current = post;
  $("kind").value = post.kind; $("title").value = post.title; $("body").value = post.body; $("cover").value = "";
  show();
}

function replace(post) {
  posts = posts.some((p) => p.id === post.id) ? posts.map((p) => (p.id === post.id ? post : p)) : [post, ...posts];
  current = post;
  show();
}

async function load() { posts = (await api("GET", "/posts")).posts; show(); }

async function guard(work, done) {
  try { await work(); status(done); } catch (e) { status("Failed: " + e.message); }
}

const draft = () => ({ kind: $("kind").value, title: $("title").value, body: $("body").value });

$("new").onclick = () => guard(async () => replace((await api("POST", "/posts", { kind: "news", title: "Untitled", body: "" })).post), "New draft");
$("save").onclick = () => guard(async () => replace((await api("PUT", "/posts/" + current.id, draft())).post), "Saved");
$("publish").onclick = () => guard(async () => {
  await api("PUT", "/posts/" + current.id, draft());
  replace((await api("POST", "/posts/" + current.id + (current.published_at ? "/unpublish" : "/publish"))).post);
}, "Done");
$("delete").onclick = () => {
  if (!confirm("Delete this post for good?")) return;
  guard(async () => { await api("DELETE", "/posts/" + current.id); posts = posts.filter((p) => p.id !== current.id); current = null; show(); }, "Deleted");
};
$("cover").onchange = () => {
  const file = $("cover").files[0];
  if (file) guard(async () => replace((await api("PUT", "/posts/" + current.id + "/cover", file, file.type)).post), "Cover uploaded");
};
$("removeCover").onclick = () => guard(async () => replace((await api("DELETE", "/posts/" + current.id + "/cover")).post), "Cover removed");
for (const id of ["kind", "title", "body"]) $(id).oninput = preview;

$("saveFeedback").onclick = () => guard(async () => {
  const url = $("feedback").value.trim();
  $("feedback").value = (await api("PUT", "/links", { feedback_url: url === "" ? null : url })).feedback_url ?? "";
}, "Feedback link saved");

guard(async () => { await load(); $("feedback").value = (await api("GET", "/links")).feedback_url ?? ""; }, "");
`;
