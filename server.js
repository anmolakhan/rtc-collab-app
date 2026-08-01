require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { nanoid } = require('nanoid');
const { Server } = require('socket.io');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const PORT = process.env.PORT || 3000;

const app = express();
app.use(helmet({ contentSecurityPolicy: false })); // basic security headers
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- In-memory "database" (swap for real DB in production) ----------
const users = new Map(); // username -> { id, username, passwordHash }
const rooms = new Map(); // roomId -> Set of socket ids

// ---------- File upload setup ----------
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${nanoid(10)}-${file.originalname}`),
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } }); // 25MB cap
app.use('/uploads', express.static(uploadDir));

// ---------- Auth helpers ----------
function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '12h' });
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ---------- Auth routes ----------
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || password.length < 6) {
    return res.status(400).json({ error: 'username required, password min 6 chars' });
  }
  if (users.has(username)) return res.status(409).json({ error: 'Username taken' });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = { id: nanoid(8), username, passwordHash };
  users.set(username, user);
  const token = signToken(user);
  res.json({ token, username });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = users.get(username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  const token = signToken(user);
  res.json({ token, username });
});

// ---------- File upload route (auth required) ----------
app.post('/api/upload', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({
    fileName: req.file.originalname,
    url: `/uploads/${req.file.filename}`,
    size: req.file.size,
  });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---------- HTTP + Socket.io server ----------
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }, // tighten in production
  maxHttpBufferSize: 1e7,
});

// Socket auth middleware: every socket connection must present a valid JWT
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    socket.user = payload; // { id, username }
    next();
  } catch (e) {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join-room', (roomId) => {
    currentRoom = roomId;
    socket.join(roomId);
    if (!rooms.has(roomId)) rooms.set(roomId, new Set());
    const peers = [...rooms.get(roomId)];
    rooms.get(roomId).add(socket.id);

    // Tell the newcomer who is already in the room
    socket.emit('existing-peers', peers.map((id) => ({ socketId: id })));

    // Tell existing peers a new user joined
    socket.to(roomId).emit('peer-joined', {
      socketId: socket.id,
      username: socket.user.username,
    });
  });

  // ---- WebRTC signaling relay (offer/answer/ICE) ----
  // Media itself flows peer-to-peer and is encrypted end-to-end via
  // mandatory DTLS-SRTP in WebRTC; the server never sees raw audio/video.
  socket.on('signal', ({ to, data }) => {
    io.to(to).emit('signal', { from: socket.id, data });
  });

  // ---- Screen share state broadcast ----
  socket.on('screen-share-toggle', ({ sharing }) => {
    if (currentRoom) {
      socket.to(currentRoom).emit('screen-share-toggle', { socketId: socket.id, sharing });
    }
  });

  // ---- Whiteboard sync ----
  socket.on('whiteboard-draw', (stroke) => {
    if (currentRoom) socket.to(currentRoom).emit('whiteboard-draw', stroke);
  });
  socket.on('whiteboard-clear', () => {
    if (currentRoom) socket.to(currentRoom).emit('whiteboard-clear');
  });

  // ---- File share notification (file already uploaded via REST) ----
  socket.on('file-shared', (fileMeta) => {
    if (currentRoom) {
      socket.to(currentRoom).emit('file-shared', {
        ...fileMeta,
        from: socket.user.username,
      });
    }
  });

  // ---- Chat (bonus, useful alongside whiteboard) ----
  socket.on('chat-message', (msg) => {
    if (currentRoom) {
      io.to(currentRoom).emit('chat-message', {
        from: socket.user.username,
        text: String(msg).slice(0, 2000),
        ts: Date.now(),
      });
    }
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      rooms.get(currentRoom).delete(socket.id);
      socket.to(currentRoom).emit('peer-left', { socketId: socket.id });
      if (rooms.get(currentRoom).size === 0) rooms.delete(currentRoom);
    }
  });
});

server.listen(PORT, () => {
  console.log(`RTC app listening on http://localhost:${PORT}`);
});
