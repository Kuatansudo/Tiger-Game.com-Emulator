import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { AudioAndDebugPanel } from './components/AudioAndDebugPanel';
import { CartridgePanel } from './components/CartridgePanel';
import { CheatPanel } from './components/CheatPanel';
import { ConsoleUnit } from './components/ConsoleUnit';
import { MultiplayerPanel } from './components/MultiplayerPanel';
import { SavestatePanel } from './components/SavestatePanel';
import { DEFAULT_GAMEPAD_CONFIG } from './emulator/gamepad';
import { GameComMachine } from './emulator/machine';
import { fetchPublicRooms, MultiplayerClient } from './emulator/multiplayer';
import { BuiltInRomEntry, getBuiltInRoms } from './emulator/roms';
import {
  clearBiosFromDb,
  deleteCheatFromDb,
  deleteStateFromDb,
  exportSaveStateFile,
  loadAllBiosFromDb,
  loadCheatsForRom,
  loadStatesForRom,
  parseSaveStateFile,
  saveBiosToDb,
  saveCheatToDb,
  saveStateToDb,
} from './emulator/storage';
import {
  AudioChannelState,
  CheatCodeEntry,
  ConnectedGamepadInfo,
  CpuSnapshot,
  EmulatorStatus,
  GamepadAction,
  GamepadConfig,
  InputButton,
  LcdPaletteId,
  MultiplayerChatMessage,
  MultiplayerControlMode,
  MultiplayerRole,
  MultiplayerRoomState,
  MultiplayerRoomSummary,
  SaveStateData,
  ShaderSettings,
} from './emulator/types';
import { extractZipEntries, isZipBuffer } from './emulator/zip';

type WorkbenchTab = 'cartridge' | 'cheats' | 'multiplayer' | 'savestates' | 'audio';

const KEY_MAP: Record<string, InputButton> = {
  ArrowUp: 'UP',
  w: 'UP',
  W: 'UP',
  ArrowDown: 'DOWN',
  s: 'DOWN',
  S: 'DOWN',
  ArrowLeft: 'LEFT',
  a: 'LEFT',
  A: 'LEFT',
  ArrowRight: 'RIGHT',
  d: 'RIGHT',
  D: 'RIGHT',
  z: 'A',
  Z: 'A',
  j: 'A',
  J: 'A',
  x: 'B',
  X: 'B',
  k: 'B',
  K: 'B',
  c: 'C',
  C: 'C',
  l: 'C',
  L: 'C',
  v: 'D',
  V: 'D',
  ';': 'D',
  m: 'MENU',
  M: 'MENU',
};

export default function App() {
  const builtInRoms = useMemo(() => getBuiltInRoms(), []);
  const initialRoomParam = useMemo(() => {
    if (typeof window === 'undefined') return '';
    const code = new URLSearchParams(window.location.search).get('room') || '';
    return code.trim().toUpperCase().slice(0, 8);
  }, []);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const topFileInputRef = useRef<HTMLInputElement | null>(null);
  const machineRef = useRef<GameComMachine | null>(null);
  const mpClientRef = useRef<MultiplayerClient | null>(null);
  const mpRoleRef = useRef<MultiplayerRole | null>(null);
  const mpRoomRef = useRef<MultiplayerRoomState | null>(null);

  const [activeTab, setActiveTab] = useState<WorkbenchTab>(
    initialRoomParam ? 'multiplayer' : 'cartridge'
  );
  const [pressedButtons, setPressedButtons] = useState<Set<InputButton>>(new Set());
  const [paletteId, setPaletteId] = useState<LcdPaletteId>('olive');
  const [shaderSettings, setShaderSettings] = useState<ShaderSettings>({
    id: 'dot-matrix',
    intensity: 0.75,
    lcdGhosting: true,
  });
  const [gamepadConfig, setGamepadConfig] = useState<GamepadConfig>(DEFAULT_GAMEPAD_CONFIG);
  const [connectedGamepads, setConnectedGamepads] = useState<ConnectedGamepadInfo[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  // Cheat Codes state
  const [cheats, setCheats] = useState<CheatCodeEntry[]>([]);
  const [cheatsMasterEnabled, setCheatsMasterEnabled] = useState(true);

  // Multiplayer state
  const [playerName, setPlayerName] = useState<string>(() => {
    try {
      return localStorage.getItem('gamecom-player-name') || 'Player 1';
    } catch {
      return 'Player 1';
    }
  });
  const [mpRole, setMpRole] = useState<MultiplayerRole | null>(null);
  const [mpPlayerId, setMpPlayerId] = useState<string | null>(null);
  const [mpRoom, setMpRoom] = useState<MultiplayerRoomState | null>(null);
  const [publicRooms, setPublicRooms] = useState<MultiplayerRoomSummary[]>([]);
  const [loadingRooms, setLoadingRooms] = useState(false);
  const [connectingRoom, setConnectingRoom] = useState(false);
  const [chatMessages, setChatMessages] = useState<MultiplayerChatMessage[]>([]);

  const [status, setStatus] = useState<EmulatorStatus>({
    running: false,
    paused: false,
    fps: 60,
    frameCount: 0,
    romLoaded: false,
    cartridge: null,
    bios: {
      internalLoaded: false,
      externalLoaded: false,
      internalSize: 0,
      externalSize: 0,
      preferBios: true,
    },
    touchActive: false,
    touchX: 0,
    touchY: 0,
    waitingForBiosPrompt: false,
  });

  const [cpuSnapshot, setCpuSnapshot] = useState<CpuSnapshot>({
    pc: 0x1020,
    sp: 0x03ff,
    ps0: 0,
    ps1: 0,
    ie0: 0,
    ie1: 0,
    ir0: 0,
    ir1: 0,
    mmu: [0, 32, 33, 34, 35],
    lcc: 0x80,
    registers: new Array(16).fill(0),
    halted: false,
    cycles: 0,
    frameCount: 0,
  });

  const [audioState, setAudioState] = useState<AudioChannelState>({
    wave0Enabled: true,
    wave1Enabled: true,
    noiseEnabled: true,
    dacEnabled: true,
    masterVolume: 0.55,
    muted: false,
    wave0FreqHz: 0,
    wave1FreqHz: 0,
    noiseLevel: 0,
    dacValue: 0x80,
  });

  const [saveStates, setSaveStates] = useState<Record<number, SaveStateData>>({});

  const showToast = useCallback((msg: string) => {
    setNotice(msg);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 3600);
    return () => window.clearTimeout(t);
  }, [notice]);

  const refreshSaveStates = useCallback(async (romId: string | undefined) => {
    if (!romId) {
      setSaveStates({});
      return;
    }
    try {
      const loaded = await loadStatesForRom(romId);
      setSaveStates(loaded);
    } catch {
      setSaveStates({});
    }
  }, []);

  const refreshCheats = useCallback(async (romId: string | undefined) => {
    if (!romId) {
      setCheats([]);
      machineRef.current?.setCheats([], cheatsMasterEnabled);
      return;
    }
    try {
      const loaded = await loadCheatsForRom(romId);
      setCheats(loaded);
      machineRef.current?.setCheats(loaded, cheatsMasterEnabled);
    } catch {
      setCheats([]);
    }
  }, [cheatsMasterEnabled]);

  useEffect(() => {
    machineRef.current?.setCheats(cheats, cheatsMasterEnabled);
  }, [cheats, cheatsMasterEnabled]);

  const handlePlayerNameChange = useCallback((name: string) => {
    setPlayerName(name);
    try {
      localStorage.setItem('gamecom-player-name', name);
    } catch {
      // Ignore storage error
    }
  }, []);

  const refreshPublicRooms = useCallback(async () => {
    setLoadingRooms(true);
    try {
      const list = await fetchPublicRooms();
      setPublicRooms(list);
    } catch {
      // Keep last directory state quietly
    } finally {
      setLoadingRooms(false);
    }
  }, []);

  const handleSaveSlot = useCallback(
    async (slot: number) => {
      const m = machineRef.current;
      if (!m) return;
      const snap = m.captureSaveState(slot);
      if (!snap) return;
      try {
        await saveStateToDb(snap);
        setSaveStates((prev) => ({ ...prev, [slot]: snap }));
        showToast(`Saved state to Slot ${slot}`);
      } catch {
        showToast('Unable to save state to browser storage.');
      }
    },
    [showToast]
  );

  const handleLoadSlot = useCallback(
    (slot: number) => {
      const m = machineRef.current;
      const entry = saveStates[slot];
      if (!m || !entry) {
        showToast(`Slot ${slot} is empty.`);
        return;
      }
      m.restoreSaveState(entry);
      showToast(`Loaded state from Slot ${slot}`);
    },
    [saveStates, showToast]
  );

  const quickSaveRef = useRef<() => void>(() => {});
  const quickLoadRef = useRef<() => void>(() => {});
  useEffect(() => {
    quickSaveRef.current = () => {
      void handleSaveSlot(1);
    };
    quickLoadRef.current = () => {
      handleLoadSlot(1);
    };
  }, [handleLoadSlot, handleSaveSlot]);

  // Initialize emulator machine & multiplayer client once
  useEffect(() => {
    const machine = new GameComMachine({
      onStatusChange: (next) => {
        setStatus(next);
        setAudioState(machine.audio.getState());
      },
      onCpuTick: (snap) => {
        setCpuSnapshot(snap);
        setAudioState(machine.audio.getState());
      },
      onGamepadButton: (btn, pressed) => {
        if (mpRoleRef.current === 'guest') {
          mpClientRef.current?.sendButtonInput(btn, pressed);
        }
        setPressedButtons((prev) => {
          const next = new Set(prev);
          if (pressed) next.add(btn);
          else next.delete(btn);
          return next;
        });
      },
      onGamepadStylus: (active, x, y) => {
        if (mpRoleRef.current === 'guest') {
          mpClientRef.current?.sendTouchInput(active, x, y);
        }
      },
      onFrameRendered: (packedFrame) => {
        if (mpRoleRef.current === 'host') {
          mpClientRef.current?.sendFrameBinary(packedFrame);
          mpClientRef.current?.sendAudioSync(machine.audio.exportRemoteSnapshot());
        }
      },
      onQuickSave: () => quickSaveRef.current(),
      onQuickLoad: () => quickLoadRef.current(),
    });
    machineRef.current = machine;
    setGamepadConfig(machine.gamepad.getConfig());

    const mpClient = new MultiplayerClient({
      onConnectionChange: (connected) => {
        if (!connected && mpRoleRef.current) {
          mpRoleRef.current = null;
          mpRoomRef.current = null;
          setMpRole(null);
          setMpPlayerId(null);
          setMpRoom(null);
          if (machine.isExternalStreamMode()) {
            machine.setExternalStreamMode(false);
          }
        }
      },
      onRoomJoined: (role, playerId, room) => {
        mpRoleRef.current = role;
        mpRoomRef.current = room;
        setMpRole(role);
        setMpPlayerId(playerId);
        setMpRoom(room);
        setChatMessages([]);
        setConnectingRoom(false);

        if (role === 'guest') {
          machine.audio.resume();
          machine.setExternalStreamMode(true);
          showToast(`Joined ${room.roomName} (${room.code})`);
        } else {
          machine.audio.resume();
          machine.setExternalStreamMode(false);
          mpClient.sendFrameBinary(machine.getPackedFrame(), true);
          mpClient.sendAudioSync(machine.audio.exportRemoteSnapshot(), true);
          showToast(`Opened server ${room.code} for ${room.romTitle}`);
        }
      },
      onRoomState: (room) => {
        const prevCount = mpRoomRef.current?.players.length ?? 0;
        mpRoomRef.current = room;
        setMpRoom(room);
        if (mpRoleRef.current === 'host' && room.players.length > prevCount) {
          mpClient.sendFrameBinary(machine.getPackedFrame(), true);
          mpClient.sendAudioSync(machine.audio.exportRemoteSnapshot(), true);
        }
      },
      onRoomLeft: () => {
        mpRoleRef.current = null;
        mpRoomRef.current = null;
        setMpRole(null);
        setMpPlayerId(null);
        setMpRoom(null);
        if (machine.isExternalStreamMode()) {
          machine.setExternalStreamMode(false);
        }
      },
      onRoomClosed: (reason) => {
        mpRoleRef.current = null;
        mpRoomRef.current = null;
        setMpRole(null);
        setMpPlayerId(null);
        setMpRoom(null);
        if (machine.isExternalStreamMode()) {
          machine.setExternalStreamMode(false);
        }
        showToast(reason);
        void refreshPublicRooms();
      },
      onFrameBinary: (packed) => {
        if (mpRoleRef.current === 'guest') {
          machine.renderExternalPackedFrame(packed);
        }
      },
      onAudioSync: (audio) => {
        if (mpRoleRef.current === 'guest') {
          machine.audio.applyRemoteSnapshot(audio);
        }
      },
      onRemoteInput: (input) => {
        if (mpRoleRef.current !== 'host') return;
        if (mpRoomRef.current?.controlMode === 'host-only') return;
        if (input.kind === 'button' && input.button) {
          machine.setButton(input.button, Boolean(input.pressed));
        } else if (input.kind === 'touch') {
          machine.setTouch(Boolean(input.active), input.x ?? 0, input.y ?? 0);
        }
      },
      onChatMessage: (msg) => {
        setChatMessages((prev) => [...prev.slice(-79), msg]);
      },
      onError: (message) => {
        setConnectingRoom(false);
        showToast(message);
      },
    });
    mpClientRef.current = mpClient;

    if (canvasRef.current) {
      machine.attachCanvas(canvasRef.current);
    }

    // Boot default built-in .tgc cartridge immediately
    const first = builtInRoms[0];
    if (first) {
      machine.loadRomBytes(
        first.bytes,
        first.info.filename,
        true,
        first.info.description
      );
      void refreshSaveStates(first.info.id);
      void refreshCheats(first.info.id);
    }

    // Restore persisted BIOS ROMs from IndexedDB if previously loaded
    void loadAllBiosFromDb()
      .then((stored) => {
        if (machineRef.current !== machine) return;
        if (stored.internal) {
          machine.loadInternalBiosBytes(stored.internal.bytes, stored.internal.filename);
        }
        if (stored.external) {
          machine.loadExternalBiosBytes(stored.external.bytes, stored.external.filename);
        }
      })
      .catch(() => {
        // Ignore IndexedDB unavailability
      });

    return () => {
      mpClient.disconnect();
      mpClientRef.current = null;
      machine.destroy();
      machineRef.current = null;
    };
  }, [builtInRoms, refreshCheats, refreshPublicRooms, refreshSaveStates, showToast]);

  // Poll connected HTML5 Gamepads for live UI feedback
  useEffect(() => {
    const syncPads = () => {
      const m = machineRef.current;
      if (!m) return;
      setConnectedGamepads(m.gamepad.getConnectedGamepads());
    };

    syncPads();
    window.addEventListener('gamepadconnected', syncPads);
    window.addEventListener('gamepaddisconnected', syncPads);
    const interval = window.setInterval(syncPads, activeTab === 'audio' ? 120 : 800);

    return () => {
      window.removeEventListener('gamepadconnected', syncPads);
      window.removeEventListener('gamepaddisconnected', syncPads);
      window.clearInterval(interval);
    };
  }, [activeTab]);

  // Refresh lobby list when opening Multiplayer tab
  useEffect(() => {
    if (activeTab === 'multiplayer' && !mpRoom) {
      void refreshPublicRooms();
    }
  }, [activeTab, mpRoom, refreshPublicRooms]);

  const handleButtonChange = useCallback((btn: InputButton, pressed: boolean) => {
    if (mpRoleRef.current === 'guest') {
      machineRef.current?.audio.resume();
      mpClientRef.current?.sendButtonInput(btn, pressed);
    } else {
      machineRef.current?.setButton(btn, pressed);
    }
    setPressedButtons((prev) => {
      const next = new Set(prev);
      if (pressed) next.add(btn);
      else next.delete(btn);
      return next;
    });
  }, []);

  const handleTouchChange = useCallback((active: boolean, x: number, y: number) => {
    machineRef.current?.setTouch(active, x, y);
    if (mpRoleRef.current === 'guest') {
      mpClientRef.current?.sendTouchInput(active, x, y);
    }
  }, []);

  const activeRomId = status.cartridge?.id ?? (status.romLoaded ? 'system-bios' : undefined);
  const activeRomTitle =
    status.cartridge?.title ?? (status.romLoaded ? 'Tiger System BIOS' : 'Tiger Game.com');

  const handleAddCheat = useCallback(
    async (name: string, code: string) => {
      if (!activeRomId) return;
      const entry: CheatCodeEntry = {
        id:
          typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : `cheat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        romId: activeRomId,
        name,
        code,
        enabled: true,
        createdAt: Date.now(),
      };
      try {
        await saveCheatToDb(entry);
        setCheats((prev) => [...prev, entry]);
        showToast(`Enabled cheat: ${name}`);
      } catch {
        showToast('Failed to save cheat to browser storage.');
      }
    },
    [activeRomId, showToast]
  );

  const handleToggleCheat = useCallback(
    async (id: string) => {
      const target = cheats.find((c) => c.id === id);
      if (!target) return;
      const updated: CheatCodeEntry = { ...target, enabled: !target.enabled };
      try {
        await saveCheatToDb(updated);
        setCheats((prev) => prev.map((c) => (c.id === id ? updated : c)));
      } catch {
        showToast('Failed to update cheat.');
      }
    },
    [cheats, showToast]
  );

  const handleDeleteCheat = useCallback(
    async (id: string) => {
      try {
        await deleteCheatFromDb(id);
        setCheats((prev) => prev.filter((c) => c.id !== id));
      } catch {
        showToast('Failed to delete cheat.');
      }
    },
    [showToast]
  );

  const handleCreateServer = useCallback(
    async (opts: {
      roomName: string;
      isPublic: boolean;
      controlMode: MultiplayerControlMode;
    }) => {
      const client = mpClientRef.current;
      const m = machineRef.current;
      if (!client || !m) return;
      setConnectingRoom(true);
      try {
        m.audio.resume();
        await client.createRoom({
          hostName: playerName.trim() || 'Player 1',
          roomName: opts.roomName,
          gameTitle: activeRomTitle,
          isPublic: opts.isPublic,
          controlMode: opts.controlMode,
        });
      } catch (err) {
        setConnectingRoom(false);
        showToast(err instanceof Error ? err.message : 'Could not open server.');
      }
    },
    [activeRomTitle, playerName, showToast]
  );

  const handleJoinServer = useCallback(
    async (code: string) => {
      const client = mpClientRef.current;
      const m = machineRef.current;
      if (!client || !m) return;
      setConnectingRoom(true);
      try {
        m.audio.resume();
        await client.joinRoom(code, playerName.trim() || 'Player 2');
      } catch (err) {
        setConnectingRoom(false);
        showToast(err instanceof Error ? err.message : 'Could not join server.');
      }
    },
    [playerName, showToast]
  );

  const handleLeaveServer = useCallback(() => {
    const client = mpClientRef.current;
    const m = machineRef.current;
    client?.leaveRoom();
    mpRoleRef.current = null;
    mpRoomRef.current = null;
    setMpRole(null);
    setMpPlayerId(null);
    setMpRoom(null);
    if (m?.isExternalStreamMode()) {
      m.setExternalStreamMode(false);
    }
    showToast('Disconnected from multiplayer server.');
    void refreshPublicRooms();
  }, [refreshPublicRooms, showToast]);

  const handleCopyInvite = useCallback(
    async (code: string) => {
      const url = `${window.location.origin}${window.location.pathname}?room=${code}`;
      try {
        await navigator.clipboard.writeText(url);
        showToast(`Copied invite link for ${code}`);
      } catch {
        showToast(`Share server code: ${code}`);
      }
    },
    [showToast]
  );

  const handleDeleteSlot = useCallback(
    async (slot: number) => {
      const romId = status.cartridge?.id ?? (status.romLoaded ? 'system-bios' : undefined);
      if (!romId) return;
      try {
        await deleteStateFromDb(romId, slot);
        setSaveStates((prev) => {
          const next = { ...prev };
          delete next[slot];
          return next;
        });
        showToast(`Deleted Slot ${slot}`);
      } catch {
        showToast('Failed to delete savestate.');
      }
    },
    [status.cartridge?.id, status.romLoaded, showToast]
  );

  const handleExportSlot = useCallback(
    (slot: number) => {
      const entry = saveStates[slot];
      if (!entry) return;
      exportSaveStateFile(entry);
      showToast(`Exported Slot ${slot} as .tgcstate`);
    },
    [saveStates, showToast]
  );

  const handleImportStateFile = useCallback(
    async (file: File) => {
      const m = machineRef.current;
      if (!m) return;
      try {
        const parsed = await parseSaveStateFile(file);
        const slot = parsed.slot >= 1 && parsed.slot <= 4 ? parsed.slot : 1;
        const targetRomId = status.cartridge?.id ?? parsed.romId;
        const normalized: SaveStateData = {
          ...parsed,
          slot,
          romId: targetRomId,
          romTitle: status.cartridge?.title ?? parsed.romTitle,
        };
        m.restoreSaveState(normalized);
        await saveStateToDb(normalized);
        setSaveStates((prev) => ({ ...prev, [slot]: normalized }));
        showToast(`Imported .tgcstate into Slot ${slot}`);
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Failed to import savestate.');
      }
    },
    [showToast, status.cartridge]
  );

  const handleLoadRomFile = useCallback(
    async (file: File) => {
      const m = machineRef.current;
      if (!m) return;
      try {
        const buffer = await file.arrayBuffer();
        let bytes: Uint8Array = new Uint8Array(buffer);
        let romFilename = file.name;

        if (isZipBuffer(bytes) || /\.zip$/i.test(file.name)) {
          const entries = await extractZipEntries(buffer);
          const candidate =
            entries.find(
              (e) => !e.name.startsWith('__MACOSX') && /\.(tgc|tcg|bin)$/i.test(e.name)
            ) ??
            entries.find(
              (e) =>
                !e.name.startsWith('__MACOSX') &&
                e.bytes.length >= 64 &&
                !/\.(txt|nfo|diz|md|png|jpg)$/i.test(e.name)
            );
          if (!candidate) {
            showToast('No .tgc, .tcg, or .bin ROM found inside ZIP archive.');
            return;
          }
          bytes = candidate.bytes;
          romFilename = candidate.name.split('/').pop() || file.name;
        }

        if (bytes.length < 64) {
          showToast('File is too small to be a valid Game.com ROM.');
          return;
        }

        if (mpRoleRef.current === 'guest') {
          mpClientRef.current?.leaveRoom();
          m.setExternalStreamMode(false);
          mpRoleRef.current = null;
          mpRoomRef.current = null;
          setMpRole(null);
          setMpPlayerId(null);
          setMpRoom(null);
        }

        m.audio.resume();
        const info = m.loadRomBytes(bytes, romFilename, false);
        await refreshSaveStates(info.id);
        await refreshCheats(info.id);
        if (mpRoleRef.current === 'host') {
          mpClientRef.current?.updateRoom({ gameTitle: info.title });
          mpClientRef.current?.sendFrameBinary(m.getPackedFrame(), true);
        }

        const nextStatus = m.getStatus();
        if (nextStatus.waitingForBiosPrompt) {
          showToast(
            `Loaded ${info.title} — Load System BIOS (gamecom.zip / internal + external) to boot`
          );
        } else {
          showToast(`Loaded ${info.title} (${romFilename})`);
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Unable to read ROM file.');
      }
    },
    [refreshCheats, refreshSaveStates, showToast]
  );

  const handleLoadBuiltIn = useCallback(
    async (rom: BuiltInRomEntry) => {
      const m = machineRef.current;
      if (!m) return;
      if (mpRoleRef.current === 'guest') {
        mpClientRef.current?.leaveRoom();
        m.setExternalStreamMode(false);
        mpRoleRef.current = null;
        mpRoomRef.current = null;
        setMpRole(null);
        setMpPlayerId(null);
        setMpRoom(null);
      }
      m.audio.resume();
      const info = m.loadRomBytes(
        rom.bytes,
        rom.info.filename,
        true,
        rom.info.description
      );
      await refreshSaveStates(info.id);
      await refreshCheats(info.id);
      if (mpRoleRef.current === 'host') {
        mpClientRef.current?.updateRoom({ gameTitle: info.title });
        mpClientRef.current?.sendFrameBinary(m.getPackedFrame(), true);
      }
      showToast(`Booted ${info.title}`);
    },
    [refreshCheats, refreshSaveStates, showToast]
  );

  const handleLoadBiosFile = useCallback(
    async (file: File, target: 'internal' | 'external' | 'auto' = 'auto') => {
      const m = machineRef.current;
      if (!m) return;
      try {
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);

        if (isZipBuffer(bytes) || /\.zip$/i.test(file.name)) {
          const entries = await extractZipEntries(buffer);
          const validEntries = entries.filter(
            (e) => !e.name.startsWith('__MACOSX') && e.bytes.length >= 1024
          );

          const internalEntry =
            validEntries.find((e) => /internal/i.test(e.name)) ??
            validEntries.find((e) => e.bytes.length <= 8192);
          const externalEntry =
            validEntries.find((e) => /external/i.test(e.name)) ??
            validEntries.find((e) => e.bytes.length > 8192);

          if (!internalEntry && !externalEntry) {
            showToast('No valid BIOS binaries found in ZIP archive.');
            return;
          }

          const loadedParts: string[] = [];
          if (internalEntry) {
            const name = internalEntry.name.split('/').pop() || 'internal.bin';
            m.loadInternalBiosBytes(internalEntry.bytes, name);
            await saveBiosToDb({
              key: 'internal',
              filename: name,
              bytes: internalEntry.bytes,
              updatedAt: Date.now(),
            });
            loadedParts.push(name);
          }
          if (externalEntry) {
            const name = externalEntry.name.split('/').pop() || 'external.bin';
            m.loadExternalBiosBytes(externalEntry.bytes, name);
            await saveBiosToDb({
              key: 'external',
              filename: name,
              bytes: externalEntry.bytes,
              updatedAt: Date.now(),
            });
            loadedParts.push(name);
          }

          const nextStatus = m.getStatus();
          if (nextStatus.cartridge && !nextStatus.cartridge.isHomebrew && !nextStatus.waitingForBiosPrompt) {
            showToast(`Loaded BIOS & booted ${nextStatus.cartridge.title}`);
          } else {
            showToast(`Loaded BIOS from ${file.name}: ${loadedParts.join(' + ')}`);
          }
          return;
        }

        const isInternal =
          target === 'internal' || (target === 'auto' && bytes.length <= 8192);

        if (isInternal) {
          m.loadInternalBiosBytes(bytes, file.name);
          await saveBiosToDb({
            key: 'internal',
            filename: file.name,
            bytes,
            updatedAt: Date.now(),
          });
          const nextStatus = m.getStatus();
          if (nextStatus.cartridge && !nextStatus.cartridge.isHomebrew && !nextStatus.waitingForBiosPrompt) {
            showToast(`Loaded ${file.name} & booted ${nextStatus.cartridge.title}`);
          } else {
            showToast(`Loaded Internal Boot BIOS (${file.name})`);
          }
        } else {
          m.loadExternalBiosBytes(bytes, file.name);
          await saveBiosToDb({
            key: 'external',
            filename: file.name,
            bytes,
            updatedAt: Date.now(),
          });
          const nextStatus = m.getStatus();
          if (nextStatus.cartridge && !nextStatus.cartridge.isHomebrew && !nextStatus.waitingForBiosPrompt) {
            showToast(`Loaded ${file.name} & booted ${nextStatus.cartridge.title}`);
          } else {
            showToast(`Loaded External OS BIOS (${file.name})`);
          }
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Unable to read BIOS file.');
      }
    },
    [showToast]
  );

  const handleTogglePreferBios = useCallback(() => {
    const m = machineRef.current;
    if (!m) return;
    const next = !status.bios.preferBios;
    m.setPreferBios(next);
    showToast(next ? 'Boot mode: External System BIOS' : 'Boot mode: Clean-Room Bootloader');
  }, [showToast, status.bios.preferBios]);

  const handleClearBios = useCallback(async () => {
    const m = machineRef.current;
    if (!m) return;
    m.clearBios();
    try {
      await clearBiosFromDb();
    } catch {
      // Ignore storage error
    }
    showToast('Cleared persisted System BIOS ROMs');
  }, [showToast]);

  const handleShaderChange = useCallback((next: ShaderSettings) => {
    setShaderSettings(next);
    machineRef.current?.setShaderSettings(next);
  }, []);

  const handleGamepadConfigChange = useCallback((next: GamepadConfig) => {
    setGamepadConfig(next);
    machineRef.current?.gamepad.setConfig(next);
  }, []);

  const handleRemapGamepadAction = useCallback(
    (action: GamepadAction, btnIndex: number) => {
      const m = machineRef.current;
      if (!m) return;
      const updated = m.gamepad.remapAction(action, btnIndex);
      setGamepadConfig(updated);
      showToast(`Mapped ${action} to Button ${btnIndex}`);
    },
    [showToast]
  );

  const handleResetGamepadDefaults = useCallback(() => {
    const m = machineRef.current;
    if (!m) return;
    const updated = m.gamepad.resetDefaults();
    setGamepadConfig(updated);
    showToast('Reset controller mapping to defaults');
  }, [showToast]);

  // Global keyboard shortcuts & handheld input
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key === 'F5') {
        e.preventDefault();
        if (mpRoleRef.current !== 'guest') {
          void handleSaveSlot(1);
        }
        return;
      }
      if (e.key === 'F8') {
        e.preventDefault();
        if (mpRoleRef.current !== 'guest') {
          handleLoadSlot(1);
        }
        return;
      }
      if (e.key === ' ' || e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        machineRef.current?.togglePause();
        return;
      }

      const btn = KEY_MAP[e.key];
      if (btn) {
        e.preventDefault();
        if (!e.repeat) {
          handleButtonChange(btn, true);
        }
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const btn = KEY_MAP[e.key];
      if (btn) {
        e.preventDefault();
        handleButtonChange(btn, false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [handleButtonChange, handleLoadSlot, handleSaveSlot]);

  return (
    <div className="min-h-screen flex flex-col bg-[#121417] text-[#e6e9ef]">
      {/* Strict 3-Zone Top Navigation Bar */}
      <header className="border-b border-white/10 bg-[#15181c]">
        <div className="max-w-[1380px] mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-6">
          <a
            href="#top"
            className="font-display text-lg font-bold tracking-tight text-zinc-100 whitespace-nowrap shrink-0"
          >
            Game.com Studio
          </a>

          <nav className="hidden lg:flex items-center gap-5 text-sm font-medium text-zinc-400">
            {(
              [
                { id: 'cartridge', label: 'Cartridges & BIOS' },
                { id: 'cheats', label: 'Cheats' },
                { id: 'multiplayer', label: 'Multiplayer' },
                { id: 'savestates', label: 'Savestates' },
                { id: 'audio', label: 'Shaders & Audio' },
              ] as const
            ).map((navItem) => (
              <button
                key={navItem.id}
                type="button"
                onClick={() => setActiveTab(navItem.id)}
                className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                  activeTab === navItem.id
                    ? 'border-amber-400 text-zinc-100'
                    : 'border-transparent hover:text-zinc-200'
                }`}
              >
                {navItem.label}
              </button>
            ))}
          </nav>

          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={() => topFileInputRef.current?.click()}
              className="px-4 py-2 rounded-lg text-xs font-semibold bg-amber-500 hover:bg-amber-400 text-zinc-950 flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors focus-visible:outline-2 focus-visible:outline-amber-300"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              <span>Load ROM</span>
            </button>
            <input
              ref={topFileInputRef}
              type="file"
              accept=".tgc,.tcg,.bin,.zip"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleLoadRomFile(file);
                e.target.value = '';
              }}
            />
          </div>
        </div>
      </header>

      {/* Main Emulator Workspace */}
      <main id="top" className="flex-1 max-w-[1380px] w-full mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_480px] gap-8 items-start">
          {/* Primary Focal Anchor: Handheld Hardware Unit */}
          <div className="flex flex-col gap-4">
            <ConsoleUnit
              canvasRef={canvasRef}
              status={status}
              pressedButtons={pressedButtons}
              shaderId={shaderSettings.id}
              connectedGamepadCount={connectedGamepads.length}
              muted={audioState.muted}
              multiplayerSession={
                mpRole && mpRoom
                  ? { role: mpRole, code: mpRoom.code, gameTitle: mpRoom.romTitle }
                  : null
              }
              onButtonChange={handleButtonChange}
              onTouchChange={handleTouchChange}
              onTogglePause={() => machineRef.current?.togglePause()}
              onReset={() => {
                if (mpRoleRef.current === 'guest') return;
                machineRef.current?.reset();
                showToast('System reset');
              }}
              onQuickSave={() => {
                if (mpRoleRef.current === 'guest') return;
                void handleSaveSlot(1);
              }}
              onQuickLoad={() => {
                if (mpRoleRef.current === 'guest') return;
                handleLoadSlot(1);
              }}
              onToggleMute={() => {
                const m = machineRef.current;
                if (!m) return;
                m.audio.resume();
                m.audio.setMuted(!audioState.muted);
                setAudioState(m.audio.getState());
              }}
            />

            {/* Feedback Toast Strip (only visible when action occurs) */}
            {notice && (
              <div
                role="status"
                aria-live="polite"
                className="max-w-[780px] w-full mx-auto px-4 py-2.5 rounded-lg bg-[#1c2026] border border-amber-500/30 text-xs font-medium text-amber-200 flex items-center justify-between"
              >
                <span>{notice}</span>
                <button
                  type="button"
                  onClick={() => setNotice(null)}
                  className="text-zinc-400 hover:text-zinc-200 text-xs ml-4"
                >
                  Dismiss
                </button>
              </div>
            )}
          </div>

          {/* Right Workbench */}
          <aside aria-label="Emulator Workbench" className="w-full space-y-5">
            {/* Segmented Tab Switcher (single-row concise labels) */}
            <div className="grid grid-cols-5 gap-1 p-1 rounded-xl bg-[#181b20] border border-white/10">
              {(
                [
                  { id: 'cartridge', label: 'Carts' },
                  { id: 'cheats', label: 'Cheats' },
                  { id: 'multiplayer', label: 'Online' },
                  { id: 'savestates', label: 'States' },
                  { id: 'audio', label: 'Shaders' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`py-2 px-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-amber-400 ${
                    activeTab === tab.id
                      ? 'bg-[#262b34] text-zinc-100 shadow-sm'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {activeTab === 'cartridge' && (
              <CartridgePanel
                currentCartridge={status.cartridge}
                bios={status.bios}
                waitingForBiosPrompt={status.waitingForBiosPrompt}
                builtInRoms={builtInRoms}
                onLoadRomFile={(f) => void handleLoadRomFile(f)}
                onLoadBuiltIn={(r) => void handleLoadBuiltIn(r)}
                onLoadBiosFile={(f, target) => void handleLoadBiosFile(f, target)}
                onTogglePreferBios={handleTogglePreferBios}
                onClearBios={() => void handleClearBios()}
                onBootBios={() => {
                  const m = machineRef.current;
                  if (!m) return;
                  if (mpRoleRef.current === 'guest') {
                    mpClientRef.current?.leaveRoom();
                    m.setExternalStreamMode(false);
                    mpRoleRef.current = null;
                    mpRoomRef.current = null;
                    setMpRole(null);
                    setMpPlayerId(null);
                    setMpRoom(null);
                  }
                  m.audio.resume();
                  m.bootSystemBios();
                  void refreshSaveStates('system-bios');
                  void refreshCheats('system-bios');
                  if (mpRoleRef.current === 'host') {
                    mpClientRef.current?.updateRoom({ gameTitle: 'Tiger System BIOS' });
                    mpClientRef.current?.sendFrameBinary(m.getPackedFrame(), true);
                  }
                  showToast('Booted Tiger Game.com System BIOS');
                }}
              />
            )}

            {activeTab === 'cheats' && (
              <CheatPanel
                romLoaded={status.romLoaded}
                romTitle={activeRomTitle}
                isGuestSession={mpRole === 'guest'}
                masterEnabled={cheatsMasterEnabled}
                cheats={cheats}
                onToggleMaster={() => {
                  const next = !cheatsMasterEnabled;
                  setCheatsMasterEnabled(next);
                  showToast(next ? 'Cheats enabled' : 'Cheats paused');
                }}
                onAddCheat={(name, code) => void handleAddCheat(name, code)}
                onToggleCheat={(id) => void handleToggleCheat(id)}
                onDeleteCheat={(id) => void handleDeleteCheat(id)}
              />
            )}

            {activeTab === 'multiplayer' && (
              <MultiplayerPanel
                playerName={playerName}
                onPlayerNameChange={handlePlayerNameChange}
                romLoaded={status.romLoaded && mpRole !== 'guest'}
                currentGameTitle={activeRomTitle}
                role={mpRole}
                playerId={mpPlayerId}
                room={mpRoom}
                publicRooms={publicRooms}
                loadingRooms={loadingRooms}
                connecting={connectingRoom}
                chatMessages={chatMessages}
                initialJoinCode={initialRoomParam}
                onRefreshRooms={() => void refreshPublicRooms()}
                onCreateServer={(opts) => void handleCreateServer(opts)}
                onJoinServer={(code) => void handleJoinServer(code)}
                onLeaveServer={handleLeaveServer}
                onUpdateControlMode={(mode) => mpClientRef.current?.updateRoom({ controlMode: mode })}
                onSendChat={(text) => mpClientRef.current?.sendChat(text)}
                onCopyInvite={(code) => void handleCopyInvite(code)}
              />
            )}

            {activeTab === 'savestates' && (
              <SavestatePanel
                romLoaded={status.romLoaded && mpRole !== 'guest'}
                romTitle={activeRomTitle}
                states={saveStates}
                onSaveSlot={(slot) => void handleSaveSlot(slot)}
                onLoadSlot={handleLoadSlot}
                onDeleteSlot={(slot) => void handleDeleteSlot(slot)}
                onExportSlot={handleExportSlot}
                onImportStateFile={(f) => void handleImportStateFile(f)}
              />
            )}

            {activeTab === 'audio' && machineRef.current && (
              <AudioAndDebugPanel
                audioEngine={machineRef.current.audio}
                audioState={audioState}
                paletteId={paletteId}
                shaderSettings={shaderSettings}
                gamepadManager={machineRef.current.gamepad}
                gamepadConfig={gamepadConfig}
                connectedGamepads={connectedGamepads}
                cpuSnapshot={cpuSnapshot}
                isPaused={status.paused}
                onVolumeChange={(v) => {
                  const m = machineRef.current;
                  if (!m) return;
                  m.audio.resume();
                  m.audio.setMasterVolume(v);
                  setAudioState(m.audio.getState());
                }}
                onToggleMute={() => {
                  const m = machineRef.current;
                  if (!m) return;
                  m.audio.resume();
                  m.audio.setMuted(!audioState.muted);
                  setAudioState(m.audio.getState());
                }}
                onToggleChannel={(ch) => {
                  const m = machineRef.current;
                  if (!m) return;
                  m.audio.resume();
                  m.audio.toggleChannel(ch);
                  setAudioState(m.audio.getState());
                }}
                onPaletteChange={(id) => {
                  setPaletteId(id);
                  machineRef.current?.setPalette(id);
                }}
                onShaderChange={handleShaderChange}
                onGamepadConfigChange={handleGamepadConfigChange}
                onRemapGamepadAction={handleRemapGamepadAction}
                onResetGamepadDefaults={handleResetGamepadDefaults}
                onStepCpu={() => machineRef.current?.stepInstruction()}
              />
            )}
          </aside>
        </div>
      </main>
    </div>
  );
}
