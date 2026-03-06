import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";

// ── ESM __dirname ─────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IS_PROD = process.env.NODE_ENV === "production";
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOADS_DIR = path.join(PUBLIC_DIR, "uploads");

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
const server = createServer(app);

// Security headers (Render serves HTTPS in front, so we relax upgrade-insecure)
app.use(
    helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "'unsafe-inline'"], // inline <script type=module>
                styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
                fontSrc: ["'self'", "https://fonts.gstatic.com"],
                mediaSrc: ["'self'", "blob:"],
                connectSrc: ["'self'", "wss:", "ws:", "https://stun.l.google.com"],
                imgSrc: ["'self'", "data:", "blob:"],
                upgradeInsecureRequests: IS_PROD ? [] : null,
            },
        },
        crossOriginEmbedderPolicy: false, // required for getUserMedia on some browsers
    })
);

// Gzip all text responses
app.use(compression());

// Trust Render's proxy so req.ip / rate limiting works correctly
app.set("trust proxy", 1);

// Rate limit REST endpoints
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 min
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." },
});
app.use("/upload", apiLimiter);
app.use(express.json({ limit: "1mb" }));

// ── Static files ──────────────────────────────────────────────────────────────
app.use(
    express.static(PUBLIC_DIR, {
        maxAge: IS_PROD ? "7d" : 0,
        etag: true,
        // Never cache index.html — always serve fresh so ICE meta stays current
        setHeaders(res, filePath) {
            if (filePath.endsWith("index.html")) {
                res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
            }
        },
    })
);

// ── Multer setup ──────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
        const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
        cb(null, `${uuidv4()}-${safe}`);
    },
});
const ALLOWED_MIME = new Set([
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/svg+xml",
    "video/mp4",
    "video/webm",
    "audio/mpeg",
    "audio/ogg",
    "audio/wav",
    "application/pdf",
    "application/zip",
    "application/x-zip-compressed",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/plain",
    "text/csv",
]);
const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        if (ALLOWED_MIME.has(file.mimetype)) cb(null, true);
        else cb(new Error(`File type "${file.mimetype}" is not allowed`));
    },
});

// ── Upload route ──────────────────────────────────────────────────────────────
app.post("/upload", upload.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file received" });
    res.json({
        fileName: req.file.originalname,
        filePath: `/uploads/${req.file.filename}`,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
    });
});

// ── TURN / ICE config injected into HTML ─────────────────────────────────────
function buildIceMeta() {
    const { TURN_URL, TURN_USERNAME, TURN_CREDENTIAL } = process.env;
    if (!TURN_URL) return "";
    const servers = [{ urls: TURN_URL, username: TURN_USERNAME ?? "", credential: TURN_CREDENTIAL ?? "" }];
    return `<meta name="ice-config" content="${encodeURIComponent(JSON.stringify(servers))}">`;
}

// Cache the patched HTML in production so we don't hit disk on every request
let _cachedHtml = null;
function getIndexHtml(cb) {
    if (IS_PROD && _cachedHtml) return cb(null, _cachedHtml);
    fs.readFile(path.join(PUBLIC_DIR, "index.html"), "utf8", (err, raw) => {
        if (err) return cb(err);
        const iceMeta = buildIceMeta();
        const html = iceMeta
            ? raw.replace(
                  "</head>",
                  `  ${iceMeta}
</head>`
              )
            : raw;
        if (IS_PROD) _cachedHtml = html;
        cb(null, html);
    });
}

// ── Root route → index.html ───────────────────────────────────────────────────
app.get("/", (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// ── Global error handler (must be last, after all routes) ─────────────────────
// Catches multer errors, JSON parse errors, and anything else thrown
app.use((err, req, res, _next) => {
    console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);
    if (err?.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "File too large (max 50 MB)" });
    if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON" });
    if (err?.message) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: "Internal server error" });
});

// ── WebSocket Server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, maxPayload: 1 * 1024 * 1024 }); // 1 MB max frame

// ── In-memory state ───────────────────────────────────────────────────────────
// clients : Map<socketId, { ws, username, roomId, isAlive }>
// rooms   : Map<roomId,   Set<socketId>>
const clients = new Map();
const rooms = new Map();

// ── WS helpers ────────────────────────────────────────────────────────────────
function safeSend(ws, payload) {
    if (ws.readyState === ws.OPEN) {
        try {
            ws.send(JSON.stringify(payload));
        } catch {
            /* ignore */
        }
    }
}
function sendTo(socketId, payload) {
    const c = clients.get(socketId);
    if (c) safeSend(c.ws, payload);
}
function broadcast(roomId, payload, excludeId = null) {
    const room = rooms.get(roomId);
    if (!room) return;
    for (const id of room) {
        if (id !== excludeId) sendTo(id, payload);
    }
}
function getRoomUsers(roomId) {
    const room = rooms.get(roomId) ?? new Set();
    return [...room]
        .map((id) => {
            const c = clients.get(id);
            return c ? { socketId: id, username: c.username } : null;
        })
        .filter(Boolean);
}
function removeClient(socketId) {
    const client = clients.get(socketId);
    if (!client) return;
    const room = rooms.get(client.roomId);
    room?.delete(socketId);
    if (room?.size === 0) rooms.delete(client.roomId);
    broadcast(client.roomId, { type: "user-left", socketId, username: client.username });
    clients.delete(socketId);
    console.log(`[-] ${client.username} disconnected (${socketId.slice(0, 8)})`);
}

// ── Heartbeat — ping every 30s, close dead connections ───────────────────────
const PING_INTERVAL = 30_000;
const pingTimer = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            ws.terminate();
            return;
        }
        ws.isAlive = false;
        ws.ping();
    });
}, PING_INTERVAL);
wss.on("close", () => clearInterval(pingTimer));

// ── Per-client message rate limiter ──────────────────────────────────────────
const MSG_WINDOW = 5_000; // 5 s
const MSG_LIMIT = 30; // max messages per window
const msgCounters = new Map(); // socketId → { count, resetAt }
function isRateLimited(socketId) {
    const now = Date.now();
    let entry = msgCounters.get(socketId);
    if (!entry || now > entry.resetAt) {
        entry = { count: 0, resetAt: now + MSG_WINDOW };
        msgCounters.set(socketId, entry);
    }
    entry.count++;
    return entry.count > MSG_LIMIT;
}

// ── Connection handler ────────────────────────────────────────────────────────
wss.on("connection", (ws, req) => {
    const socketId = uuidv4();
    ws.isAlive = true;
    ws.on("pong", () => {
        ws.isAlive = true;
    });

    const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() ?? req.socket.remoteAddress;
    console.log(`[+] WS connected: ${socketId.slice(0, 8)} from ${ip}`);

    safeSend(ws, { type: "connected", socketId });

    ws.on("message", (raw) => {
        // Rate limit check
        if (isRateLimited(socketId)) {
            safeSend(ws, { type: "error", message: "Rate limit exceeded" });
            return;
        }

        let msg;
        try {
            msg = JSON.parse(raw);
        } catch {
            return;
        }

        const { type } = msg;

        // ── join-room ─────────────────────────────────────────────────────────
        if (type === "join-room") {
            const username =
                String(msg.username ?? "")
                    .slice(0, 30)
                    .trim() || "Anonymous";
            const roomId = String(msg.roomId ?? "")
                .slice(0, 50)
                .trim();
            if (!roomId) return;

            clients.set(socketId, { ws, username, roomId, isAlive: true });
            const room = rooms.get(roomId) ?? new Set();
            room.add(socketId);
            rooms.set(roomId, room);

            const existing = getRoomUsers(roomId).filter((u) => u.socketId !== socketId);
            safeSend(ws, { type: "room-users", users: existing });
            broadcast(roomId, { type: "user-joined", socketId, username }, socketId);
            console.log(`[R] ${username} → room "${roomId}" (${room.size} users)`);
            return;
        }

        // ── WebRTC signalling (relay only — server never inspects SDP) ────────
        const RELAY_TYPES = ["offer", "answer", "ice-candidate", "call-rejected", "call-ended"];
        if (RELAY_TYPES.includes(type)) {
            const to = String(msg.to ?? "");
            if (!clients.has(to)) return; // target gone
            const client = clients.get(socketId);
            sendTo(to, {
                type,
                from: socketId,
                username: client?.username,
                ...(msg.offer && { offer: msg.offer, callType: msg.callType }),
                ...(msg.answer && { answer: msg.answer }),
                ...(msg.candidate && { candidate: msg.candidate }),
            });
            return;
        }

        // ── Chat message ──────────────────────────────────────────────────────
        if (type === "chat-message") {
            const client = clients.get(socketId);
            if (!client) return;
            const message = String(msg.message ?? "")
                .slice(0, 2000)
                .trim();
            if (!message) return;
            broadcast(client.roomId, {
                type: "chat-message",
                id: uuidv4(),
                socketId,
                username: client.username,
                message,
                timestamp: new Date().toISOString(),
                msgType: "text",
            });
            return;
        }

        // ── File-shared notification ──────────────────────────────────────────
        if (type === "file-shared") {
            const client = clients.get(socketId);
            if (!client) return;
            broadcast(client.roomId, {
                type: "file-shared",
                id: uuidv4(),
                socketId,
                username: client.username,
                fileName: String(msg.fileName ?? "").slice(0, 200),
                filePath: String(msg.filePath ?? ""),
                fileSize: Number(msg.fileSize ?? 0),
                mimeType: String(msg.mimeType ?? ""),
                timestamp: new Date().toISOString(),
                msgType: "file",
            });
            return;
        }
    });

    ws.on("close", () => removeClient(socketId));
    ws.on("error", (err) => {
        console.error(`WS error (${socketId.slice(0, 8)}):`, err.message);
        removeClient(socketId);
    });
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 PulseRTC [${IS_PROD ? "production" : "development"}] → http://0.0.0.0:${PORT}`);
    console.log(`📁 Static: ${PUBLIC_DIR}`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(signal) {
    console.log(`\n${signal} — shutting down…`);
    clearInterval(pingTimer);
    wss.clients.forEach((ws) => ws.terminate());
    server.close(() => {
        console.log("Server closed.");
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
