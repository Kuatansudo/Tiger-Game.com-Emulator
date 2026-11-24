import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Express, Request, Response } from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type {
  InputButton,
  MultiplayerChatMessage,
  MultiplayerControlMode,
  MultiplayerPlayer,
  MultiplayerRoomState,
  MultiplayerRoomSummary,
  RemoteAudioSnapshot,
} from './src/emulator/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS_PER_ROOM = 8;
const MAX_BINARY_FRAME_BYTES = 16384;
const ALLOWED_BUTTONS = new Set<string>([
  'UP',
  'DOWN',
  'LEFT',
  'RIGHT',
  'A',
  'B',
  'C',
  'D',
  'MENU',
  'PAUSE',
  'SOUND',
]);
const ALLOWED_CONTROL_MODES = new Set<string>(['shared', 'guest-only', 'host-only']);

interface RoomClient {
  socket: WebSocket;
  playerId: string;
  name: string;
  role: 'host' | 'guest';
  joinedAt: number;
  isAlive: boolean;
  roomCode: string | null;
}

interface GameRoom {
  code: string;
  roomName: string;
  romTitle: string;
  romId: string;
  hostName: string;
  isPublic: boolean;
  controlMode: MultiplayerControlMode;
  createdAt: number;
  hostClient: RoomClient;
  clients: Map<string, RoomClient>;
  lastFramePacket: Buffer | null;
  lastAudioSync: RemoteAudioSnapshot | null;
}

function sanitizeText(value: unknown, fallback: string, maxLen: number): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!cleaned) return fallback;
  return cleaned.slice(0, maxLen);
}

function generateRoomCode(existing: Map<string, GameRoom>): string {
  for (let attempt = 0; attempt < 24; attempt++) {
    let code = '';
    const bytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) {
      code += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
    }
    if (!existing.has(code)) return code;
  }
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function toRoomSummary(room: GameRoom): MultiplayerRoomSummary {
  return {
    code: room.code,
    roomName: room.roomName,
    hostName: room.hostName,
    romTitle: room.romTitle,
    romId: room.romId,
    playerCount: room.clients.size,
    maxPlayers: MAX_PLAYERS_PER_ROOM,
    controlMode: room.controlMode,
    createdAt: room.createdAt,
  };
}

function toRoomState(room: GameRoom): MultiplayerRoomState {
  const players: MultiplayerPlayer[] = Array.from(room.clients.values())
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((c) => ({
      id: c.playerId,
      name: c.name,
      role: c.role,
      joinedAt: c.joinedAt,
    }));

  return {
    ...toRoomSummary(room),
    isPublic: room.isPublic,
    players,
  };
}

function sanitizeAudioSnapshot(raw: unknown): RemoteAudioSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const clampNum = (v: unknown, min: number, max: number, def: number): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return def;
    return Math.max(min, Math.min(max, v));
  };
  const clampTable = (v: unknown, len: number): number[] => {
    if (!Array.isArray(v)) return new Array(len).fill(0);
    const out: number[] = [];
    for (let i = 0; i < Math.min(32, v.length); i++) {
      out.push(clampNum(v[i], 0, 15, 0) | 0);
    }
    return out;
  };
  const waveLen0 = r.waveLen0 === 32 ? 32 : 16;
  const waveLen1 = r.waveLen1 === 32 ? 32 : 16;
  return {
    realAudioMode: Boolean(r.realAudioMode),
    soundControl: clampNum(r.soundControl, 0, 255, 0) | 0,
    wave0FreqHz: clampNum(r.wave0FreqHz, 0, 20000, 0),
    wave1FreqHz: clampNum(r.wave1FreqHz, 0, 20000, 0),
    wave0Vol: clampNum(r.wave0Vol, 0, 31, 0) | 0,
    wave1Vol: clampNum(r.wave1Vol, 0, 31, 0) | 0,
    noiseVol: clampNum(r.noiseVol, 0, 31, 0) | 0,
    noiseHz: clampNum(r.noiseHz, 40, 12000, 1800),
    dacValue: clampNum(r.dacValue, 0, 255, 0x80) | 0,
    waveLen0,
    waveLen1,
    waveTable0: clampTable(r.waveTable0, waveLen0),
    waveTable1: clampTable(r.waveTable1, waveLen1),
  };
}

function sendJson(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

export function createMultiplayerBackend(): {
  app: Express;
  server: http.Server;
  wss: WebSocketServer;
  rooms: Map<string, GameRoom>;
  closeAll: () => Promise<void>;
} {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  const rooms = new Map<string, GameRoom>();

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true, activeRooms: rooms.size });
  });

  app.get('/api/rooms', (_req: Request, res: Response) => {
    const list = Array.from(rooms.values())
      .filter((room) => room.isPublic)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(toRoomSummary);
    res.json({ rooms: list });
  });

  app.get('/api/rooms/:code', (req: Request, res: Response) => {
    const rawCode = String(req.params.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(rawCode)) {
      res.status(400).json({ error: 'Invalid room code format.' });
      return;
    }
    const room = rooms.get(rawCode);
    if (!room) {
      res.status(404).json({ error: 'Room not found.' });
      return;
    }
    res.json({ room: toRoomSummary(room) });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({
    server,
    path: '/ws/multiplayer',
    maxPayload: 65536,
  });

  const clientsBySocket = new Map<WebSocket, RoomClient>();

  const removeClientFromRoom = (client: RoomClient, reason?: string) => {
    if (!client.roomCode) return;
    const room = rooms.get(client.roomCode);
    client.roomCode = null;
    if (!room) return;

    if (room.hostClient.playerId === client.playerId) {
      for (const member of room.clients.values()) {
        if (member.playerId !== client.playerId) {
          member.roomCode = null;
          sendJson(member.socket, {
            type: 'room:closed',
            code: room.code,
            reason: reason || 'The host closed this game server.',
          });
        }
      }
      room.clients.clear();
      rooms.delete(room.code);
      return;
    }

    room.clients.delete(client.playerId);
    const state = toRoomState(room);
    for (const member of room.clients.values()) {
      sendJson(member.socket, { type: 'room:state', room: state });
    }
  };

  wss.on('connection', (socket: WebSocket, _req: IncomingMessage) => {
    const client: RoomClient = {
      socket,
      playerId: crypto.randomUUID(),
      name: 'Player',
      role: 'guest',
      joinedAt: Date.now(),
      isAlive: true,
      roomCode: null,
    };
    clientsBySocket.set(socket, client);

    socket.on('pong', () => {
      client.isAlive = true;
    });

    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      client.isAlive = true;

      if (isBinary) {
        const buf = Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data);

        if (buf.length < 2 || buf.length > MAX_BINARY_FRAME_BYTES) return;
        if (!client.roomCode || client.role !== 'host') return;

        const room = rooms.get(client.roomCode);
        if (!room || room.hostClient.playerId !== client.playerId) return;

        if (buf[0] === 0x01 && buf.length === 8001) {
          room.lastFramePacket = Buffer.from(buf);
          for (const member of room.clients.values()) {
            if (member.playerId !== client.playerId && member.socket.readyState === WebSocket.OPEN) {
              member.socket.send(buf, { binary: true });
            }
          }
        }
        return;
      }

      const rawText = data.toString();
      if (rawText.length > 32768) return;

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(rawText) as Record<string, unknown>;
      } catch {
        return;
      }

      if (!msg || typeof msg.type !== 'string') return;

      switch (msg.type) {
        case 'ping': {
          sendJson(socket, { type: 'pong', ts: typeof msg.ts === 'number' ? msg.ts : Date.now() });
          break;
        }

        case 'room:create': {
          removeClientFromRoom(client, 'Host started a new game server.');

          const hostName = sanitizeText(msg.hostName, 'Host', 24);
          const roomName = sanitizeText(msg.roomName, `${hostName}'s Game.com`, 48);
          const romTitle = sanitizeText(msg.romTitle ?? msg.gameTitle, 'Tiger Game.com', 64);
          const romId = sanitizeText(msg.romId, 'gamecom', 64);
          const isPublic = msg.isPublic !== false;
          const controlMode: MultiplayerControlMode =
            typeof msg.controlMode === 'string' && ALLOWED_CONTROL_MODES.has(msg.controlMode)
              ? (msg.controlMode as MultiplayerControlMode)
              : 'shared';

          const code = generateRoomCode(rooms);
          client.name = hostName;
          client.role = 'host';
          client.joinedAt = Date.now();
          client.roomCode = code;

          const room: GameRoom = {
            code,
            roomName,
            romTitle,
            romId,
            hostName,
            isPublic,
            controlMode,
            createdAt: Date.now(),
            hostClient: client,
            clients: new Map([[client.playerId, client]]),
            lastFramePacket: null,
            lastAudioSync: null,
          };
          rooms.set(code, room);

          sendJson(socket, {
            type: 'room:joined',
            role: 'host',
            playerId: client.playerId,
            room: toRoomState(room),
          });
          break;
        }

        case 'room:join': {
          const rawCode = sanitizeText(msg.code, '', 8).toUpperCase();
          if (!/^[A-Z0-9]{4,8}$/.test(rawCode)) {
            sendJson(socket, { type: 'error', message: 'Enter a valid 6-character server code.' });
            return;
          }
          const room = rooms.get(rawCode);
          if (!room) {
            sendJson(socket, { type: 'error', message: 'Server not found or already closed.' });
            return;
          }
          if (room.clients.size >= MAX_PLAYERS_PER_ROOM) {
            sendJson(socket, { type: 'error', message: 'This game server is currently full.' });
            return;
          }

          removeClientFromRoom(client);

          client.name = sanitizeText(msg.playerName, 'Player 2', 24);
          client.role = 'guest';
          client.joinedAt = Date.now();
          client.roomCode = room.code;
          room.clients.set(client.playerId, client);

          const state = toRoomState(room);
          sendJson(socket, {
            type: 'room:joined',
            role: 'guest',
            playerId: client.playerId,
            room: state,
          });

          if (room.lastFramePacket && socket.readyState === WebSocket.OPEN) {
            socket.send(room.lastFramePacket, { binary: true });
          }
          if (room.lastAudioSync) {
            sendJson(socket, { type: 'audio:sync', audio: room.lastAudioSync });
          }

          for (const member of room.clients.values()) {
            if (member.playerId !== client.playerId) {
              sendJson(member.socket, { type: 'room:state', room: state });
            }
          }
          break;
        }

        case 'room:update': {
          if (!client.roomCode || client.role !== 'host') return;
          const room = rooms.get(client.roomCode);
          if (!room || room.hostClient.playerId !== client.playerId) return;

          if (typeof msg.controlMode === 'string' && ALLOWED_CONTROL_MODES.has(msg.controlMode)) {
            room.controlMode = msg.controlMode as MultiplayerControlMode;
          }
          if (typeof msg.isPublic === 'boolean') {
            room.isPublic = msg.isPublic;
          }
          if (typeof msg.romTitle === 'string' || typeof msg.gameTitle === 'string') {
            room.romTitle = sanitizeText(msg.romTitle ?? msg.gameTitle, room.romTitle, 64);
          }
          if (typeof msg.romId === 'string') {
            room.romId = sanitizeText(msg.romId, room.romId, 64);
          }
          if (typeof msg.roomName === 'string') {
            room.roomName = sanitizeText(msg.roomName, room.roomName, 48);
          }

          const state = toRoomState(room);
          for (const member of room.clients.values()) {
            sendJson(member.socket, { type: 'room:state', room: state });
          }
          break;
        }

        case 'room:leave': {
          removeClientFromRoom(client);
          sendJson(socket, { type: 'room:left' });
          break;
        }

        case 'input:state': {
          if (!client.roomCode || client.role !== 'guest') return;
          const room = rooms.get(client.roomCode);
          if (!room) return;
          if (room.controlMode === 'host-only') return;

          if (msg.kind === 'button') {
            if (typeof msg.button !== 'string' || !ALLOWED_BUTTONS.has(msg.button)) return;
            sendJson(room.hostClient.socket, {
              type: 'input:remote',
              playerId: client.playerId,
              playerName: client.name,
              kind: 'button',
              button: msg.button as InputButton,
              pressed: Boolean(msg.pressed),
            });
          } else if (msg.kind === 'touch') {
            const x =
              typeof msg.x === 'number' && Number.isFinite(msg.x)
                ? Math.max(0, Math.min(199, Math.round(msg.x)))
                : 0;
            const y =
              typeof msg.y === 'number' && Number.isFinite(msg.y)
                ? Math.max(0, Math.min(159, Math.round(msg.y)))
                : 0;
            sendJson(room.hostClient.socket, {
              type: 'input:remote',
              playerId: client.playerId,
              playerName: client.name,
              kind: 'touch',
              active: Boolean(msg.active),
              x,
              y,
            });
          }
          break;
        }

        case 'audio:sync': {
          if (!client.roomCode || client.role !== 'host') return;
          const room = rooms.get(client.roomCode);
          if (!room || room.hostClient.playerId !== client.playerId) return;
          const sanitized = sanitizeAudioSnapshot(msg.audio);
          if (!sanitized) return;
          room.lastAudioSync = sanitized;

          for (const member of room.clients.values()) {
            if (member.playerId !== client.playerId) {
              sendJson(member.socket, { type: 'audio:sync', audio: sanitized });
            }
          }
          break;
        }

        case 'chat:send': {
          if (!client.roomCode) return;
          const room = rooms.get(client.roomCode);
          if (!room) return;
          const text = sanitizeText(msg.text, '', 240);
          if (!text) return;

          const chatMsg: MultiplayerChatMessage = {
            id: crypto.randomUUID(),
            senderName: client.name,
            role: client.role,
            text,
            timestamp: Date.now(),
          };
          for (const member of room.clients.values()) {
            sendJson(member.socket, { type: 'chat:message', message: chatMsg });
          }
          break;
        }
      }
    });

    socket.on('close', () => {
      clientsBySocket.delete(socket);
      removeClientFromRoom(client);
    });

    socket.on('error', () => {
      clientsBySocket.delete(socket);
      removeClientFromRoom(client);
    });
  });

  const heartbeatTimer = setInterval(() => {
    for (const client of clientsBySocket.values()) {
      if (!client.isAlive) {
        client.socket.terminate();
        continue;
      }
      client.isAlive = false;
      if (client.socket.readyState === WebSocket.OPEN) {
        client.socket.ping();
      }
    }
  }, 30000);

  const closeAll = async () => {
    clearInterval(heartbeatTimer);
    for (const socket of wss.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve) => {
      wss.close(() => {
        server.close(() => resolve());
      });
    });
  };

  return { app, server, wss, rooms, closeAll };
}

async function startServer() {
  const { app, server } = createMultiplayerBackend();
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (req: Request, res: Response, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/ws/')) {
        next();
        return;
      }
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build output not found.');
      }
    });
  }

  const port = Number(process.env.PORT) || 3000;
  server.listen(port, '0.0.0.0', () => {
    console.log(`Game.com Studio server listening on http://0.0.0.0:${port}`);
  });
}

const isEntrypoint =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === __filename;

if (isEntrypoint) {
  void startServer();
}
