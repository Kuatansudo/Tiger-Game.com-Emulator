import React, { useCallback, useRef } from 'react';
import { Pause, Play, RotateCcw, Save, Upload, Volume2, VolumeX } from 'lucide-react';
import { SCREEN_HEIGHT, SCREEN_WIDTH } from '../emulator/sm8521';
import {
  EmulatorStatus,
  InputButton,
  MultiplayerRole,
  SHADER_PRESETS,
  ShaderId,
} from '../emulator/types';

interface ConsoleUnitProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  status: EmulatorStatus;
  pressedButtons: Set<InputButton>;
  shaderId: ShaderId;
  connectedGamepadCount: number;
  muted: boolean;
  multiplayerSession?: {
    role: MultiplayerRole;
    code: string;
    gameTitle: string;
  } | null;
  onButtonChange: (btn: InputButton, pressed: boolean) => void;
  onTouchChange: (active: boolean, x: number, y: number) => void;
  onTogglePause: () => void;
  onReset: () => void;
  onQuickSave: () => void;
  onQuickLoad: () => void;
  onToggleMute: () => void;
}

export const ConsoleUnit: React.FC<ConsoleUnitProps> = ({
  canvasRef,
  status,
  pressedButtons,
  shaderId,
  connectedGamepadCount,
  muted,
  multiplayerSession,
  onButtonChange,
  onTouchChange,
  onTogglePause,
  onReset,
  onQuickSave,
  onQuickLoad,
  onToggleMute,
}) => {
  const isTouchingRef = useRef(false);

  const computeTouchCoords = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
      const rect = e.currentTarget.getBoundingClientRect();
      const relX = (e.clientX - rect.left) / Math.max(1, rect.width);
      const relY = (e.clientY - rect.top) / Math.max(1, rect.height);
      const x = Math.max(0, Math.min(SCREEN_WIDTH - 1, Math.floor(relX * SCREEN_WIDTH)));
      const y = Math.max(0, Math.min(SCREEN_HEIGHT - 1, Math.floor(relY * SCREEN_HEIGHT)));
      return { x, y };
    },
    []
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    isTouchingRef.current = true;
    const { x, y } = computeTouchCoords(e);
    onTouchChange(true, x, y);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isTouchingRef.current) return;
    const { x, y } = computeTouchCoords(e);
    onTouchChange(true, x, y);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isTouchingRef.current) return;
    isTouchingRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    onTouchChange(false, status.touchX, status.touchY);
  };

  const bindHardwareButton = (btn: InputButton) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      onButtonChange(btn, true);
    },
    onPointerUp: (e: React.PointerEvent) => {
      e.preventDefault();
      onButtonChange(btn, false);
    },
    onPointerLeave: () => {
      if (pressedButtons.has(btn)) {
        onButtonChange(btn, false);
      }
    },
    onPointerCancel: () => onButtonChange(btn, false),
  });

  const activeShaderName = SHADER_PRESETS.find((s) => s.id === shaderId)?.name ?? 'LCD';

  return (
    <section aria-label="Handheld Console" className="w-full flex flex-col items-center">
      {/* Tiger Game.com Hardware Chassis */}
      <div className="console-shell w-full max-w-[780px] rounded-[28px] p-5 sm:p-7 border border-white/10 select-none">
        {/* Top Hardware Branding Strip */}
        <div className="flex items-center justify-between gap-4 mb-4 px-1">
          <div className="flex items-baseline gap-2.5">
            <span className="font-display text-lg sm:text-xl font-bold tracking-wider text-zinc-100">
              TIGER
            </span>
            <span className="font-display text-base sm:text-lg font-semibold tracking-tight text-amber-400">
              game.com
            </span>
          </div>

          <div className="flex items-center gap-2 text-xs font-mono tabular-nums text-zinc-400">
            {multiplayerSession && (
              <>
                <span className="text-amber-400 font-semibold">
                  {multiplayerSession.role === 'host' ? 'HOST' : 'GUEST'} · {multiplayerSession.code}
                </span>
                <span aria-hidden="true">·</span>
              </>
            )}
            <span>{status.paused ? 'PAUSED' : `${status.fps} FPS`}</span>
            <span aria-hidden="true">·</span>
            <span>200×160</span>
            <span aria-hidden="true">·</span>
            <span className="truncate max-w-[180px]">
              {multiplayerSession?.role === 'guest'
                ? multiplayerSession.gameTitle
                : status.cartridge
                  ? status.cartridge.title
                  : status.romLoaded
                    ? 'SYSTEM BIOS'
                    : 'NO CART'}
            </span>
          </div>
        </div>

        {/* Main Handheld Body: D-Pad + Recessed Touchscreen LCD + A/B/C/D */}
        <div className="grid grid-cols-1 md:grid-cols-[136px_1fr_136px] gap-5 items-center">
          {/* Left: D-Pad Cluster */}
          <div className="order-2 md:order-1 flex flex-col items-center justify-center gap-3">
            <div
              className="grid grid-cols-3 grid-rows-3 gap-1 w-[124px] h-[124px] p-1.5 rounded-2xl bg-[#15181e] border border-white/5"
              role="group"
              aria-label="Directional Pad"
            >
              <div />
              <button
                type="button"
                aria-label="D-Pad Up"
                data-pressed={pressedButtons.has('UP')}
                {...bindHardwareButton('UP')}
                className="tactile-key rounded-t-lg flex items-center justify-center text-xs font-bold text-zinc-300 focus-visible:outline-2 focus-visible:outline-amber-400"
              >
                ▲
              </button>
              <div />

              <button
                type="button"
                aria-label="D-Pad Left"
                data-pressed={pressedButtons.has('LEFT')}
                {...bindHardwareButton('LEFT')}
                className="tactile-key rounded-l-lg flex items-center justify-center text-xs font-bold text-zinc-300 focus-visible:outline-2 focus-visible:outline-amber-400"
              >
                ◀
              </button>
              <div className="rounded bg-[#22262f] flex items-center justify-center">
                <div className="w-3.5 h-3.5 rounded-full bg-[#16181e] border border-white/10" />
              </div>
              <button
                type="button"
                aria-label="D-Pad Right"
                data-pressed={pressedButtons.has('RIGHT')}
                {...bindHardwareButton('RIGHT')}
                className="tactile-key rounded-r-lg flex items-center justify-center text-xs font-bold text-zinc-300 focus-visible:outline-2 focus-visible:outline-amber-400"
              >
                ▶
              </button>

              <div />
              <button
                type="button"
                aria-label="D-Pad Down"
                data-pressed={pressedButtons.has('DOWN')}
                {...bindHardwareButton('DOWN')}
                className="tactile-key rounded-b-lg flex items-center justify-center text-xs font-bold text-zinc-300 focus-visible:outline-2 focus-visible:outline-amber-400"
              >
                ▼
              </button>
              <div />
            </div>

            <span className="text-[11px] font-medium text-zinc-400 tracking-wide">
              {connectedGamepadCount > 0 ? 'D-Pad / Pad' : 'Arrows / WASD'}
            </span>
          </div>

          {/* Center: Recessed LCD Bezel + WebGL2 Shader Touchscreen Canvas */}
          <div className="order-1 md:order-2 console-bezel rounded-2xl p-3.5 sm:p-4 border border-white/10">
            <div className="relative w-full aspect-[200/160] rounded-lg overflow-hidden lcd-glass-recess bg-[#8c967e]">
              <canvas
                ref={canvasRef}
                width={SCREEN_WIDTH * 3}
                height={SCREEN_HEIGHT * 3}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                className="w-full h-full block cursor-crosshair touch-none"
                aria-label="Tiger Game.com 200 by 160 Touchscreen LCD"
              />

              {status.paused && (
                <div className="pointer-events-none absolute inset-0 bg-black/45 flex items-center justify-center">
                  <span className="font-display text-lg font-semibold tracking-wider text-zinc-100 bg-[#17191f]/90 px-4 py-1.5 rounded-md border border-white/15">
                    Emulation Paused
                  </span>
                </div>
              )}
            </div>

            {/* Bezel Bottom Legend */}
            <div className="mt-2.5 flex items-center justify-between text-[11px] text-zinc-400 font-mono tabular-nums">
              <span>
                {status.touchActive
                  ? `Stylus ${status.touchX}, ${status.touchY}`
                  : activeShaderName}
              </span>
              <span>
                {connectedGamepadCount > 0
                  ? `${connectedGamepadCount} Controller · Fr ${status.frameCount.toLocaleString()}`
                  : `Frame ${status.frameCount.toLocaleString()}`}
              </span>
            </div>
          </div>

          {/* Right: 4 Action Buttons (A, B, C, D) + Speaker Grille */}
          <div className="order-3 flex flex-col items-center justify-center gap-4">
            <div
              className="grid grid-cols-2 gap-2.5 p-2 rounded-2xl bg-[#15181e] border border-white/5"
              role="group"
              aria-label="Action Buttons"
            >
              {(
                [
                  { id: 'A', keyHint: 'Z' },
                  { id: 'B', keyHint: 'X' },
                  { id: 'C', keyHint: 'C' },
                  { id: 'D', keyHint: 'V' },
                ] as const
              ).map(({ id, keyHint }) => (
                <button
                  key={id}
                  type="button"
                  aria-label={`Button ${id} (${keyHint})`}
                  data-pressed={pressedButtons.has(id)}
                  {...bindHardwareButton(id)}
                  className="tactile-action-btn w-12 h-12 rounded-full flex flex-col items-center justify-center text-zinc-100 focus-visible:outline-2 focus-visible:outline-amber-400"
                >
                  <span className="font-display text-sm font-bold leading-none">{id}</span>
                  <span className="text-[9px] text-zinc-400 leading-none mt-0.5">{keyHint}</span>
                </button>
              ))}
            </div>

            {/* Perforated Speaker Grille */}
            <div
              className="w-24 h-7 rounded-lg speaker-grille opacity-80 border border-white/5"
              aria-hidden="true"
            />
          </div>
        </div>

        {/* Bottom Console Hardware Function Buttons + Quick Emulation Strip */}
        <div className="mt-5 pt-4 border-t border-white/10 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-pressed={pressedButtons.has('MENU')}
              {...bindHardwareButton('MENU')}
              className="tactile-key px-3.5 py-2 rounded-lg text-xs font-medium text-zinc-200 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-amber-400"
            >
              Menu
            </button>
            <button
              type="button"
              onClick={onTogglePause}
              className="tactile-key px-3.5 py-2 rounded-lg text-xs font-medium text-zinc-200 flex items-center gap-1.5 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-amber-400"
            >
              {status.paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
              <span>{status.paused ? 'Resume' : 'Pause'}</span>
            </button>
            <button
              type="button"
              onClick={onToggleMute}
              className="tactile-key px-3.5 py-2 rounded-lg text-xs font-medium text-zinc-200 flex items-center gap-1.5 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-amber-400"
            >
              {muted ? <VolumeX className="w-3.5 h-3.5 text-amber-400" /> : <Volume2 className="w-3.5 h-3.5" />}
              <span>{muted ? 'Unmute' : 'Sound'}</span>
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onReset}
              disabled={multiplayerSession?.role === 'guest'}
              className="px-3.5 py-2 rounded-lg text-xs font-medium bg-[#17191f] hover:bg-[#232730] disabled:opacity-40 text-zinc-200 border border-white/10 flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors focus-visible:outline-2 focus-visible:outline-amber-400"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset</span>
            </button>
            <button
              type="button"
              onClick={onQuickSave}
              disabled={!status.romLoaded || multiplayerSession?.role === 'guest'}
              className="px-3.5 py-2 rounded-lg text-xs font-medium bg-[#17191f] hover:bg-[#232730] disabled:opacity-40 text-zinc-200 border border-white/10 flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors focus-visible:outline-2 focus-visible:outline-amber-400"
              title="Quick Save to Slot 1 (F5)"
            >
              <Save className="w-3.5 h-3.5 text-amber-400" />
              <span>Save F5</span>
            </button>
            <button
              type="button"
              onClick={onQuickLoad}
              disabled={!status.romLoaded || multiplayerSession?.role === 'guest'}
              className="px-3.5 py-2 rounded-lg text-xs font-medium bg-[#17191f] hover:bg-[#232730] disabled:opacity-40 text-zinc-200 border border-white/10 flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors focus-visible:outline-2 focus-visible:outline-amber-400"
              title="Quick Load from Slot 1 (F8)"
            >
              <Upload className="w-3.5 h-3.5 text-amber-400" />
              <span>Load F8</span>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
};
