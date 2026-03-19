import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';

// Ensure logs directory exists
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const serverLogStream = fs.createWriteStream(path.join(logsDir, 'server.log'), { flags: 'a' });
const clientLogStream = fs.createWriteStream(path.join(logsDir, 'client.log'), { flags: 'a' });

function logServer(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  serverLogStream.write(line);
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '50mb' })); // For large log payloads

  const server = createServer(app);
  const io = new SocketIOServer(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  const rooms = new Map<string, Set<WebSocket>>();

  // Endpoint to receive client logs
  app.post('/api/logs', (req, res) => {
    const { logs, deviceId } = req.body;
    if (Array.isArray(logs)) {
      const logLines = logs.map((l: string) => `[${new Date().toISOString()}] [Client ${deviceId || 'Unknown'}] ${l}\n`).join('');
      clientLogStream.write(logLines);
    }
    res.status(200).send({ success: true });
  });

  // Endpoint to download logs
  app.get('/api/logs/download', (req, res) => {
    const type = req.query.type === 'server' ? 'server.log' : 'client.log';
    const filePath = path.join(logsDir, type);
    if (fs.existsSync(filePath)) {
      res.download(filePath);
    } else {
      res.status(404).send('Log file not found');
    }
  });

  // Endpoint to clear logs
  app.post('/api/logs/clear', (req, res) => {
    fs.writeFileSync(path.join(logsDir, 'server.log'), '');
    fs.writeFileSync(path.join(logsDir, 'client.log'), '');
    res.status(200).send({ success: true });
  });

  wss.on('connection', (ws: WebSocket, request) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);
    const roomId = url.searchParams.get('room');
    const token = url.searchParams.get('token');
    const isLoopback = url.searchParams.get('loopback') === 'true';

    if (!roomId) {
      ws.close(1008, 'Room ID required');
      return;
    }

    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Set());
    }
    const room = rooms.get(roomId)!;
    room.add(ws);

    logServer(`Client connected to room ${roomId}. Loopback: ${isLoopback}. Total clients: ${room.size}`);

    ws.on('message', (data, isBinary) => {
      // Broadcast to others in the room (and to self if loopback is enabled)
      room.forEach(client => {
        if ((client !== ws || isLoopback) && client.readyState === WebSocket.OPEN) {
          client.send(data, { binary: isBinary });
        }
      });
    });

    ws.on('close', () => {
      room.delete(ws);
      if (room.size === 0) {
        rooms.delete(roomId);
      }
      logServer(`Client disconnected from room ${roomId}. Remaining: ${room.size}`);
    });

    ws.on('error', (err) => {
      logServer(`WebSocket error in room ${roomId}: ${err.message}`);
    });
  });

  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;

    if (pathname === '/secure-relay') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  // Socket.IO for signaling
  io.on('connection', (socket) => {
    logServer(`Socket.IO client connected: ${socket.id}`);

    socket.on('join-room', (roomId) => {
      socket.join(roomId);
      logServer(`Socket ${socket.id} joined room ${roomId}`);
      socket.to(roomId).emit('user-joined', socket.id);
    });

    socket.on('signal', (data) => {
      const { roomId, signal, to } = data;
      if (to) {
        io.to(to).emit('signal', { from: socket.id, signal });
      } else {
        socket.to(roomId).emit('signal', { from: socket.id, signal });
      }
    });

    socket.on('rotation', (data) => {
      const { roomId, angle } = data;
      socket.to(roomId).emit('rotation', { from: socket.id, angle });
    });

    socket.on('disconnect', () => {
      logServer(`Socket.IO client disconnected: ${socket.id}`);
    });
  });

  // Vite middleware
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const PORT = 3000;
  server.listen(PORT, '0.0.0.0', () => {
    logServer(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  logServer(`Server failed to start: ${err.message}`);
  console.error(err);
});
