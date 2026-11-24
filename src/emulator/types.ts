export type InputButton =
  | 'UP'
  | 'DOWN'
  | 'LEFT'
  | 'RIGHT'
  | 'A'
  | 'B'
  | 'C'
  | 'D'
  | 'MENU'
  | 'PAUSE'
  | 'SOUND';

export type LcdPaletteId = 'olive' | 'pocket' | 'amber' | 'indigo';

export interface LcdPalette {
  id: LcdPaletteId;
  name: string;
  shades: [string, string, string, string]; // 0 = lightest, 3 = darkest
}

export const LCD_PALETTES: Record<LcdPaletteId, LcdPalette> = {
  olive: {
    id: 'olive',
    name: 'Classic Olive LCD',
    shades: ['#A4AE95', '#768068', '#444D3A', '#1B2115'],
  },
  pocket: {
    id: 'pocket',
    name: 'Crisp Monochrome',
    shades: ['#D8DCE0', '#969CA4', '#525860', '#181B20'],
  },
  amber: {
    id: 'amber',
    name: 'Amber Backlight',
    shades: ['#E5BA73', '#B0823E', '#6B481B', '#241606'],
  },
  indigo: {
    id: 'indigo',
    name: 'Indigo Dot Matrix',
    shades: ['#9BB0C9', '#667D99', '#384B63', '#121B28'],
  },
};

export type ShaderId =
  | 'sharp'
  | 'dot-matrix'
  | 'stn-shadow'
  | 'crt-scanline'
  | 'backlight-glow'
  | 'smooth-scale';

export interface ShaderPreset {
  id: ShaderId;
  name: string;
  description: string;
}

export const SHADER_PRESETS: ShaderPreset[] = [
  {
    id: 'dot-matrix',
    name: 'Dot Matrix LCD',
    description: '1997 passive-matrix pixel grid with crisp subpixel gaps',
  },
  {
    id: 'stn-shadow',
    name: 'STN Shadow Layer',
    description: 'Reflective LCD depth with subtle pixel cast shadows',
  },
  {
    id: 'crt-scanline',
    name: 'Retro CRT Scanlines',
    description: 'Phosphor scanlines, soft bloom, and subtle screen vignette',
  },
  {
    id: 'backlight-glow',
    name: 'Backlit Diffuser',
    description: 'Warm diffused backlight halo with gentle pixel bleed',
  },
  {
    id: 'smooth-scale',
    name: 'Bilinear Smooth',
    description: 'Softly interpolated scaling for larger displays',
  },
  {
    id: 'sharp',
    name: 'Raw Nearest Pixel',
    description: 'Unfiltered 1:1 integer-sharp pixels',
  },
];

export interface ShaderSettings {
  id: ShaderId;
  intensity: number; // 0..1
  lcdGhosting: boolean;
}

export interface BiosState {
  internalLoaded: boolean;
  externalLoaded: boolean;
  internalSize: number;
  externalSize: number;
  internalName?: string;
  externalName?: string;
  preferBios: boolean;
}

export interface CartridgeInfo {
  id: string;
  filename: string;
  title: string;
  serial: string;
  signature: string;
  signatureOffset: number;
  hasValidHeader: boolean;
  sizeBytes: number;
  bankCount: number;
  entryPoint: number;
  sha1LikeHash: string;
  isBuiltIn: boolean;
  isHomebrew: boolean;
  requiresBios: boolean;
  description?: string;
}

export interface CpuSnapshot {
  pc: number;
  sp: number;
  ps0: number;
  ps1: number;
  ie0: number;
  ie1: number;
  ir0: number;
  ir1: number;
  mmu: [number, number, number, number, number];
  lcc: number;
  registers: number[]; // R0..R15
  halted: boolean;
  cycles: number;
  frameCount: number;
}

export interface AudioChannelState {
  wave0Enabled: boolean;
  wave1Enabled: boolean;
  noiseEnabled: boolean;
  dacEnabled: boolean;
  masterVolume: number; // 0..1
  muted: boolean;
  wave0FreqHz: number;
  wave1FreqHz: number;
  noiseLevel: number;
  dacValue: number;
}

export interface SaveStateData {
  version: number;
  slot: number;
  romId: string;
  romTitle: string;
  savedAt: number;
  frameCount: number;
  thumbnailDataUrl: string;
  mode?: 'homebrew' | 'real';
  cpu: {
    pc: number;
    halted: boolean;
    cycles: number;
    bootRomMapped: boolean;
  };
  realCpuState?: {
    sp: number;
    ps0: number;
    ps1: number;
    sys: number;
    ckc: number;
    ie0: number;
    ie1: number;
    ir0: number;
    ir1: number;
    mmu: [number, number, number, number, number];
    iflags: number;
    cartEnabled: boolean;
  };
  registerRam?: number[];
  internalRam: number[]; // 0x0000..0x03FF (1024 bytes)
  extendedRam: number[]; // 0xE000..0xFFFF (8192 bytes)
  vramBank0: number[];   // 8000 bytes
  vramBank1: number[];   // 8000 bytes
  waveTable0: number[];  // 16 bytes
  waveTable1: number[];  // 16 bytes
}

export interface EmulatorStatus {
  running: boolean;
  paused: boolean;
  fps: number;
  frameCount: number;
  romLoaded: boolean;
  cartridge: CartridgeInfo | null;
  bios: BiosState;
  touchActive: boolean;
  touchX: number;
  touchY: number;
  waitingForBiosPrompt: boolean;
}

export type GamepadAction =
  | 'UP'
  | 'DOWN'
  | 'LEFT'
  | 'RIGHT'
  | 'A'
  | 'B'
  | 'C'
  | 'D'
  | 'MENU'
  | 'PAUSE'
  | 'QUICKSAVE'
  | 'QUICKLOAD'
  | 'STYLUS_TAP';

export type GamepadButtonMap = Record<GamepadAction, number>;

export interface GamepadConfig {
  enabled: boolean;
  deadzone: number;
  rightStickStylus: boolean;
  buttonMap: GamepadButtonMap;
}

export interface ConnectedGamepadInfo {
  index: number;
  id: string;
  buttons: number;
  axes: number;
  activeButtons: number[];
}

export type CheatPatchKind = 'ram-freeze' | 'ram-conditional' | 'rom-patch';

export interface CheatPatchRule {
  kind: CheatPatchKind;
  address: number;
  value: number;
  compare?: number;
}

export interface CheatCodeEntry {
  id: string;
  romId: string;
  name: string;
  code: string;
  enabled: boolean;
  createdAt: number;
}

export type MultiplayerRole = 'none' | 'host' | 'guest';
export type MultiplayerControlMode = 'shared' | 'guest-only' | 'host-only';

export interface MultiplayerPlayer {
  id: string;
  name: string;
  role: 'host' | 'guest';
  joinedAt: number;
}

export interface MultiplayerRoomSummary {
  code: string;
  roomName: string;
  hostName: string;
  romTitle: string;
  romId: string;
  playerCount: number;
  maxPlayers: number;
  controlMode: MultiplayerControlMode;
  createdAt: number;
}

export interface MultiplayerRoomState extends MultiplayerRoomSummary {
  isPublic: boolean;
  players: MultiplayerPlayer[];
}

export interface MultiplayerChatMessage {
  id: string;
  senderName: string;
  role: 'host' | 'guest' | 'system';
  text: string;
  timestamp: number;
}

export interface RemoteAudioSnapshot {
  realAudioMode: boolean;
  soundControl: number;
  wave0FreqHz: number;
  wave1FreqHz: number;
  wave0Vol: number;
  wave1Vol: number;
  noiseVol: number;
  noiseHz: number;
  dacValue: number;
  waveLen0: 16 | 32;
  waveLen1: 16 | 32;
  waveTable0: number[];
  waveTable1: number[];
}

