import {
  InputButton,
  MultiplayerChatMessage,
  MultiplayerControlMode,
  MultiplayerRole,
  MultiplayerRoomState,
  MultiplayerRoomSummary,
  RemoteAudioSnapshot,
} from './types';

export interface MultiplayerClientCallbacks {
  onConnectionChange?: (connected: boolean) => void;
  onRoomJoined?: (role: MultiplayerRole, playerId: string, room: MultiplayerRoomState) => void;
  onRoomState?: (room: MultiplayerRoomState) => void;
  onRoomLeft?: () => void;
  onRoomClosed?: (reason: string) => void;
  onFrameBinary?: (packedFrame: Uint8Array) => void;
  onAudioSync?: (audio: RemoteAudioSnapshot) => void;
  onRemoteInput?: (input: {
    playerId: string;
    playerName: string;
    kind: 'button' | 'touch';
    button?: InputButton;
    pressed?: boolean;
    active?: boolean;
    x?: number;
    y?: number;
  }) => void;
  onChatMessage?: (message: MultiplayerChatMessage) => void;
  onError?: (message: string) => void;
}

export async function fetchPublicRooms(): Promise<MultiplayerRoomSummary[]> {
  const res = await fetch('/api/rooms', { cache: 'no-store' });
  if (!res.ok) {
    throw new Error('Unable to load server directory.');
  }
  const data = (await res.json()) as { rooms?: MultiplayerRoomSummary[] };
  return Array.isArray(data.rooms) ? data.rooms : [];
}

export class MultiplayerClient {
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private callbacks: MultiplayerClientCallbacks;
  private framePacketScratch = new Uint8Array(8001);
  private lastFrameSendMs = 0;
  private lastAudioSendMs = 0;
  private lastAudioKey = '';
  private pingTimer: number | null = null;

  constructor(callbacks: MultiplayerClientCallbacks) {
    this.callbacks = callbacks;
    this.framePacketScratch[0] = 0x01;
  }

  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private getWsUrl(): string {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws/multiplayer`;
  }

  public connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.getWsUrl());
      ws.binaryType = 'arraybuffer';
      let settled = false;

      ws.onopen = () => {
        this.ws = ws;
        this.connectPromise = null;
        settled = true;
        this.callbacks.onConnectionChange?.(true);
        this.startPingLoop();
        resolve();
      };

      ws.onerror = () => {
        if (!settled) {
          settled = true;
          this.connectPromise = null;
          reject(new Error('Could not connect to multiplayer server.'));
        }
      };

      ws.onclose = () => {
        const wasCurrent = this.ws === ws;
        this.stopPingLoop();
        if (wasCurrent) {
          this.ws = null;
          this.callbacks.onConnectionChange?.(false);
        }
        if (!settled) {
          settled = true;
          this.connectPromise = null;
          reject(new Error('Multiplayer connection closed.'));
        }
      };

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(event.data);
          if (bytes.length === 8001 && bytes[0] === 0x01) {
            this.callbacks.onFrameBinary?.(bytes.subarray(1));
          }
          return;
        }

        if (typeof event.data !== 'string') return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(event.data) as Record<string, unknown>;
        } catch {
          return;
        }
        if (!msg || typeof msg.type !== 'string') return;

        switch (msg.type) {
          case 'room:joined':
            if (msg.room && typeof msg.playerId === 'string') {
              this.callbacks.onRoomJoined?.(
                msg.role === 'host' ? 'host' : 'guest',
                msg.playerId,
                msg.room as MultiplayerRoomState
              );
            }
            break;
          case 'room:state':
            if (msg.room) {
              this.callbacks.onRoomState?.(msg.room as MultiplayerRoomState);
            }
            break;
          case 'room:left':
            this.callbacks.onRoomLeft?.();
            break;
          case 'room:closed':
            this.callbacks.onRoomClosed?.(
              typeof msg.reason === 'string' ? msg.reason : 'The host closed the game server.'
            );
            break;
          case 'audio:sync':
            if (msg.audio) {
              this.callbacks.onAudioSync?.(msg.audio as RemoteAudioSnapshot);
            }
            break;
          case 'input:remote':
            this.callbacks.onRemoteInput?.({
              playerId: String(msg.playerId ?? ''),
              playerName: String(msg.playerName ?? 'Player 2'),
              kind: msg.kind === 'touch' ? 'touch' : 'button',
              button: msg.button as InputButton | undefined,
              pressed: Boolean(msg.pressed),
              active: Boolean(msg.active),
              x: typeof msg.x === 'number' ? msg.x : 0,
              y: typeof msg.y === 'number' ? msg.y : 0,
            });
            break;
          case 'chat:message':
            if (msg.message) {
              this.callbacks.onChatMessage?.(msg.message as MultiplayerChatMessage);
            }
            break;
          case 'error':
            if (typeof msg.message === 'string') {
              this.callbacks.onError?.(msg.message);
            }
            break;
        }
      };
    });

    return this.connectPromise;
  }

  private startPingLoop(): void {
    this.stopPingLoop();
    this.pingTimer = window.setInterval(() => {
      this.sendJson({ type: 'ping', ts: Date.now() });
    }, 20000);
  }

  private stopPingLoop(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private sendJson(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  public async createRoom(params: {
    hostName: string;
    roomName: string;
    gameTitle: string;
    isPublic: boolean;
    controlMode: MultiplayerControlMode;
  }): Promise<void> {
    await this.connect();
    this.lastAudioKey = '';
    this.lastFrameSendMs = 0;
    this.sendJson({ type: 'room:create', ...params });
  }

  public async joinRoom(code: string, playerName: string): Promise<void> {
    await this.connect();
    this.sendJson({ type: 'room:join', code: code.trim().toUpperCase(), playerName });
  }

  public leaveRoom(): void {
    this.sendJson({ type: 'room:leave' });
  }

  public updateRoom(patch: {
    controlMode?: MultiplayerControlMode;
    isPublic?: boolean;
    gameTitle?: string;
    roomName?: string;
  }): void {
    this.sendJson({ type: 'room:update', ...patch });
  }

  public sendFrameBinary(packedFrame: Uint8Array, force = false): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || packedFrame.length < 8000) return;
    const now = performance.now();
    // Cap stream to ~33 fps unless forced (and drop if socket backpressure builds up)
    if (!force && now - this.lastFrameSendMs < 28) return;
    if (this.ws.bufferedAmount > 65536) return;
    this.lastFrameSendMs = now;
    this.framePacketScratch.set(packedFrame.subarray(0, 8000), 1);
    this.ws.send(this.framePacketScratch);
  }

  public sendAudioSync(audio: RemoteAudioSnapshot, force = false): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const now = performance.now();
    if (!force && now - this.lastAudioSendMs < 25) return;
    const key = `${audio.soundControl}:${audio.wave0FreqHz}:${audio.wave0Vol}:${audio.wave1FreqHz}:${audio.wave1Vol}:${audio.noiseVol}:${audio.dacValue}`;
    if (!force && key === this.lastAudioKey && now - this.lastAudioSendMs < 250) return;
    this.lastAudioKey = key;
    this.lastAudioSendMs = now;
    this.sendJson({ type: 'audio:sync', audio });
  }

  public sendButtonInput(button: InputButton, pressed: boolean): void {
    this.sendJson({ type: 'input:state', kind: 'button', button, pressed });
  }

  public sendTouchInput(active: boolean, x: number, y: number): void {
    this.sendJson({ type: 'input:state', kind: 'touch', active, x, y });
  }

  public sendChat(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.sendJson({ type: 'chat:send', text: trimmed });
  }

  public disconnect(): void {
    this.stopPingLoop();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connectPromise = null;
  }
}
