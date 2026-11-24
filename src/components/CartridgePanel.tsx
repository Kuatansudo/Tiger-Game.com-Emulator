import React, { useRef, useState } from 'react';
import {
  AlertCircle,
  Download,
  FolderOpen,
  HardDrive,
  Play,
  Trash2,
} from 'lucide-react';
import { BuiltInRomEntry, downloadTgcFile } from '../emulator/roms';
import { BiosState, CartridgeInfo } from '../emulator/types';

interface CartridgePanelProps {
  currentCartridge: CartridgeInfo | null;
  bios: BiosState;
  waitingForBiosPrompt: boolean;
  builtInRoms: BuiltInRomEntry[];
  onLoadRomFile: (file: File) => void;
  onLoadBuiltIn: (rom: BuiltInRomEntry) => void;
  onLoadBiosFile: (file: File, target?: 'internal' | 'external' | 'auto') => void;
  onTogglePreferBios: () => void;
  onClearBios: () => void;
  onBootBios?: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export const CartridgePanel: React.FC<CartridgePanelProps> = ({
  currentCartridge,
  bios,
  waitingForBiosPrompt,
  builtInRoms,
  onLoadRomFile,
  onLoadBuiltIn,
  onLoadBiosFile,
  onTogglePreferBios,
  onClearBios,
  onBootBios,
}) => {
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const biosZipRef = useRef<HTMLInputElement | null>(null);
  const biosInternalRef = useRef<HTMLInputElement | null>(null);
  const biosExternalRef = useRef<HTMLInputElement | null>(null);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      onLoadRomFile(file);
    }
  };

  return (
    <div className="space-y-6">
      {/* .tgc / .tcg / .bin / .zip Drag & Drop Loader */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={`rounded-xl border border-dashed p-5 transition-colors ${
          dragging
            ? 'border-amber-400 bg-amber-500/10'
            : 'border-white/15 bg-[#181b20]'
        }`}
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <h3 className="font-display text-base font-semibold text-zinc-100">
              Load Cartridge ROM
            </h3>
            <p className="text-sm text-zinc-400">
              Drop a .tgc, .tcg, .bin, or .zip Game.com ROM image here, or browse from disk.
            </p>
          </div>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="px-4 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-zinc-950 font-semibold text-xs flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors focus-visible:outline-2 focus-visible:outline-amber-300"
          >
            <FolderOpen className="w-4 h-4" />
            <span>Open ROM File</span>
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".tgc,.tcg,.bin,.zip"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onLoadRomFile(file);
            e.target.value = '';
          }}
        />
      </div>

      {/* Inserted Cartridge Metadata */}
      {currentCartridge && (
        <div className="rounded-xl bg-[#181b20] border border-white/10 p-5 space-y-4">
          <div className="flex items-center justify-between gap-3 pb-3 border-b border-white/10">
            <div className="min-w-0">
              <p className="text-xs text-zinc-400">Active Cartridge</p>
              <h3 className="font-display text-lg font-semibold text-zinc-100 truncate">
                {currentCartridge.title}
              </h3>
            </div>
            <span className="text-xs font-mono text-zinc-400 tabular-nums shrink-0">
              {currentCartridge.serial}
            </span>
          </div>

          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3 text-xs">
            <div>
              <dt className="text-zinc-500">Header Signature</dt>
              <dd className="mt-0.5 font-mono text-zinc-200">
                {currentCartridge.hasValidHeader
                  ? `${currentCartridge.signature} @0x${currentCartridge.signatureOffset.toString(16).toUpperCase()}`
                  : 'Raw Binary'}
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500">ROM Size</dt>
              <dd className="mt-0.5 font-mono tabular-nums text-zinc-200">
                {formatBytes(currentCartridge.sizeBytes)} · {currentCartridge.bankCount} banks
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500">Runtime Mode</dt>
              <dd className="mt-0.5 font-mono text-zinc-200">
                {currentCartridge.isHomebrew
                  ? 'Direct SM8521'
                  : bios.internalLoaded && bios.externalLoaded && bios.preferBios
                    ? 'Sharp SM8500 + BIOS'
                    : 'BIOS Required'}
              </dd>
            </div>
          </dl>

          {waitingForBiosPrompt && (
            <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-3.5 flex items-start gap-2.5 text-xs text-amber-200">
              <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="font-semibold text-amber-100">
                  Commercial Cartridge Detected — System BIOS Required
                </p>
                <p className="text-amber-200/85 leading-relaxed">
                  Commercial titles such as {currentCartridge.title} call routines inside the
                  Tiger System BIOS (internal.bin + external.bin). Load gamecom.zip or both BIOS
                  files below to boot.
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* System BIOS Manager */}
      <div className="rounded-xl bg-[#181b20] border border-white/10 p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-amber-400" />
              <h3 className="font-display text-base font-semibold text-zinc-100">
                System BIOS Firmware
              </h3>
            </div>
            <p className="text-xs text-zinc-400">
              Persisted in browser storage. Load gamecom.zip or separate internal.bin &amp; external.bin dumps.
            </p>
          </div>
          <button
            type="button"
            onClick={() => biosZipRef.current?.click()}
            className="px-3.5 py-2 rounded-lg text-xs font-semibold bg-[#22262e] hover:bg-[#2c313b] text-zinc-100 border border-white/10 whitespace-nowrap shrink-0 transition-colors focus-visible:outline-2 focus-visible:outline-amber-400"
          >
            Load gamecom.zip / BIOS
          </button>
          <input
            ref={biosZipRef}
            type="file"
            accept=".zip,.bin,.rom"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onLoadBiosFile(file, 'auto');
              e.target.value = '';
            }}
          />
        </div>

        {/* Individual Internal (4KB) & External (256KB) BIOS Slots */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="rounded-lg bg-[#121417] border border-white/10 p-3 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs font-medium text-zinc-200">Internal Boot (4 KB)</div>
              <div className="text-[11px] font-mono text-zinc-400 truncate mt-0.5">
                {bios.internalLoaded
                  ? `${bios.internalName || 'internal.bin'} · ${formatBytes(bios.internalSize)}`
                  : 'Using Clean-Room Boot'}
              </div>
            </div>
            <button
              type="button"
              onClick={() => biosInternalRef.current?.click()}
              className="px-2.5 py-1.5 rounded text-xs font-medium bg-[#22262e] hover:bg-[#2c313b] text-zinc-200 border border-white/10 shrink-0"
            >
              Load
            </button>
            <input
              ref={biosInternalRef}
              type="file"
              accept=".bin,.rom"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onLoadBiosFile(f, 'internal');
                e.target.value = '';
              }}
            />
          </div>

          <div className="rounded-lg bg-[#121417] border border-white/10 p-3 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs font-medium text-zinc-200">External OS (256 KB)</div>
              <div className="text-[11px] font-mono text-zinc-400 truncate mt-0.5">
                {bios.externalLoaded
                  ? `${bios.externalName || 'external.bin'} · ${formatBytes(bios.externalSize)}`
                  : 'Not Loaded'}
              </div>
            </div>
            <button
              type="button"
              onClick={() => biosExternalRef.current?.click()}
              className="px-2.5 py-1.5 rounded text-xs font-medium bg-[#22262e] hover:bg-[#2c313b] text-zinc-200 border border-white/10 shrink-0"
            >
              Load
            </button>
            <input
              ref={biosExternalRef}
              type="file"
              accept=".bin,.rom"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onLoadBiosFile(f, 'external');
                e.target.value = '';
              }}
            />
          </div>
        </div>

        {(bios.internalLoaded || bios.externalLoaded) && (
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={onTogglePreferBios}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  bios.preferBios
                    ? 'bg-[#22262e] border-amber-500/40 text-zinc-100'
                    : 'bg-[#14161b] border-white/10 text-zinc-400'
                }`}
              >
                Boot Mode: {bios.preferBios ? 'External System BIOS' : 'Clean-Room Bootloader'}
              </button>
              {bios.internalLoaded && bios.externalLoaded && onBootBios && (
                <button
                  type="button"
                  onClick={onBootBios}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-500 hover:bg-amber-400 text-zinc-950 flex items-center gap-1.5 transition-colors focus-visible:outline-2 focus-visible:outline-amber-300"
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>Boot System BIOS</span>
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={onClearBios}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[#22262e] hover:bg-red-950/60 hover:text-red-300 text-zinc-300 border border-white/10 flex items-center gap-1.5 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Clear BIOS</span>
            </button>
          </div>
        )}
      </div>

      {/* Built-In Playable .tgc Cartridge Library */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-base font-semibold text-zinc-100">
            Included .tgc Cartridges
          </h3>
          <span className="text-xs text-zinc-400">Runs without external BIOS</span>
        </div>

        <div className="divide-y divide-white/10 rounded-xl bg-[#181b20] border border-white/10">
          {builtInRoms.map((rom) => {
            const isActive = currentCartridge?.id === rom.info.id;
            return (
              <div
                key={rom.info.id}
                className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-display font-semibold text-zinc-100">
                      {rom.info.title}
                    </span>
                    <span className="text-xs font-mono text-zinc-500">
                      {rom.info.filename}
                    </span>
                    {isActive && (
                      <span className="text-xs font-medium text-amber-400">
                        Inserted
                      </span>
                    )}
                  </div>
                  {rom.info.description && (
                    <p className="text-xs text-zinc-400 leading-relaxed">
                      {rom.info.description}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => downloadTgcFile(rom.bytes, rom.info.filename)}
                    className="px-3 py-2 rounded-lg text-xs font-medium bg-[#22262e] hover:bg-[#2c313b] text-zinc-200 border border-white/10 flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors focus-visible:outline-2 focus-visible:outline-amber-400"
                    title={`Download ${rom.info.filename}`}
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Export .tgc</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onLoadBuiltIn(rom)}
                    className={`px-3.5 py-2 rounded-lg text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors focus-visible:outline-2 focus-visible:outline-amber-400 ${
                      isActive
                        ? 'bg-zinc-700 text-zinc-100 hover:bg-zinc-600'
                        : 'bg-amber-500 text-zinc-950 hover:bg-amber-400'
                    }`}
                  >
                    <Play className="w-3.5 h-3.5" />
                    <span>{isActive ? 'Reboot' : 'Run ROM'}</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
