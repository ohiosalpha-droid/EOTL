const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const svg = (paths, size = 16) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const ICONS = {
  copy: svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>'),
  check: svg('<path d="m5 12 5 5 9-10"/>'),
  retry: svg('<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16M3 21v-5h5"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  download: svg('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  open: svg('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>', 18),
  spark: '<svg class="spark" viewBox="0 0 24 24"><use href="#i-spark"/></svg>',
};

const load = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
};
let chats = load("eotl-chats", []);
let projects = load("eotl-projects", []);
let images = load("eotl-images", []);
chats.forEach((c) => { c.projectId ??= null; c.updated ??= Date.now(); });

function persist() {
  localStorage.setItem("eotl-chats", JSON.stringify(chats));
  localStorage.setItem("eotl-projects", JSON.stringify(projects));
  localStorage.setItem("eotl-images", JSON.stringify(images));
}

const state = { view: "chat", chatId: null, draftProjectId: null, openProjectId: null, pendingImages: [], busy: false, imgBusy: false };

const messagesEl = $("#messages");
const inputEl = $("#input");
const sendBtn = $("#send");

marked.setOptions({ gfm: true, breaks: true });

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const currentChat = () => chats.find((c) => c.id === state.chatId);
const projectById = (id) => projects.find((p) => p.id === id);

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "gerade eben";
  if (s < 3600) return `vor ${Math.floor(s / 60)} Min.`;
  if (s < 86400) return `vor ${Math.floor(s / 3600)} Std.`;
  const d = Math.floor(s / 86400);
  return d === 1 ? "gestern" : `vor ${d} Tagen`;
}

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return "Gute Nacht";
  if (h < 11) return "Guten Morgen";
  if (h < 18) return "Guten Tag";
  return "Guten Abend";
}

/* ---------- Rendering helpers ---------- */
function renderMarkdown(text) {
  const tpl = document.createElement("div");
  tpl.innerHTML = DOMPurify.sanitize(marked.parse(text || ""));
  tpl.querySelectorAll("pre > code").forEach((code) => {
    const lang = (code.className.match(/language-([\w+#-]+)/) || [])[1] || "code";
    hljs.highlightElement(code);
    const block = document.createElement("div");
    block.className = "code-block";
    block.innerHTML = `<div class="code-head"><span>${esc(lang)}</span><button type="button" class="copy-code">${ICONS.copy}Kopieren</button></div>`;
    const pre = code.parentElement;
    pre.replaceWith(block);
    block.appendChild(pre);
  });
  return tpl.innerHTML;
}

function imageActions(url) {
  return `<div class="img-actions"><a href="${esc(url)}" download>${ICONS.download}Herunterladen</a><a href="${esc(url)}" target="_blank" rel="noopener">${ICONS.open}Öffnen</a></div>`;
}

function fillBody(body, msg) {
  if (msg.role === "user") {
    const imgs = (msg.images || []).map((u) => `<img src="${esc(u)}" alt="Anhang" />`).join("");
    body.innerHTML = (imgs ? `<div class="user-images">${imgs}</div>` : "") + esc(msg.content);
    return;
  }
  let html = msg.content ? renderMarkdown(msg.content) : "";
  for (const img of msg.generated || []) {
    html += `<div class="gen-image"><img src="${esc(img.url)}" alt="${esc(img.prompt)}" />${imageActions(img.url)}</div>`;
  }
  if (msg.status) html += `<div class="thinking">${ICONS.spark}<span class="shimmer">${esc(msg.status)}</span></div>`;
  if (msg.errorText) html += `<div class="error-text">${esc(msg.errorText)}</div>`;
  body.innerHTML = html;
  body.classList.toggle("streaming", !!msg.pending && !msg.status && !!msg.content);
}

function messageEl(msg, isLast) {
  const el = document.createElement("div");
  el.className = `msg ${msg.role}`;
  const body = document.createElement("div");
  body.className = "body";
  el.appendChild(body);
  fillBody(body, msg);
  if (msg.role === "assistant" && !msg.pending) {
    const actions = document.createElement("div");
    actions.className = "msg-actions";
    actions.innerHTML =
      `<button class="icon-btn act-copy" title="Kopieren">${ICONS.copy}</button>` +
      (isLast ? `<button class="icon-btn act-retry" title="Neu generieren">${ICONS.retry}</button>` : "");
    el.appendChild(actions);
  }
  return el;
}

/* ---------- Views ---------- */
function showView(view) {
  state.view = view;
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  $$("#sidebar .nav[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  if (view === "chat") renderChat();
  if (view === "chats") renderChatsView();
  if (view === "projekte") renderProjectsView();
  if (view === "bilder") renderGallery();
  renderTopbar();
  renderSidebar();
  if (window.innerWidth < 820) document.body.classList.add("collapsed");
}

function renderTopbar() {
  const el = $("#topbar-title");
  const chat = currentChat();
  if (state.view !== "chat" || !chat || !chat.messages.length) { el.innerHTML = ""; return; }
  const p = projectById(chat.projectId);
  el.innerHTML = (p ? `<span class="proj">${esc(p.name)} / </span>` : "") + esc(chat.title);
}

function renderSidebar() {
  const list = $("#recent");
  list.innerHTML = "";
  const recent = chats.slice(0, 20);
  if (!recent.length) list.innerHTML = `<li class="empty">Noch keine Chats</li>`;
  for (const c of recent) {
    const li = document.createElement("li");
    li.textContent = c.title;
    li.title = c.title;
    li.classList.toggle("active", state.view === "chat" && c.id === state.chatId);
    li.onclick = () => openChat(c.id);
    list.appendChild(li);
  }
}

function renderChat() {
  const chat = currentChat();
  const has = !!(chat && chat.messages.length);
  $("#view-chat").classList.toggle("empty", !has);
  $("#greeting-text").textContent = greeting();
  const project = projectById(chat ? chat.projectId : state.draftProjectId);
  $("#project-badge").hidden = !project;
  if (project) $("#project-badge span").textContent = project.name;
  messagesEl.innerHTML = "";
  if (has) {
    chat.messages.forEach((m, i) => messagesEl.appendChild(messageEl(m, i === chat.messages.length - 1)));
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  renderTopbar();
}

function openChat(id) {
  state.chatId = id;
  state.draftProjectId = null;
  showView("chat");
  inputEl.focus();
}

function newChat(projectId = null) {
  state.chatId = null;
  state.draftProjectId = projectId;
  showView("chat");
  inputEl.focus();
}

function deleteChat(id) {
  if (!confirm("Diesen Chat wirklich löschen?")) return;
  chats = chats.filter((c) => c.id !== id);
  if (state.chatId === id) state.chatId = null;
  persist();
  showView(state.view);
}

function chatRow(c, i) {
  const p = projectById(c.projectId);
  const row = document.createElement("div");
  row.className = "chat-row";
  row.style.animationDelay = `${Math.min(i, 12) * 25}ms`;
  row.innerHTML = `<div class="chat-row-main"><div class="chat-row-title">${esc(c.title)}</div>
    <div class="chat-row-meta">${p ? esc(p.name) + " · " : ""}Zuletzt ${timeAgo(c.updated)}</div></div>
    <button class="icon-btn danger" title="Löschen">${ICONS.trash}</button>`;
  row.onclick = (e) => (e.target.closest("button") ? deleteChat(c.id) : openChat(c.id));
  return row;
}

function renderChatsView() {
  const q = $("#chat-search").value.trim().toLowerCase();
  const list = $("#all-chats");
  const filtered = chats.filter((c) => c.title.toLowerCase().includes(q));
  $("#chats-count").textContent = `${chats.length} ${chats.length === 1 ? "Chat" : "Chats"}`;
  list.innerHTML = filtered.length ? "" : `<div class="empty-state">${q ? "Keine Chats gefunden." : "Noch keine Chats. Starte einen neuen Chat."}</div>`;
  filtered.forEach((c, i) => list.appendChild(chatRow(c, i)));
}

function renderProjectsView() {
  const p = projectById(state.openProjectId);
  $("#projects-overview").hidden = !!p;
  $("#project-detail").hidden = !p;
  if (!p) {
    const grid = $("#projects-grid");
    grid.innerHTML = projects.length ? "" : `<div class="empty-state" style="grid-column:1/-1">Noch keine Projekte. Lege dein erstes Projekt an.</div>`;
    projects.forEach((proj, i) => {
      const count = chats.filter((c) => c.projectId === proj.id).length;
      const card = document.createElement("div");
      card.className = "card project-card";
      card.style.animationDelay = `${i * 40}ms`;
      card.innerHTML = `<div class="pc-title">${ICONS.folder}${esc(proj.name)}</div>
        <div class="pc-desc">${esc(proj.description || "")}</div>
        <div class="pc-meta">${count} ${count === 1 ? "Chat" : "Chats"} · erstellt ${timeAgo(proj.created)}</div>`;
      card.onclick = () => { state.openProjectId = proj.id; renderProjectsView(); };
      grid.appendChild(card);
    });
    return;
  }
  $("#pd-name").textContent = p.name;
  $("#pd-desc").textContent = p.description || "";
  $("#pd-instructions").value = p.instructions || "";
  $("#pd-saved").textContent = "";
  const list = $("#pd-chats");
  const pc = chats.filter((c) => c.projectId === p.id);
  list.innerHTML = pc.length ? "" : `<div class="empty-state">Noch keine Chats in diesem Projekt.</div>`;
  pc.forEach((c, i) => list.appendChild(chatRow(c, i)));
}

function renderGallery() {
  const g = $("#gallery");
  g.innerHTML = "";
  if (state.imgBusy) {
    g.insertAdjacentHTML("beforeend", `<figure class="tile loading"><div class="thinking">${ICONS.spark}<span>Erstelle Bild …</span></div></figure>`);
  }
  if (!images.length && !state.imgBusy) {
    g.innerHTML = `<div class="empty-state" style="grid-column:1/-1">Hier erscheinen deine erstellten Bilder.</div>`;
    return;
  }
  images.forEach((img, i) => {
    const fig = document.createElement("figure");
    fig.className = "tile";
    fig.style.animationDelay = `${Math.min(i, 12) * 30}ms`;
    fig.innerHTML = `<img src="${esc(img.url)}" alt="${esc(img.prompt)}" loading="lazy" />
      <figcaption><p>${esc(img.prompt)}</p>${imageActions(img.url)}</figcaption>`;
    g.appendChild(fig);
  });
}

/* ---------- Chat logic ---------- */
function setBusy(b) {
  state.busy = b;
  updateSendState();
}

function updateSendState() {
  sendBtn.disabled = state.busy || (!inputEl.value.trim() && !state.pendingImages.length);
}

function apiHistory(messages) {
  return messages
    .filter((m) => m.content || (m.generated || []).length || (m.images || []).length)
    .map((m) => {
      let content = m.content || "";
      for (const g of m.generated || []) content += `\n[Bild erstellt: ${g.prompt}]`;
      return { role: m.role, content: content.trim(), images: m.images || [] };
    });
}

async function send(text) {
  text = text.trim();
  if ((!text && !state.pendingImages.length) || state.busy) return;
  let chat = currentChat();
  if (!chat) {
    const title = (text || "Bildanalyse").replace(/\s+/g, " ");
    chat = { id: uid(), title: title.length > 48 ? title.slice(0, 48) + " …" : title, projectId: state.draftProjectId, messages: [], updated: Date.now() };
    chats.unshift(chat);
    state.chatId = chat.id;
    state.draftProjectId = null;
  }
  chat.messages.push({ role: "user", content: text, images: state.pendingImages.map((p) => p.url) });
  state.pendingImages = [];
  renderAttachments();
  inputEl.value = "";
  autoResize();
  await respond(chat);
}

async function respond(chat) {
  chat.updated = Date.now();
  chats = [chat, ...chats.filter((c) => c.id !== chat.id)];
  const bot = { role: "assistant", content: "", generated: [], pending: true, status: "EOTL denkt nach" };
  chat.messages.push(bot);
  persist();
  renderSidebar();
  renderChat();
  const body = $(".body", messagesEl.lastElementChild);
  let frame = 0;
  const update = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 160;
      fillBody(body, bot);
      if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  };
  setBusy(true);
  try {
    await streamChat(chat, bot, update);
  } catch (err) {
    bot.errorText = err.message;
  } finally {
    cancelAnimationFrame(frame);
    delete bot.pending;
    delete bot.status;
    persist();
    setBusy(false);
    if (state.view === "chat" && state.chatId === chat.id) renderChat();
  }
}

async function streamChat(chat, bot, update) {
  const project = projectById(chat.projectId);
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: apiHistory(chat.messages.slice(0, -1).filter((m) => !m.errorText || m.content)),
      mode: $("#style-select").value,
      instructions: project?.instructions || "",
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || `Serverfehler (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop();
    for (const raw of events) {
      if (!raw.startsWith("data: ")) continue;
      const ev = JSON.parse(raw.slice(6));
      if (ev.type === "text") {
        delete bot.status;
        bot.content += ev.text;
      } else if (ev.type === "status") {
        bot.status = ev.text.replace(/\s*…$/, "");
      } else if (ev.type === "image") {
        delete bot.status;
        bot.generated.push({ url: ev.url, prompt: ev.prompt });
        images.unshift({ url: ev.url, prompt: ev.prompt, created: Date.now() });
      } else if (ev.type === "error") {
        throw new Error(ev.text);
      }
      update();
    }
  }
}

messagesEl.addEventListener("click", (e) => {
  const flash = (btn, html) => {
    const old = btn.innerHTML;
    btn.innerHTML = html;
    setTimeout(() => (btn.innerHTML = old), 1500);
  };
  const codeBtn = e.target.closest(".copy-code");
  if (codeBtn) {
    navigator.clipboard.writeText(codeBtn.closest(".code-block").querySelector("code").innerText);
    flash(codeBtn, `${ICONS.check}Kopiert`);
    return;
  }
  const copyBtn = e.target.closest(".act-copy");
  if (copyBtn) {
    const idx = $$(".msg", messagesEl).indexOf(copyBtn.closest(".msg"));
    navigator.clipboard.writeText(currentChat().messages[idx].content || "");
    flash(copyBtn, ICONS.check);
    return;
  }
  if (e.target.closest(".act-retry") && !state.busy) {
    const chat = currentChat();
    if (chat.messages.at(-1)?.role === "assistant") chat.messages.pop();
    respond(chat);
  }
});

/* ---------- Composer ---------- */
function autoResize() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 240) + "px";
  updateSendState();
}

function renderAttachments() {
  const el = $("#attachments");
  el.innerHTML = "";
  state.pendingImages.forEach((img, i) => {
    const div = document.createElement("div");
    div.className = "thumb";
    div.innerHTML = `<img src="${esc(img.url)}" alt="Anhang" /><button type="button" title="Entfernen">&times;</button>`;
    div.querySelector("button").onclick = () => {
      state.pendingImages.splice(i, 1);
      renderAttachments();
    };
    el.appendChild(div);
  });
  updateSendState();
}

$("#file-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/upload", { method: "POST", body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return alert(data.detail || "Upload fehlgeschlagen.");
  state.pendingImages.push({ url: data.url });
  renderAttachments();
});

$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  send(inputEl.value);
});
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send(inputEl.value);
  }
});
inputEl.addEventListener("input", autoResize);

$$("#chips button").forEach((b) => {
  b.onclick = () => {
    if (b.dataset.view) return showView(b.dataset.view);
    inputEl.value = b.dataset.text;
    autoResize();
    inputEl.focus();
  };
});

/* ---------- Sidebar & navigation ---------- */
$("#new-chat").onclick = () => newChat();
$("#chats-new").onclick = () => newChat();
$$("#sidebar .nav[data-view]").forEach((b) => (b.onclick = () => {
  if (b.dataset.view === "projekte") state.openProjectId = null;
  showView(b.dataset.view);
}));
$("#collapse").onclick = () => document.body.classList.add("collapsed");
$("#open-sidebar").onclick = () => document.body.classList.remove("collapsed");
$("#chat-search").addEventListener("input", renderChatsView);

/* ---------- Projects ---------- */
const dialog = $("#project-dialog");
$("#new-project").onclick = () => {
  $("#project-form").reset();
  dialog.showModal();
  $("#pf-name").focus();
};
$("#pf-cancel").onclick = () => dialog.close();
$("#project-form").addEventListener("submit", () => {
  const name = $("#pf-name").value.trim();
  if (!name) return;
  const p = { id: uid(), name, description: $("#pf-desc").value.trim(), instructions: $("#pf-instructions").value.trim(), created: Date.now() };
  projects.unshift(p);
  persist();
  state.openProjectId = p.id;
  renderProjectsView();
});
$("#pd-back").onclick = () => { state.openProjectId = null; renderProjectsView(); };
$("#pd-new-chat").onclick = () => newChat(state.openProjectId);
$("#pd-delete").onclick = () => {
  const p = projectById(state.openProjectId);
  if (!p || !confirm(`Projekt „${p.name}“ löschen? Die Chats bleiben erhalten.`)) return;
  projects = projects.filter((x) => x.id !== p.id);
  chats.forEach((c) => { if (c.projectId === p.id) c.projectId = null; });
  persist();
  state.openProjectId = null;
  renderProjectsView();
};
let saveTimer;
$("#pd-instructions").addEventListener("input", (e) => {
  const p = projectById(state.openProjectId);
  if (!p) return;
  p.instructions = e.target.value;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { persist(); $("#pd-saved").textContent = "Gespeichert"; }, 400);
});

/* ---------- Images ---------- */
$("#img-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const prompt = $("#img-prompt").value.trim();
  if (!prompt || state.imgBusy) return;
  state.imgBusy = true;
  $("#img-submit").disabled = true;
  $("#img-error").hidden = true;
  renderGallery();
  try {
    const res = await fetch("/api/bild", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, groesse: $("#img-size").value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "Bild konnte nicht erstellt werden.");
    images.unshift({ url: data.url, prompt, created: Date.now() });
    persist();
    $("#img-prompt").value = "";
  } catch (err) {
    $("#img-error").textContent = err.message;
    $("#img-error").hidden = false;
  } finally {
    state.imgBusy = false;
    $("#img-submit").disabled = false;
    renderGallery();
  }
});
$("#img-prompt").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("#img-form").requestSubmit();
  }
});

/* ---------- Status ---------- */
async function loadStatus() {
  const el = $("#status");
  try {
    const s = await (await fetch("/api/status")).json();
    el.innerHTML = s.key_gesetzt
      ? `<span class="dot ok"></span>Verbunden · ${esc(s.chat_modell)}`
      : `<span class="dot"></span>Kein API-Key gesetzt`;
  } catch {
    el.innerHTML = `<span class="dot"></span>Server nicht erreichbar`;
  }
}

showView("chat");
loadStatus();
inputEl.focus();
