const $ = (sel) => document.querySelector(sel);
const messagesEl = $("#messages");
const inputEl = $("#input");
const sendBtn = $("#send");
const chatListEl = $("#chat-list");
const attachmentsEl = $("#attachments");

const STORAGE_KEY = "eotl-chats";
let chats = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
let currentId = null;
let mode = "chat";
let pendingImages = [];
let busy = false;

marked.setOptions({ gfm: true, breaks: true });

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(chats));
}

function currentChat() {
  return chats.find((c) => c.id === currentId);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderMarkdown(text) {
  const html = DOMPurify.sanitize(marked.parse(text || ""));
  const tpl = document.createElement("div");
  tpl.innerHTML = html;
  tpl.querySelectorAll("pre > code").forEach((code) => {
    const lang = (code.className.match(/language-([\w+#-]+)/) || [])[1] || "code";
    hljs.highlightElement(code);
    const block = document.createElement("div");
    block.className = "code-block";
    block.innerHTML = `<div class="code-head"><span>${escapeHtml(lang)}</span><button type="button" class="copy">Kopieren</button></div>`;
    const pre = code.parentElement;
    pre.replaceWith(block);
    block.appendChild(pre);
  });
  return tpl.innerHTML;
}

messagesEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".copy");
  if (!btn) return;
  const code = btn.closest(".code-block").querySelector("code").innerText;
  navigator.clipboard.writeText(code).then(() => {
    btn.textContent = "Kopiert ✓";
    setTimeout(() => (btn.textContent = "Kopieren"), 1500);
  });
});

function imageHtml(url, prompt) {
  return `<div class="gen-image"><img src="${escapeHtml(url)}" alt="${escapeHtml(prompt || "Bild")}" loading="lazy" />
    <div class="actions"><a href="${escapeHtml(url)}" download>⬇ Herunterladen</a><a href="${escapeHtml(url)}" target="_blank">↗ Öffnen</a></div></div>`;
}

function messageEl(msg) {
  const el = document.createElement("div");
  el.className = `msg ${msg.role}${msg.error ? " error" : ""}`;
  const avatar = document.createElement("div");
  avatar.className = "logo avatar";
  avatar.textContent = msg.role === "user" ? "Du" : "E";
  if (msg.role === "user") avatar.style.fontSize = "11px";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  fillBubble(bubble, msg);
  el.append(avatar, bubble);
  return el;
}

function fillBubble(bubble, msg) {
  if (msg.role === "user") {
    const imgs = (msg.images || []).map((u) => `<img src="${escapeHtml(u)}" alt="Anhang" />`).join("");
    bubble.innerHTML = (imgs ? `<div class="user-images">${imgs}</div>` : "") + escapeHtml(msg.content);
    return;
  }
  let html = msg.content ? renderMarkdown(msg.content) : "";
  for (const img of msg.generated || []) html += imageHtml(img.url, img.prompt);
  if (msg.status) html += `<div class="status-line"><span class="typing"><span></span><span></span><span></span></span>${escapeHtml(msg.status)}</div>`;
  bubble.innerHTML = html;
}

function renderMessages() {
  const chat = currentChat();
  messagesEl.innerHTML = "";
  if (!chat || chat.messages.length === 0) {
    messagesEl.appendChild(welcomeTemplate.cloneNode(true));
    bindSuggestions();
    return;
  }
  chat.messages.forEach((m) => messagesEl.appendChild(messageEl(m)));
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderChatList() {
  chatListEl.innerHTML = "";
  for (const chat of chats) {
    const li = document.createElement("li");
    li.className = chat.id === currentId ? "active" : "";
    li.innerHTML = `<span class="title">${escapeHtml(chat.title)}</span><button class="del" title="Löschen">✕</button>`;
    li.addEventListener("click", (e) => {
      if (e.target.closest(".del")) {
        chats = chats.filter((c) => c.id !== chat.id);
        if (currentId === chat.id) currentId = null;
        save();
        renderChatList();
        renderMessages();
        return;
      }
      currentId = chat.id;
      renderChatList();
      renderMessages();
    });
    chatListEl.appendChild(li);
  }
}

function newChat() {
  currentId = null;
  renderChatList();
  renderMessages();
  inputEl.focus();
}

function ensureChat(firstText) {
  let chat = currentChat();
  if (!chat) {
    chat = { id: crypto.randomUUID(), title: (firstText || "Neuer Chat").slice(0, 40), messages: [] };
    chats.unshift(chat);
    currentId = chat.id;
  }
  return chat;
}

function setMode(m) {
  mode = m;
  document.querySelectorAll(".mode").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
  inputEl.placeholder = {
    chat: "Nachricht an EOTL …",
    code: "Beschreibe, was EOTL programmieren soll …",
    bild: "Beschreibe das Bild, das EOTL erstellen soll …",
  }[m];
}

function setBusy(b) {
  busy = b;
  sendBtn.disabled = b;
}

function apiHistory(chat) {
  return chat.messages
    .filter((m) => !m.error && (m.content || (m.generated || []).length || (m.images || []).length))
    .map((m) => {
      let content = m.content || "";
      for (const g of m.generated || []) content += `\n[Bild erstellt: ${g.prompt}]`;
      return { role: m.role, content: content.trim(), images: m.images || [] };
    });
}

async function send(text) {
  text = text.trim();
  if ((!text && pendingImages.length === 0) || busy) return;
  const chat = ensureChat(text || "Bildanalyse");
  const userMsg = { role: "user", content: text, images: pendingImages.map((p) => p.url) };
  chat.messages.push(userMsg);
  pendingImages = [];
  renderAttachments();
  inputEl.value = "";
  autoResize();
  save();
  renderChatList();
  renderMessages();

  const botMsg = { role: "assistant", content: "", generated: [], status: "EOTL denkt nach …" };
  chat.messages.push(botMsg);
  const el = messageEl(botMsg);
  messagesEl.appendChild(el);
  const bubble = el.querySelector(".bubble");
  const update = () => {
    fillBubble(bubble, botMsg);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  };
  update();
  setBusy(true);

  try {
    if (mode === "bild") {
      botMsg.status = "Erstelle Bild …";
      update();
      const res = await fetch("/api/bild", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Bild konnte nicht erstellt werden.");
      botMsg.generated.push({ url: data.url, prompt: data.prompt });
    } else {
      await streamChat(chat, botMsg, update);
    }
  } catch (err) {
    botMsg.content += (botMsg.content ? "\n\n" : "") + `⚠️ ${err.message}`;
    botMsg.error = !botMsg.generated.length && botMsg.content.startsWith("⚠️");
  } finally {
    delete botMsg.status;
    if (botMsg.error) el.classList.add("error");
    update();
    save();
    setBusy(false);
  }
}

async function streamChat(chat, botMsg, update) {
  const history = apiHistory({ messages: chat.messages.slice(0, -1) });
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: history, mode }),
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
        delete botMsg.status;
        botMsg.content += ev.text;
      } else if (ev.type === "status") {
        botMsg.status = ev.text;
      } else if (ev.type === "image") {
        delete botMsg.status;
        botMsg.generated.push({ url: ev.url, prompt: ev.prompt });
      } else if (ev.type === "error") {
        throw new Error(ev.text);
      }
      update();
    }
  }
}

function autoResize() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 220) + "px";
}

function renderAttachments() {
  attachmentsEl.innerHTML = "";
  pendingImages.forEach((img, i) => {
    const div = document.createElement("div");
    div.className = "thumb";
    div.innerHTML = `<img src="${escapeHtml(img.url)}" alt="Anhang" /><button type="button" title="Entfernen">✕</button>`;
    div.querySelector("button").onclick = () => {
      pendingImages.splice(i, 1);
      renderAttachments();
    };
    attachmentsEl.appendChild(div);
  });
}

$("#file-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/upload", { method: "POST", body: form });
  const data = await res.json();
  if (!res.ok) return alert(data.detail || "Upload fehlgeschlagen.");
  pendingImages.push({ url: data.url });
  if (mode === "bild") setMode("chat");
  renderAttachments();
});

function bindSuggestions() {
  messagesEl.querySelectorAll(".suggestions button").forEach((b) => {
    b.onclick = () => {
      setMode(b.dataset.mode);
      send(b.dataset.text);
    };
  });
}

$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  send(inputEl.value);
});
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send(inputEl.value);
  }
});
inputEl.addEventListener("input", autoResize);
document.querySelectorAll(".mode").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
$("#new-chat").onclick = newChat;
$("#toggle-sidebar").onclick = () => $("#sidebar").classList.toggle("hidden");

async function loadStatus() {
  try {
    const s = await (await fetch("/api/status")).json();
    $("#status").innerHTML = s.key_gesetzt
      ? `<span class="dot ok"></span>Verbunden · ${escapeHtml(s.chat_modell)}`
      : `<span class="dot"></span>Kein API-Key gesetzt`;
  } catch {
    $("#status").innerHTML = `<span class="dot"></span>Server nicht erreichbar`;
  }
}

const welcomeTemplate = $("#welcome").cloneNode(true);
renderChatList();
renderMessages();
loadStatus();
inputEl.focus();
