import React, { useState } from 'react';
import {
  Copy,
  Globe,
  LogOut,
  Radio,
  RefreshCw,
  Send,
  Server,
  Users,
} from 'lucide-react';
import {
  MultiplayerChatMessage,
  MultiplayerControlMode,
  MultiplayerRole,
  MultiplayerRoomState,
  MultiplayerRoomSummary,
} from '../emulator/types';

interface MultiplayerPanelProps {
  playerName: string;
  onPlayerNameChange: (name: string) => void;
  romLoaded: boolean;
  currentGameTitle: string;
  role: MultiplayerRole | null;
  playerId: string | null;
  room: MultiplayerRoomState | null;
  publicRooms: MultiplayerRoomSummary[];
  loadingRooms: boolean;
  connecting: boolean;
  chatMessages: MultiplayerChatMessage[];
  initialJoinCode?: string;
  onRefreshRooms: () => void;
  onCreateServer: (opts: {
    roomName: string;
    isPublic: boolean;
    controlMode: MultiplayerControlMode;
  }) => void;
  onJoinServer: (code: string) => void;
  onLeaveServer: () => void;
  onUpdateControlMode: (mode: MultiplayerControlMode) => void;
  onSendChat: (text: string) => void;
  onCopyInvite: (code: string) => void;
}

const CONTROL_MODES: { id: MultiplayerControlMode; label: string; hint: string }[] = [
  { id: 'shared', label: 'Shared Controls', hint: 'Both players control game' },
  { id: 'guest-only', label: 'Guest Control', hint: 'Remote player takes controls' },
  { id: 'host-only', label: 'Spectate Only', hint: 'Remote player watches stream' },
];

export const MultiplayerPanel: React.FC<MultiplayerPanelProps> = ({
  playerName,
  onPlayerNameChange,
  romLoaded,
  currentGameTitle,
  role,
  playerId,
  room,
  publicRooms,
  loadingRooms,
  connecting,
  chatMessages,
  initialJoinCode = '',
  onRefreshRooms,
  onCreateServer,
  onJoinServer,
  onLeaveServer,
  onUpdateControlMode,
  onSendChat,
  onCopyInvite,
}) => {
  const [serverName, setServerName] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const [controlMode, setControlMode] = useState<MultiplayerControlMode>('shared');
  const [joinCode, setJoinCode] = useState(initialJoinCode);
  const [chatText, setChatText] = useState('');

  if (room && role) {
    return (
      <div className="space-y-5">
        {/* Active Session Card */}
        <div className="rounded-xl bg-[#181b20] border border-amber-500/35 p-4 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs font-mono text-amber-400">
                <Radio className="w-3.5 h-3.5 shrink-0" />
                <span>{role === 'host' ? 'HOSTING SERVER' : 'CONNECTED AS GUEST'}</span>
              </div>
              <h3 className="font-display text-base font-semibold text-zinc-100 truncate mt-1">
                {room.roomName}
              </h3>
              <p className="text-xs text-zinc-400 truncate">
                {room.romTitle} · {room.isPublic ? 'Public Lobby' : 'Private Code Only'}
              </p>
            </div>

            <button
              type="button"
              onClick={onLeaveServer}
              className="px-3.5 py-2 rounded-lg text-xs font-semibold bg-[#22262e] hover:bg-red-950/70 hover:text-red-200 text-zinc-200 border border-white/10 flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors focus-visible:outline-2 focus-visible:outline-amber-400"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>{role === 'host' ? 'Close Server' : 'Disconnect'}</span>
            </button>
          </div>

          {/* Room Code & Invite Copy */}
          <div className="rounded-lg bg-[#121417] border border-white/10 p-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-[11px] text-zinc-400">Server Code</div>
              <div className="font-mono text-lg font-bold tracking-widest tabular-nums text-amber-400">
                {room.code}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onCopyInvite(room.code)}
              className="px-3.5 py-2 rounded-lg text-xs font-semibold bg-amber-500 hover:bg-amber-400 text-zinc-950 flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors focus-visible:outline-2 focus-visible:outline-amber-300"
            >
              <Copy className="w-3.5 h-3.5" />
              <span>Copy Invite Link</span>
            </button>
          </div>

          {/* Control Mode (Host Editable / Guest Read-only) */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-zinc-300">Controller Sharing</span>
              <span className="text-[11px] text-zinc-400">
                {CONTROL_MODES.find((m) => m.id === room.controlMode)?.hint}
              </span>
            </div>

            {role === 'host' ? (
              <div className="grid grid-cols-3 gap-1.5">
                {CONTROL_MODES.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => onUpdateControlMode(m.id)}
                    className={`px-2.5 py-2 rounded-lg text-xs font-medium border whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-amber-400 ${
                      room.controlMode === m.id
                        ? 'bg-amber-500 text-zinc-950 border-amber-400 font-semibold'
                        : 'bg-[#121417] text-zinc-300 border-white/10 hover:bg-[#22262e]'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            ) : (
              <div className="px-3 py-2 rounded-lg bg-[#121417] border border-white/10 text-xs text-zinc-300">
                {CONTROL_MODES.find((m) => m.id === room.controlMode)?.label}
              </div>
            )}
          </div>

          {/* Connected Players */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-zinc-300 flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5 text-amber-400" />
                <span>Connected Players</span>
              </span>
              <span className="font-mono tabular-nums text-zinc-400">
                {room.players.length} / {room.maxPlayers}
              </span>
            </div>
            <ul className="space-y-1.5">
              {room.players.map((p) => (
                <li
                  key={p.id}
                  className="px-3 py-2 rounded-lg bg-[#121417] border border-white/10 flex items-center justify-between text-xs"
                >
                  <span className="text-zinc-100 font-medium truncate">
                    {p.name}
                    {p.id === playerId ? ' (You)' : ''}
                  </span>
                  <span className="font-mono text-[11px] uppercase text-zinc-400 shrink-0">
                    {p.role}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Room Chat */}
        <div className="rounded-xl bg-[#181b20] border border-white/10 p-4 space-y-3">
          <div className="font-display text-sm font-semibold text-zinc-100">
            Session Chat
          </div>
          <div className="h-36 overflow-y-auto rounded-lg bg-[#121417] border border-white/10 p-3 space-y-2">
            {chatMessages.length === 0 ? (
              <p className="text-xs text-zinc-500">
                No messages yet. Share the invite link or room code so another player can join.
              </p>
            ) : (
              chatMessages.map((msg) => (
                <div key={msg.id} className="text-xs leading-relaxed">
                  <span
                    className={`font-semibold mr-1.5 ${
                      msg.role === 'host' ? 'text-amber-400' : 'text-zinc-200'
                    }`}
                  >
                    {msg.senderName}:
                  </span>
                  <span className="text-zinc-300 break-words">{msg.text}</span>
                </div>
              ))
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!chatText.trim()) return;
              onSendChat(chatText);
              setChatText('');
            }}
            className="flex items-center gap-2"
          >
            <input
              type="text"
              value={chatText}
              onChange={(e) => setChatText(e.target.value)}
              maxLength={240}
              placeholder="Send a message..."
              className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-[#121417] border border-white/10 text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-amber-400"
            />
            <button
              type="submit"
              className="px-3.5 py-2 rounded-lg text-xs font-semibold bg-amber-500 hover:bg-amber-400 text-zinc-950 flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors focus-visible:outline-2 focus-visible:outline-amber-300"
            >
              <Send className="w-3.5 h-3.5" />
              <span>Send</span>
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-display text-base font-semibold text-zinc-100">
          Multiplayer Server
        </h3>
        <p className="text-xs text-zinc-400">
          Open a server with your active game so another player can watch and play live without needing the ROM file.
        </p>
      </div>

      {/* Player Handle */}
      <div className="rounded-xl bg-[#181b20] border border-white/10 p-4 space-y-2">
        <label
          htmlFor="mp-player-name"
          className="block text-xs font-medium text-zinc-300"
        >
          Your Player Name
        </label>
        <input
          id="mp-player-name"
          type="text"
          value={playerName}
          onChange={(e) => onPlayerNameChange(e.target.value)}
          maxLength={24}
          placeholder="Player 1"
          className="w-full px-3 py-2 rounded-lg bg-[#121417] border border-white/10 text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-amber-400"
        />
      </div>

      {/* Host Current Game */}
      <div className="rounded-xl bg-[#181b20] border border-white/10 p-4 space-y-3.5">
        <div className="flex items-center justify-between gap-2">
          <span className="font-display text-sm font-semibold text-zinc-100 flex items-center gap-2">
            <Server className="w-4 h-4 text-amber-400" />
            <span>Open Game Server</span>
          </span>
          <span className="text-[11px] font-mono text-zinc-400 truncate max-w-[180px]">
            {romLoaded ? currentGameTitle : 'No Game Loaded'}
          </span>
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor="mp-server-name"
            className="block text-xs font-medium text-zinc-300"
          >
            Server Name
          </label>
          <input
            id="mp-server-name"
            type="text"
            value={serverName}
            onChange={(e) => setServerName(e.target.value)}
            maxLength={48}
            placeholder={`${currentGameTitle || 'Game.com'} Room`}
            className="w-full px-3 py-2 rounded-lg bg-[#121417] border border-white/10 text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-amber-400"
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setIsPublic(true)}
            className={`px-3 py-2 rounded-lg text-xs font-medium border flex items-center justify-center gap-1.5 whitespace-nowrap transition-colors ${
              isPublic
                ? 'bg-[#262b34] text-zinc-100 border-amber-400/50'
                : 'bg-[#121417] text-zinc-400 border-white/10 hover:text-zinc-200'
            }`}
          >
            <Globe className="w-3.5 h-3.5" />
            <span>Public Lobby</span>
          </button>
          <button
            type="button"
            onClick={() => setIsPublic(false)}
            className={`px-3 py-2 rounded-lg text-xs font-medium border flex items-center justify-center gap-1.5 whitespace-nowrap transition-colors ${
              !isPublic
                ? 'bg-[#262b34] text-zinc-100 border-amber-400/50'
                : 'bg-[#121417] text-zinc-400 border-white/10 hover:text-zinc-200'
            }`}
          >
            <span>Private Code</span>
          </button>
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          {CONTROL_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setControlMode(m.id)}
              className={`px-2 py-2 rounded-lg text-xs font-medium border whitespace-nowrap transition-colors ${
                controlMode === m.id
                  ? 'bg-[#262b34] text-amber-300 border-amber-400/50'
                  : 'bg-[#121417] text-zinc-400 border-white/10 hover:text-zinc-200'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          disabled={!romLoaded || connecting}
          onClick={() =>
            onCreateServer({
              roomName: serverName.trim() || `${currentGameTitle || 'Game.com'} Room`,
              isPublic,
              controlMode,
            })
          }
          className="w-full px-4 py-2.5 rounded-lg text-xs font-semibold bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-zinc-950 flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-amber-300"
        >
          <Server className="w-4 h-4" />
          <span>{connecting ? 'Opening Server...' : 'Open Server With Current Game'}</span>
        </button>
      </div>

      {/* Join by Code + Public Lobby Directory */}
      <div className="rounded-xl bg-[#181b20] border border-white/10 p-4 space-y-3.5">
        <div className="flex items-center justify-between gap-2">
          <span className="font-display text-sm font-semibold text-zinc-100">
            Join a Server
          </span>
          <button
            type="button"
            onClick={onRefreshRooms}
            disabled={loadingRooms}
            className="px-2.5 py-1.5 rounded-md text-xs font-medium bg-[#22262e] hover:bg-[#2c313b] text-zinc-300 border border-white/10 flex items-center gap-1.5 whitespace-nowrap transition-colors"
          >
            <RefreshCw className={`w-3 h-3 ${loadingRooms ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!joinCode.trim()) return;
            onJoinServer(joinCode.trim().toUpperCase());
          }}
          className="flex items-center gap-2"
        >
          <input
            type="text"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            maxLength={8}
            placeholder="ENTER CODE"
            className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-[#121417] border border-white/10 text-xs font-mono tracking-widest uppercase text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-amber-400"
          />
          <button
            type="submit"
            disabled={!joinCode.trim() || connecting}
            className="px-4 py-2 rounded-lg text-xs font-semibold bg-[#22262e] hover:bg-[#2c313b] disabled:opacity-40 text-zinc-100 border border-white/10 whitespace-nowrap shrink-0 transition-colors"
          >
            Join Code
          </button>
        </form>

        <div className="space-y-2">
          <div className="text-[11px] font-mono text-zinc-400">
            Open Game Servers ({publicRooms.length})
          </div>
          {publicRooms.length === 0 ? (
            <p className="text-xs text-zinc-500 py-3 text-center border border-dashed border-white/10 rounded-lg">
              No public servers online right now. Open one above or join with a code.
            </p>
          ) : (
            <ul className="space-y-2">
              {publicRooms.map((r) => (
                <li
                  key={r.code}
                  className="rounded-lg bg-[#121417] border border-white/10 px-3 py-2.5 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-zinc-100 truncate">
                      {r.roomName}
                    </div>
                    <div className="text-[11px] text-zinc-400 font-mono tabular-nums truncate">
                      {r.romTitle} · {r.hostName} · {r.playerCount}/{r.maxPlayers} · {r.code}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={connecting}
                    onClick={() => onJoinServer(r.code)}
                    className="px-3 py-1.5 rounded-md text-xs font-semibold bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-zinc-950 whitespace-nowrap shrink-0 transition-colors"
                  >
                    Join
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};
