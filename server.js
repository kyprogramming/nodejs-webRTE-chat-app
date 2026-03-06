import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Express setup ────────────────────────────────────────────────────────────
const app = express();
const server = createServer(app);

const uploadsDir = path.join(__dirname, "public", "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => cb(null, `${uuidv4()}-${file.originalname}`),
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.post("/upload", upload.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    res.json({
        fileName: req.file.originalname,
        filePath: `/uploads/${req.file.filename}`,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
    });
});

// ── Native WebSocket Server ──────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

// State
// clients: Map<socketId, { ws, username, roomId }>
const clients = new Map();
// rooms:   Map<roomId, Set<socketId>>
const rooms = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────
function send(ws, payload) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function sendTo(socketId, payload) {
    const client = clients.get(socketId);
    if (client) send(client.ws, payload);
}

function broadcast(roomId, payload, excludeId = null) {
    const room = rooms.get(roomId) ?? new Set();
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

// ── Connection handler ────────────────────────────────────────────────────────
wss.on("connection", (ws) => {
    const socketId = uuidv4();
    console.log(`✅ WS connected: ${socketId}`);

    // Assign the id so the client knows who it is
    send(ws, { type: "connected", socketId });

    ws.on("message", (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch {
            return;
        }

        const { type } = msg;

        // ── join-room ────────────────────────────────────────────────────────────
        if (type === "join-room") {
            const { roomId, username } = msg;
            clients.set(socketId, { ws, username, roomId });

            const room = rooms.get(roomId) ?? new Set();
            room.add(socketId);
            rooms.set(roomId, room);

            // Tell joiner who is already there (everyone except themselves)
            const existing = getRoomUsers(roomId).filter((u) => u.socketId !== socketId);
            send(ws, { type: "room-users", users: existing });

            // Notify existing peers
            broadcast(roomId, { type: "user-joined", socketId, username }, socketId);
            console.log(`👤 ${username} joined room "${roomId}"`);
            return;
        }

        // ── WebRTC signalling ────────────────────────────────────────────────────
        if (type === "offer") {
            const client = clients.get(socketId);
            sendTo(msg.to, {
                type: "offer",
                from: socketId,
                username: client?.username,
                offer: msg.offer,
                callType: msg.callType,
            });
            return;
        }

        if (type === "answer") {
            sendTo(msg.to, { type: "answer", from: socketId, answer: msg.answer });
            return;
        }

        if (type === "ice-candidate") {
            sendTo(msg.to, { type: "ice-candidate", from: socketId, candidate: msg.candidate });
            return;
        }

        if (type === "call-rejected") {
            sendTo(msg.to, { type: "call-rejected", from: socketId });
            return;
        }

        if (type === "call-ended") {
            sendTo(msg.to, { type: "call-ended", from: socketId });
            return;
        }

        // ── Chat message ─────────────────────────────────────────────────────────
        if (type === "chat-message") {
            const client = clients.get(socketId);
            const payload = {
                type: "chat-message",
                id: uuidv4(),
                socketId,
                username: client?.username ?? "Unknown",
                message: msg.message,
                timestamp: new Date().toISOString(),
                msgType: "text",
            };
            broadcast(msg.roomId, payload);
            return;
        }

        // ── File shared ──────────────────────────────────────────────────────────
        if (type === "file-shared") {
            const client = clients.get(socketId);
            const payload = {
                type: "file-shared",
                id: uuidv4(),
                socketId,
                username: client?.username ?? "Unknown",
                fileName: msg.fileName,
                filePath: msg.filePath,
                fileSize: msg.fileSize,
                mimeType: msg.mimeType,
                timestamp: new Date().toISOString(),
                msgType: "file",
            };
            broadcast(msg.roomId, payload);
            return;
        }
    });

    // ── Disconnect ───────────────────────────────────────────────────────────
    ws.on("close", () => {
        const client = clients.get(socketId);
        if (client) {
            const room = rooms.get(client.roomId);
            room?.delete(socketId);
            if (room?.size === 0) rooms.delete(client.roomId);
            broadcast(client.roomId, {
                type: "user-left",
                socketId,
                username: client.username,
            });
            clients.delete(socketId);
            console.log(`❌ Disconnected: ${client.username}`);
        }
    });

    ws.on("error", (err) => console.error("WS error:", err.message));
});

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT ?? 3000;
server.listen(PORT, () => console.log(`🚀 Server → http://localhost:${PORT}`));
