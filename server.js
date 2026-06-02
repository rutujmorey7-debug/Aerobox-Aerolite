const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "OPTIONS"]
  }
});

const PORT = Number(process.env.PORT) || 4100;
const DOMAIN = "aerobox.com";
const STORE_PATH = process.env.AEROBOX_STORE_PATH
  ? path.resolve(process.env.AEROBOX_STORE_PATH)
  : path.join(__dirname, "data", "store.json");
const INTEGRATION_SECRET = String(process.env.AEROBOX_INTEGRATION_SECRET || "").trim();

function emptyStore() {
  return {
    version: 1,
    users: [],
    sessions: [],
    mails: [],
    chats: []
  };
}

function readStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) {
      fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
      const firstStore = emptyStore();
      fs.writeFileSync(STORE_PATH, JSON.stringify(firstStore, null, 2), "utf-8");
      return firstStore;
    }

    const raw = fs.readFileSync(STORE_PATH, "utf-8");
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      ...emptyStore(),
      ...parsed,
      users: Array.isArray(parsed.users) ? parsed.users : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      mails: Array.isArray(parsed.mails) ? parsed.mails : [],
      chats: Array.isArray(parsed.chats) ? parsed.chats : []
    };
  } catch (error) {
    console.error("Failed to read store, resetting with empty data:", error.message);
    return emptyStore();
  }
}

let store = readStore();

function persistStore() {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

function nowISO() {
  return new Date().toISOString();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, "sha256").toString("hex");
  return `pbkdf2$120000$${salt}$${hash}`;
}

function legacyHashPassword(password) {
  return crypto.createHash("sha256").update(String(password)).digest("hex");
}

function verifyPassword(password, storedHash) {
  const value = String(storedHash || "");
  if (value.startsWith("pbkdf2$")) {
    const [, roundsText, salt, expected] = value.split("$");
    const rounds = Number(roundsText);
    if (!rounds || !salt || !expected) return false;
    const hash = crypto.pbkdf2Sync(String(password), salt, rounds, 32, "sha256").toString("hex");
    if (hash.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(expected, "hex"));
  }
  return value === legacyHashPassword(password);
}

function inferCategory({ from, subject, body }) {
  const text = [from, subject, body].join(" ").toLowerCase();
  if (/(sale|offer|deal|discount|promo|coupon|limited time|upgrade)/.test(text)) return "promotions";
  if (/(linkedin|facebook|instagram|twitter|x\.com|social|follow|mentioned)/.test(text)) return "social";
  if (/(receipt|invoice|otp|code|security|alert|update|notification|verify)/.test(text)) return "updates";
  return "primary";
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

function normalizeEmail(input) {
  const value = String(input || "").trim().toLowerCase();
  if (!value) return "";
  if (value.includes("@")) return value;
  return `${sanitizeHandle(value)}@${DOMAIN}`;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ""));
}

function isTrustedIntegrationRequest(req) {
  if (INTEGRATION_SECRET) {
    return req.get("x-aerobox-integration-secret") === INTEGRATION_SECRET;
  }

  const address = req.socket.remoteAddress || "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  store.sessions = store.sessions.filter((session) => session.userId !== userId);
  store.sessions.push({
    token,
    userId,
    createdAt: nowISO()
  });
  return token;
}

function publicUser(user) {
  return {
    id: user.id,
    displayName: user.displayName,
    email: user.email,
    handle: user.handle,
    bio: user.bio || "",
    theme: user.theme || "light",
    accent: user.accent || "#0a84ff",
    createdAt: user.createdAt
  };
}

function initials(name) {
  const parts = String(name || "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2);
  if (!parts.length) return "AB";
  return parts.map((part) => part[0].toUpperCase()).join("");
}

function buildPreview(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

function makeMailCopy({
  ownerId,
  folder,
  sourceId,
  from,
  to,
  subject,
  body,
  read,
  starred,
  createdAt
}) {
  const timestamp = createdAt || nowISO();
  return {
    id: crypto.randomUUID(),
    sourceId,
    ownerId,
    folder,
    from,
    to,
    subject: String(subject || "").trim() || "(No Subject)",
    body: String(body || ""),
    preview: buildPreview(body),
    category: inferCategory({ from, subject, body }),
    read: Boolean(read),
    starred: Boolean(starred),
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function parseRecipients(input) {
  const raw = Array.isArray(input) ? input.join(",") : String(input || "");
  const emails = raw
    .split(",")
    .map((chunk) => normalizeEmail(chunk))
    .filter(Boolean);
  return [...new Set(emails)];
}

function folderCountsForUser(userId) {
  const counts = {
    inbox: 0,
    outbox: 0,
    sent: 0,
    drafts: 0,
    archive: 0,
    spam: 0,
    starred: 0,
    trash: 0,
    unread: 0,
    primary: 0,
    social: 0,
    promotions: 0,
    updates: 0
  };

  for (const mail of store.mails) {
    if (mail.ownerId !== userId) continue;

    if (counts[mail.folder] !== undefined) {
      counts[mail.folder] += 1;
    }
    if (mail.folder === "outbox") {
      counts.sent += 1;
    }
    if (mail.starred && mail.folder !== "trash") {
      counts.starred += 1;
    }
    if (mail.folder === "inbox" && !mail.read) {
      counts.unread += 1;
    }
    if (mail.folder === "inbox") {
      const category = mail.category || "primary";
      if (counts[category] !== undefined) counts[category] += 1;
    }
  }

  return counts;
}

function emitMailboxRefresh(userId) {
  io.to(`user:${userId}`).emit("mail:refresh", {
    counts: folderCountsForUser(userId)
  });
}

function deliverSystemMail({ toEmail, subject, body }) {
  const recipient = store.users.find((user) => user.email === toEmail);
  if (!recipient) {
    return {
      delivered: false,
      message: `No AeroBox mailbox exists for ${toEmail}.`
    };
  }

  const sender = store.users.find((user) => user.handle === "team") || store.users[0];
  if (!sender) {
    return {
      delivered: false,
      message: "AeroBox does not have a system sender account yet."
    };
  }

  const sourceId = crypto.randomUUID();
  const timestamp = nowISO();

  store.mails.push(
    makeMailCopy({
      ownerId: sender.id,
      folder: "outbox",
      sourceId,
      from: sender.email,
      to: [toEmail],
      subject,
      body,
      read: true,
      createdAt: timestamp
    })
  );

  store.mails.push(
    makeMailCopy({
      ownerId: recipient.id,
      folder: "inbox",
      sourceId,
      from: sender.email,
      to: [toEmail],
      subject,
      body,
      read: false,
      createdAt: timestamp
    })
  );

  persistStore();
  emitMailboxRefresh(sender.id);
  emitMailboxRefresh(recipient.id);

  return {
    delivered: true,
    message: `Delivered to ${toEmail}.`
  };
}

function formatChatMessage(chat) {
  const sender = store.users.find((user) => user.id === chat.senderId);
  return {
    id: chat.id,
    body: chat.body,
    createdAt: chat.createdAt,
    senderId: chat.senderId,
    senderName: sender ? sender.displayName : "Unknown",
    senderEmail: sender ? sender.email : "",
    senderInitials: initials(sender ? sender.displayName : "U")
  };
}

function createUser({ displayName, handle, password, bio = "" }) {
  const safeHandle = sanitizeHandle(handle);
  const email = `${safeHandle}@${DOMAIN}`;
  const user = {
    id: crypto.randomUUID(),
    displayName: String(displayName || "").trim(),
    handle: safeHandle,
    email,
    passwordHash: hashPassword(password),
    bio: String(bio || ""),
    theme: "light",
    accent: "#0a84ff",
    createdAt: nowISO()
  };
  store.users.push(user);
  return user;
}

function seedIfNeeded() {
  if (store.users.length > 0) return;

  const team = createUser({
    displayName: "AeroBox Team",
    handle: "team",
    password: "welcome123",
    bio: "Official AeroBox workspace account"
  });

  const demo = createUser({
    displayName: "Demo Pilot",
    handle: "demo",
    password: "demo123",
    bio: "Try the premium AeroBox mail experience"
  });

  const firstMailId = crypto.randomUUID();
  const content =
    "Welcome to AeroBox Mail. This workspace supports real-time chat, inbox/outbox/drafts, starred mail, and profile settings.";

  store.mails.push(
    makeMailCopy({
      ownerId: team.id,
      folder: "outbox",
      sourceId: firstMailId,
      from: team.email,
      to: [demo.email],
      subject: "Welcome to AeroBox",
      body: content,
      read: true
    })
  );

  store.mails.push(
    makeMailCopy({
      ownerId: demo.id,
      folder: "inbox",
      sourceId: firstMailId,
      from: team.email,
      to: [demo.email],
      subject: "Welcome to AeroBox",
      body: content,
      read: false
    })
  );

  store.chats.push(
    {
      id: crypto.randomUUID(),
      senderId: team.id,
      body: "Welcome everyone. Use this space for quick team conversations.",
      createdAt: nowISO()
    },
    {
      id: crypto.randomUUID(),
      senderId: demo.id,
      body: "Realtime chat is live. Inbox + Outbox + Drafts are ready too.",
      createdAt: nowISO()
    }
  );

  persistStore();
}

seedIfNeeded();

function auth(req, res, next) {
  const bearer = String(req.headers.authorization || "");
  const token = bearer.startsWith("Bearer ") ? bearer.slice(7).trim() : "";
  if (!token) {
    return res.status(401).json({ error: "Missing authorization token." });
  }

  const session = store.sessions.find((item) => item.token === token);
  if (!session) {
    return res.status(401).json({ error: "Invalid or expired session." });
  }

  const user = store.users.find((item) => item.id === session.userId);
  if (!user) {
    return res.status(401).json({ error: "Session user not found." });
  }

  req.authToken = token;
  req.user = user;
  next();
}

app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
});
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/auth/signup", (req, res) => {
  const displayName = String(req.body.displayName || "").trim();
  const handle = sanitizeHandle(req.body.handle);
  const password = String(req.body.password || "");

  if (displayName.length < 2) {
    return res.status(400).json({ error: "Display name must be at least 2 characters." });
  }
  if (handle.length < 3) {
    return res.status(400).json({ error: "Handle must be at least 3 characters." });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  }

  const handleExists = store.users.some((user) => user.handle === handle);
  if (handleExists) {
    return res.status(409).json({ error: "This handle is already taken." });
  }

  const user = createUser({ displayName, handle, password });

  const teamUser = store.users.find((item) => item.handle === "team");
  if (teamUser) {
    const messageId = crypto.randomUUID();
    const body =
      `Hi ${displayName}, your new mailbox ${user.email} is active. ` +
      "Compose your first message and invite teammates into realtime chat.";
    store.mails.push(
      makeMailCopy({
        ownerId: teamUser.id,
        folder: "outbox",
        sourceId: messageId,
        from: teamUser.email,
        to: [user.email],
        subject: "Your AeroBox account is ready",
        body,
        read: true
      })
    );
    store.mails.push(
      makeMailCopy({
        ownerId: user.id,
        folder: "inbox",
        sourceId: messageId,
        from: teamUser.email,
        to: [user.email],
        subject: "Your AeroBox account is ready",
        body,
        read: false
      })
    );
  }

  const token = createSession(user.id);
  persistStore();

  return res.json({
    token,
    user: publicUser(user),
    counts: folderCountsForUser(user.id)
  });
});

app.post("/api/auth/login", (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || "");
  const user = store.users.find((item) => item.email === email);

  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: "Invalid email or password." });
  }

  if (!String(user.passwordHash || "").startsWith("pbkdf2$")) {
    user.passwordHash = hashPassword(password);
  }

  const token = createSession(user.id);
  persistStore();

  return res.json({
    token,
    user: publicUser(user),
    counts: folderCountsForUser(user.id)
  });
});

app.post("/api/integrations/aerolite-otp", (req, res) => {
  if (!isTrustedIntegrationRequest(req)) {
    return res.status(403).json({ error: "Integration request is not allowed." });
  }

  const email = normalizeEmail(req.body.email);
  const code = String(req.body.code || "").trim();
  const expiresAt = Number(req.body.expiresAt || 0);
  const appName = String(req.body.appName || "Aerolite Word").trim() || "Aerolite Word";

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "A valid AeroBox email is required." });
  }
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: "A 6-digit OTP is required." });
  }

  const expiresDate = Number.isFinite(expiresAt) && expiresAt > Date.now()
    ? new Date(expiresAt)
    : new Date(Date.now() + 5 * 60 * 1000);
  const body = [
    `Your ${appName} sign-in OTP is ${code}.`,
    `This code expires at ${expiresDate.toLocaleString()}.`,
    "If you did not request this code, you can ignore this message."
  ].join("\n\n");

  const delivery = deliverSystemMail({
    toEmail: email,
    subject: `${appName} sign-in OTP`,
    body
  });

  if (!delivery.delivered) {
    return res.status(404).json({ error: delivery.message });
  }

  return res.json(delivery);
});

app.post("/api/integrations/aerolite-document-saved", (req, res) => {
  if (!isTrustedIntegrationRequest(req)) {
    return res.status(403).json({ error: "Integration request is not allowed." });
  }

  const email = normalizeEmail(req.body.email);
  const title = String(req.body.title || "Untitled Document").trim() || "Untitled Document";
  const updatedAt = String(req.body.updatedAt || nowISO());
  const appName = String(req.body.appName || "Aerolite Word").trim() || "Aerolite Word";

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "A valid AeroBox email is required." });
  }

  const delivery = deliverSystemMail({
    toEmail: email,
    subject: `${appName} saved "${title}"`,
    body: [
      `Your ${appName} document "${title}" was saved successfully.`,
      `Saved at: ${updatedAt}`,
      `Open ${appName} to continue editing or export the document.`
    ].join("\n\n")
  });

  if (!delivery.delivered) {
    return res.status(404).json({ error: delivery.message });
  }

  return res.json(delivery);
});

app.post("/api/integrations/aerolite-workbook-saved", (req, res) => {
  if (!isTrustedIntegrationRequest(req)) {
    return res.status(403).json({ error: "Integration request is not allowed." });
  }

  const email = normalizeEmail(req.body.email);
  const title = String(req.body.title || "Book1").trim() || "Book1";
  const updatedAt = String(req.body.updatedAt || nowISO());
  const appName = String(req.body.appName || "Aerolite Sheets").trim() || "Aerolite Sheets";

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "A valid AeroBox email is required." });
  }

  const delivery = deliverSystemMail({
    toEmail: email,
    subject: `${appName} saved "${title}"`,
    body: [
      `Your ${appName} workbook "${title}" was saved successfully.`,
      `Saved at: ${updatedAt}`,
      `Open ${appName} to continue editing or export the workbook.`
    ].join("\n\n")
  });

  if (!delivery.delivered) {
    return res.status(404).json({ error: delivery.message });
  }

  return res.json(delivery);
});

app.post("/api/auth/logout", auth, (req, res) => {
  store.sessions = store.sessions.filter((session) => session.token !== req.authToken);
  persistStore();
  return res.json({ ok: true });
});

app.get("/api/bootstrap", auth, (req, res) => {
  res.json({
    user: publicUser(req.user),
    counts: folderCountsForUser(req.user.id)
  });
});

app.get("/api/mails", auth, (req, res) => {
  const folder = String(req.query.folder || "inbox").toLowerCase();
  const category = String(req.query.category || "").toLowerCase();
  const search = String(req.query.search || "").trim().toLowerCase();

  let items = store.mails.filter((mail) => mail.ownerId === req.user.id);

  if (folder === "starred") {
    items = items.filter((mail) => mail.starred && mail.folder !== "trash");
  } else if (folder === "sent") {
    items = items.filter((mail) => mail.folder === "outbox");
  } else {
    items = items.filter((mail) => mail.folder === folder);
  }

  if (folder === "inbox" && ["primary", "social", "promotions", "updates"].includes(category)) {
    items = items.filter((mail) => (mail.category || "primary") === category);
  }

  if (search) {
    items = items.filter((mail) => {
      const haystack = [mail.from, mail.to.join(", "), mail.subject, mail.body]
        .join(" ")
        .toLowerCase();
      return haystack.includes(search);
    });
  }

  items.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  const mails = items.map((mail) => ({
    id: mail.id,
    sourceId: mail.sourceId,
    folder: mail.folder,
    from: mail.from,
    to: mail.to,
    subject: mail.subject,
    preview: mail.preview,
    read: mail.read,
    starred: mail.starred,
    category: mail.category || "primary",
    createdAt: mail.createdAt,
    updatedAt: mail.updatedAt
  }));

  res.json({ mails, counts: folderCountsForUser(req.user.id) });
});

app.get("/api/mails/:id", auth, (req, res) => {
  const mail = store.mails.find((item) => item.id === req.params.id && item.ownerId === req.user.id);
  if (!mail) {
    return res.status(404).json({ error: "Mail not found." });
  }

  if (mail.folder === "inbox" && !mail.read) {
    mail.read = true;
    mail.updatedAt = nowISO();
    persistStore();
    emitMailboxRefresh(req.user.id);
  }

  return res.json({ mail });
});

app.post("/api/mails/send", auth, (req, res) => {
  const recipients = parseRecipients(req.body.to);
  const subject = String(req.body.subject || "").trim();
  const body = String(req.body.body || "");

  if (!recipients.length) {
    return res.status(400).json({ error: "Please add at least one recipient." });
  }
  if (!body.trim()) {
    return res.status(400).json({ error: "Email body cannot be empty." });
  }

  const sourceId = crypto.randomUUID();
  const timestamp = nowISO();
  const from = req.user.email;

  store.mails.push(
    makeMailCopy({
      ownerId: req.user.id,
      folder: "outbox",
      sourceId,
      from,
      to: recipients,
      subject,
      body,
      read: true,
      createdAt: timestamp
    })
  );

  const deliveredTo = [];
  const deliveredUserIds = new Set();

  for (const email of recipients) {
    const recipient = store.users.find((user) => user.email === email);
    if (!recipient) continue;

    const ownMessage = recipient.id === req.user.id;
    store.mails.push(
      makeMailCopy({
        ownerId: recipient.id,
        folder: "inbox",
        sourceId,
        from,
        to: recipients,
        subject,
        body,
        read: ownMessage,
        createdAt: timestamp
      })
    );

    deliveredTo.push(email);
    deliveredUserIds.add(recipient.id);
  }

  persistStore();

  emitMailboxRefresh(req.user.id);
  for (const recipientId of deliveredUserIds) {
    emitMailboxRefresh(recipientId);
  }

  const undeliveredTo = recipients.filter((email) => !deliveredTo.includes(email));
  return res.json({
    ok: true,
    deliveredTo,
    undeliveredTo,
    message: undeliveredTo.length
      ? "Sent to existing AeroBox users. Some recipients are not registered yet."
      : "Email sent successfully."
  });
});

app.post("/api/mails/draft", auth, (req, res) => {
  const draftId = String(req.body.id || "").trim();
  const recipients = parseRecipients(req.body.to);
  const subject = String(req.body.subject || "").trim();
  const body = String(req.body.body || "");

  if (draftId) {
    const existing = store.mails.find(
      (mail) => mail.id === draftId && mail.ownerId === req.user.id && mail.folder === "drafts"
    );
    if (!existing) {
      return res.status(404).json({ error: "Draft not found." });
    }

    existing.to = recipients;
    existing.subject = subject || "(No Subject)";
    existing.body = body;
    existing.preview = buildPreview(body);
    existing.updatedAt = nowISO();
    persistStore();
    emitMailboxRefresh(req.user.id);
    return res.json({ draft: existing, counts: folderCountsForUser(req.user.id) });
  }

  const draft = makeMailCopy({
    ownerId: req.user.id,
    folder: "drafts",
    sourceId: crypto.randomUUID(),
    from: req.user.email,
    to: recipients,
    subject,
    body,
    read: true
  });

  store.mails.push(draft);
  persistStore();
  emitMailboxRefresh(req.user.id);
  return res.json({ draft, counts: folderCountsForUser(req.user.id) });
});

app.post("/api/mails/:id/star", auth, (req, res) => {
  const mail = store.mails.find((item) => item.id === req.params.id && item.ownerId === req.user.id);
  if (!mail) {
    return res.status(404).json({ error: "Mail not found." });
  }

  mail.starred = !mail.starred;
  mail.updatedAt = nowISO();
  persistStore();
  emitMailboxRefresh(req.user.id);

  return res.json({ starred: mail.starred, counts: folderCountsForUser(req.user.id) });
});

app.post("/api/mails/:id/read", auth, (req, res) => {
  const mail = store.mails.find((item) => item.id === req.params.id && item.ownerId === req.user.id);
  if (!mail) {
    return res.status(404).json({ error: "Mail not found." });
  }

  mail.read = Boolean(req.body.read);
  mail.updatedAt = nowISO();
  persistStore();
  emitMailboxRefresh(req.user.id);

  return res.json({ read: mail.read, counts: folderCountsForUser(req.user.id) });
});

app.post("/api/mails/:id/move", auth, (req, res) => {
  const folder = String(req.body.folder || "").toLowerCase();
  const allowed = new Set(["inbox", "outbox", "drafts", "archive", "spam", "trash"]);
  if (!allowed.has(folder)) {
    return res.status(400).json({ error: "Unsupported folder move target." });
  }

  const mail = store.mails.find((item) => item.id === req.params.id && item.ownerId === req.user.id);
  if (!mail) {
    return res.status(404).json({ error: "Mail not found." });
  }

  mail.folder = folder;
  mail.updatedAt = nowISO();
  persistStore();
  emitMailboxRefresh(req.user.id);

  return res.json({ ok: true, counts: folderCountsForUser(req.user.id) });
});

app.get("/api/profile", auth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.put("/api/profile", auth, (req, res) => {
  const displayName = String(req.body.displayName || req.user.displayName).trim();
  const bio = String(req.body.bio || "").trim().slice(0, 200);
  const theme = String(req.body.theme || "light").toLowerCase();

  if (displayName.length < 2) {
    return res.status(400).json({ error: "Display name must be at least 2 characters." });
  }

  req.user.displayName = displayName;
  req.user.bio = bio;
  req.user.theme = theme === "dusk" ? "dusk" : "light";
  req.user.updatedAt = nowISO();
  persistStore();

  io.to(`user:${req.user.id}`).emit("profile:updated", {
    user: publicUser(req.user)
  });

  return res.json({ user: publicUser(req.user) });
});

app.get("/api/chat/messages", auth, (req, res) => {
  const messages = store.chats.slice(-150).map(formatChatMessage);
  res.json({ messages });
});

app.post("/api/chat/messages", auth, (req, res) => {
  const body = String(req.body.body || "").trim();
  if (!body) {
    return res.status(400).json({ error: "Chat message cannot be empty." });
  }
  if (body.length > 500) {
    return res.status(400).json({ error: "Chat message is too long." });
  }

  const message = {
    id: crypto.randomUUID(),
    senderId: req.user.id,
    body,
    createdAt: nowISO()
  };

  store.chats.push(message);
  if (store.chats.length > 500) {
    store.chats = store.chats.slice(-500);
  }
  persistStore();

  const payload = formatChatMessage(message);
  io.to("chat:lobby").emit("chat:new", payload);
  res.json({ message: payload });
});

io.use((socket, next) => {
  const token =
    String(socket.handshake.auth?.token || socket.handshake.query?.token || "").trim();
  if (!token) {
    return next(new Error("Missing auth token"));
  }

  const session = store.sessions.find((item) => item.token === token);
  if (!session) {
    return next(new Error("Invalid auth token"));
  }

  const user = store.users.find((item) => item.id === session.userId);
  if (!user) {
    return next(new Error("User not found"));
  }

  socket.user = user;
  next();
});

io.on("connection", (socket) => {
  const user = socket.user;
  socket.join("chat:lobby");
  socket.join(`user:${user.id}`);

  socket.emit("session:ready", {
    user: publicUser(user),
    counts: folderCountsForUser(user.id)
  });

  socket.on("chat:send", (payload) => {
    const body = String(payload?.body || "").trim();
    if (!body) return;
    if (body.length > 500) {
      socket.emit("chat:error", { error: "Message too long" });
      return;
    }

    const message = {
      id: crypto.randomUUID(),
      senderId: user.id,
      body,
      createdAt: nowISO()
    };

    store.chats.push(message);
    if (store.chats.length > 500) {
      store.chats = store.chats.slice(-500);
    }
    persistStore();

    io.to("chat:lobby").emit("chat:new", formatChatMessage(message));
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

server.listen(PORT, () => {
  console.log(`AeroBox Mail running at http://localhost:${PORT}`);
  console.log("Demo account: demo@aerobox.com / demo123");
});
