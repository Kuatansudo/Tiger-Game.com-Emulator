import { CheatCodeEntry, SaveStateData } from './types';

const DB_NAME = 'tiger_gamecom_emu_db';
const DB_VERSION = 3;
const STORE_SAVESTATES = 'savestates';
const STORE_BIOS = 'bios_roms';
const STORE_CHEATS = 'cheats';

export interface StoredBiosEntry {
  key: 'internal' | 'external';
  filename: string;
  bytes: Uint8Array;
  updatedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SAVESTATES)) {
        const store = db.createObjectStore(STORE_SAVESTATES, { keyPath: 'storageKey' });
        store.createIndex('romId', 'romId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_BIOS)) {
        db.createObjectStore(STORE_BIOS, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_CHEATS)) {
        const cheatStore = db.createObjectStore(STORE_CHEATS, { keyPath: 'id' });
        cheatStore.createIndex('romId', 'romId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function makeKey(romId: string, slot: number): string {
  return `${romId}::slot_${slot}`;
}

export async function saveStateToDb(state: SaveStateData): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SAVESTATES, 'readwrite');
    const store = tx.objectStore(STORE_SAVESTATES);
    store.put({
      ...state,
      storageKey: makeKey(state.romId, state.slot),
    });
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function loadStatesForRom(romId: string): Promise<Record<number, SaveStateData>> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SAVESTATES, 'readonly');
    const store = tx.objectStore(STORE_SAVESTATES);
    const index = store.index('romId');
    const req = index.getAll(romId);
    req.onsuccess = () => {
      const map: Record<number, SaveStateData> = {};
      for (const item of req.result as (SaveStateData & { storageKey?: string })[]) {
        map[item.slot] = item;
      }
      db.close();
      resolve(map);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

export async function deleteStateFromDb(romId: string, slot: number): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SAVESTATES, 'readwrite');
    const store = tx.objectStore(STORE_SAVESTATES);
    store.delete(makeKey(romId, slot));
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function saveBiosToDb(entry: StoredBiosEntry): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BIOS, 'readwrite');
    const store = tx.objectStore(STORE_BIOS);
    store.put({
      ...entry,
      bytes: Array.from(entry.bytes),
    });
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function loadAllBiosFromDb(): Promise<{
  internal?: StoredBiosEntry;
  external?: StoredBiosEntry;
}> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BIOS, 'readonly');
    const store = tx.objectStore(STORE_BIOS);
    const req = store.getAll();
    req.onsuccess = () => {
      const out: { internal?: StoredBiosEntry; external?: StoredBiosEntry } = {};
      for (const row of req.result as Array<{
        key: 'internal' | 'external';
        filename: string;
        bytes: number[];
        updatedAt: number;
      }>) {
        out[row.key] = {
          key: row.key,
          filename: row.filename,
          bytes: new Uint8Array(row.bytes),
          updatedAt: row.updatedAt,
        };
      }
      db.close();
      resolve(out);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

export async function clearBiosFromDb(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BIOS, 'readwrite');
    const store = tx.objectStore(STORE_BIOS);
    store.clear();
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export function exportSaveStateFile(state: SaveStateData): void {
  const json = JSON.stringify(state);
  const blob = new Blob([json], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = state.romTitle.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  a.href = url;
  a.download = `${safeName}_slot${state.slot}.tgcstate`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function parseSaveStateFile(file: File): Promise<SaveStateData> {
  const text = await file.text();
  const parsed = JSON.parse(text) as SaveStateData;
  if (
    !parsed ||
    typeof parsed.version !== 'number' ||
    !Array.isArray(parsed.internalRam) ||
    !Array.isArray(parsed.vramBank0) ||
    !parsed.cpu
  ) {
    throw new Error('Invalid .tgcstate savestate file.');
  }
  return parsed;
}

export async function saveCheatToDb(entry: CheatCodeEntry): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHEATS, 'readwrite');
    const store = tx.objectStore(STORE_CHEATS);
    store.put(entry);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function loadCheatsForRom(romId: string): Promise<CheatCodeEntry[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHEATS, 'readonly');
    const store = tx.objectStore(STORE_CHEATS);
    const index = store.index('romId');
    const req = index.getAll(romId);
    req.onsuccess = () => {
      const list = (req.result as CheatCodeEntry[]) || [];
      list.sort((a, b) => a.createdAt - b.createdAt);
      db.close();
      resolve(list);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

export async function deleteCheatFromDb(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHEATS, 'readwrite');
    const store = tx.objectStore(STORE_CHEATS);
    store.delete(id);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

