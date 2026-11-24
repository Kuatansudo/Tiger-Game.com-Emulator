import { GameComAudioEngine } from './audio';
import { compileEnabledCheats } from './cheats';
import { GamepadManager } from './gamepad';
import { RealGameComCore } from './realGameCom';
import {
  drawCleanRoomCartridgeScreen,
  getBuiltInRoms,
  parseTgcRom,
} from './roms';
import { LcdShaderRenderer } from './shaders';
import {
  REG_LCC,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  SM8521,
  VRAM_BANK_BYTES,
} from './sm8521';
import {
  CartridgeInfo,
  CheatCodeEntry,
  CheatPatchRule,
  CpuSnapshot,
  EmulatorStatus,
  InputButton,
  LCD_PALETTES,
  LcdPaletteId,
  SaveStateData,
  ShaderSettings,
} from './types';

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const n = parseInt(clean, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export class GameComMachine {
  public audio: GameComAudioEngine;
  public cpu: SM8521;
  public realCore: RealGameComCore;
  public gamepad: GamepadManager;
  private shaderRenderer: LcdShaderRenderer;

  private cartridge: CartridgeInfo | null = null;
  private useRealCore = false;
  private systemBiosBootRequested = false;
  private lastRealBootKey = '';
  private running = false;
  private paused = false;
  private waitingForBiosPrompt = false;
  private rafId: number | null = null;
  private lastFrameTime = 0;
  private accumulator = 0;
  private frameCount = 0;
  private fps = 60;
  private fpsFrames = 0;
  private fpsLastMeasure = 0;

  private paletteId: LcdPaletteId = 'olive';
  private shaderSettings: ShaderSettings = {
    id: 'dot-matrix',
    intensity: 0.75,
    lcdGhosting: true,
  };
  private prevShadeBuffer = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);
  private realShadeBuffer = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);
  private latestPackedFrame = new Uint8Array(VRAM_BANK_BYTES);
  private externalPackedFrame = new Uint8Array(VRAM_BANK_BYTES);
  private externalStreamMode = false;
  private hasExternalFrame = false;
  private externalTouchActive = false;
  private externalTouchX = 0;
  private externalTouchY = 0;

  private cheatsEnabled = true;
  private activeRamCheats: CheatPatchRule[] = [];

  private offscreenCanvas: HTMLCanvasElement;
  private offscreenCtx: CanvasRenderingContext2D | null;
  private imageData: ImageData | null = null;

  private onStatusChange?: (status: EmulatorStatus) => void;
  private onCpuTick?: (snapshot: CpuSnapshot) => void;
  private onGamepadButton?: (btn: InputButton, pressed: boolean) => void;
  private onGamepadStylus?: (active: boolean, x: number, y: number) => void;
  private onFrameRendered?: (packedFrame: Uint8Array) => void;
  private onQuickSave?: () => void;
  private onQuickLoad?: () => void;

  constructor(callbacks?: {
    onStatusChange?: (status: EmulatorStatus) => void;
    onCpuTick?: (snapshot: CpuSnapshot) => void;
    onGamepadButton?: (btn: InputButton, pressed: boolean) => void;
    onGamepadStylus?: (active: boolean, x: number, y: number) => void;
    onFrameRendered?: (packedFrame: Uint8Array) => void;
    onQuickSave?: () => void;
    onQuickLoad?: () => void;
  }) {
    this.audio = new GameComAudioEngine();
    this.cpu = new SM8521(this.audio);
    this.realCore = new RealGameComCore(this.audio);
    this.gamepad = new GamepadManager();
    this.shaderRenderer = new LcdShaderRenderer();

    this.offscreenCanvas = document.createElement('canvas');
    this.offscreenCanvas.width = SCREEN_WIDTH;
    this.offscreenCanvas.height = SCREEN_HEIGHT;
    this.offscreenCtx = this.offscreenCanvas.getContext('2d');
    if (this.offscreenCtx) {
      this.imageData = this.offscreenCtx.createImageData(SCREEN_WIDTH, SCREEN_HEIGHT);
    }

    this.onStatusChange = callbacks?.onStatusChange;
    this.onCpuTick = callbacks?.onCpuTick;
    this.onGamepadButton = callbacks?.onGamepadButton;
    this.onGamepadStylus = callbacks?.onGamepadStylus;
    this.onFrameRendered = callbacks?.onFrameRendered;
    this.onQuickSave = callbacks?.onQuickSave;
    this.onQuickLoad = callbacks?.onQuickLoad;
  }

  public attachCanvas(canvas: HTMLCanvasElement | null): void {
    this.shaderRenderer.attach(canvas);
    this.renderScreen();
  }

  public loadBuiltInRom(idOrFilename: string): void {
    const builtIns = getBuiltInRoms();
    const match =
      builtIns.find((r) => r.info.id === idOrFilename || r.info.filename === idOrFilename) ||
      builtIns[0];
    this.loadRomBytes(match.bytes, match.info.filename, true, match.info.description);
  }

  private evaluateBiosPromptState(forceRealReset = false): void {
    const bios = this.cpu.getBiosState();
    this.realCore.biosState.preferBios = bios.preferBios;
    const hasFullBios = bios.internalLoaded && bios.externalLoaded && bios.preferBios;

    if (!this.cartridge) {
      if (this.systemBiosBootRequested && hasFullBios) {
        this.useRealCore = true;
        this.waitingForBiosPrompt = false;
        const bootKey = `bios:${bios.internalSize}:${bios.externalSize}`;
        if (forceRealReset || this.lastRealBootKey !== bootKey) {
          this.realCore.reset();
          this.lastRealBootKey = bootKey;
        }
      } else {
        this.useRealCore = false;
        this.waitingForBiosPrompt = false;
      }
      return;
    }

    if (this.cartridge.isHomebrew) {
      this.useRealCore = false;
      this.waitingForBiosPrompt = false;
      return;
    }

    if (hasFullBios) {
      this.useRealCore = true;
      this.waitingForBiosPrompt = false;
      const bootKey = `cart:${this.cartridge.id}:${bios.internalSize}:${bios.externalSize}`;
      if (forceRealReset || this.lastRealBootKey !== bootKey) {
        this.realCore.reset();
        this.lastRealBootKey = bootKey;
      }
    } else {
      this.useRealCore = false;
      this.waitingForBiosPrompt = true;
      drawCleanRoomCartridgeScreen(
        this.cpu.vramBank0,
        this.cartridge,
        bios.internalLoaded,
        bios.externalLoaded
      );
      this.cpu.halted = true;
    }
  }

  public bootSystemBios(): void {
    this.cartridge = null;
    this.systemBiosBootRequested = true;
    this.realCore.clearCartridge();
    this.frameCount = 0;
    this.prevShadeBuffer.fill(0);
    this.lastRealBootKey = '';
    this.evaluateBiosPromptState(true);
    this.paused = false;
    this.start();
    this.renderScreen();
    this.onCpuTick?.(this.getCpuSnapshot());
    this.emitStatus();
  }

  public loadRomBytes(
    bytes: Uint8Array,
    filename: string,
    isBuiltIn = false,
    description?: string
  ): CartridgeInfo {
    const info = parseTgcRom(bytes, filename, isBuiltIn, description);
    this.cartridge = info;
    this.systemBiosBootRequested = false;
    this.frameCount = 0;
    this.prevShadeBuffer.fill(0);
    this.cpu.loadCartridge(bytes);
    if (!info.isHomebrew) {
      this.realCore.loadCartridge(bytes);
    } else {
      this.realCore.clearCartridge();
    }
    this.evaluateBiosPromptState(true);
    this.paused = false;
    this.start();
    this.renderScreen();
    this.onCpuTick?.(this.getCpuSnapshot());
    this.emitStatus();
    return info;
  }

  public loadInternalBiosBytes(bytes: Uint8Array, filename?: string): void {
    this.cpu.loadInternalBios(bytes, filename);
    this.realCore.loadInternalBios(bytes, filename);
    this.lastRealBootKey = '';
    this.frameCount = 0;
    this.prevShadeBuffer.fill(0);
    this.evaluateBiosPromptState(true);
    this.renderScreen();
    this.onCpuTick?.(this.getCpuSnapshot());
    this.emitStatus();
  }

  public loadExternalBiosBytes(bytes: Uint8Array, filename?: string): void {
    this.cpu.loadExternalBios(bytes, filename);
    this.realCore.loadExternalBios(bytes, filename);
    this.lastRealBootKey = '';
    this.frameCount = 0;
    this.prevShadeBuffer.fill(0);
    this.evaluateBiosPromptState(true);
    this.renderScreen();
    this.onCpuTick?.(this.getCpuSnapshot());
    this.emitStatus();
  }

  public loadBiosBytes(bytes: Uint8Array, filename?: string): void {
    this.cpu.loadBios(bytes, filename);
    if (bytes.length <= 8192) {
      this.realCore.loadInternalBios(bytes, filename);
    } else {
      this.realCore.loadExternalBios(bytes, filename);
    }
    this.lastRealBootKey = '';
    this.frameCount = 0;
    this.prevShadeBuffer.fill(0);
    this.evaluateBiosPromptState(true);
    this.renderScreen();
    this.onCpuTick?.(this.getCpuSnapshot());
    this.emitStatus();
  }

  public clearBios(): void {
    this.cpu.clearBios();
    this.realCore.clearBios();
    this.lastRealBootKey = '';
    this.systemBiosBootRequested = false;
    this.frameCount = 0;
    this.prevShadeBuffer.fill(0);
    this.evaluateBiosPromptState();
    this.renderScreen();
    this.onCpuTick?.(this.getCpuSnapshot());
    this.emitStatus();
  }

  public setPreferBios(prefer: boolean): void {
    this.cpu.setPreferBios(prefer);
    this.realCore.biosState.preferBios = prefer;
    this.lastRealBootKey = '';
    this.frameCount = 0;
    this.prevShadeBuffer.fill(0);
    this.evaluateBiosPromptState(true);
    this.renderScreen();
    this.onCpuTick?.(this.getCpuSnapshot());
    this.emitStatus();
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this.lastFrameTime = performance.now();
    this.fpsLastMeasure = this.lastFrameTime;
    this.fpsFrames = 0;
    this.accumulator = 0;
    this.scheduleNextFrame();
    this.emitStatus();
  }

  public stop(): void {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.audio.silenceAll();
    this.emitStatus();
  }

  public togglePause(): void {
    this.paused = !this.paused;
    if (this.paused) {
      this.audio.silenceAll();
    }
    this.emitStatus();
  }

  public setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) {
      this.audio.silenceAll();
    }
    this.emitStatus();
  }

  public reset(): void {
    this.frameCount = 0;
    this.prevShadeBuffer.fill(0);
    if (this.useRealCore) {
      this.realCore.reset();
    } else {
      this.cpu.reset();
    }
    this.evaluateBiosPromptState();
    this.paused = false;
    if (!this.running) {
      this.start();
    }
    this.renderScreen();
    this.onCpuTick?.(this.getCpuSnapshot());
    this.emitStatus();
  }

  public stepInstruction(): void {
    this.paused = true;
    if (this.useRealCore) {
      this.realCore.step();
    } else {
      this.cpu.step();
    }
    this.renderScreen();
    this.onCpuTick?.(this.getCpuSnapshot());
    this.emitStatus();
  }

  public setButton(btn: InputButton, pressed: boolean): void {
    this.audio.resume();
    if (this.externalStreamMode) return;
    if (this.useRealCore) {
      this.realCore.setButton(btn, pressed);
    } else {
      this.cpu.setButton(btn, pressed);
    }
  }

  public setTouch(active: boolean, x: number, y: number): void {
    if (active) {
      this.audio.resume();
    }
    if (this.externalStreamMode) {
      this.externalTouchActive = active;
      this.externalTouchX = Math.max(0, Math.min(SCREEN_WIDTH - 1, Math.round(x)));
      this.externalTouchY = Math.max(0, Math.min(SCREEN_HEIGHT - 1, Math.round(y)));
      this.emitStatus();
      return;
    }
    if (this.useRealCore) {
      this.realCore.setTouch(active, x, y);
    } else {
      this.cpu.setTouch(active, x, y);
    }
    this.emitStatus();
  }

  public setCheats(entries: CheatCodeEntry[], enabled: boolean): void {
    this.cheatsEnabled = enabled;
    if (!enabled) {
      this.activeRamCheats = [];
      this.realCore.setRomPatches([]);
      this.cpu.setRomPatches([]);
      return;
    }
    const compiled = compileEnabledCheats(entries);
    this.activeRamCheats = compiled.ramRules;
    this.realCore.setRomPatches(compiled.romPatches);
    this.cpu.setRomPatches(compiled.romPatches);
    if (!this.waitingForBiosPrompt && !this.externalStreamMode && !this.paused) {
      this.applyActiveRamCheats();
    }
  }

  private applyActiveRamCheats(): void {
    if (!this.cheatsEnabled || this.activeRamCheats.length === 0) return;
    if (this.useRealCore) {
      for (let i = 0; i < this.activeRamCheats.length; i++) {
        this.realCore.applyRamCheat(this.activeRamCheats[i]);
      }
    } else {
      for (let i = 0; i < this.activeRamCheats.length; i++) {
        this.cpu.applyRamCheat(this.activeRamCheats[i]);
      }
    }
  }

  public setExternalStreamMode(active: boolean): void {
    this.externalStreamMode = active;
    this.hasExternalFrame = false;
    this.externalTouchActive = false;
    this.prevShadeBuffer.fill(0);
    this.audio.silenceAll();
    if (active) {
      this.paused = false;
      if (!this.running) {
        this.start();
      }
    }
    this.renderScreen();
    this.emitStatus();
  }

  public isExternalStreamMode(): boolean {
    return this.externalStreamMode;
  }

  public renderExternalPackedFrame(packed: Uint8Array): void {
    if (packed.length < VRAM_BANK_BYTES) return;
    this.externalPackedFrame.set(packed.subarray(0, VRAM_BANK_BYTES));
    this.hasExternalFrame = true;
    this.renderScreen();
  }

  public getPackedFrame(): Uint8Array {
    return new Uint8Array(this.latestPackedFrame);
  }

  public setPalette(id: LcdPaletteId): void {
    this.paletteId = id;
    this.renderScreen();
  }

  public getPalette(): LcdPaletteId {
    return this.paletteId;
  }

  public setShaderSettings(next: ShaderSettings): void {
    this.shaderSettings = { ...next };
    this.renderScreen();
  }

  public getShaderSettings(): ShaderSettings {
    return { ...this.shaderSettings };
  }

  private scheduleNextFrame(): void {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.tick);
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    const dt = Math.min(100, now - this.lastFrameTime);
    this.lastFrameTime = now;

    // Poll HTML5 Gamepad API every animation frame
    this.gamepad.poll({
      onButtonState: (btn, pressed) => {
        this.setButton(btn, pressed);
        this.onGamepadButton?.(btn, pressed);
      },
      onTogglePause: () => this.togglePause(),
      onQuickSave: () => this.onQuickSave?.(),
      onQuickLoad: () => this.onQuickLoad?.(),
      onStylusUpdate: (active, x, y) => {
        this.setTouch(active, x, y);
        this.onGamepadStylus?.(active, x, y);
      },
    });

    if (!this.paused) {
      const FRAME_MS = 1000 / 60;
      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= FRAME_MS && steps < 3) {
        if (this.externalStreamMode) {
          this.audio.renderRemoteFrame();
        } else if (!this.waitingForBiosPrompt) {
          this.applyActiveRamCheats();
          if (this.useRealCore) {
            this.realCore.runFrame();
          } else {
            this.cpu.runFrame();
          }
          this.applyActiveRamCheats();
        }
        this.frameCount++;
        this.fpsFrames++;
        this.accumulator -= FRAME_MS;
        steps++;
      }
      if (steps > 0 && !this.externalStreamMode) {
        this.renderScreen();
        this.onFrameRendered?.(this.latestPackedFrame);
        if (this.frameCount % 6 === 0) {
          this.onCpuTick?.(this.getCpuSnapshot());
        }
      }
    }

    if (now - this.fpsLastMeasure >= 500) {
      const elapsed = (now - this.fpsLastMeasure) / 1000;
      this.fps = Math.round(this.fpsFrames / Math.max(0.01, elapsed));
      this.fpsFrames = 0;
      this.fpsLastMeasure = now;
      this.emitStatus();
    }

    this.scheduleNextFrame();
  };

  public renderScreen(): void {
    if (!this.offscreenCtx || !this.imageData) return;

    const palette = LCD_PALETTES[this.paletteId];
    const rgb = palette.shades.map(hexToRgb);
    const data = this.imageData.data;

    if (this.externalStreamMode) {
      const ghosting = this.shaderSettings.lcdGhosting && this.hasExternalFrame;
      if (!this.hasExternalFrame) {
        const [r, g, b] = rgb[0];
        for (let i = 0; i < SCREEN_WIDTH * SCREEN_HEIGHT; i++) {
          const p = i * 4;
          data[p] = r;
          data[p + 1] = g;
          data[p + 2] = b;
          data[p + 3] = 255;
        }
      } else {
        for (let i = 0; i < SCREEN_WIDTH * SCREEN_HEIGHT; i++) {
          const byteIdx = i >> 2;
          const shift = 6 - ((i & 3) * 2);
          const shade = (this.externalPackedFrame[byteIdx] >> shift) & 0x03;

          const prevShade = this.prevShadeBuffer[i];
          this.prevShadeBuffer[i] = shade;

          const p = i * 4;
          if (ghosting && prevShade !== shade) {
            const c1 = rgb[shade];
            const c0 = rgb[prevShade];
            data[p] = (c1[0] * 0.78 + c0[0] * 0.22) | 0;
            data[p + 1] = (c1[1] * 0.78 + c0[1] * 0.22) | 0;
            data[p + 2] = (c1[2] * 0.78 + c0[2] * 0.22) | 0;
          } else {
            const c = rgb[shade];
            data[p] = c[0];
            data[p + 1] = c[1];
            data[p + 2] = c[2];
          }
          data[p + 3] = 255;
        }
      }
    } else if (this.useRealCore) {
      this.realCore.renderShadeBuffer(this.realShadeBuffer);
      const lcdOn = (this.realCore.internalRam[0x30] & 0x80) !== 0;
      const ghosting = this.shaderSettings.lcdGhosting && lcdOn;
      this.latestPackedFrame.fill(0);
      for (let i = 0; i < SCREEN_WIDTH * SCREEN_HEIGHT; i++) {
        const shade = this.realShadeBuffer[i];
        if (shade !== 0) {
          this.latestPackedFrame[i >> 2] |= (shade & 0x03) << (6 - ((i & 3) * 2));
        }
        const prevShade = this.prevShadeBuffer[i];
        this.prevShadeBuffer[i] = shade;

        const p = i * 4;
        if (ghosting && prevShade !== shade) {
          const c1 = rgb[shade];
          const c0 = rgb[prevShade];
          data[p] = (c1[0] * 0.78 + c0[0] * 0.22) | 0;
          data[p + 1] = (c1[1] * 0.78 + c0[1] * 0.22) | 0;
          data[p + 2] = (c1[2] * 0.78 + c0[2] * 0.22) | 0;
        } else {
          const c = rgb[shade];
          data[p] = c[0];
          data[p + 1] = c[1];
          data[p + 2] = c[2];
        }
        data[p + 3] = 255;
      }
    } else {
      const lcc = this.cpu.internalRam[REG_LCC];
      const lcdOn = (lcc & 0x80) !== 0 || this.waitingForBiosPrompt;
      const useBank1 = !this.waitingForBiosPrompt && (lcc & 0x40) !== 0;
      const vram = useBank1 ? this.cpu.vramBank1 : this.cpu.vramBank0;

      if (!lcdOn) {
        this.latestPackedFrame.fill(0);
        const [r, g, b] = rgb[0];
        for (let i = 0; i < SCREEN_WIDTH * SCREEN_HEIGHT; i++) {
          const p = i * 4;
          data[p] = r;
          data[p + 1] = g;
          data[p + 2] = b;
          data[p + 3] = 255;
        }
      } else {
        this.latestPackedFrame.set(vram.subarray(0, VRAM_BANK_BYTES));
        const ghosting = this.shaderSettings.lcdGhosting && !this.waitingForBiosPrompt;
        for (let i = 0; i < SCREEN_WIDTH * SCREEN_HEIGHT; i++) {
          const byteIdx = i >> 2;
          const shift = 6 - ((i & 3) * 2);
          const shade = byteIdx < VRAM_BANK_BYTES ? (vram[byteIdx] >> shift) & 0x03 : 0;

          const prevShade = this.prevShadeBuffer[i];
          this.prevShadeBuffer[i] = shade;

          const p = i * 4;
          if (ghosting && prevShade !== shade) {
            const c1 = rgb[shade];
            const c0 = rgb[prevShade];
            data[p] = (c1[0] * 0.78 + c0[0] * 0.22) | 0;
            data[p + 1] = (c1[1] * 0.78 + c0[1] * 0.22) | 0;
            data[p + 2] = (c1[2] * 0.78 + c0[2] * 0.22) | 0;
          } else {
            const c = rgb[shade];
            data[p] = c[0];
            data[p + 1] = c[1];
            data[p + 2] = c[2];
          }
          data[p + 3] = 255;
        }
      }
    }

    this.offscreenCtx.putImageData(this.imageData, 0, 0);
    this.shaderRenderer.render(
      this.offscreenCanvas,
      this.shaderSettings.id,
      this.shaderSettings.intensity
    );
  }

  public captureSaveState(slot: number): SaveStateData | null {
    if (!this.cartridge && !this.useRealCore) return null;
    this.renderScreen();
    const thumbnailDataUrl = this.offscreenCanvas.toDataURL('image/png');
    const waves = this.audio.getWaveTables();
    const romId = this.cartridge?.id ?? 'system-bios';
    const romTitle = this.cartridge?.title ?? 'Tiger System BIOS';

    if (this.useRealCore) {
      return {
        version: 1,
        slot,
        romId,
        romTitle,
        savedAt: Date.now(),
        frameCount: this.frameCount,
        thumbnailDataUrl,
        mode: 'real',
        cpu: {
          pc: this.realCore.pc,
          halted: this.realCore.halted,
          cycles: this.realCore.cycles,
          bootRomMapped: false,
        },
        realCpuState: this.realCore.captureRealCpuState(),
        registerRam: Array.from(this.realCore.registerRam),
        internalRam: Array.from(this.realCore.internalRam),
        extendedRam: Array.from(this.realCore.extendedRam),
        vramBank0: Array.from(this.realCore.vram.subarray(0, 0x2000)),
        vramBank1: Array.from(this.realCore.vram.subarray(0x2000, 0x4000)),
        waveTable0: Array.from(waves.wave0),
        waveTable1: Array.from(waves.wave1),
      };
    }

    return {
      version: 1,
      slot,
      romId,
      romTitle,
      savedAt: Date.now(),
      frameCount: this.frameCount,
      thumbnailDataUrl,
      mode: 'homebrew',
      cpu: {
        pc: this.cpu.pc,
        halted: this.cpu.halted,
        cycles: this.cpu.cycles,
        bootRomMapped: this.cpu.bootRomMapped,
      },
      internalRam: Array.from(this.cpu.internalRam),
      extendedRam: Array.from(this.cpu.extendedRam),
      vramBank0: Array.from(this.cpu.vramBank0),
      vramBank1: Array.from(this.cpu.vramBank1),
      waveTable0: Array.from(waves.wave0),
      waveTable1: Array.from(waves.wave1),
    };
  }

  public restoreSaveState(state: SaveStateData): void {
    if (state.mode === 'real' || state.realCpuState) {
      this.useRealCore = true;
      this.waitingForBiosPrompt = false;
      this.frameCount = state.frameCount;
      this.realCore.restoreRealState({
        pc: state.cpu.pc,
        halted: state.cpu.halted,
        cycles: state.cpu.cycles,
        internalRam: state.internalRam,
        extendedRam: state.extendedRam,
        vramBank0: state.vramBank0,
        vramBank1: state.vramBank1,
        registerRam: state.registerRam,
        realCpuState: state.realCpuState,
      });
      this.prevShadeBuffer.fill(0);
      this.renderScreen();
      this.onCpuTick?.(this.getCpuSnapshot());
      this.emitStatus();
      return;
    }

    this.useRealCore = false;
    this.cpu.internalRam.set(state.internalRam.slice(0, this.cpu.internalRam.length));
    this.cpu.extendedRam.set(state.extendedRam.slice(0, this.cpu.extendedRam.length));
    this.cpu.vramBank0.set(state.vramBank0.slice(0, this.cpu.vramBank0.length));
    this.cpu.vramBank1.set(state.vramBank1.slice(0, this.cpu.vramBank1.length));
    this.cpu.pc = state.cpu.pc;
    this.cpu.halted = state.cpu.halted;
    this.cpu.cycles = state.cpu.cycles;
    this.cpu.bootRomMapped = state.cpu.bootRomMapped;
    this.frameCount = state.frameCount;
    this.waitingForBiosPrompt = false;

    if (state.waveTable0 && state.waveTable1) {
      this.audio.setWaveTables(
        new Uint8Array(state.waveTable0),
        new Uint8Array(state.waveTable1)
      );
    }

    this.audio.silenceAll();
    for (let r = 0x50; r <= 0x59; r++) {
      if (r !== 0x58) {
        this.audio.updateRegister(r, this.cpu.internalRam[r]);
      }
    }

    this.prevShadeBuffer.fill(0);
    this.renderScreen();
    this.onCpuTick?.(this.getCpuSnapshot());
    this.emitStatus();
  }

  public getStatus(): EmulatorStatus {
    return {
      running: this.running,
      paused: this.paused,
      fps: this.paused ? 0 : this.fps,
      frameCount: this.frameCount,
      romLoaded: this.cartridge !== null || this.useRealCore || this.externalStreamMode,
      cartridge: this.cartridge,
      bios: this.cpu.getBiosState(),
      touchActive: this.externalStreamMode
        ? this.externalTouchActive
        : this.useRealCore
          ? this.realCore.touchActive
          : this.cpu.touchActive,
      touchX: this.externalStreamMode
        ? this.externalTouchX
        : this.useRealCore
          ? this.realCore.touchX
          : this.cpu.touchX,
      touchY: this.externalStreamMode
        ? this.externalTouchY
        : this.useRealCore
          ? this.realCore.touchY
          : this.cpu.touchY,
      waitingForBiosPrompt: this.externalStreamMode ? false : this.waitingForBiosPrompt,
    };
  }

  public getCpuSnapshot(): CpuSnapshot {
    return this.useRealCore
      ? this.realCore.getSnapshot(this.frameCount)
      : this.cpu.getSnapshot(this.frameCount);
  }

  private emitStatus(): void {
    this.onStatusChange?.(this.getStatus());
  }

  public destroy(): void {
    this.stop();
    this.shaderRenderer.destroy();
    this.audio.destroy();
  }
}
