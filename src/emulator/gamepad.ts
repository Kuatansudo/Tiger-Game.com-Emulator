import {
  ConnectedGamepadInfo,
  GamepadAction,
  GamepadButtonMap,
  GamepadConfig,
  InputButton,
} from './types';

const STORAGE_KEY = 'tiger_gamecom_gamepad_cfg_v1';

export const DEFAULT_GAMEPAD_MAP: GamepadButtonMap = {
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
  A: 0,         // Cross / A
  B: 1,         // Circle / B
  C: 2,         // Square / X
  D: 3,         // Triangle / Y
  MENU: 8,      // Back / Select
  PAUSE: 9,     // Start
  QUICKSAVE: 4, // LB
  QUICKLOAD: 5, // RB
  STYLUS_TAP: 7, // RT
};

export const DEFAULT_GAMEPAD_CONFIG: GamepadConfig = {
  enabled: true,
  deadzone: 0.35,
  rightStickStylus: true,
  buttonMap: { ...DEFAULT_GAMEPAD_MAP },
};

export function loadGamepadConfig(): GamepadConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_GAMEPAD_CONFIG, buttonMap: { ...DEFAULT_GAMEPAD_MAP } };
    const parsed = JSON.parse(raw) as Partial<GamepadConfig>;
    return {
      enabled: parsed.enabled ?? true,
      deadzone: typeof parsed.deadzone === 'number' ? parsed.deadzone : 0.35,
      rightStickStylus: parsed.rightStickStylus ?? true,
      buttonMap: {
        ...DEFAULT_GAMEPAD_MAP,
        ...(parsed.buttonMap || {}),
      },
    };
  } catch {
    return { ...DEFAULT_GAMEPAD_CONFIG, buttonMap: { ...DEFAULT_GAMEPAD_MAP } };
  }
}

export function saveGamepadConfig(cfg: GamepadConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    // Ignore storage quota errors
  }
}

export interface GamepadPollCallbacks {
  onButtonState: (btn: InputButton, pressed: boolean) => void;
  onTogglePause: () => void;
  onQuickSave: () => void;
  onQuickLoad: () => void;
  onStylusUpdate: (active: boolean, x: number, y: number) => void;
}

export class GamepadManager {
  private config: GamepadConfig = loadGamepadConfig();
  private prevActionStates = new Map<GamepadAction, boolean>();
  private prevGamepadButtons = new Set<InputButton>();
  private stylusX = 100;
  private stylusY = 80;
  private stylusMoving = false;
  private stylusTapping = false;

  public getConfig(): GamepadConfig {
    return {
      ...this.config,
      buttonMap: { ...this.config.buttonMap },
    };
  }

  public setConfig(next: GamepadConfig): void {
    this.config = {
      ...next,
      buttonMap: { ...next.buttonMap },
    };
    saveGamepadConfig(this.config);
  }

  public remapAction(action: GamepadAction, buttonIndex: number): GamepadConfig {
    this.config.buttonMap[action] = buttonIndex;
    saveGamepadConfig(this.config);
    return this.getConfig();
  }

  public resetDefaults(): GamepadConfig {
    this.config = {
      ...DEFAULT_GAMEPAD_CONFIG,
      buttonMap: { ...DEFAULT_GAMEPAD_MAP },
    };
    saveGamepadConfig(this.config);
    return this.getConfig();
  }

  public getConnectedGamepads(): ConnectedGamepadInfo[] {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return [];
    const pads = navigator.getGamepads();
    const list: ConnectedGamepadInfo[] = [];
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      const activeButtons: number[] = [];
      for (let i = 0; i < pad.buttons.length; i++) {
        if (pad.buttons[i]?.pressed) activeButtons.push(i);
      }
      list.push({
        index: pad.index,
        id: pad.id,
        buttons: pad.buttons.length,
        axes: pad.axes.length,
        activeButtons,
      });
    }
    return list;
  }

  /**
   * Returns the first newly pressed physical gamepad button index (used for interactive remapping).
   */
  public detectPressedButtonIndex(): number | null {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      for (let i = 0; i < pad.buttons.length; i++) {
        if (pad.buttons[i]?.pressed) return i;
      }
    }
    return null;
  }

  public getStylusCursor(): { visible: boolean; x: number; y: number } {
    return {
      visible: this.stylusMoving || this.stylusTapping,
      x: Math.round(this.stylusX),
      y: Math.round(this.stylusY),
    };
  }

  public poll(callbacks: GamepadPollCallbacks): void {
    if (!this.config.enabled) return;
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return;
    const pads = navigator.getGamepads();

    let activePad: Gamepad | null = null;
    for (const p of pads) {
      if (p && p.connected) {
        activePad = p;
        break;
      }
    }
    if (!activePad) {
      if (this.prevGamepadButtons.size > 0) {
        for (const btn of this.prevGamepadButtons) {
          callbacks.onButtonState(btn, false);
        }
        this.prevGamepadButtons.clear();
      }
      return;
    }

    const isBtnDown = (idx: number): boolean => Boolean(activePad!.buttons[idx]?.pressed);
    const dz = this.config.deadzone;
    const ax0 = activePad.axes[0] ?? 0;
    const ax1 = activePad.axes[1] ?? 0;

    const held = new Set<InputButton>();
    if (isBtnDown(this.config.buttonMap.UP) || ax1 < -dz) held.add('UP');
    if (isBtnDown(this.config.buttonMap.DOWN) || ax1 > dz) held.add('DOWN');
    if (isBtnDown(this.config.buttonMap.LEFT) || ax0 < -dz) held.add('LEFT');
    if (isBtnDown(this.config.buttonMap.RIGHT) || ax0 > dz) held.add('RIGHT');
    if (isBtnDown(this.config.buttonMap.A)) held.add('A');
    if (isBtnDown(this.config.buttonMap.B)) held.add('B');
    if (isBtnDown(this.config.buttonMap.C)) held.add('C');
    if (isBtnDown(this.config.buttonMap.D)) held.add('D');
    if (isBtnDown(this.config.buttonMap.MENU)) held.add('MENU');

    const allBtns: InputButton[] = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'A', 'B', 'C', 'D', 'MENU'];
    for (const btn of allBtns) {
      const nowDown = held.has(btn);
      const wasDown = this.prevGamepadButtons.has(btn);
      if (nowDown !== wasDown) {
        callbacks.onButtonState(btn, nowDown);
        if (nowDown) this.prevGamepadButtons.add(btn);
        else this.prevGamepadButtons.delete(btn);
      }
    }

    // Edge-triggered emulator actions
    const checkEdge = (action: GamepadAction, cb: () => void) => {
      const now = isBtnDown(this.config.buttonMap[action]);
      const prev = this.prevActionStates.get(action) ?? false;
      this.prevActionStates.set(action, now);
      if (now && !prev) cb();
    };

    checkEdge('PAUSE', callbacks.onTogglePause);
    checkEdge('QUICKSAVE', callbacks.onQuickSave);
    checkEdge('QUICKLOAD', callbacks.onQuickLoad);

    // Right analog stick -> Virtual Stylus Cursor + RT tap
    if (this.config.rightStickStylus && activePad.axes.length >= 4) {
      const rx = activePad.axes[2] ?? 0;
      const ry = activePad.axes[3] ?? 0;
      const moving = Math.abs(rx) > dz || Math.abs(ry) > dz;
      if (moving) {
        this.stylusX = Math.max(0, Math.min(199, this.stylusX + rx * 3.2));
        this.stylusY = Math.max(0, Math.min(159, this.stylusY + ry * 3.2));
      }
      const tapping = isBtnDown(this.config.buttonMap.STYLUS_TAP);
      if (tapping !== this.stylusTapping || (tapping && moving)) {
        callbacks.onStylusUpdate(tapping, Math.round(this.stylusX), Math.round(this.stylusY));
      }
      this.stylusMoving = moving;
      this.stylusTapping = tapping;
    }
  }
}
