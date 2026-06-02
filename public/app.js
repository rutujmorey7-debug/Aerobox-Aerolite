const DOMAIN = "aerobox.com";
const LOCAL_API_BASE = "http://localhost:4100";
const API_BASE = resolveApiBase();

const state = {
  token: localStorage.getItem("aerobox_token") || "",
  user: null,
  counts: {},
  folder: "inbox",
  category: "primary",
  mails: [],
  activeMailId: "",
  activeMail: null,
  selectedMailId: "",
  socket: null,
  draftId: "",
  search: "",
  chatMessages: []
};

const ui = {};
const folderLabels = {
  inbox: "Inbox",
  starred: "Starred",
  sent: "Sent",
  drafts: "Drafts",
  archive: "Archive",
  spam: "Spam",
  trash: "Trash"
};

let searchTimer = null;
let socketScriptPromise = null;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  cacheElements();
  bindEvents();
  await delay(1150);

  if (state.token) {
    try {
      await bootstrapWithToken();
      return;
    } catch {
      clearSession();
      showToast("Session expired. Sign in again.", "error");
    }
  }

  showAuth();
}

function cacheElements() {
  ui.splash = document.getElementById("splash-screen");
  ui.authShell = document.getElementById("auth-shell");
  ui.appShell = document.getElementById("app-shell");
  ui.signinTab = document.getElementById("signin-tab");
  ui.signupTab = document.getElementById("signup-tab");
  ui.signinForm = document.getElementById("signin-form");
  ui.signupForm = document.getElementById("signup-form");
  ui.signinEmail = document.getElementById("signin-email");
  ui.signinPassword = document.getElementById("signin-password");
  ui.signupName = document.getElementById("signup-name");
  ui.signupHandle = document.getElementById("signup-handle");
  ui.signupPassword = document.getElementById("signup-password");
  ui.handlePreview = document.getElementById("handle-preview");
  ui.logoutBtn = document.getElementById("logout-btn");
  ui.refreshBtn = document.getElementById("refresh-btn");
  ui.searchInput = document.getElementById("mail-search");
  ui.folderButtons = Array.from(document.querySelectorAll(".folder-btn[data-folder]"));
  ui.categoryTabs = Array.from(document.querySelectorAll(".category-tab"));
  ui.categoryTabsShell = document.getElementById("category-tabs");
  ui.folderTitle = document.getElementById("folder-title");
  ui.mailCountCaption = document.getElementById("mail-count-caption");
  ui.mailList = document.getElementById("mail-list");
  ui.mailDetail = document.getElementById("mail-detail");
  ui.composeBtn = document.getElementById("compose-btn");
  ui.composeModal = document.getElementById("compose-modal");
  ui.composeTitle = document.getElementById("compose-title");
  ui.closeCompose = document.getElementById("close-compose");
  ui.minimizeCompose = document.getElementById("minimize-compose");
  ui.composeTo = document.getElementById("compose-to");
  ui.composeSubject = document.getElementById("compose-subject");
  ui.composeBody = document.getElementById("compose-body");
  ui.saveDraftBtn = document.getElementById("save-draft-btn");
  ui.sendMailBtn = document.getElementById("send-mail-btn");
  ui.sidebarAvatar = document.getElementById("sidebar-avatar");
  ui.headerAvatar = document.getElementById("header-avatar");
  ui.headerName = document.getElementById("header-name");
  ui.sidebarUserName = document.getElementById("sidebar-user-name");
  ui.sidebarUserEmail = document.getElementById("sidebar-user-email");
  ui.accountEmail = document.getElementById("account-email");
  ui.sidebarToggle = document.getElementById("sidebar-toggle");
  ui.markUnreadBtn = document.getElementById("mark-unread-btn");
  ui.archiveBtn = document.getElementById("archive-btn");
  ui.spamBtn = document.getElementById("spam-btn");
  ui.metricUnread = document.getElementById("metric-unread");
  ui.metricTotal = document.getElementById("metric-total");
  ui.chatMessages = document.getElementById("chat-messages");
  ui.chatForm = document.getElementById("chat-form");
  ui.chatInput = document.getElementById("chat-input");
  ui.openChatBtn = document.getElementById("open-chat-btn");
  ui.openProfileBtn = document.getElementById("open-profile-btn");
  ui.profileDrawer = document.getElementById("profile-drawer");
  ui.closeProfileBtn = document.getElementById("close-profile-btn");
  ui.profileForm = document.getElementById("profile-form");
  ui.profileName = document.getElementById("profile-name");
  ui.profileEmail = document.getElementById("profile-email");
  ui.profileBio = document.getElementById("profile-bio");
  ui.profileTheme = document.getElementById("profile-theme");
  ui.toastRoot = document.getElementById("toast-root");
}

function bindEvents() {
  ui.signinTab.addEventListener("click", () => setAuthTab("signin"));
  ui.signupTab.addEventListener("click", () => setAuthTab("signup"));
  ui.signupHandle.addEventListener("input", updateHandlePreview);
  ui.signinForm.addEventListener("submit", onSigninSubmit);
  ui.signupForm.addEventListener("submit", onSignupSubmit);
  ui.logoutBtn.addEventListener("click", onLogout);
  ui.refreshBtn.addEventListener("click", loadMailbox);
  ui.searchInput.addEventListener("input", onSearchChanged);
  ui.folderButtons.forEach((button) => button.addEventListener("click", () => setFolder(button.dataset.folder)));
  ui.categoryTabs.forEach((button) => button.addEventListener("click", () => setCategory(button.dataset.category)));
  ui.composeBtn.addEventListener("click", () => openCompose());
  ui.closeCompose.addEventListener("click", closeCompose);
  ui.minimizeCompose.addEventListener("click", closeCompose);
  ui.composeModal.addEventListener("click", (event) => {
    if (event.target === ui.composeModal) closeCompose();
  });
  ui.saveDraftBtn.addEventListener("click", saveDraft);
  ui.sendMailBtn.addEventListener("click", sendMail);
  ui.sidebarToggle.addEventListener("click", () => ui.appShell.classList.toggle("sidebar-collapsed"));
  ui.markUnreadBtn.addEventListener("click", () => markActiveRead(false));
  ui.archiveBtn.addEventListener("click", () => moveActiveMail("archive"));
  ui.spamBtn.addEventListener("click", () => moveActiveMail("spam"));
  ui.chatForm.addEventListener("submit", sendChatMessage);
  ui.openChatBtn.addEventListener("click", () => document.getElementById("chat-panel")?.scrollIntoView({ behavior: "smooth" }));
  ui.openProfileBtn.addEventListener("click", openProfileDrawer);
  ui.closeProfileBtn.addEventListener("click", closeProfileDrawer);
  ui.profileDrawer.addEventListener("click", (event) => {
    if (event.target === ui.profileDrawer) closeProfileDrawer();
  });
  ui.profileForm.addEventListener("submit", saveProfile);
}

function setAuthTab(tabName) {
  const signup = tabName === "signup";
  ui.signupTab.classList.toggle("active", signup);
  ui.signinTab.classList.toggle("active", !signup);
  ui.signupForm.classList.toggle("hidden", !signup);
  ui.signinForm.classList.toggle("hidden", signup);
}

function updateHandlePreview() {
  const clean = sanitizeHandle(ui.signupHandle.value) || "yourname";
  ui.handlePreview.textContent = `Your email: ${clean}@${DOMAIN}`;
}

async function onSigninSubmit(event) {
  event.preventDefault();
  const emailInput = ui.signinEmail.value.trim();
  const email = emailInput.includes("@") ? emailInput : `${sanitizeHandle(emailInput)}@${DOMAIN}`;

  try {
    const data = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password: ui.signinPassword.value })
    }, false);
    await startSession(data);
    showToast(`Welcome back, ${data.user.displayName}`, "ok");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function onSignupSubmit(event) {
  event.preventDefault();

  try {
    const data = await api("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({
        displayName: ui.signupName.value.trim(),
        handle: sanitizeHandle(ui.signupHandle.value),
        password: ui.signupPassword.value
      })
    }, false);
    await startSession(data);
    showToast(`Mailbox created: ${data.user.email}`, "ok");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function bootstrapWithToken() {
  const boot = await api("/api/bootstrap");
  state.user = boot.user;
  state.counts = boot.counts || {};
  applyUserState();
  showApp();
  connectSocket();
  await Promise.all([loadMailbox(), loadChatHistory()]);
}

async function startSession(data) {
  state.token = data.token;
  localStorage.setItem("aerobox_token", state.token);
  state.user = data.user;
  state.counts = data.counts || {};
  applyUserState();
  showApp();
  connectSocket();
  await Promise.all([loadMailbox(), loadChatHistory()]);
}

function applyUserState() {
  applyTheme(state.user?.theme);
  renderUserCard();
  renderCounts();
}

function clearSession() {
  if (state.socket) state.socket.disconnect();
  state.socket = null;
  state.token = "";
  state.user = null;
  localStorage.removeItem("aerobox_token");
}

async function onLogout() {
  try {
    if (state.token) await api("/api/auth/logout", { method: "POST" });
  } catch {
    // The browser session should still be cleared locally.
  } finally {
    clearSession();
    state.mails = [];
    showAuth();
    showToast("Signed out successfully.", "ok");
  }
}

function showAuth() {
  ui.splash.classList.add("hidden");
  ui.appShell.classList.add("hidden");
  ui.authShell.classList.remove("hidden");
  setAuthTab("signin");
}

function showApp() {
  ui.splash.classList.add("hidden");
  ui.authShell.classList.add("hidden");
  ui.appShell.classList.remove("hidden");
}

function renderUserCard() {
  if (!state.user) return;
  const initialsText = initials(state.user.displayName);
  ui.sidebarUserName.textContent = state.user.displayName;
  ui.sidebarUserEmail.textContent = state.user.email;
  ui.sidebarAvatar.textContent = initialsText;
  ui.headerAvatar.textContent = initialsText;
  ui.headerName.textContent = state.user.displayName.split(" ")[0] || "Account";
  ui.accountEmail.textContent = state.user.email;
}

function renderCounts() {
  const keys = ["inbox", "starred", "sent", "drafts", "archive", "spam", "trash", "primary", "social", "promotions", "updates"];
  keys.forEach((key) => {
    const el = document.getElementById(`count-${key}`);
    if (el) el.textContent = state.counts[key] || 0;
  });
  ui.metricUnread.textContent = state.counts.unread || 0;
  ui.metricTotal.textContent = state.mails.length || 0;
}

function setFolder(folder) {
  state.folder = folder || "inbox";
  state.activeMailId = "";
  state.activeMail = null;
  updateNavigation();
  renderMailDetailEmpty();
  loadMailbox();
}

function setCategory(category) {
  state.category = category || "primary";
  updateNavigation();
  loadMailbox();
}

function updateNavigation() {
  ui.folderButtons.forEach((button) => button.classList.toggle("active", button.dataset.folder === state.folder));
  ui.categoryTabs.forEach((button) => button.classList.toggle("active", button.dataset.category === state.category));
  ui.categoryTabsShell.classList.toggle("hidden", state.folder !== "inbox");
  ui.folderTitle.textContent = folderLabels[state.folder] || "Mailbox";
}

async function loadMailbox() {
  try {
    const params = new URLSearchParams();
    params.set("folder", state.folder);
    if (state.folder === "inbox") params.set("category", state.category);
    if (state.search) params.set("search", state.search);
    const data = await api(`/api/mails?${params.toString()}`);
    state.mails = data.mails || [];
    state.counts = data.counts || state.counts;
    renderCounts();
    renderMailList();
  } catch (error) {
    showToast(error.message, "error");
  }
}

function renderMailList() {
  ui.mailCountCaption.textContent = `${state.mails.length} message${state.mails.length === 1 ? "" : "s"}`;
  ui.metricTotal.textContent = state.mails.length;

  if (!state.mails.length) {
    ui.mailList.innerHTML = `<p class="mail-empty">No mail in ${escapeHtml(folderLabels[state.folder] || "this view")}.</p>`;
    return;
  }

  ui.mailList.innerHTML = state.mails.map((mail) => {
    const person = ["sent", "outbox", "drafts"].includes(state.folder) ? `To: ${mail.to.join(", ")}` : mail.from;
    return `
      <article class="mail-item ${mail.read ? "" : "unread"} ${mail.id === state.activeMailId ? "active" : ""}" data-mail-id="${mail.id}">
        <input class="mail-select" type="radio" name="selected-mail" ${mail.id === state.selectedMailId ? "checked" : ""} aria-label="Select message">
        <div class="mail-main">
          <div class="mail-row">
            <strong>${escapeHtml(person)}</strong>
            <span class="mail-time">${escapeHtml(formatTime(mail.updatedAt))}</span>
          </div>
          <div class="mail-subject">${escapeHtml(mail.subject)}</div>
          <div class="mail-preview">${escapeHtml(mail.preview || "(No preview)")}</div>
        </div>
        <button class="star-btn ${mail.starred ? "starred" : ""}" type="button" data-star-id="${mail.id}" title="Star">${mail.starred ? "★" : "☆"}</button>
      </article>
    `;
  }).join("");

  ui.mailList.querySelectorAll(".mail-item").forEach((item) => {
    item.addEventListener("click", async (event) => {
      const starButton = event.target.closest("[data-star-id]");
      const mailId = item.getAttribute("data-mail-id");
      if (!mailId) return;
      if (starButton) {
        event.stopPropagation();
        await toggleStar(mailId);
        return;
      }
      state.selectedMailId = mailId;
      await openMail(mailId);
    });
  });
}

async function openMail(mailId) {
  try {
    const data = await api(`/api/mails/${mailId}`);
    state.activeMailId = mailId;
    state.activeMail = data.mail;
    renderMailList();
    renderMailDetail();
  } catch (error) {
    showToast(error.message, "error");
  }
}

function renderMailDetailEmpty() {
  ui.mailDetail.classList.add("empty");
  ui.mailDetail.innerHTML = `
    <div>
      <h3>Select an email</h3>
      <p>Open a message to read, reply, star, archive, report spam, or move it.</p>
    </div>
  `;
}

function renderMailDetail() {
  const mail = state.activeMail;
  if (!mail) {
    renderMailDetailEmpty();
    return;
  }

  ui.mailDetail.classList.remove("empty");
  ui.mailDetail.innerHTML = `
    <div class="mail-actions">
      <button id="reply-btn" class="primary-btn" type="button">Reply</button>
      <button id="detail-star-btn" class="ghost-btn" type="button">${mail.starred ? "Unstar" : "Star"}</button>
      <button id="detail-unread-btn" class="ghost-btn" type="button">Mark unread</button>
      <button id="detail-archive-btn" class="ghost-btn" type="button">Archive</button>
      <button id="detail-spam-btn" class="ghost-btn" type="button">Report spam</button>
      <button id="detail-trash-btn" class="ghost-btn" type="button">${mail.folder === "trash" ? "Restore" : "Move to trash"}</button>
      ${mail.folder === "drafts" ? `<button id="edit-draft-btn" class="ghost-btn" type="button">Edit draft</button>` : ""}
    </div>
    <h3>${escapeHtml(mail.subject)}</h3>
    <div class="mail-meta">
      <div><strong>From:</strong> ${escapeHtml(mail.from)}</div>
      <div><strong>To:</strong> ${escapeHtml(mail.to.join(", "))}</div>
      <div><strong>Category:</strong> ${escapeHtml(titleCase(mail.category || "primary"))}</div>
      <div><strong>Time:</strong> ${escapeHtml(formatFullTime(mail.createdAt))}</div>
    </div>
    <div class="mail-body">${escapeHtml(mail.body || "(empty)")}</div>
  `;

  document.getElementById("reply-btn")?.addEventListener("click", () => {
    const subject = mail.subject.startsWith("Re:") ? mail.subject : `Re: ${mail.subject}`;
    openCompose({ to: mail.from, subject, body: `\n\n--- Original message ---\n${mail.body}` });
  });
  document.getElementById("detail-star-btn")?.addEventListener("click", () => toggleStar(mail.id));
  document.getElementById("detail-unread-btn")?.addEventListener("click", () => markActiveRead(false));
  document.getElementById("detail-archive-btn")?.addEventListener("click", () => moveActiveMail("archive"));
  document.getElementById("detail-spam-btn")?.addEventListener("click", () => moveActiveMail("spam"));
  document.getElementById("detail-trash-btn")?.addEventListener("click", () => moveActiveMail(mail.folder === "trash" ? "inbox" : "trash"));
  document.getElementById("edit-draft-btn")?.addEventListener("click", () => {
    openCompose({ to: mail.to.join(", "), subject: mail.subject === "(No Subject)" ? "" : mail.subject, body: mail.body }, mail.id);
  });
}

async function toggleStar(mailId) {
  try {
    const data = await api(`/api/mails/${mailId}/star`, { method: "POST" });
    state.counts = data.counts || state.counts;
    await refreshAfterMailChange(mailId);
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function markActiveRead(read) {
  const mailId = state.activeMailId || state.selectedMailId;
  if (!mailId) return showToast("Select a message first.", "error");
  try {
    const data = await api(`/api/mails/${mailId}/read`, {
      method: "POST",
      body: JSON.stringify({ read })
    });
    state.counts = data.counts || state.counts;
    await refreshAfterMailChange(mailId);
    showToast(read ? "Marked as read." : "Marked as unread.", "ok");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function moveActiveMail(folder) {
  const mailId = state.activeMailId || state.selectedMailId;
  if (!mailId) return showToast("Select a message first.", "error");
  await moveMail(mailId, folder);
}

async function moveMail(mailId, folder) {
  try {
    const data = await api(`/api/mails/${mailId}/move`, {
      method: "POST",
      body: JSON.stringify({ folder })
    });
    state.counts = data.counts || state.counts;
    state.activeMail = null;
    state.activeMailId = "";
    state.selectedMailId = "";
    renderMailDetailEmpty();
    await loadMailbox();
    showToast(folder === "trash" ? "Moved to trash." : `Moved to ${folder}.`, "ok");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function refreshAfterMailChange(mailId) {
  await loadMailbox();
  if (state.activeMailId === mailId) await openMail(mailId);
  renderCounts();
}

function openCompose(prefill = {}, draftId = "") {
  state.draftId = draftId || "";
  ui.composeTitle.textContent = state.draftId ? "Edit Draft" : "New Message";
  ui.composeTo.value = prefill.to || "";
  ui.composeSubject.value = prefill.subject || "";
  ui.composeBody.value = prefill.body || "";
  ui.composeModal.classList.remove("hidden");
  ui.composeTo.focus();
}

function closeCompose() {
  state.draftId = "";
  ui.composeModal.classList.add("hidden");
  ui.composeTo.value = "";
  ui.composeSubject.value = "";
  ui.composeBody.value = "";
}

async function saveDraft() {
  try {
    const data = await api("/api/mails/draft", {
      method: "POST",
      body: JSON.stringify({
        id: state.draftId || undefined,
        to: ui.composeTo.value,
        subject: ui.composeSubject.value,
        body: ui.composeBody.value
      })
    });
    state.counts = data.counts || state.counts;
    state.draftId = data.draft?.id || state.draftId;
    renderCounts();
    if (state.folder === "drafts") await loadMailbox();
    showToast("Draft saved.", "ok");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function sendMail() {
  try {
    const data = await api("/api/mails/send", {
      method: "POST",
      body: JSON.stringify({
        to: ui.composeTo.value,
        subject: ui.composeSubject.value,
        body: ui.composeBody.value
      })
    });

    if (state.draftId) {
      await api(`/api/mails/${state.draftId}/move`, {
        method: "POST",
        body: JSON.stringify({ folder: "trash" })
      });
    }

    closeCompose();
    state.folder = "sent";
    updateNavigation();
    await loadMailbox();
    showToast(data.message || "Email sent.", data.undeliveredTo?.length ? "error" : "ok");
  } catch (error) {
    showToast(error.message, "error");
  }
}

function onSearchChanged() {
  state.search = ui.searchInput.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadMailbox, 220);
}

async function loadChatHistory() {
  try {
    const data = await api("/api/chat/messages");
    state.chatMessages = data.messages || [];
    renderChat();
  } catch (error) {
    showToast(error.message, "error");
  }
}

function renderChat() {
  if (!state.chatMessages.length) {
    ui.chatMessages.innerHTML = `<p class="mail-empty">No chat messages yet.</p>`;
    return;
  }

  ui.chatMessages.innerHTML = state.chatMessages.map((message) => `
    <article class="chat-item">
      <div class="avatar">${escapeHtml(message.senderInitials || "AB")}</div>
      <div class="chat-bubble">
        <div class="chat-name-row">
          <strong>${escapeHtml(message.senderName)}</strong>
          <span>${escapeHtml(formatTime(message.createdAt))}</span>
        </div>
        <div class="chat-text">${escapeHtml(message.body)}</div>
      </div>
    </article>
  `).join("");
  ui.chatMessages.scrollTop = ui.chatMessages.scrollHeight;
}

async function sendChatMessage(event) {
  event.preventDefault();
  const body = ui.chatInput.value.trim();
  if (!body) return;

  try {
    if (state.socket?.connected) {
      state.socket.emit("chat:send", { body });
    } else {
      await api("/api/chat/messages", { method: "POST", body: JSON.stringify({ body }) });
      await loadChatHistory();
    }
    ui.chatInput.value = "";
  } catch (error) {
    showToast(error.message, "error");
  }
}

function connectSocket() {
  if (!state.token) return;
  if (!window.io) {
    ensureSocketClient().then(connectSocket).catch(() => showToast("Realtime chat unavailable.", "error"));
    return;
  }

  if (state.socket) state.socket.disconnect();
  state.socket = API_BASE ? window.io(API_BASE, { auth: { token: state.token } }) : window.io({ auth: { token: state.token } });

  state.socket.on("session:ready", (payload) => {
    if (payload?.counts) {
      state.counts = payload.counts;
      renderCounts();
    }
  });
  state.socket.on("mail:refresh", (payload) => {
    if (payload?.counts) state.counts = payload.counts;
    renderCounts();
    loadMailbox();
  });
  state.socket.on("chat:new", (message) => {
    state.chatMessages.push(message);
    state.chatMessages = state.chatMessages.slice(-220);
    renderChat();
  });
  state.socket.on("profile:updated", (payload) => {
    if (!payload?.user || payload.user.id !== state.user?.id) return;
    state.user = payload.user;
    applyUserState();
    syncProfileForm();
  });
  state.socket.on("connect_error", () => showToast("Realtime reconnecting...", "error"));
}

function openProfileDrawer() {
  syncProfileForm();
  ui.profileDrawer.classList.remove("hidden");
}

function closeProfileDrawer() {
  ui.profileDrawer.classList.add("hidden");
}

function syncProfileForm() {
  if (!state.user) return;
  ui.profileName.value = state.user.displayName || "";
  ui.profileEmail.value = state.user.email || "";
  ui.profileBio.value = state.user.bio || "";
  ui.profileTheme.value = state.user.theme || "light";
}

async function saveProfile(event) {
  event.preventDefault();
  try {
    const data = await api("/api/profile", {
      method: "PUT",
      body: JSON.stringify({
        displayName: ui.profileName.value.trim(),
        bio: ui.profileBio.value.trim(),
        theme: ui.profileTheme.value
      })
    });
    state.user = data.user;
    applyUserState();
    closeProfileDrawer();
    showToast("Settings saved.", "ok");
  } catch (error) {
    showToast(error.message, "error");
  }
}

function applyTheme(theme) {
  document.body.dataset.theme = theme === "dusk" ? "dusk" : "light";
}

async function api(url, options = {}, useAuth = true) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (useAuth && state.token) headers.Authorization = `Bearer ${state.token}`;

  let response;
  try {
    const targetUrl = url.startsWith("http") ? url : `${API_BASE}${url}`;
    response = await fetch(targetUrl, { ...options, headers });
  } catch {
    throw new Error("Cannot reach AeroBox server. Start it with npm start and open http://localhost:4100");
  }

  const rawText = await response.text();
  let payload = {};
  try {
    payload = rawText ? JSON.parse(rawText) : {};
  } catch {
    payload = {};
  }

  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
  return payload;
}

function showToast(message, kind = "ok") {
  const toast = document.createElement("div");
  toast.className = `toast ${kind}`;
  toast.textContent = message;
  ui.toastRoot.appendChild(toast);
  setTimeout(() => toast.remove(), 3400);
}

function resolveApiBase() {
  const queryApi = new URLSearchParams(window.location.search).get("api");
  if (queryApi) return queryApi.replace(/\/+$/, "");

  const host = window.location.hostname;
  const local = host === "localhost" || host === "127.0.0.1";
  if (window.location.protocol !== "file:" && local && window.location.port) return "";

  const storedApi = localStorage.getItem("aerobox_api_base");
  if (storedApi) return storedApi.replace(/\/+$/, "");
  if (window.location.protocol === "file:") return LOCAL_API_BASE;
  return "";
}

function ensureSocketClient() {
  if (window.io) return Promise.resolve();
  if (!API_BASE) return Promise.reject(new Error("No API base found"));
  if (socketScriptPromise) return socketScriptPromise;
  socketScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${API_BASE}/socket.io/socket.io.js`;
    script.async = true;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return socketScriptPromise;
}

function sanitizeHandle(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "");
}

function initials(name) {
  const parts = String(name || "").trim().split(" ").filter(Boolean).slice(0, 2);
  return parts.length ? parts.map((part) => part[0].toUpperCase()).join("") : "AB";
}

function formatTime(dateString) {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return "";
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return "Now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatFullTime(dateString) {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function titleCase(value) {
  return String(value || "").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
