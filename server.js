const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

require('dotenv').config();

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Çok fazla istek, lütfen bekleyin.' },
});
app.use('/api/', apiLimiter);

const rooms = new Map();

const logger = {
  info: (msg, data) => console.log(`[INFO] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg, data) => console.warn(`[WARN] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg, data) => console.error(`[ERROR] ${msg}`, data ? JSON.stringify(data) : ''),
};

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  create(dailyRoomName, dailyRoomUrl, createdBy) {
    const roomId = uuidv4().slice(0, 8);
    const room = {
      id: roomId,
      dailyRoomName,
      dailyRoomUrl,
      createdBy,
      createdAt: Date.now(),
      users: new Map(),
      videoState: {
        videoId: null,
        isPlaying: false,
        currentTime: 0,
        timestamp: Date.now(),
      },
    };
    this.rooms.set(roomId, room);
    logger.info('Oda oluşturuldu', { roomId, createdBy });
    return room;
  }

  get(roomId) {
    return this.rooms.get(roomId);
  }

  addUser(roomId, socketId, username) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    room.users.set(socketId, { username, joinedAt: Date.now() });
    logger.info('Kullanıcı odaya katıldı', { roomId, username, socketId });
    return room;
  }

  removeUser(roomId, socketId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.users.delete(socketId);
    logger.info('Kullanıcı odadan ayrıldı', { roomId, socketId });
    if (room.users.size === 0) {
      this.rooms.delete(roomId);
      logger.info('Oda silindi (boş)', { roomId });
    }
    return room;
  }

  updateVideoState(roomId, state) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.videoState = { ...room.videoState, ...state, timestamp: Date.now() };
  }

  delete(roomId) {
    this.rooms.delete(roomId);
    logger.info('Oda silindi', { roomId });
  }
}

const roomManager = new RoomManager();

app.post('/api/rooms', async (req, res) => {
  try {
    const { username } = req.body;
    if (!username || username.trim().length === 0) {
      return res.status(400).json({ error: 'Kullanıcı adı gerekli' });
    }

    const room = roomManager.create(null, null, username);

    res.json({
      roomId: room.id,
    });
  } catch (err) {
    logger.error('Room creation error', err.message);
    res.status(500).json({ error: 'Oda oluşturulamadı' });
  }
});

app.get('/api/rooms/:roomId', (req, res) => {
  const room = roomManager.get(req.params.roomId);
  if (!room) {
    return res.status(404).json({ error: 'Oda bulunamadı' });
  }
  res.json({
    roomId: room.id,
    dailyRoomName: room.dailyRoomName,
    dailyRoomUrl: room.dailyRoomUrl,
    userCount: room.users.size,
    videoState: room.videoState,
  });
});



io.on('connection', (socket) => {
  logger.info('Socket bağlandı', { socketId: socket.id });

  socket.on('join-room', ({ roomId, username }) => {
    try {
      const room = roomManager.addUser(roomId, socket.id, username);
      if (!room) {
        socket.emit('error', 'Oda bulunamadı');
        return;
      }

      socket.join(roomId);
      socket.roomId = roomId;
      socket.username = username;

      const users = Array.from(room.users.entries()).map(([id, u]) => ({
        id,
        username: u.username,
      }));

      socket.emit('room-joined', {
        roomId: room.id,
        users,
        videoState: room.videoState,
      });

      socket.to(roomId).emit('user-joined', {
        id: socket.id,
        username,
      });
    } catch (err) {
      logger.error('Join room error', err.message);
      socket.emit('error', 'Odaya katılınamadı');
    }
  });

  socket.on('video-state-change', ({ roomId, state }) => {
    try {
      const room = roomManager.get(roomId);
      if (!room) return;

      roomManager.updateVideoState(roomId, state);

      socket.to(roomId).emit('video-state-sync', {
        state,
        from: socket.id,
      });
    } catch (err) {
      logger.error('Video state change error', err.message);
    }
  });

  socket.on('video-seek', ({ roomId, currentTime }) => {
    try {
      const room = roomManager.get(roomId);
      if (!room) return;

      roomManager.updateVideoState(roomId, { currentTime, timestamp: Date.now() });

      socket.to(roomId).emit('video-seek-sync', {
        currentTime,
        from: socket.id,
      });
    } catch (err) {
      logger.error('Video seek error', err.message);
    }
  });

  socket.on('sync-request', ({ roomId }) => {
    try {
      const room = roomManager.get(roomId);
      if (!room) return;

      socket.emit('video-state-sync', {
        state: {
          ...room.videoState,
          isPlaying: room.videoState.isPlaying,
          currentTime: room.videoState.currentTime,
        },
        from: 'server',
      });
    } catch (err) {
      logger.error('Sync request error', err.message);
    }
  });

  socket.on('set-video', ({ roomId, videoId }) => {
    try {
      const room = roomManager.get(roomId);
      if (!room) return;

      roomManager.updateVideoState(roomId, { videoId, currentTime: 0, isPlaying: false });

      socket.to(roomId).emit('video-set', { videoId, setBy: socket.id });
    } catch (err) {
      logger.error('Set video error', err.message);
    }
  });

  socket.on('webrtc-offer', ({ roomId, sdp }) => {
    try {
      socket.to(roomId).emit('webrtc-offer', { sdp, from: socket.id });
    } catch (err) {
      logger.error('WebRTC offer error', err.message);
    }
  });

  socket.on('webrtc-answer', ({ roomId, sdp }) => {
    try {
      socket.to(roomId).emit('webrtc-answer', { sdp, from: socket.id });
    } catch (err) {
      logger.error('WebRTC answer error', err.message);
    }
  });

  socket.on('webrtc-ice-candidate', ({ roomId, candidate }) => {
    try {
      socket.to(roomId).emit('webrtc-ice-candidate', { candidate, from: socket.id });
    } catch (err) {
      logger.error('WebRTC ICE error', err.message);
    }
  });

  socket.on('disconnect', () => {
    try {
      const { roomId, username } = socket;
      if (roomId) {
        const room = roomManager.removeUser(roomId, socket.id);
        if (room) {
          socket.to(roomId).emit('user-left', {
            id: socket.id,
            username,
          });
        }
      }
    } catch (err) {
      logger.error('Disconnect error', err.message);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║     Watch Party - Senkronize İzle    ║
  ║     Port: ${PORT}                       ║
  ╚══════════════════════════════════════╝
  `);
  logger.info('Server started', { port: PORT });
});
