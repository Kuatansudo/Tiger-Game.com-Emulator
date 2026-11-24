import React, { useMemo, useState } from 'react';
import { Plus, Power, ShieldCheck, Trash2 } from 'lucide-react';
import { validateCheatCode } from '../emulator/cheats';
import { CheatCodeEntry } from '../emulator/types';

interface CheatPanelProps {
  romLoaded: boolean;
  romTitle: string;
  isGuestSession: boolean;
  masterEnabled: boolean;
  cheats: CheatCodeEntry[];
  onToggleMaster: () => void;
  onAddCheat: (name: string, code: string) => void;
  onToggleCheat: (id: string) => void;
  onDeleteCheat: (id: string) => void;
}

export const CheatPanel: React.FC<CheatPanelProps> = ({
  romLoaded,
  romTitle,
  isGuestSession,
  masterEnabled,
  cheats,
  onToggleMaster,
  onAddCheat,
  onToggleCheat,
  onDeleteCheat,
}) => {
  const [nameInput, setNameInput] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const validation = useMemo(() => {
    if (!codeInput.trim()) return null;
    return validateCheatCode(codeInput);
  }, [codeInput]);

  const activeCount = useMemo(
    () => cheats.filter((c) => c.enabled).length,
    [cheats]
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = nameInput.trim();
    const trimmedCode = codeInput.trim();
    if (!trimmedName) {
      setFormError('Enter a name for this cheat.');
      return;
    }
    const check = validateCheatCode(trimmedCode);
    if (!check.valid) {
      setFormError(check.error || 'Invalid cheat code format.');
      return;
    }
    setFormError(null);
    onAddCheat(trimmedName, trimmedCode);
    setNameInput('');
    setCodeInput('');
  };

  return (
    <div className="space-y-5">
      {/* Header + Master Cheat Switch */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 className="font-display text-base font-semibold text-zinc-100">
            Cheat Codes
          </h3>
          <p className="text-xs text-zinc-400">
            {isGuestSession
              ? 'Cheats run locally on the host console while joined as guest.'
              : romLoaded
                ? `${romTitle} · ${activeCount} enabled of ${cheats.length} saved`
                : 'Load a cartridge or boot BIOS to manage cheats.'}
          </p>
        </div>

        <button
          type="button"
          onClick={onToggleMaster}
          disabled={!romLoaded || isGuestSession}
          className={`px-3.5 py-2 rounded-lg text-xs font-semibold border flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors focus-visible:outline-2 focus-visible:outline-amber-400 disabled:opacity-40 ${
            masterEnabled
              ? 'bg-amber-500 hover:bg-amber-400 text-zinc-950 border-amber-400'
              : 'bg-[#22262e] hover:bg-[#2c313b] text-zinc-300 border-white/10'
          }`}
        >
          <Power className="w-3.5 h-3.5" />
          <span>{masterEnabled ? 'Cheats Active: On' : 'Cheats Active: Off'}</span>
        </button>
      </div>

      {/* Add Cheat Form */}
      <form
        onSubmit={handleSubmit}
        className="rounded-xl bg-[#181b20] border border-white/10 p-4 space-y-3.5"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-display text-sm font-semibold text-zinc-100">
            Add New Cheat
          </span>
          <span className="text-[11px] font-mono text-zinc-400">
            RAM &amp; ROM Patch
          </span>
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor="cheat-name-input"
            className="block text-xs font-medium text-zinc-300"
          >
            Cheat Name
          </label>
          <input
            id="cheat-name-input"
            type="text"
            value={nameInput}
            onChange={(e) => {
              setNameInput(e.target.value);
              if (formError) setFormError(null);
            }}
            disabled={!romLoaded || isGuestSession}
            maxLength={48}
            placeholder="e.g. Infinite Health"
            className="w-full px-3 py-2 rounded-lg bg-[#121417] border border-white/10 text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-amber-400 disabled:opacity-50"
          />
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor="cheat-code-input"
            className="block text-xs font-medium text-zinc-300"
          >
            Cheat Code
          </label>
          <textarea
            id="cheat-code-input"
            rows={2}
            value={codeInput}
            onChange={(e) => {
              setCodeInput(e.target.value);
              if (formError) setFormError(null);
            }}
            disabled={!romLoaded || isGuestSession}
            placeholder="E042:63 or E042:FF:01 or ROM@001A4:EA"
            className="w-full px-3 py-2 rounded-lg bg-[#121417] border border-white/10 text-xs font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-amber-400 disabled:opacity-50 resize-y"
          />
          <p className="text-[11px] text-zinc-500 font-mono">
            Formats: ADDR:VAL (freeze RAM), ADDR:VAL:CMP (conditional), ROM@OFFSET:VAL (ROM patch). Multi-line supported.
          </p>
        </div>

        {validation && validation.valid && !formError && (
          <div className="text-[11px] text-emerald-300 font-mono flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
            <span>
              Valid · {validation.rules.length} {validation.rules.length === 1 ? 'rule' : 'rules'} ready
            </span>
          </div>
        )}

        {(formError || (validation && !validation.valid)) && (
          <p className="text-[11px] text-red-300 font-medium">
            {formError || validation?.error}
          </p>
        )}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={!romLoaded || isGuestSession}
            className="px-4 py-2 rounded-lg text-xs font-semibold bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-zinc-950 flex items-center gap-1.5 whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-amber-300"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Cheat</span>
          </button>
        </div>
      </form>

      {/* Saved Cheats List */}
      <div className="rounded-xl bg-[#181b20] border border-white/10 p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className="font-display text-sm font-semibold text-zinc-100">
            Saved Cheats
          </span>
          <span className="text-[11px] font-mono tabular-nums text-zinc-400">
            {activeCount} / {cheats.length} Enabled
          </span>
        </div>

        {cheats.length === 0 ? (
          <p className="text-xs text-zinc-500 py-4 text-center border border-dashed border-white/10 rounded-lg">
            No cheats saved for this game yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {cheats.map((cheat) => (
              <li
                key={cheat.id}
                className="rounded-lg bg-[#121417] border border-white/10 px-3 py-2.5 flex items-center justify-between gap-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-zinc-100 truncate">
                      {cheat.name}
                    </span>
                  </div>
                  <p className="text-[11px] font-mono tabular-nums text-zinc-400 truncate mt-0.5">
                    {cheat.code.replace(/\n+/g, '; ')}
                  </p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={isGuestSession}
                    onClick={() => onToggleCheat(cheat.id)}
                    className={`px-3 py-1.5 rounded-md text-xs font-semibold border whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-amber-400 disabled:opacity-40 ${
                      cheat.enabled
                        ? 'bg-amber-500/20 text-amber-300 border-amber-400/40 hover:bg-amber-500/30'
                        : 'bg-[#1d2128] text-zinc-400 border-white/10 hover:text-zinc-200'
                    }`}
                  >
                    {cheat.enabled ? 'Enabled' : 'Disabled'}
                  </button>
                  <button
                    type="button"
                    disabled={isGuestSession}
                    onClick={() => onDeleteCheat(cheat.id)}
                    title="Delete cheat"
                    aria-label={`Delete ${cheat.name}`}
                    className="p-1.5 rounded-md bg-[#1d2128] hover:bg-red-950/60 hover:text-red-300 disabled:opacity-40 text-zinc-400 border border-white/10 transition-colors focus-visible:outline-2 focus-visible:outline-amber-400"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
