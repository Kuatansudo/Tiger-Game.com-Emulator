import React, { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Gamepad2,
  RotateCcw,
  StepForward,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { GameComAudioEngine } from '../emulator/audio';
import { GamepadManager } from '../emulator/gamepad';
import {
  AudioChannelState,
  ConnectedGamepadInfo,
  CpuSnapshot,
  GamepadAction,
  GamepadConfig,
  LCD_PALETTES,
  LcdPaletteId,
  SHADER_PRESETS,
  ShaderSettings,
} from '../emulator/types';

interface AudioAndDebugPanelProps {
  audioEngine: GameComAudioEngine;
  audioState: AudioChannelState;
  paletteId: LcdPaletteId;
  shaderSettings: ShaderSettings;
  gamepadManager: GamepadManager;
  gamepadConfig: GamepadConfig;
  connectedGamepads: ConnectedGamepadInfo[];
  cpuSnapshot: CpuSnapshot;
  isPaused: boolean;
  onVolumeChange: (vol: number) => void;
  onToggleMute: () => void;
  onToggleChannel: (ch: 'wave0' | 'wave1' | 'noise' | 'dac') => void;
  onPaletteChange: (id: LcdPaletteId) => void;
  onShaderChange: (next: ShaderSettings) => void;
  onGamepadConfigChange: (next: GamepadConfig) => void;
  onRemapGamepadAction: (action: GamepadAction, btnIndex: number) => void;
  onResetGamepadDefaults: () => void;
  onStepCpu: () => void;
}

const hex2 = (n: number) => (n & 0xff).toString(16).toUpperCase().padStart(2, '0');
const hex4 = (n: number) => (n & 0xffff).toString(16).toUpperCase().padStart(4, '0');

const GAMEPAD_ACTION_LABELS: { action: GamepadAction; label: string }[] = [
  { action: 'UP', label: 'D-Pad Up' },
  { action: 'DOWN', label: 'D-Pad Down' },
  { action: 'LEFT', label: 'D-Pad Left' },
  { action: 'RIGHT', label: 'D-Pad Right' },
  { action: 'A', label: 'Button A' },
  { action: 'B', label: 'Button B' },
  { action: 'C', label: 'Button C' },
  { action: 'D', label: 'Button D' },
  { action: 'MENU', label: 'Menu' },
  { action: 'PAUSE', label: 'Pause / Resume' },
  { action: 'QUICKSAVE', label: 'Quick Save' },
  { action: 'QUICKLOAD', label: 'Quick Load' },
  { action: 'STYLUS_TAP', label: 'Stylus Tap' },
];

export const AudioAndDebugPanel: React.FC<AudioAndDebugPanelProps> = ({
  audioEngine,
  audioState,
  paletteId,
  shaderSettings,
  gamepadManager,
  gamepadConfig,
  connectedGamepads,
  cpuSnapshot,
  isPaused,
  onVolumeChange,
  onToggleMute,
  onToggleChannel,
  onPaletteChange,
  onShaderChange,
  onGamepadConfigChange,
  onRemapGamepadAction,
  onResetGamepadDefaults,
  onStepCpu,
}) => {
  const scopeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [showCpuInspector, setShowCpuInspector] = useState(false);
  const [remappingAction, setRemappingAction] = useState<GamepadAction | null>(null);

  // Interactive gamepad button capture during remapping
  useEffect(() => {
    if (!remappingAction) return;
    let raf = 0;
    const pollForBind = () => {
      const pressedIdx = gamepadManager.detectPressedButtonIndex();
      if (pressedIdx !== null) {
        onRemapGamepadAction(remappingAction, pressedIdx);
        setRemappingAction(null);
        return;
      }
      raf = requestAnimationFrame(pollForBind);
    };
    raf = requestAnimationFrame(pollForBind);
    return () => cancelAnimationFrame(raf);
  }, [gamepadManager, onRemapGamepadAction, remappingAction]);

  // Live audio waveform oscilloscope
  useEffect(() => {
    const canvas = scopeCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const samples = new Uint8Array(256);
    let raf = 0;

    const draw = () => {
      audioEngine.getWaveformSamples(samples);
      const w = canvas.width;
      const h = canvas.height;

      ctx.fillStyle = '#121417';
      ctx.fillRect(0, 0, w, h);

      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();

      ctx.strokeStyle = audioState.muted ? '#525866' : '#f59e0b';
      ctx.lineWidth = 1.75;
      ctx.beginPath();
      for (let i = 0; i < samples.length; i++) {
        const x = (i / (samples.length - 1)) * w;
        const y = ((samples[i] - 128) / 128) * (h * 0.42) + h / 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [audioEngine, audioState.muted]);

  return (
    <div className="space-y-6">
      {/* Shaders & LCD Display Section */}
      <div className="rounded-xl bg-[#181b20] border border-white/10 p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-display text-base font-semibold text-zinc-100">
              Shaders &amp; LCD Display
            </h3>
            <p className="text-xs text-zinc-400">
              Real-time WebGL2 post-processing shaders and authentic LCD color palettes
            </p>
          </div>
        </div>

        {/* Shader Preset Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {SHADER_PRESETS.map((preset) => {
            const active = shaderSettings.id === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() =>
                  onShaderChange({ ...shaderSettings, id: preset.id })
                }
                className={`p-3 rounded-lg border text-left transition-colors focus-visible:outline-2 focus-visible:outline-amber-400 ${
                  active
                    ? 'bg-[#22262e] border-amber-500 text-zinc-100'
                    : 'bg-[#14161b] border-white/10 text-zinc-300 hover:border-white/20'
                }`}
              >
                <div className="text-xs font-semibold">{preset.name}</div>
                <div className="mt-0.5 text-[11px] text-zinc-400 line-clamp-1">
                  {preset.description}
                </div>
              </button>
            );
          })}
        </div>

        {/* Shader Intensity & Persistence */}
        <div className="flex items-center gap-4 pt-1">
          <label
            htmlFor="shader-intensity"
            className="text-xs font-medium text-zinc-300 w-28 shrink-0"
          >
            Shader Strength
          </label>
          <input
            id="shader-intensity"
            type="range"
            min={0}
            max={100}
            value={Math.round(shaderSettings.intensity * 100)}
            onChange={(e) =>
              onShaderChange({
                ...shaderSettings,
                intensity: Number(e.target.value) / 100,
              })
            }
            className="flex-1 accent-amber-500 cursor-pointer"
          />
          <span className="text-xs font-mono tabular-nums text-zinc-300 w-10 text-right">
            {Math.round(shaderSettings.intensity * 100)}%
          </span>
        </div>

        {/* LCD Palette Swatches */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-1">
          {Object.values(LCD_PALETTES).map((pal) => {
            const active = paletteId === pal.id;
            return (
              <button
                key={pal.id}
                type="button"
                onClick={() => onPaletteChange(pal.id)}
                className={`p-3 rounded-lg border text-left transition-colors focus-visible:outline-2 focus-visible:outline-amber-400 ${
                  active
                    ? 'bg-[#22262e] border-amber-500 text-zinc-100'
                    : 'bg-[#14161b] border-white/10 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <div className="flex items-center gap-1 mb-2">
                  {pal.shades.map((hex, i) => (
                    <span
                      key={i}
                      className="w-4 h-3 rounded-xs border border-black/30"
                      style={{ backgroundColor: hex }}
                    />
                  ))}
                </div>
                <div className="text-xs font-medium truncate">{pal.name}</div>
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() =>
              onShaderChange({
                ...shaderSettings,
                lcdGhosting: !shaderSettings.lcdGhosting,
              })
            }
            className={`px-3.5 py-2 rounded-lg text-xs font-medium border transition-colors focus-visible:outline-2 focus-visible:outline-amber-400 ${
              shaderSettings.lcdGhosting
                ? 'bg-[#22262e] border-amber-500/40 text-zinc-100'
                : 'bg-[#14161b] border-white/10 text-zinc-400'
            }`}
          >
            Passive LCD Persistence: {shaderSettings.lcdGhosting ? 'On' : 'Off'}
          </button>
        </div>
      </div>

      {/* Controller Support (HTML5 Gamepad API) */}
      <div className="rounded-xl bg-[#181b20] border border-white/10 p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Gamepad2 className="w-4 h-4 text-amber-400" />
            <div>
              <h3 className="font-display text-base font-semibold text-zinc-100">
                Controller Support
              </h3>
              <p className="text-xs text-zinc-400">
                {connectedGamepads.length > 0
                  ? `${connectedGamepads.length} gamepad connected · Press any button to test`
                  : 'Connect a USB or Bluetooth controller and press any button'}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() =>
              onGamepadConfigChange({
                ...gamepadConfig,
                enabled: !gamepadConfig.enabled,
              })
            }
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              gamepadConfig.enabled
                ? 'bg-[#22262e] border-amber-500/40 text-zinc-100'
                : 'bg-[#14161b] border-white/10 text-zinc-400'
            }`}
          >
            {gamepadConfig.enabled ? 'Enabled' : 'Disabled'}
          </button>
        </div>

        {/* Connected Devices List */}
        {connectedGamepads.length > 0 && (
          <div className="space-y-2">
            {connectedGamepads.map((pad) => (
              <div
                key={pad.index}
                className="rounded-lg bg-[#121417] border border-white/10 px-3.5 py-2.5 flex items-center justify-between gap-3 text-xs"
              >
                <span className="font-medium text-zinc-200 truncate">{pad.id}</span>
                <span className="font-mono tabular-nums text-amber-400 shrink-0">
                  {pad.activeButtons.length > 0
                    ? `Active: ${pad.activeButtons.map((b) => `B${b}`).join(', ')}`
                    : `${pad.buttons} btns · ${pad.axes} axes`}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Stick Deadzone & Right-Stick Stylus */}
        <div className="space-y-3">
          <div className="flex items-center gap-4">
            <label
              htmlFor="gamepad-deadzone"
              className="text-xs font-medium text-zinc-300 w-28 shrink-0"
            >
              Stick Deadzone
            </label>
            <input
              id="gamepad-deadzone"
              type="range"
              min={10}
              max={70}
              value={Math.round(gamepadConfig.deadzone * 100)}
              onChange={(e) =>
                onGamepadConfigChange({
                  ...gamepadConfig,
                  deadzone: Number(e.target.value) / 100,
                })
              }
              className="flex-1 accent-amber-500 cursor-pointer"
            />
            <span className="text-xs font-mono tabular-nums text-zinc-300 w-10 text-right">
              {Math.round(gamepadConfig.deadzone * 100)}%
            </span>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={() =>
                onGamepadConfigChange({
                  ...gamepadConfig,
                  rightStickStylus: !gamepadConfig.rightStickStylus,
                })
              }
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                gamepadConfig.rightStickStylus
                  ? 'bg-[#22262e] border-amber-500/40 text-zinc-100'
                  : 'bg-[#14161b] border-white/10 text-zinc-400'
              }`}
            >
              Right Stick Virtual Stylus: {gamepadConfig.rightStickStylus ? 'On' : 'Off'}
            </button>
            <button
              type="button"
              onClick={() => {
                setRemappingAction(null);
                onResetGamepadDefaults();
              }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[#22262e] hover:bg-[#2c313b] text-zinc-300 border border-white/10 flex items-center gap-1.5"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset Mapping</span>
            </button>
          </div>
        </div>

        {/* Interactive Button Remapping Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {GAMEPAD_ACTION_LABELS.map(({ action, label }) => {
            const isCapturing = remappingAction === action;
            const btnIdx = gamepadConfig.buttonMap[action];
            return (
              <button
                key={action}
                type="button"
                onClick={() =>
                  setRemappingAction((prev) => (prev === action ? null : action))
                }
                className={`px-3 py-2 rounded-lg border text-left text-xs flex items-center justify-between gap-2 transition-colors ${
                  isCapturing
                    ? 'bg-amber-500/15 border-amber-400 text-amber-200'
                    : 'bg-[#121417] border-white/10 text-zinc-300 hover:border-white/25'
                }`}
              >
                <span className="truncate">{label}</span>
                <span className="font-mono tabular-nums text-[11px] text-zinc-400 shrink-0">
                  {isCapturing ? 'Press...' : `B${btnIdx}`}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Audio Synthesizer Section */}
      <div className="rounded-xl bg-[#181b20] border border-white/10 p-5 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="font-display text-base font-semibold text-zinc-100">
              SM8521 Audio Synthesizer
            </h3>
            <p className="text-xs text-zinc-400">
              Dual 4-bit wavetable channels, LFSR noise, and 8-bit PCM DAC
            </p>
          </div>
          <button
            type="button"
            onClick={onToggleMute}
            className="px-3.5 py-2 rounded-lg text-xs font-medium bg-[#22262e] hover:bg-[#2c313b] text-zinc-100 border border-white/10 flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors focus-visible:outline-2 focus-visible:outline-amber-400"
          >
            {audioState.muted ? (
              <VolumeX className="w-3.5 h-3.5 text-amber-400" />
            ) : (
              <Volume2 className="w-3.5 h-3.5" />
            )}
            <span>{audioState.muted ? 'Unmute' : 'Mute'}</span>
          </button>
        </div>

        <div className="flex items-center gap-4">
          <label htmlFor="master-volume" className="text-xs font-medium text-zinc-300 w-24 shrink-0">
            Volume
          </label>
          <input
            id="master-volume"
            type="range"
            min={0}
            max={100}
            value={Math.round(audioState.masterVolume * 100)}
            onChange={(e) => onVolumeChange(Number(e.target.value) / 100)}
            className="flex-1 accent-amber-500 cursor-pointer"
          />
          <span className="text-xs font-mono tabular-nums text-zinc-300 w-10 text-right">
            {Math.round(audioState.masterVolume * 100)}%
          </span>
        </div>

        <div className="rounded-lg overflow-hidden border border-white/10 bg-[#121417]">
          <canvas
            ref={scopeCanvasRef}
            width={480}
            height={72}
            className="w-full h-[72px] block"
            aria-label="Real-time audio output waveform"
          />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          {[
            {
              key: 'wave0' as const,
              label: 'Wave 0',
              enabled: audioState.wave0Enabled,
              detail: audioState.wave0FreqHz > 0 ? `${audioState.wave0FreqHz} Hz` : 'Idle',
            },
            {
              key: 'wave1' as const,
              label: 'Wave 1',
              enabled: audioState.wave1Enabled,
              detail: audioState.wave1FreqHz > 0 ? `${audioState.wave1FreqHz} Hz` : 'Idle',
            },
            {
              key: 'noise' as const,
              label: 'Noise',
              enabled: audioState.noiseEnabled,
              detail:
                audioState.noiseLevel > 0
                  ? `${Math.round(audioState.noiseLevel * 100)}%`
                  : 'Idle',
            },
            {
              key: 'dac' as const,
              label: '8-bit DAC',
              enabled: audioState.dacEnabled,
              detail: `0x${hex2(audioState.dacValue)}`,
            },
          ].map((ch) => (
            <button
              key={ch.key}
              type="button"
              onClick={() => onToggleChannel(ch.key)}
              className={`p-3 rounded-lg border text-left transition-colors focus-visible:outline-2 focus-visible:outline-amber-400 ${
                ch.enabled
                  ? 'bg-[#22262e] border-amber-500/40 text-zinc-100'
                  : 'bg-[#14161b] border-white/5 text-zinc-500'
              }`}
            >
              <div className="flex items-center justify-between text-xs font-medium">
                <span>{ch.label}</span>
                <span>{ch.enabled ? 'On' : 'Off'}</span>
              </div>
              <div className="mt-1 text-xs font-mono tabular-nums text-zinc-400">
                {ch.detail}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Collapsible SM8521 CPU & MMU Inspector */}
      <div className="rounded-xl bg-[#181b20] border border-white/10">
        <button
          type="button"
          onClick={() => setShowCpuInspector((v) => !v)}
          className="w-full p-4 flex items-center justify-between text-left focus-visible:outline-2 focus-visible:outline-amber-400 rounded-xl"
        >
          <div className="flex items-center gap-2">
            {showCpuInspector ? (
              <ChevronDown className="w-4 h-4 text-zinc-400" />
            ) : (
              <ChevronRight className="w-4 h-4 text-zinc-400" />
            )}
            <span className="font-display text-sm font-semibold text-zinc-100">
              SM8521 CPU &amp; MMU Inspector
            </span>
          </div>
          <span className="text-xs font-mono tabular-nums text-zinc-400">
            PC 0x{hex4(cpuSnapshot.pc)} · SP 0x{hex4(cpuSnapshot.sp)}
          </span>
        </button>

        {showCpuInspector && (
          <div className="px-4 pb-4 pt-2 border-t border-white/10 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3 text-xs font-mono tabular-nums text-zinc-300">
                <span>PC: 0x{hex4(cpuSnapshot.pc)}</span>
                <span>SP: 0x{hex4(cpuSnapshot.sp)}</span>
                <span>PS0: 0x{hex2(cpuSnapshot.ps0)}</span>
                <span>PS1: 0x{hex2(cpuSnapshot.ps1)}</span>
                <span>IE0: 0x{hex2(cpuSnapshot.ie0)}</span>
                <span>IR0: 0x{hex2(cpuSnapshot.ir0)}</span>
                <span>LCC: 0x{hex2(cpuSnapshot.lcc)}</span>
              </div>
              <button
                type="button"
                onClick={onStepCpu}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[#22262e] hover:bg-[#2c313b] text-zinc-100 border border-white/10 flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <StepForward className="w-3.5 h-3.5" />
                <span>{isPaused ? 'Step' : 'Pause & Step'}</span>
              </button>
            </div>

            <div>
              <div className="text-xs text-zinc-400 mb-1.5">MMU Banks (0x1000–0x9FFF)</div>
              <div className="grid grid-cols-5 gap-2 text-xs font-mono tabular-nums">
                {cpuSnapshot.mmu.map((bank, idx) => (
                  <div
                    key={idx}
                    className="p-2 rounded bg-[#121417] border border-white/5 text-center text-zinc-200"
                  >
                    M{idx}: {bank}
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="text-xs text-zinc-400 mb-1.5">Register File (R0–R15)</div>
              <div className="grid grid-cols-4 sm:grid-cols-8 gap-1.5 text-xs font-mono tabular-nums">
                {cpuSnapshot.registers.map((val, idx) => (
                  <div
                    key={idx}
                    className="px-2 py-1.5 rounded bg-[#121417] border border-white/5 text-zinc-300 flex justify-between"
                  >
                    <span className="text-zinc-500">R{idx}</span>
                    <span>{hex2(val)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
