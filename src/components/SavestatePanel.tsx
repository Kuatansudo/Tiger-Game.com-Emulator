import React, { useRef } from 'react';
import { Download, Monitor, Save, Trash2, Upload } from 'lucide-react';
import { SaveStateData } from '../emulator/types';

interface SavestatePanelProps {
  romLoaded: boolean;
  romTitle: string;
  states: Record<number, SaveStateData>;
  onSaveSlot: (slot: number) => void;
  onLoadSlot: (slot: number) => void;
  onDeleteSlot: (slot: number) => void;
  onExportSlot: (slot: number) => void;
  onImportStateFile: (file: File) => void;
}

const SLOTS = [1, 2, 3, 4];

function formatSavedTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const SavestatePanel: React.FC<SavestatePanelProps> = ({
  romLoaded,
  romTitle,
  states,
  onSaveSlot,
  onLoadSlot,
  onDeleteSlot,
  onExportSlot,
  onImportStateFile,
}) => {
  const importRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 className="font-display text-base font-semibold text-zinc-100">
            Savestate Slots
          </h3>
          <p className="text-xs text-zinc-400">
            {romLoaded
              ? `Persisted locally per cartridge for ${romTitle} · F5 Quick Save · F8 Quick Load`
              : 'Insert a .tgc cartridge to capture and restore savestates.'}
          </p>
        </div>
        <button
          type="button"
          disabled={!romLoaded}
          onClick={() => importRef.current?.click()}
          className="px-3.5 py-2 rounded-lg text-xs font-medium bg-[#22262e] hover:bg-[#2c313b] disabled:opacity-40 text-zinc-200 border border-white/10 flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors focus-visible:outline-2 focus-visible:outline-amber-400"
        >
          <Upload className="w-3.5 h-3.5" />
          <span>Import .tgcstate</span>
        </button>
        <input
          ref={importRef}
          type="file"
          accept=".tgcstate,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onImportStateFile(file);
            e.target.value = '';
          }}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {SLOTS.map((slot) => {
          const entry = states[slot];
          return (
            <div
              key={slot}
              className="rounded-xl bg-[#181b20] border border-white/10 p-4 flex flex-col gap-3"
            >
              {/* Thumbnail */}
              <div className="relative aspect-[200/160] w-full rounded-lg overflow-hidden bg-[#121417] border border-white/10 flex items-center justify-center">
                {entry?.thumbnailDataUrl ? (
                  <img
                    src={entry.thumbnailDataUrl}
                    alt={`Savestate slot ${slot} LCD capture`}
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover pixelated"
                  />
                ) : (
                  <div className="flex flex-col items-center gap-1.5 text-zinc-600">
                    <Monitor className="w-6 h-6" />
                    <span className="text-xs font-medium">Empty Slot {slot}</span>
                  </div>
                )}
              </div>

              {/* Slot Metadata */}
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-display font-semibold text-zinc-100">
                  Slot {slot}
                  {slot === 1 ? ' · Quick' : ''}
                </span>
                {entry ? (
                  <span className="font-mono tabular-nums text-zinc-400">
                    Fr {entry.frameCount.toLocaleString()} · {formatSavedTime(entry.savedAt)}
                  </span>
                ) : (
                  <span className="text-zinc-500">No snapshot</span>
                )}
              </div>

              {/* Slot Actions */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={!romLoaded}
                  onClick={() => onSaveSlot(slot)}
                  className="flex-1 px-3 py-2 rounded-lg text-xs font-semibold bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-zinc-950 flex items-center justify-center gap-1.5 whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-amber-300"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>Save</span>
                </button>
                <button
                  type="button"
                  disabled={!romLoaded || !entry}
                  onClick={() => onLoadSlot(slot)}
                  className="flex-1 px-3 py-2 rounded-lg text-xs font-medium bg-[#22262e] hover:bg-[#2c313b] disabled:opacity-40 text-zinc-100 border border-white/10 flex items-center justify-center gap-1.5 whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-amber-400"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>Load</span>
                </button>
                <button
                  type="button"
                  disabled={!entry}
                  onClick={() => onExportSlot(slot)}
                  title="Export .tgcstate file"
                  aria-label={`Export slot ${slot}`}
                  className="p-2 rounded-lg text-xs bg-[#22262e] hover:bg-[#2c313b] disabled:opacity-35 text-zinc-300 border border-white/10 transition-colors focus-visible:outline-2 focus-visible:outline-amber-400"
                >
                  <Download className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  disabled={!entry}
                  onClick={() => onDeleteSlot(slot)}
                  title="Delete savestate"
                  aria-label={`Delete slot ${slot}`}
                  className="p-2 rounded-lg text-xs bg-[#22262e] hover:bg-red-950/60 hover:text-red-300 disabled:opacity-35 text-zinc-400 border border-white/10 transition-colors focus-visible:outline-2 focus-visible:outline-amber-400"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
