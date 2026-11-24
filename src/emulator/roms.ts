import {
  INT_VBLANK,
  REG_DM_BANK,
  REG_DM_CTRL,
  REG_DM_DST_X,
  REG_DM_DST_Y,
  REG_DM_H,
  REG_DM_SRC_H,
  REG_DM_SRC_L,
  REG_DM_W,
  REG_IE0,
  REG_IR0,
  REG_LCC,
  REG_MMU0,
  REG_MMU1,
  REG_P0,
  REG_P1,
  REG_P2,
  REG_P3,
  REG_SG0H,
  REG_SG0L,
  REG_SG0V,
  REG_SG1H,
  REG_SG1L,
  REG_SG1V,
  REG_SG2C,
  REG_SG2V,
  REG_SGC,
  REG_SPH,
  REG_SPL,
} from './sm8521';
import { CartridgeInfo } from './types';

export interface BuiltInRomEntry {
  info: CartridgeInfo;
  bytes: Uint8Array;
}

// Compute fast deterministic hex hash for ROM identification & savestate keying
export function computeRomHash(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xdeadbeef;
  const step = Math.max(1, Math.floor(bytes.length / 4096));
  for (let i = 0; i < bytes.length; i += step) {
    h1 ^= bytes[i];
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= bytes[bytes.length - 1 - i];
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return (
    h1.toString(16).padStart(8, '0') +
    h2.toString(16).padStart(8, '0') +
    bytes.length.toString(16).padStart(6, '0')
  );
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length && offset + i < bytes.length; i++) {
    const c = bytes[offset + i];
    if (c === 0) break;
    if (c >= 32 && c <= 126) {
      out += String.fromCharCode(c);
    }
  }
  return out.trim();
}

function findTigerSignatureOffset(bytes: Uint8Array): number {
  const target = 'TigerDMGC';
  const matchAt = (offset: number): boolean => {
    if (offset < 0 || offset + target.length > bytes.length) return false;
    for (let j = 0; j < target.length; j++) {
      if (bytes[offset + j] !== target.charCodeAt(j)) return false;
    }
    return true;
  };

  // Canonical bank-0 (0x05) and commercial bank-32 (0x40005 = 0x20 << 13 + 5)
  if (matchAt(0x05)) return 0x05;
  if (matchAt(0x40005)) return 0x40005;

  // Scan first 4 KB and bank 32 (0x40000..0x41000)
  const limit0 = Math.min(bytes.length - target.length, 4096);
  for (let i = 0; i <= limit0; i++) {
    if (matchAt(i)) return i;
  }
  if (bytes.length > 0x40000 + target.length) {
    const limit32 = Math.min(bytes.length - target.length, 0x41000);
    for (let i = 0x40000; i <= limit32; i++) {
      if (matchAt(i)) return i;
    }
  }
  return -1;
}

export function parseTgcRom(
  bytes: Uint8Array,
  filename: string,
  isBuiltIn = false,
  description?: string
): CartridgeInfo {
  const sigOffset = findTigerSignatureOffset(bytes);
  const sig = sigOffset >= 0 ? 'TigerDMGC' : '';
  const hasValidHeader = sigOffset >= 0;

  const cleanFilenameTitle = filename
    .replace(/\.(tgc|tcg|bin|zip)$/i, '')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .trim();

  let title = '';
  let serial = '';
  let entryPoint = 0x2040;
  let isHomebrew = isBuiltIn;

  if (hasValidHeader) {
    // Standard Tiger header places title near sigOffset + 9
    const rawHdrTitle = readAscii(bytes, sigOffset + 9, 16);
    // Filter out non-alphanumeric garbage in commercial binary headers
    const printableRatio =
      rawHdrTitle.length > 0
        ? rawHdrTitle.replace(/[^a-zA-Z0-9 .:-]/g, '').length / rawHdrTitle.length
        : 0;
    title =
      rawHdrTitle.length >= 3 && printableRatio >= 0.8
        ? rawHdrTitle
        : cleanFilenameTitle || 'Game.com Cartridge';

    const rawSerial = readAscii(bytes, sigOffset + 25, 8);
    serial =
      rawSerial.length >= 3 && /^[a-zA-Z0-9-]+$/.test(rawSerial)
        ? rawSerial
        : 'TIGER-CART';

    const hdrBase = sigOffset >= 0x40000 ? 0x40000 : 0;
    if (bytes.length > hdrBase + 0x27) {
      if (sigOffset === 0x05 && bytes[0x02] === 0x40) {
        const vec = bytes[0x26] | (bytes[0x27] << 8);
        if (vec === 0x2040) {
          entryPoint = vec;
          isHomebrew = true;
        }
      } else {
        // Commercial SM8500 big-endian entry address inside bank header (+0x26/+0x27)
        const beVec = (bytes[hdrBase + 0x26] << 8) | bytes[hdrBase + 0x27];
        if (beVec >= 0x2000) {
          entryPoint = beVec;
        }
      }
    }
  } else {
    title = cleanFilenameTitle || filename;
    serial = 'RAW-ROM';
  }

  const hash = computeRomHash(bytes);
  const bankCount = Math.max(1, Math.ceil(bytes.length / 0x2000));
  const requiresBios = !isHomebrew;

  return {
    id: hash,
    filename,
    title,
    serial,
    signature: sig || 'NONE',
    signatureOffset: sigOffset,
    hasValidHeader,
    sizeBytes: bytes.length,
    bankCount,
    entryPoint,
    sha1LikeHash: hash,
    isBuiltIn,
    isHomebrew,
    requiresBios,
    description,
  };
}

export function drawCleanRoomCartridgeScreen(
  vram: Uint8Array,
  cart: CartridgeInfo,
  hasInternalBios: boolean,
  hasExternalBios: boolean
): void {
  const W = 200;
  const H = 160;
  vram.fill(0);

  const setPx = (x: number, y: number, shade: number) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const idx = y * W + x;
    const bIdx = idx >> 2;
    const shift = 6 - (idx & 3) * 2;
    vram[bIdx] = (vram[bIdx] & ~(0x03 << shift)) | ((shade & 3) << shift);
  };

  const fillRect = (x: number, y: number, w: number, h: number, shade: number) => {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        setPx(xx, yy, shade);
      }
    }
  };

  const drawText = (x: number, y: number, str: string, shade = 3) => {
    const upper = str.toUpperCase();
    let cx = x;
    for (let i = 0; i < upper.length && cx + 4 <= W; i++) {
      const ch = upper[i];
      const glyph = FONT_5X6_PATTERNS[ch] ?? FONT_5X6_PATTERNS[' '];
      for (let row = 0; row < 5; row++) {
        const bits = glyph[row];
        for (let col = 0; col < 4; col++) {
          if ((bits >> (3 - col)) & 1) {
            setPx(cx + col, y + row, shade);
          }
        }
      }
      cx += 5;
    }
  };

  // Top Tiger Game.com Header Banner
  fillRect(0, 0, W, 20, 3);
  drawText(8, 7, 'TIGER GAME.COM', 0);
  drawText(132, 7, 'CART DETECTED', 1);

  // Cartridge Card Box
  fillRect(8, 28, 184, 54, 1);
  fillRect(10, 30, 180, 50, 0);
  fillRect(10, 30, 180, 12, 2);
  drawText(14, 33, cart.title.slice(0, 34), 0);

  const kb = Math.round(cart.sizeBytes / 1024);
  drawText(14, 48, `SIG: ${cart.signature}`, 3);
  drawText(104, 48, `BANKS: ${cart.bankCount}`, 3);
  drawText(14, 58, `SIZE: ${kb} KB`, 3);
  drawText(104, 58, `ID: ${cart.serial.slice(0, 10)}`, 3);
  drawText(14, 68, `FILE: ${cart.filename.slice(0, 28)}`, 2);

  // BIOS Status Section
  fillRect(8, 88, 184, 64, 1);
  fillRect(10, 90, 180, 60, 0);
  drawText(14, 96, 'SYSTEM BIOS REQUIRED TO BOOT', 3);
  drawText(14, 108, `INTERNAL: ${hasInternalBios ? 'LOADED' : 'MISSING'}`, hasInternalBios ? 3 : 2);
  drawText(14, 118, `EXTERNAL: ${hasExternalBios ? 'LOADED' : 'MISSING'}`, hasExternalBios ? 3 : 2);
  drawText(14, 132, 'LOAD GAMECOM.ZIP OR INTERNAL+', 2);
  drawText(14, 140, 'EXTERNAL.BIN IN CARTRIDGE BAY', 2);
}

// ============================================================================
// Miniature Two-Pass SM8521 Assembler for Built-In Authentic .TGC Cartridges
// ============================================================================

const COND = {
  LT: 0x1,
  LE: 0x2,
  ULE: 0x3,
  OV: 0x4,
  MI: 0x5,
  EQ: 0x6,
  Z: 0x6,
  C: 0x7,
  ULT: 0x7,
  T: 0x8,
  GE: 0x9,
  GT: 0xa,
  UGT: 0xb,
  NOV: 0xc,
  PL: 0xd,
  NE: 0xe,
  NZ: 0xe,
  NC: 0xf,
  UGE: 0xf,
};

interface Fixup {
  pos: number;
  label: string;
  kind: 'abs16' | 'rel8';
}

class SM8521Asm {
  private baseAddr = 0x2000;
  private buf: number[] = [];
  private labels = new Map<string, number>();
  private fixups: Fixup[] = [];

  constructor(title: string, serial: string) {
    // 64-byte TigerDMGC Header (0x0000..0x003F -> 0x2000..0x203F)
    for (let i = 0; i < 0x40; i++) this.buf.push(0x00);
    this.buf[0x00] = 0x00;
    this.buf[0x01] = 0x00;
    this.buf[0x02] = 0x40;
    this.buf[0x03] = 0x00;
    this.buf[0x04] = 0x01;
    const sig = 'TigerDMGC';
    for (let i = 0; i < sig.length; i++) this.buf[0x05 + i] = sig.charCodeAt(i);
    for (let i = 0; i < Math.min(16, title.length); i++) this.buf[0x0e + i] = title.charCodeAt(i);
    for (let i = 0; i < Math.min(8, serial.length); i++) this.buf[0x1e + i] = serial.charCodeAt(i);
    // Entry point at 0x2026..0x2027 -> 0x2040
    this.buf[0x26] = 0x40;
    this.buf[0x27] = 0x20;
  }

  public here(): number {
    return this.baseAddr + this.buf.length;
  }

  public label(name: string): void {
    this.labels.set(name, this.here());
  }

  public db(...bytes: number[]): void {
    for (const b of bytes) this.buf.push(b & 0xff);
  }

  public dw(word: number): void {
    this.buf.push(word & 0xff, (word >> 8) & 0xff);
  }

  public dwLabel(label: string): void {
    this.fixups.push({ pos: this.buf.length, label, kind: 'abs16' });
    this.buf.push(0, 0);
  }

  public asciiZ(str: string): void {
    for (let i = 0; i < str.length; i++) this.buf.push(str.charCodeAt(i) & 0xff);
    this.buf.push(0);
  }

  // Instructions
  public di(): void { this.db(0xf3); }
  public ei(): void { this.db(0xf2); }
  public halt(): void { this.db(0xf4); }
  public nop(): void { this.db(0xff); }
  public ret(): void { this.db(0xf0); }
  public iret(): void { this.db(0xf1); }

  public clr(addr8: number): void { this.db(0x00, addr8); }
  public inc(addr8: number): void { this.db(0x08, addr8); }
  public dec(addr8: number): void { this.db(0x09, addr8); }
  public srl(addr8: number): void { this.db(0x07, addr8); }
  public sll(addr8: number): void { this.db(0x0b, addr8); }
  public push(addr8: number): void { this.db(0x0e, addr8); }
  public pop(addr8: number): void { this.db(0x0f, addr8); }

  public movImm(addr8: number, imm8: number): void { this.db(0x1b, addr8, imm8); }
  public movMem(dst8: number, src8: number): void { this.db(0x1a, dst8, src8); }
  public movRImm(r: number, imm8: number): void { this.db(0x40 | (r & 0x0f), imm8); }
  public movRR(d: number, s: number): void { this.db(0x80 | (d & 0x0f), s & 0x0f); }
  public movwImm(rr: number, imm16: number): void { this.db(0x3a, rr & 0x0e); this.dw(imm16); }
  public movwLabel(rr: number, label: string): void { this.db(0x3a, rr & 0x0e); this.dwLabel(label); }

  public ldInd(r: number, rr: number, postInc = false): void {
    this.db(0x2a, ((r & 0x07) << 4) | (rr & 0x0e) | (postInc ? 1 : 0));
  }
  public stInd(r: number, rr: number, postInc = false): void {
    this.db(0x2a, 0x80 | ((r & 0x07) << 4) | (rr & 0x0e) | (postInc ? 1 : 0));
  }
  public ldAbs(r: number, addr16: number): void { this.db(0x2b, r & 0x0f); this.dw(addr16); }
  public stAbs(r: number, addr16: number): void { this.db(0x2b, 0x80 | (r & 0x0f)); this.dw(addr16); }

  public cmpImm(addr8: number, imm8: number): void { this.db(0x20, addr8, imm8); }
  public addImm(addr8: number, imm8: number): void { this.db(0x21, addr8, imm8); }
  public subImm(addr8: number, imm8: number): void { this.db(0x22, addr8, imm8); }
  public andImm(addr8: number, imm8: number): void { this.db(0x25, addr8, imm8); }
  public orImm(addr8: number, imm8: number): void { this.db(0x26, addr8, imm8); }
  public xorImm(addr8: number, imm8: number): void { this.db(0x27, addr8, imm8); }

  public cmpRImm(r: number, imm8: number): void { this.db(0xb0 | (r & 0x0f), imm8); }
  public addRImm(r: number, imm8: number): void { this.db(0xe0 | (r & 0x0f), imm8); }

  public cmpMem(d8: number, s8: number): void { this.db(0x10, d8, s8); }
  public addMem(d8: number, s8: number): void { this.db(0x11, d8, s8); }
  public subMem(d8: number, s8: number): void { this.db(0x12, d8, s8); }
  public andMem(d8: number, s8: number): void { this.db(0x15, d8, s8); }
  public orMem(d8: number, s8: number): void { this.db(0x16, d8, s8); }
  public xorMem(d8: number, s8: number): void { this.db(0x17, d8, s8); }

  public incw(rr: number): void { this.db(0x50 | ((rr >> 1) & 0x07)); }
  public decw(rr: number): void { this.db(0x58 | ((rr >> 1) & 0x07)); }
  public addwImm(rr: number, imm16: number): void { this.db(0x7a, rr & 0x0e); this.dw(imm16); }
  public addwRR(dstRR: number, srcRR: number): void { this.db(0x7d, dstRR & 0x0e, srcRR & 0x0e); }
  public pushw(rr: number): void { this.db(0x78, rr & 0x0e); }
  public popw(rr: number): void { this.db(0x79, rr & 0x0e); }

  public bclr(addr8: number, bit: number): void { this.db(0x60 | (bit & 7), addr8); }
  public bset(addr8: number, bit: number): void { this.db(0x68 | (bit & 7), addr8); }
  public btst(addr8: number, bit: number): void { this.db(0x70 | (bit & 7), addr8); }

  public mul(rr: number): void { this.db(0x3c, rr & 0x0e); }
  public div(rr: number, rDiv: number): void { this.db(0x3d, rr & 0x0e, rDiv & 0x0f); }

  public jmp(label: string): void { this.db(0x3e, 0x40); this.dwLabel(label); }
  public call(label: string): void { this.db(0x3f, 0x40); this.dwLabel(label); }

  private skipCounter = 0;

  public br(cond: number, label: string): void {
    this.db(0xd0 | (cond & 0x0f));
    this.fixups.push({ pos: this.buf.length, label, kind: 'rel8' });
    this.buf.push(0);
  }

  public jcc(cond: number, label: string): void {
    if (cond === COND.T) {
      this.jmp(label);
      return;
    }
    const skip = `__jcc_skip_${this.skipCounter++}`;
    this.br(cond ^ 0x08, skip);
    this.jmp(label);
    this.label(skip);
  }

  public dbnz(r: number, label: string): void {
    this.db(0xc0 | (r & 0x0f));
    this.fixups.push({ pos: this.buf.length, label, kind: 'rel8' });
    this.buf.push(0);
  }

  // Helper: Clear entire 200x160 screen with shade (0..3)
  public fillRect(x: number, y: number, w: number, h: number, shade: number): void {
    this.movImm(REG_DM_SRC_L, shade & 3);
    this.movImm(REG_DM_DST_X, x);
    this.movImm(REG_DM_DST_Y, y);
    this.movImm(REG_DM_W, w);
    this.movImm(REG_DM_H, h);
    this.movImm(REG_DM_CTRL, 0x08);
  }

  public build(minSizeBytes = 8192): Uint8Array {
    for (const f of this.fixups) {
      const target = this.labels.get(f.label);
      if (target === undefined) {
        throw new Error(`Undefined SM8521 label: ${f.label}`);
      }
      if (f.kind === 'abs16') {
        this.buf[f.pos] = target & 0xff;
        this.buf[f.pos + 1] = (target >> 8) & 0xff;
      } else {
        const nextPc = this.baseAddr + f.pos + 1;
        const rel = target - nextPc;
        if (rel < -128 || rel > 127) {
          throw new Error(`Relative branch out of range to ${f.label}: ${rel}`);
        }
        this.buf[f.pos] = rel & 0xff;
      }
    }
    const size = Math.max(minSizeBytes, Math.ceil(this.buf.length / 0x2000) * 0x2000);
    const out = new Uint8Array(size);
    out.fill(0xff);
    out.set(this.buf);
    return out;
  }
}

// ============================================================================
// Shared 4x6 Compact 2bpp Bitmap Font (Uppercase A-Z, 0-9, :, /, !, -, space)
// Each glyph is 4 pixels wide x 6 pixels tall -> 1 byte per row, 6 bytes/glyph
// ============================================================================
const FONT_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:!- ';
const FONT_5X6_PATTERNS: Record<string, number[]> = {
  A: [0b0110, 0b1001, 0b1111, 0b1001, 0b1001, 0],
  B: [0b1110, 0b1001, 0b1110, 0b1001, 0b1110, 0],
  C: [0b0111, 0b1000, 0b1000, 0b1000, 0b0111, 0],
  D: [0b1110, 0b1001, 0b1001, 0b1001, 0b1110, 0],
  E: [0b1111, 0b1000, 0b1110, 0b1000, 0b1111, 0],
  F: [0b1111, 0b1000, 0b1110, 0b1000, 0b1000, 0],
  G: [0b0111, 0b1000, 0b1011, 0b1001, 0b0111, 0],
  H: [0b1001, 0b1001, 0b1111, 0b1001, 0b1001, 0],
  I: [0b1110, 0b0100, 0b0100, 0b0100, 0b1110, 0],
  J: [0b0001, 0b0001, 0b0001, 0b1001, 0b0110, 0],
  K: [0b1001, 0b1010, 0b1100, 0b1010, 0b1001, 0],
  L: [0b1000, 0b1000, 0b1000, 0b1000, 0b1111, 0],
  M: [0b1001, 0b1111, 0b1111, 0b1001, 0b1001, 0],
  N: [0b1001, 0b1101, 0b1011, 0b1001, 0b1001, 0],
  O: [0b0110, 0b1001, 0b1001, 0b1001, 0b0110, 0],
  P: [0b1110, 0b1001, 0b1110, 0b1000, 0b1000, 0],
  Q: [0b0110, 0b1001, 0b1001, 0b1011, 0b0111, 0],
  R: [0b1110, 0b1001, 0b1110, 0b1010, 0b1001, 0],
  S: [0b0111, 0b1000, 0b0110, 0b0001, 0b1110, 0],
  T: [0b1111, 0b0100, 0b0100, 0b0100, 0b0100, 0],
  U: [0b1001, 0b1001, 0b1001, 0b1001, 0b0110, 0],
  V: [0b1001, 0b1001, 0b1001, 0b0110, 0b0110, 0],
  W: [0b1001, 0b1001, 0b1111, 0b1111, 0b1001, 0],
  X: [0b1001, 0b0110, 0b0110, 0b0110, 0b1001, 0],
  Y: [0b1001, 0b1001, 0b0110, 0b0100, 0b0100, 0],
  Z: [0b1111, 0b0010, 0b0100, 0b1000, 0b1111, 0],
  '0': [0b0110, 0b1011, 0b1101, 0b1001, 0b0110, 0],
  '1': [0b0100, 0b1100, 0b0100, 0b0100, 0b1110, 0],
  '2': [0b1110, 0b0001, 0b0110, 0b1000, 0b1111, 0],
  '3': [0b1110, 0b0001, 0b0110, 0b0001, 0b1110, 0],
  '4': [0b1001, 0b1001, 0b1111, 0b0001, 0b0001, 0],
  '5': [0b1111, 0b1000, 0b1110, 0b0001, 0b1110, 0],
  '6': [0b0111, 0b1000, 0b1110, 0b1001, 0b0110, 0],
  '7': [0b1111, 0b0001, 0b0010, 0b0100, 0b0100, 0],
  '8': [0b0110, 0b1001, 0b0110, 0b1001, 0b0110, 0],
  '9': [0b0110, 0b1001, 0b0111, 0b0001, 0b1110, 0],
  ':': [0b0000, 0b0100, 0b0000, 0b0100, 0b0000, 0],
  '!': [0b0100, 0b0100, 0b0100, 0b0000, 0b0100, 0],
  '-': [0b0000, 0b0000, 0b1110, 0b0000, 0b0000, 0],
  ' ': [0b0000, 0b0000, 0b0000, 0b0000, 0b0000, 0],
};

function packFont2bpp(shade = 3): number[] {
  const out: number[] = [];
  for (const ch of FONT_CHARS) {
    const rows = FONT_5X6_PATTERNS[ch] ?? FONT_5X6_PATTERNS[' '];
    for (let y = 0; y < 6; y++) {
      const bits = rows[y];
      let b = 0;
      for (let x = 0; x < 4; x++) {
        if ((bits >> (3 - x)) & 1) {
          b |= (shade & 3) << (6 - x * 2);
        }
      }
      out.push(b);
    }
  }
  return out;
}

function emitFontHelper(a: SM8521Asm, fontLabel: string): void {
  // draw_text(RR2 = null-terminated str ptr, R4 = startX, R5 = startY)
  // Uses R0, R1, R6, R7, RR8
  a.label('draw_text');
  a.ldInd(0, 2, true); // R0 = *RR2++
  a.cmpRImm(0, 0);
  a.br(COND.NE, 'dt_char');
  a.ret();

  a.label('dt_char');
  // Look up index in FONT_CHARS via simple ASCII range or table? Let's do a fast loop over font_chars_tbl!
  a.movwLabel(8, 'font_chars_tbl'); // RR8 -> FONT_CHARS
  a.movRImm(6, 0); // R6 = glyph index
  a.label('dt_find');
  a.ldInd(1, 8, true); // R1 = *RR8++
  a.cmpRImm(1, 0);
  a.br(COND.EQ, 'dt_space');
  a.cmpMem(1, 0); // R1 == R0?
  a.br(COND.EQ, 'dt_found');
  a.inc(6);
  a.br(COND.T, 'dt_find');

  a.label('dt_space');
  a.movRImm(6, FONT_CHARS.length - 1);

  a.label('dt_found');
  // glyph offset = R6 * 6 -> RR8 = fontLabel + (R6 * 6)
  a.movRImm(7, 6);
  // 8-bit mul: RR6 = R6 * R7 -> result in RR6 (R6=hi, R7=lo)
  a.mul(6);
  a.movwLabel(8, fontLabel);
  a.addwRR(8, 6); // RR8 += glyph offset

  // Blit 4x6 glyph at (R4, R5) from RR8 (bank 32)
  a.movMem(REG_DM_SRC_L, 9); // lo of RR8
  a.movMem(REG_DM_SRC_H, 8); // hi of RR8
  a.movMem(REG_DM_DST_X, 4);
  a.movMem(REG_DM_DST_Y, 5);
  a.movImm(REG_DM_W, 4);
  a.movImm(REG_DM_H, 6);
  a.movImm(REG_DM_BANK, 32);
  a.movImm(REG_DM_CTRL, 0x01); // transparent blit

  a.addRImm(4, 5); // X += 5
  a.jmp('draw_text');

  // draw_digit(R0 = 0..9, R4 = x, R5 = y)
  a.label('draw_digit');
  a.addRImm(0, 26); // '0' starts at index 26 in FONT_CHARS
  a.movRImm(7, 6);
  a.movRR(6, 0);
  a.mul(6);
  a.movwLabel(8, fontLabel);
  a.addwRR(8, 6);
  a.movMem(REG_DM_SRC_L, 9);
  a.movMem(REG_DM_SRC_H, 8);
  a.movMem(REG_DM_DST_X, 4);
  a.movMem(REG_DM_DST_Y, 5);
  a.movImm(REG_DM_W, 4);
  a.movImm(REG_DM_H, 6);
  a.movImm(REG_DM_BANK, 32);
  a.movImm(REG_DM_CTRL, 0x01);
  a.ret();

  // draw_2digits(R0 = 0..99, R4 = x, R5 = y)
  a.label('draw_2digits');
  a.movRImm(1, 0); // tens
  a.label('d2_loop');
  a.cmpRImm(0, 10);
  a.br(COND.ULT, 'd2_tens_done');
  a.subImm(0, 10);
  a.inc(1);
  a.br(COND.T, 'd2_loop');
  a.label('d2_tens_done');
  a.push(0); // save ones
  a.movRR(0, 1);
  a.call('draw_digit');
  a.addRImm(4, 5);
  a.pop(0);
  a.call('draw_digit');
  a.ret();
}

function emitFontData(a: SM8521Asm, fontLabel: string): void {
  a.label('font_chars_tbl');
  a.asciiZ(FONT_CHARS);
  a.label(fontLabel);
  a.db(...packFont2bpp(3));
}

// ============================================================================
// 1. LIGHTS OUT (TGC) — Interactive Touchscreen + D-Pad Puzzle
// ============================================================================
function buildLightsOutRom(): BuiltInRomEntry {
  const a = new SM8521Asm('LIGHTS OUT', '71-501');

  // RAM variables (0x80..0xCF)
  const V_CUR_X = 0x80;
  const V_CUR_Y = 0x81;
  const V_MOVES = 0x82;
  const V_LEVEL = 0x83;
  const V_PREV_P0 = 0x84;
  const V_PREV_P1 = 0x85;
  const V_SFX_TIMER = 0x86;
  const V_WIN_FLAG = 0x87;
  const V_FLASH = 0x88;
  const V_BOARD = 0x90; // 25 bytes: 0x90..0xA8 (0 = off, 1 = on)

  // Entry at 0x2040
  a.di();
  a.movImm(REG_SPH, 0x03);
  a.movImm(REG_SPL, 0xff);
  a.movImm(REG_MMU0, 32);
  a.movImm(REG_MMU1, 32);
  a.movImm(REG_LCC, 0x80); // LCD On
  a.movImm(REG_SGC, 0x80); // Audio On
  a.movImm(REG_IE0, INT_VBLANK);
  a.movImm(REG_IR0, 0x00);

  a.movImm(V_CUR_X, 2);
  a.movImm(V_CUR_Y, 2);
  a.movImm(V_LEVEL, 0);
  a.movImm(V_PREV_P0, 0xff);
  a.movImm(V_PREV_P1, 0xff);
  a.movImm(V_SFX_TIMER, 0);
  a.movImm(V_WIN_FLAG, 0);
  a.movImm(V_FLASH, 0);

  a.call('load_level');
  a.call('render_all');

  // Main 60Hz Loop
  a.label('main_loop');
  // Wait for VBlank flag in IR0
  a.label('wait_vblank');
  a.btst(REG_IR0, 0);
  a.br(COND.Z, 'wait_vblank');
  a.bclr(REG_IR0, 0);

  // Tick audio decay
  a.cmpImm(V_SFX_TIMER, 0);
  a.br(COND.EQ, 'sfx_done');
  a.dec(V_SFX_TIMER);
  a.cmpImm(V_SFX_TIMER, 0);
  a.br(COND.NE, 'sfx_done');
  a.movImm(REG_SG0V, 0);
  a.movImm(REG_SG1V, 0);
  a.label('sfx_done');

  // Flash win banner / re-render every 16 frames if won
  a.inc(V_FLASH);

  // Poll inputs
  a.movMem(10, REG_P0); // R10 = current P0
  a.movMem(11, REG_P1); // R11 = current P1

  // Detect newly pressed bits: (~curr) & prev
  // Check UP (bit 0)
  a.btst(REG_P0, 0);
  a.br(COND.NE, 'chk_down');
  a.btst(V_PREV_P0, 0);
  a.br(COND.Z, 'chk_down');
  a.cmpImm(V_CUR_Y, 0);
  a.br(COND.EQ, 'chk_down');
  a.dec(V_CUR_Y);
  a.call('play_move_blip');
  a.call('render_board');

  a.label('chk_down');
  a.btst(REG_P0, 1);
  a.br(COND.NE, 'chk_left');
  a.btst(V_PREV_P0, 1);
  a.br(COND.Z, 'chk_left');
  a.cmpImm(V_CUR_Y, 4);
  a.br(COND.EQ, 'chk_left');
  a.inc(V_CUR_Y);
  a.call('play_move_blip');
  a.call('render_board');

  a.label('chk_left');
  a.btst(REG_P0, 2);
  a.br(COND.NE, 'chk_right');
  a.btst(V_PREV_P0, 2);
  a.br(COND.Z, 'chk_right');
  a.cmpImm(V_CUR_X, 0);
  a.br(COND.EQ, 'chk_right');
  a.dec(V_CUR_X);
  a.call('play_move_blip');
  a.call('render_board');

  a.label('chk_right');
  a.btst(REG_P0, 3);
  a.br(COND.NE, 'chk_btn_a');
  a.btst(V_PREV_P0, 3);
  a.br(COND.Z, 'chk_btn_a');
  a.cmpImm(V_CUR_X, 4);
  a.br(COND.EQ, 'chk_btn_a');
  a.inc(V_CUR_X);
  a.call('play_move_blip');
  a.call('render_board');

  // Button A (P1 bit 0): Toggle cell at cursor (or advance if win)
  a.label('chk_btn_a');
  a.btst(REG_P1, 0);
  a.br(COND.NE, 'chk_btn_b');
  a.btst(V_PREV_P1, 0);
  a.br(COND.Z, 'chk_btn_b');
  a.cmpImm(V_WIN_FLAG, 1);
  a.br(COND.NE, 'do_cur_toggle');
  a.call('next_level');
  a.br(COND.T, 'chk_btn_b');
  a.label('do_cur_toggle');
  a.movMem(4, V_CUR_X);
  a.movMem(5, V_CUR_Y);
  a.call('toggle_at_r4_r5');

  // Button B (P1 bit 1): Reset current level
  a.label('chk_btn_b');
  a.btst(REG_P1, 1);
  a.br(COND.NE, 'chk_btn_c');
  a.btst(V_PREV_P1, 1);
  a.br(COND.Z, 'chk_btn_c');
  a.call('load_level');
  a.call('play_reset_sfx');
  a.call('render_all');

  // Button C (P1 bit 2): Next level
  a.label('chk_btn_c');
  a.btst(REG_P1, 2);
  a.br(COND.NE, 'chk_touch');
  a.btst(V_PREV_P1, 2);
  a.br(COND.Z, 'chk_touch');
  a.call('next_level');

  // Touchscreen Stylus (P1 bit 7): Map X (45..154) and Y (32..141) to 5x5 grid
  a.label('chk_touch');
  a.btst(REG_P1, 7);
  a.br(COND.NE, 'save_prev_inputs');
  a.btst(V_PREV_P1, 7);
  a.br(COND.Z, 'save_prev_inputs');

  // If won, any tap advances to next level
  a.cmpImm(V_WIN_FLAG, 1);
  a.br(COND.NE, 'touch_grid_hit');
  a.call('next_level');
  a.br(COND.T, 'save_prev_inputs');

  a.label('touch_grid_hit');
  a.movMem(4, REG_P2); // Touch X
  a.movMem(5, REG_P3); // Touch Y
  a.cmpRImm(4, 45);
  a.br(COND.ULT, 'save_prev_inputs');
  a.cmpRImm(4, 155);
  a.br(COND.UGE, 'save_prev_inputs');
  a.cmpRImm(5, 32);
  a.br(COND.ULT, 'save_prev_inputs');
  a.cmpRImm(5, 142);
  a.br(COND.UGE, 'save_prev_inputs');

  // col = (X - 45) / 22
  a.subImm(4, 45);
  a.movRImm(6, 0);
  a.label('t_div_x');
  a.cmpRImm(4, 22);
  a.br(COND.ULT, 't_div_x_done');
  a.subImm(4, 22);
  a.inc(6);
  a.br(COND.T, 't_div_x');
  a.label('t_div_x_done');

  // row = (Y - 32) / 22
  a.subImm(5, 32);
  a.movRImm(7, 0);
  a.label('t_div_y');
  a.cmpRImm(5, 22);
  a.br(COND.ULT, 't_div_y_done');
  a.subImm(5, 22);
  a.inc(7);
  a.br(COND.T, 't_div_y');
  a.label('t_div_y_done');

  a.movMem(V_CUR_X, 6);
  a.movMem(V_CUR_Y, 7);
  a.movRR(4, 6);
  a.movRR(5, 7);
  a.call('toggle_at_r4_r5');

  a.label('save_prev_inputs');
  a.movMem(V_PREV_P0, REG_P0);
  a.movMem(V_PREV_P1, REG_P1);
  a.jmp('main_loop');

  // ---- Subroutines ----
  a.label('next_level');
  a.inc(V_LEVEL);
  a.cmpImm(V_LEVEL, 5);
  a.br(COND.ULT, 'nl_ok');
  a.movImm(V_LEVEL, 0);
  a.label('nl_ok');
  a.call('load_level');
  a.call('play_reset_sfx');
  a.call('render_all');
  a.ret();

  a.label('load_level');
  a.movImm(V_MOVES, 0);
  a.movImm(V_WIN_FLAG, 0);
  // RR2 = level_data + level * 25
  a.movMem(6, V_LEVEL);
  a.movRImm(7, 25);
  a.mul(6);
  a.movwLabel(2, 'level_data');
  a.addwRR(2, 6);
  a.movwImm(8, V_BOARD);
  a.movRImm(12, 25);
  a.label('ll_copy');
  a.ldInd(0, 2, true);
  a.stInd(0, 8, true);
  a.dbnz(12, 'll_copy');
  a.ret();

  // toggle_at_r4_r5: toggles (R4, R5) + 4 orthogonal neighbors
  a.label('toggle_at_r4_r5');
  a.push(4);
  a.push(5);
  a.call('flip_cell'); // center
  a.pop(5);
  a.pop(4);

  // left
  a.cmpRImm(4, 0);
  a.br(COND.EQ, 'tg_right');
  a.push(4);
  a.push(5);
  a.dec(4);
  a.call('flip_cell');
  a.pop(5);
  a.pop(4);

  a.label('tg_right');
  a.cmpRImm(4, 4);
  a.br(COND.EQ, 'tg_up');
  a.push(4);
  a.push(5);
  a.inc(4);
  a.call('flip_cell');
  a.pop(5);
  a.pop(4);

  a.label('tg_up');
  a.cmpRImm(5, 0);
  a.br(COND.EQ, 'tg_down');
  a.push(4);
  a.push(5);
  a.dec(5);
  a.call('flip_cell');
  a.pop(5);
  a.pop(4);

  a.label('tg_down');
  a.cmpRImm(5, 4);
  a.br(COND.EQ, 'tg_done');
  a.push(4);
  a.push(5);
  a.inc(5);
  a.call('flip_cell');
  a.pop(5);
  a.pop(4);

  a.label('tg_done');
  a.cmpImm(V_MOVES, 99);
  a.br(COND.EQ, 'tg_no_inc');
  a.inc(V_MOVES);
  a.label('tg_no_inc');
  a.call('play_toggle_sfx');
  a.call('check_win');
  a.call('render_all');
  a.ret();

  // flip_cell(R4=x, R5=y): board[y*5+x] ^= 1
  a.label('flip_cell');
  a.movRR(6, 5);
  a.movRImm(7, 5);
  a.mul(6); // RR6 = y * 5 (lo in R7)
  a.addMem(7, 4); // R7 = y*5 + x
  a.movRImm(6, 0);
  a.movwImm(2, V_BOARD);
  a.addwRR(2, 6);
  a.ldInd(0, 2, false);
  a.xorImm(0, 1);
  a.stInd(0, 2, false);
  a.ret();

  a.label('check_win');
  a.movwImm(2, V_BOARD);
  a.movRImm(12, 25);
  a.label('cw_loop');
  a.ldInd(0, 2, true);
  a.cmpRImm(0, 0);
  a.br(COND.NE, 'cw_not_yet');
  a.dbnz(12, 'cw_loop');
  a.movImm(V_WIN_FLAG, 1);
  a.call('play_win_sfx');
  a.label('cw_not_yet');
  a.ret();

  // Audio routines
  a.label('play_move_blip');
  a.movImm(REG_SG0L, 0x90);
  a.movImm(REG_SG0H, 0x00);
  a.movImm(REG_SG0V, 0x0a);
  a.movImm(V_SFX_TIMER, 3);
  a.ret();

  a.label('play_toggle_sfx');
  a.movImm(REG_SG0L, 0x35);
  a.movImm(REG_SG0H, 0x01);
  a.movImm(REG_SG0V, 0x16);
  a.movImm(V_SFX_TIMER, 6);
  a.ret();

  a.label('play_reset_sfx');
  a.movImm(REG_SG1L, 0x00);
  a.movImm(REG_SG1H, 0x02);
  a.movImm(REG_SG1V, 0x14);
  a.movImm(V_SFX_TIMER, 9);
  a.ret();

  a.label('play_win_sfx');
  a.movImm(REG_SG0L, 0xc8);
  a.movImm(REG_SG0H, 0x00);
  a.movImm(REG_SG0V, 0x1c);
  a.movImm(REG_SG1L, 0x96);
  a.movImm(REG_SG1H, 0x00);
  a.movImm(REG_SG1V, 0x18);
  a.movImm(V_SFX_TIMER, 28);
  a.ret();

  // Rendering
  a.label('render_all');
  // Clear screen shade 0
  a.fillRect(0, 0, 200, 160, 0);
  // Top header bar (shade 1) + bottom divider
  a.fillRect(0, 0, 200, 18, 1);
  a.fillRect(0, 18, 200, 1, 3);

  // Title "LIGHTS OUT"
  a.movwLabel(2, 'str_title');
  a.movRImm(4, 6);
  a.movRImm(5, 6);
  a.call('draw_text');

  // "LV:" + (level+1)
  a.movwLabel(2, 'str_lv');
  a.movRImm(4, 114);
  a.movRImm(5, 6);
  a.call('draw_text');
  a.movMem(0, V_LEVEL);
  a.inc(0);
  a.movRImm(4, 129);
  a.movRImm(5, 6);
  a.call('draw_digit');

  // "MV:" + 2-digit moves
  a.movwLabel(2, 'str_mv');
  a.movRImm(4, 148);
  a.movRImm(5, 6);
  a.call('draw_text');
  a.movMem(0, V_MOVES);
  a.movRImm(4, 164);
  a.movRImm(5, 6);
  a.call('draw_2digits');

  // Footer text
  a.cmpImm(V_WIN_FLAG, 1);
  a.br(COND.EQ, 'ra_win_msg');
  a.movwLabel(2, 'str_hint');
  a.movRImm(4, 22);
  a.movRImm(5, 148);
  a.call('draw_text');
  a.br(COND.T, 'ra_draw_grid');

  a.label('ra_win_msg');
  a.fillRect(28, 144, 144, 14, 2);
  a.movwLabel(2, 'str_win');
  a.movRImm(4, 34);
  a.movRImm(5, 148);
  a.call('draw_text');

  a.label('ra_draw_grid');
  a.call('render_board');
  a.ret();

  a.label('render_board');
  // Outer board frame at (41, 28) size 118 x 118
  a.fillRect(41, 28, 118, 118, 1);
  a.fillRect(43, 30, 114, 114, 0);

  a.movRImm(5, 0); // row = 0..4
  a.label('rb_row');
  a.movRImm(4, 0); // col = 0..4
  a.label('rb_col');

  // Compute pixel x = 45 + col * 22 -> R12
  a.movRR(6, 4);
  a.movRImm(7, 22);
  a.mul(6);
  a.addRImm(7, 45);
  a.movRR(12, 7); // R12 = px

  // Compute pixel y = 32 + row * 22 -> R13
  a.movRR(6, 5);
  a.movRImm(7, 22);
  a.mul(6);
  a.addRImm(7, 32);
  a.movRR(13, 7); // R13 = py

  // Check if cursor is on (col, row)
  a.cmpMem(4, V_CUR_X);
  a.br(COND.NE, 'rb_no_cur');
  a.cmpMem(5, V_CUR_Y);
  a.br(COND.NE, 'rb_no_cur');
  // Draw cursor border (22x22 shade 3, inner 20x20 cleared)
  a.movImm(REG_DM_SRC_L, 3);
  a.movMem(REG_DM_DST_X, 12);
  a.dec(REG_DM_DST_X);
  a.movMem(REG_DM_DST_Y, 13);
  a.dec(REG_DM_DST_Y);
  a.movImm(REG_DM_W, 22);
  a.movImm(REG_DM_H, 22);
  a.movImm(REG_DM_CTRL, 0x08);
  a.br(COND.T, 'rb_tile_body');

  a.label('rb_no_cur');
  // Clear 22x22 border around tile so moving cursor erases cleanly
  a.movImm(REG_DM_SRC_L, 0);
  a.movMem(REG_DM_DST_X, 12);
  a.dec(REG_DM_DST_X);
  a.movMem(REG_DM_DST_Y, 13);
  a.dec(REG_DM_DST_Y);
  a.movImm(REG_DM_W, 22);
  a.movImm(REG_DM_H, 22);
  a.movImm(REG_DM_CTRL, 0x08);

  a.label('rb_tile_body');
  // Read board[row*5 + col]
  a.movRR(6, 5);
  a.movRImm(7, 5);
  a.mul(6);
  a.addMem(7, 4);
  a.movRImm(6, 0);
  a.movwImm(2, V_BOARD);
  a.addwRR(2, 6);
  a.ldInd(0, 2, false);
  a.cmpRImm(0, 1);
  a.br(COND.EQ, 'rb_lit');

  // Unlit tile: soft border shade 1, inner shade 0
  a.movImm(REG_DM_SRC_L, 1);
  a.movMem(REG_DM_DST_X, 12);
  a.movMem(REG_DM_DST_Y, 13);
  a.movImm(REG_DM_W, 20);
  a.movImm(REG_DM_H, 20);
  a.movImm(REG_DM_CTRL, 0x08);

  a.movImm(REG_DM_SRC_L, 0);
  a.movMem(REG_DM_DST_X, 12);
  a.inc(REG_DM_DST_X);
  a.movMem(REG_DM_DST_Y, 13);
  a.inc(REG_DM_DST_Y);
  a.movImm(REG_DM_W, 18);
  a.movImm(REG_DM_H, 18);
  a.movImm(REG_DM_CTRL, 0x08);
  a.br(COND.T, 'rb_next_col');

  a.label('rb_lit');
  // Lit tile: dark shade 3 body + bright shade 1 inner bulb core
  a.movImm(REG_DM_SRC_L, 3);
  a.movMem(REG_DM_DST_X, 12);
  a.movMem(REG_DM_DST_Y, 13);
  a.movImm(REG_DM_W, 20);
  a.movImm(REG_DM_H, 20);
  a.movImm(REG_DM_CTRL, 0x08);

  a.movImm(REG_DM_SRC_L, 2);
  a.movMem(REG_DM_DST_X, 12);
  a.addImm(REG_DM_DST_X, 4);
  a.movMem(REG_DM_DST_Y, 13);
  a.addImm(REG_DM_DST_Y, 4);
  a.movImm(REG_DM_W, 12);
  a.movImm(REG_DM_H, 12);
  a.movImm(REG_DM_CTRL, 0x08);

  a.label('rb_next_col');
  a.inc(4);
  a.cmpRImm(4, 5);
  a.br(COND.EQ, 'rb_col_done');
  a.jmp('rb_col');
  a.label('rb_col_done');

  a.inc(5);
  a.cmpRImm(5, 5);
  a.br(COND.EQ, 'rb_row_done');
  a.jmp('rb_row');
  a.label('rb_row_done');
  a.ret();

  emitFontHelper(a, 'font_2bpp');
  emitFontData(a, 'font_2bpp');

  a.label('str_title'); a.asciiZ('LIGHTS OUT');
  a.label('str_lv'); a.asciiZ('LV:');
  a.label('str_mv'); a.asciiZ('MV:');
  a.label('str_hint'); a.asciiZ('TAP TILE OR DPAD-A  B:RST C:NXT');
  a.label('str_win'); a.asciiZ('CLEARED! TAP OR A FOR NEXT');

  // 5 Solvable Lights Out Levels (5x5)
  a.label('level_data');
  // Level 1: Single center cross (1 tap at center solves!)
  a.db(
    0, 0, 0, 0, 0,
    0, 0, 1, 0, 0,
    0, 1, 1, 1, 0,
    0, 0, 1, 0, 0,
    0, 0, 0, 0, 0
  );
  // Level 2: Corners
  a.db(
    1, 1, 0, 1, 1,
    1, 0, 0, 0, 1,
    0, 0, 0, 0, 0,
    1, 0, 0, 0, 1,
    1, 1, 0, 1, 1
  );
  // Level 3: Classic row
  a.db(
    0, 0, 0, 0, 0,
    0, 1, 0, 1, 0,
    1, 1, 1, 1, 1,
    0, 1, 0, 1, 0,
    0, 0, 0, 0, 0
  );
  // Level 4: Checker
  a.db(
    1, 0, 1, 0, 1,
    0, 1, 0, 1, 0,
    1, 0, 1, 0, 1,
    0, 1, 0, 1, 0,
    1, 0, 1, 0, 1
  );
  // Level 5: Diamond
  a.db(
    0, 0, 1, 0, 0,
    0, 1, 0, 1, 0,
    1, 0, 0, 0, 1,
    0, 1, 0, 1, 0,
    0, 0, 1, 0, 0
  );

  const bytes = a.build(8192);
  return {
    bytes,
    info: parseTgcRom(
      bytes,
      'lights_out.tgc',
      true,
      'Classic 5x5 grid puzzle inspired by the 1997 Game.com pack-in. Supports Touchscreen Stylus taps and D-Pad.'
    ),
  };
}

// ============================================================================
// 2. CYBER PADDLE (TGC) — Handheld Brick Breaker Arcade
// ============================================================================
function buildCyberPaddleRom(): BuiltInRomEntry {
  const a = new SM8521Asm('CYBER PADDLE', '71-502');

  const V_PAD_X = 0x80;
  const V_BALL_X = 0x81;
  const V_BALL_Y = 0x82;
  const V_BALL_DX = 0x83; // signed byte (-2..2) stored as unsigned; bit 7 = negative
  const V_BALL_DY = 0x84;
  const V_LAUNCHED = 0x85;
  const V_SCORE = 0x86;
  const V_LIVES = 0x87;
  const V_SFX = 0x88;
  const V_PREV_PAD_X = 0x89;
  const V_PREV_BALL_X = 0x8a;
  const V_PREV_BALL_Y = 0x8b;
  const V_BRICKS = 0xa0; // 30 bytes (3 rows x 10 cols)

  a.di();
  a.movImm(REG_SPH, 0x03);
  a.movImm(REG_SPL, 0xff);
  a.movImm(REG_MMU0, 32);
  a.movImm(REG_MMU1, 32);
  a.movImm(REG_LCC, 0x80);
  a.movImm(REG_SGC, 0x80);
  a.movImm(REG_IE0, INT_VBLANK);
  a.movImm(REG_IR0, 0x00);

  a.call('init_game');

  a.label('cp_loop');
  a.label('cp_wait_vb');
  a.btst(REG_IR0, 0);
  a.br(COND.Z, 'cp_wait_vb');
  a.bclr(REG_IR0, 0);

  // Audio decay
  a.cmpImm(V_SFX, 0);
  a.br(COND.EQ, 'cp_sfx_ok');
  a.dec(V_SFX);
  a.cmpImm(V_SFX, 0);
  a.br(COND.NE, 'cp_sfx_ok');
  a.movImm(REG_SG0V, 0);
  a.movImm(REG_SG2V, 0);
  a.label('cp_sfx_ok');

  // Check if Game Over (lives == 0)
  a.cmpImm(V_LIVES, 0);
  a.br(COND.NE, 'cp_active');
  a.btst(REG_P1, 0);
  a.br(COND.Z, 'cp_restart');
  a.btst(REG_P1, 7);
  a.br(COND.NZ, 'cp_loop');
  a.label('cp_restart');
  a.call('init_game');
  a.jmp('cp_loop');

  a.label('cp_active');
  a.movMem(V_PREV_PAD_X, V_PAD_X);
  a.movMem(V_PREV_BALL_X, V_BALL_X);
  a.movMem(V_PREV_BALL_Y, V_BALL_Y);

  // Paddle movement: D-pad Left (P0 bit 2) / Right (P0 bit 3)
  a.btst(REG_P0, 2);
  a.br(COND.NZ, 'cp_chk_right');
  a.cmpImm(V_PAD_X, 6);
  a.br(COND.ULT, 'cp_chk_right');
  a.subImm(V_PAD_X, 3);

  a.label('cp_chk_right');
  a.btst(REG_P0, 3);
  a.br(COND.NZ, 'cp_chk_touch');
  a.cmpImm(V_PAD_X, 162);
  a.br(COND.UGE, 'cp_chk_touch');
  a.addImm(V_PAD_X, 3);

  // Touchscreen drag sets paddle X directly!
  a.label('cp_chk_touch');
  a.btst(REG_P1, 7);
  a.br(COND.NZ, 'cp_chk_launch');
  a.movMem(0, REG_P2);
  a.cmpRImm(0, 18);
  a.br(COND.UGE, 'cp_tx_min_ok');
  a.movRImm(0, 18);
  a.label('cp_tx_min_ok');
  a.cmpRImm(0, 180);
  a.br(COND.ULT, 'cp_tx_max_ok');
  a.movRImm(0, 180);
  a.label('cp_tx_max_ok');
  a.subImm(0, 16);
  a.movMem(V_PAD_X, 0);
  a.movImm(V_LAUNCHED, 1);

  a.label('cp_chk_launch');
  a.cmpImm(V_LAUNCHED, 1);
  a.br(COND.EQ, 'cp_move_ball');
  // Follow paddle before launch
  a.movMem(0, V_PAD_X);
  a.addRImm(0, 14);
  a.movMem(V_BALL_X, 0);
  a.movImm(V_BALL_Y, 141);
  a.btst(REG_P1, 0); // A button launches
  a.jcc(COND.NZ, 'cp_draw_frame');
  a.movImm(V_LAUNCHED, 1);
  a.jmp('cp_draw_frame');

  a.label('cp_move_ball');
  // X += DX
  a.movMem(0, V_BALL_X);
  a.addMem(0, V_BALL_DX);
  // Wall collisions X
  a.cmpRImm(0, 4);
  a.br(COND.UGE, 'cp_wall_r');
  a.movRImm(0, 4);
  a.movImm(V_BALL_DX, 2);
  a.call('sfx_wall');
  a.label('cp_wall_r');
  a.cmpRImm(0, 192);
  a.br(COND.ULT, 'cp_save_bx');
  a.movRImm(0, 192);
  a.movImm(V_BALL_DX, 0xfe); // -2
  a.call('sfx_wall');
  a.label('cp_save_bx');
  a.movMem(V_BALL_X, 0);

  // Y += DY
  a.movMem(1, V_BALL_Y);
  a.addMem(1, V_BALL_DY);
  // Top wall Y <= 20
  a.cmpRImm(1, 20);
  a.br(COND.UGE, 'cp_chk_paddle');
  a.movRImm(1, 20);
  a.movImm(V_BALL_DY, 2);
  a.call('sfx_wall');
  a.jmp('cp_save_by');

  // Paddle collision: Y >= 142 && Y <= 149 && X+4 >= PAD_X && X <= PAD_X + 32
  a.label('cp_chk_paddle');
  a.cmpRImm(1, 142);
  a.br(COND.ULT, 'cp_chk_bricks');
  a.cmpRImm(1, 150);
  a.br(COND.UGE, 'cp_chk_miss');
  a.movMem(2, V_PAD_X);
  a.movRR(3, 0);
  a.addRImm(3, 4);
  a.cmpMem(3, 2);
  a.br(COND.ULT, 'cp_chk_bricks');
  a.addRImm(2, 32);
  a.cmpMem(0, 2);
  a.br(COND.UGE, 'cp_chk_bricks');
  // Bounce off paddle!
  a.movRImm(1, 141);
  a.movImm(V_BALL_DY, 0xfe); // -2
  a.call('sfx_paddle');
  a.jmp('cp_save_by');

  // Missed ball at bottom Y >= 156
  a.label('cp_chk_miss');
  a.cmpRImm(1, 156);
  a.br(COND.ULT, 'cp_chk_bricks');
  a.dec(V_LIVES);
  a.movImm(V_LAUNCHED, 0);
  a.call('sfx_miss');
  a.call('draw_hud');
  a.cmpImm(V_LIVES, 0);
  a.jcc(COND.NE, 'cp_save_by');
  a.call('draw_game_over');
  a.jmp('cp_loop');

  // Brick collision check: Y in [26..56]
  a.label('cp_chk_bricks');
  a.cmpRImm(1, 26);
  a.jcc(COND.ULT, 'cp_save_by');
  a.cmpRImm(1, 56);
  a.jcc(COND.UGE, 'cp_save_by');
  // row = (Y - 26) / 10 -> 0..2
  a.movRR(4, 1);
  a.subImm(4, 26);
  a.movRImm(5, 0);
  a.label('cp_bdiv_y');
  a.cmpRImm(4, 10);
  a.br(COND.ULT, 'cp_bdiv_y_ok');
  a.subImm(4, 10);
  a.inc(5);
  a.br(COND.T, 'cp_bdiv_y');
  a.label('cp_bdiv_y_ok');
  a.cmpRImm(5, 3);
  a.jcc(COND.UGE, 'cp_save_by');

  // col = (X - 5) / 19 -> 0..9
  a.cmpRImm(0, 5);
  a.jcc(COND.ULT, 'cp_save_by');
  a.movRR(4, 0);
  a.subImm(4, 5);
  a.movRImm(6, 0);
  a.label('cp_bdiv_x');
  a.cmpRImm(4, 19);
  a.br(COND.ULT, 'cp_bdiv_x_ok');
  a.subImm(4, 19);
  a.inc(6);
  a.br(COND.T, 'cp_bdiv_x');
  a.label('cp_bdiv_x_ok');
  a.cmpRImm(6, 10);
  a.jcc(COND.UGE, 'cp_save_by');

  // Index = row * 10 + col
  a.movRR(8, 5);
  a.movRImm(9, 10);
  a.mul(8); // RR8 -> R9 = row*10
  a.addMem(9, 6);
  a.movRImm(8, 0);
  a.movwImm(2, V_BRICKS);
  a.addwRR(2, 8);
  a.ldInd(3, 2, false);
  a.cmpRImm(3, 0);
  a.jcc(COND.EQ, 'cp_save_by');
  // Brick hit!
  a.movRImm(3, 0);
  a.stInd(3, 2, false);
  // Erase brick visually: x = 5 + col*19, y = 26 + row*10
  a.movRR(8, 6);
  a.movRImm(9, 19);
  a.mul(8);
  a.addRImm(9, 5);
  a.movMem(REG_DM_DST_X, 9);
  a.movRR(8, 5);
  a.movRImm(9, 10);
  a.mul(8);
  a.addRImm(9, 26);
  a.movMem(REG_DM_DST_Y, 9);
  a.movImm(REG_DM_SRC_L, 0);
  a.movImm(REG_DM_W, 17);
  a.movImm(REG_DM_H, 8);
  a.movImm(REG_DM_CTRL, 0x08);

  // Flip DY and increment score
  a.movImm(0, 0);
  a.subMem(0, V_BALL_DY);
  a.movMem(V_BALL_DY, 0);
  a.cmpImm(V_SCORE, 99);
  a.br(COND.EQ, 'cp_sc_cap');
  a.inc(V_SCORE);
  a.label('cp_sc_cap');
  a.call('sfx_brick');
  a.call('draw_hud');

  // Reload X/Y into R0/R1
  a.movMem(0, V_BALL_X);
  a.br(COND.T, 'cp_save_by');

  a.label('cp_save_by');
  a.movMem(V_BALL_Y, 1);

  a.label('cp_draw_frame');
  // Erase old ball
  a.movImm(REG_DM_SRC_L, 0);
  a.movMem(REG_DM_DST_X, V_PREV_BALL_X);
  a.movMem(REG_DM_DST_Y, V_PREV_BALL_Y);
  a.movImm(REG_DM_W, 4);
  a.movImm(REG_DM_H, 4);
  a.movImm(REG_DM_CTRL, 0x08);

  // Erase old paddle
  a.movImm(REG_DM_SRC_L, 0);
  a.movMem(REG_DM_DST_X, V_PREV_PAD_X);
  a.movImm(REG_DM_DST_Y, 146);
  a.movImm(REG_DM_W, 32);
  a.movImm(REG_DM_H, 5);
  a.movImm(REG_DM_CTRL, 0x08);

  // Draw new ball
  a.movImm(REG_DM_SRC_L, 3);
  a.movMem(REG_DM_DST_X, V_BALL_X);
  a.movMem(REG_DM_DST_Y, V_BALL_Y);
  a.movImm(REG_DM_W, 4);
  a.movImm(REG_DM_H, 4);
  a.movImm(REG_DM_CTRL, 0x08);

  // Draw new paddle
  a.movImm(REG_DM_SRC_L, 3);
  a.movMem(REG_DM_DST_X, V_PAD_X);
  a.movImm(REG_DM_DST_Y, 146);
  a.movImm(REG_DM_W, 32);
  a.movImm(REG_DM_H, 5);
  a.movImm(REG_DM_CTRL, 0x08);

  a.jmp('cp_loop');

  // ---- Init & Draw Helpers ----
  a.label('init_game');
  a.movImm(V_PAD_X, 84);
  a.movImm(V_PREV_PAD_X, 84);
  a.movImm(V_BALL_X, 98);
  a.movImm(V_BALL_Y, 141);
  a.movImm(V_PREV_BALL_X, 98);
  a.movImm(V_PREV_BALL_Y, 141);
  a.movImm(V_BALL_DX, 2);
  a.movImm(V_BALL_DY, 0xfe);
  a.movImm(V_LAUNCHED, 0);
  a.movImm(V_SCORE, 0);
  a.movImm(V_LIVES, 3);
  a.movImm(V_SFX, 0);

  // Fill 30 bricks
  a.movwImm(2, V_BRICKS);
  a.movRImm(12, 30);
  a.movRImm(0, 1);
  a.label('ig_bricks');
  a.stInd(0, 2, true);
  a.dbnz(12, 'ig_bricks');

  // Clear full screen & draw border + bricks + HUD
  a.fillRect(0, 0, 200, 160, 0);
  a.fillRect(0, 18, 200, 1, 3);
  a.fillRect(0, 19, 3, 141, 2);
  a.fillRect(197, 19, 3, 141, 2);
  a.call('draw_hud');
  a.call('draw_all_bricks');
  a.ret();

  a.label('draw_hud');
  a.fillRect(0, 0, 200, 18, 1);
  a.movwLabel(2, 'str_cp_title');
  a.movRImm(4, 6);
  a.movRImm(5, 6);
  a.call('draw_text');

  a.movwLabel(2, 'str_cp_sc');
  a.movRImm(4, 110);
  a.movRImm(5, 6);
  a.call('draw_text');
  a.movMem(0, V_SCORE);
  a.movRImm(4, 126);
  a.movRImm(5, 6);
  a.call('draw_2digits');

  a.movwLabel(2, 'str_cp_lv');
  a.movRImm(4, 158);
  a.movRImm(5, 6);
  a.call('draw_text');
  a.movMem(0, V_LIVES);
  a.movRImm(4, 174);
  a.movRImm(5, 6);
  a.call('draw_digit');
  a.ret();

  a.label('draw_all_bricks');
  a.movRImm(5, 0);
  a.label('dab_row');
  a.movRImm(4, 0);
  a.label('dab_col');
  a.movRR(8, 4);
  a.movRImm(9, 19);
  a.mul(8);
  a.addRImm(9, 5);
  a.movMem(REG_DM_DST_X, 9);
  a.movRR(8, 5);
  a.movRImm(9, 10);
  a.mul(8);
  a.addRImm(9, 26);
  a.movMem(REG_DM_DST_Y, 9);
  // Shade = 3 - row
  a.movRImm(0, 3);
  a.subMem(0, 5);
  a.movMem(REG_DM_SRC_L, 0);
  a.movImm(REG_DM_W, 17);
  a.movImm(REG_DM_H, 8);
  a.movImm(REG_DM_CTRL, 0x08);
  a.inc(4);
  a.cmpRImm(4, 10);
  a.br(COND.NE, 'dab_col');
  a.inc(5);
  a.cmpRImm(5, 3);
  a.br(COND.NE, 'dab_row');
  a.ret();

  a.label('draw_game_over');
  a.fillRect(42, 76, 116, 22, 2);
  a.movwLabel(2, 'str_cp_go');
  a.movRImm(4, 52);
  a.movRImm(5, 84);
  a.call('draw_text');
  a.ret();

  // SFX
  a.label('sfx_wall');
  a.movImm(REG_SG0L, 0xf0);
  a.movImm(REG_SG0H, 0x01);
  a.movImm(REG_SG0V, 0x10);
  a.movImm(V_SFX, 3);
  a.ret();

  a.label('sfx_paddle');
  a.movImm(REG_SG0L, 0x00);
  a.movImm(REG_SG0H, 0x01);
  a.movImm(REG_SG0V, 0x16);
  a.movImm(V_SFX, 5);
  a.ret();

  a.label('sfx_brick');
  a.movImm(REG_SG0L, 0x90);
  a.movImm(REG_SG0H, 0x00);
  a.movImm(REG_SG0V, 0x1a);
  a.movImm(V_SFX, 6);
  a.ret();

  a.label('sfx_miss');
  a.movImm(REG_SG2C, 0x50);
  a.movImm(REG_SG2V, 0x1c);
  a.movImm(V_SFX, 14);
  a.ret();

  emitFontHelper(a, 'font_2bpp');
  emitFontData(a, 'font_2bpp');

  a.label('str_cp_title'); a.asciiZ('CYBER PADDLE');
  a.label('str_cp_sc'); a.asciiZ('SC:');
  a.label('str_cp_lv'); a.asciiZ('HP:');
  a.label('str_cp_go'); a.asciiZ('GAME OVER - PRESS A');

  const bytes = a.build(8192);
  return {
    bytes,
    info: parseTgcRom(
      bytes,
      'cyber_paddle.tgc',
      true,
      '60fps arcade brick-breaker using SM8521 hardware blitter, D-Pad or Touchscreen paddle control, and sound synthesis.'
    ),
  };
}

// ============================================================================
// 3. STAR PATROL (TGC) — Handheld Space Shooter
// ============================================================================
function buildStarPatrolRom(): BuiltInRomEntry {
  const a = new SM8521Asm('STAR PATROL', '71-503');

  const V_SHIP_X = 0x80;
  const V_PREV_SHIP_X = 0x81;
  const V_BULLET_X = 0x82;
  const V_BULLET_Y = 0x83;
  const V_BULLET_ON = 0x84;
  const V_PREV_BX = 0x85;
  const V_PREV_BY = 0x86;
  const V_ENEMY_X = 0x87;
  const V_ENEMY_Y = 0x88;
  const V_PREV_EX = 0x89;
  const V_PREV_EY = 0x8a;
  const V_ENEMY_DX = 0x8b;
  const V_SCORE = 0x8c;
  const V_HP = 0x8d;
  const V_SFX = 0x8e;
  const V_TICK = 0x8f;
  const V_STAR_Y = 0x90;

  a.di();
  a.movImm(REG_SPH, 0x03);
  a.movImm(REG_SPL, 0xff);
  a.movImm(REG_MMU0, 32);
  a.movImm(REG_MMU1, 32);
  a.movImm(REG_LCC, 0x80);
  a.movImm(REG_SGC, 0x80);
  a.movImm(REG_IE0, INT_VBLANK);
  a.movImm(REG_IR0, 0x00);

  a.call('sp_init');

  a.label('sp_loop');
  a.label('sp_wait_vb');
  a.btst(REG_IR0, 0);
  a.br(COND.Z, 'sp_wait_vb');
  a.bclr(REG_IR0, 0);

  a.inc(V_TICK);
  a.cmpImm(V_SFX, 0);
  a.br(COND.EQ, 'sp_sfx_done');
  a.dec(V_SFX);
  a.cmpImm(V_SFX, 0);
  a.br(COND.NE, 'sp_sfx_done');
  a.movImm(REG_SG0V, 0);
  a.movImm(REG_SG2V, 0);
  a.label('sp_sfx_done');

  // Game Over check
  a.cmpImm(V_HP, 0);
  a.br(COND.NE, 'sp_active');
  a.btst(REG_P1, 0);
  a.br(COND.Z, 'sp_do_reset');
  a.btst(REG_P1, 7);
  a.br(COND.NZ, 'sp_loop');
  a.label('sp_do_reset');
  a.call('sp_init');
  a.jmp('sp_loop');

  a.label('sp_active');
  a.movMem(V_PREV_SHIP_X, V_SHIP_X);
  a.movMem(V_PREV_BX, V_BULLET_X);
  a.movMem(V_PREV_BY, V_BULLET_Y);
  a.movMem(V_PREV_EX, V_ENEMY_X);
  a.movMem(V_PREV_EY, V_ENEMY_Y);

  // Move starfield dot
  a.fillRect(36, 40, 2, 2, 0);
  a.fillRect(150, 80, 2, 2, 0);
  a.movMem(0, V_STAR_Y);
  a.addRImm(0, 2);
  a.cmpRImm(0, 156);
  a.br(COND.ULT, 'sp_star_ok');
  a.movRImm(0, 22);
  a.label('sp_star_ok');
  a.movMem(V_STAR_Y, 0);

  // Ship D-pad left/right
  a.btst(REG_P0, 2);
  a.br(COND.NZ, 'sp_chk_right');
  a.cmpImm(V_SHIP_X, 8);
  a.br(COND.ULT, 'sp_chk_right');
  a.subImm(V_SHIP_X, 3);
  a.label('sp_chk_right');
  a.btst(REG_P0, 3);
  a.br(COND.NZ, 'sp_chk_touch');
  a.cmpImm(V_SHIP_X, 180);
  a.br(COND.UGE, 'sp_chk_touch');
  a.addImm(V_SHIP_X, 3);

  // Touch X moves ship + fires
  a.label('sp_chk_touch');
  a.btst(REG_P1, 7);
  a.br(COND.NZ, 'sp_chk_fire');
  a.movMem(0, REG_P2);
  a.cmpRImm(0, 12);
  a.br(COND.UGE, 'sp_tx1');
  a.movRImm(0, 12);
  a.label('sp_tx1');
  a.cmpRImm(0, 184);
  a.br(COND.ULT, 'sp_tx2');
  a.movRImm(0, 184);
  a.label('sp_tx2');
  a.subImm(0, 6);
  a.movMem(V_SHIP_X, 0);
  a.br(COND.T, 'sp_try_fire');

  a.label('sp_chk_fire');
  a.btst(REG_P1, 0);
  a.br(COND.NZ, 'sp_move_bullet');
  a.label('sp_try_fire');
  a.cmpImm(V_BULLET_ON, 1);
  a.br(COND.EQ, 'sp_move_bullet');
  a.movImm(V_BULLET_ON, 1);
  a.movMem(0, V_SHIP_X);
  a.addRImm(0, 5);
  a.movMem(V_BULLET_X, 0);
  a.movImm(V_BULLET_Y, 134);
  a.call('sp_sfx_laser');

  a.label('sp_move_bullet');
  a.cmpImm(V_BULLET_ON, 1);
  a.br(COND.NE, 'sp_move_enemy');
  a.subImm(V_BULLET_Y, 5);
  a.cmpImm(V_BULLET_Y, 22);
  a.br(COND.UGE, 'sp_move_enemy');
  a.movImm(V_BULLET_ON, 0);

  a.label('sp_move_enemy');
  // Move enemy X by DX and Y down every 2 ticks
  a.movMem(0, V_ENEMY_X);
  a.addMem(0, V_ENEMY_DX);
  a.cmpRImm(0, 10);
  a.br(COND.UGE, 'sp_ex_max');
  a.movRImm(0, 10);
  a.movImm(V_ENEMY_DX, 2);
  a.label('sp_ex_max');
  a.cmpRImm(0, 178);
  a.br(COND.ULT, 'sp_ex_ok');
  a.movRImm(0, 178);
  a.movImm(V_ENEMY_DX, 0xfe);
  a.label('sp_ex_ok');
  a.movMem(V_ENEMY_X, 0);

  a.btst(V_TICK, 0);
  a.br(COND.Z, 'sp_chk_hit');
  a.inc(V_ENEMY_Y);

  // Check bullet-enemy collision
  a.label('sp_chk_hit');
  a.cmpImm(V_BULLET_ON, 1);
  a.jcc(COND.NE, 'sp_chk_breach');
  a.movMem(0, V_BULLET_X);
  a.movMem(1, V_ENEMY_X);
  a.addRImm(0, 3);
  a.cmpMem(0, 1);
  a.jcc(COND.ULT, 'sp_chk_breach');
  a.addRImm(1, 12);
  a.movMem(0, V_BULLET_X);
  a.cmpMem(0, 1);
  a.jcc(COND.UGE, 'sp_chk_breach');
  a.movMem(0, V_BULLET_Y);
  a.movMem(1, V_ENEMY_Y);
  a.addRImm(1, 10);
  a.cmpMem(0, 1);
  a.jcc(COND.UGE, 'sp_chk_breach');

  // Hit!
  a.movImm(V_BULLET_ON, 0);
  a.cmpImm(V_SCORE, 99);
  a.br(COND.EQ, 'sp_sc_cap');
  a.inc(V_SCORE);
  a.label('sp_sc_cap');
  a.call('sp_sfx_boom');
  a.call('sp_respawn_enemy');
  a.call('sp_draw_hud');

  a.label('sp_chk_breach');
  a.cmpImm(V_ENEMY_Y, 134);
  a.br(COND.ULT, 'sp_draw');
  a.dec(V_HP);
  a.call('sp_sfx_boom');
  a.call('sp_respawn_enemy');
  a.call('sp_draw_hud');
  a.cmpImm(V_HP, 0);
  a.br(COND.NE, 'sp_draw');
  a.fillRect(42, 76, 116, 22, 2);
  a.movwLabel(2, 'str_sp_go');
  a.movRImm(4, 52);
  a.movRImm(5, 84);
  a.call('draw_text');
  a.jmp('sp_loop');

  a.label('sp_draw');
  // Erase previous bullet, enemy, ship
  a.movImm(REG_DM_SRC_L, 0);
  a.movMem(REG_DM_DST_X, V_PREV_BX);
  a.movMem(REG_DM_DST_Y, V_PREV_BY);
  a.movImm(REG_DM_W, 3);
  a.movImm(REG_DM_H, 6);
  a.movImm(REG_DM_CTRL, 0x08);

  a.movImm(REG_DM_SRC_L, 0);
  a.movMem(REG_DM_DST_X, V_PREV_EX);
  a.movMem(REG_DM_DST_Y, V_PREV_EY);
  a.movImm(REG_DM_W, 12);
  a.movImm(REG_DM_H, 8);
  a.movImm(REG_DM_CTRL, 0x08);

  a.movImm(REG_DM_SRC_L, 0);
  a.movMem(REG_DM_DST_X, V_PREV_SHIP_X);
  a.movImm(REG_DM_DST_Y, 140);
  a.movImm(REG_DM_W, 12);
  a.movImm(REG_DM_H, 10);
  a.movImm(REG_DM_CTRL, 0x08);

  // Draw bullet if active
  a.cmpImm(V_BULLET_ON, 1);
  a.br(COND.NE, 'sp_draw_enemy');
  a.movImm(REG_DM_SRC_L, 3);
  a.movMem(REG_DM_DST_X, V_BULLET_X);
  a.movMem(REG_DM_DST_Y, V_BULLET_Y);
  a.movImm(REG_DM_W, 3);
  a.movImm(REG_DM_H, 6);
  a.movImm(REG_DM_CTRL, 0x08);

  a.label('sp_draw_enemy');
  a.movwLabel(8, 'sprite_enemy');
  a.movMem(REG_DM_SRC_L, 9);
  a.movMem(REG_DM_SRC_H, 8);
  a.movMem(REG_DM_DST_X, V_ENEMY_X);
  a.movMem(REG_DM_DST_Y, V_ENEMY_Y);
  a.movImm(REG_DM_W, 12);
  a.movImm(REG_DM_H, 8);
  a.movImm(REG_DM_BANK, 32);
  a.movImm(REG_DM_CTRL, 0x01);

  // Draw ship sprite
  a.movwLabel(8, 'sprite_ship');
  a.movMem(REG_DM_SRC_L, 9);
  a.movMem(REG_DM_SRC_H, 8);
  a.movMem(REG_DM_DST_X, V_SHIP_X);
  a.movImm(REG_DM_DST_Y, 140);
  a.movImm(REG_DM_W, 12);
  a.movImm(REG_DM_H, 10);
  a.movImm(REG_DM_BANK, 32);
  a.movImm(REG_DM_CTRL, 0x01);

  a.jmp('sp_loop');

  // Helpers
  a.label('sp_init');
  a.movImm(V_SHIP_X, 94);
  a.movImm(V_PREV_SHIP_X, 94);
  a.movImm(V_BULLET_ON, 0);
  a.movImm(V_ENEMY_X, 94);
  a.movImm(V_ENEMY_Y, 24);
  a.movImm(V_PREV_EX, 94);
  a.movImm(V_PREV_EY, 24);
  a.movImm(V_ENEMY_DX, 2);
  a.movImm(V_SCORE, 0);
  a.movImm(V_HP, 3);
  a.movImm(V_SFX, 0);
  a.movImm(V_STAR_Y, 30);
  a.fillRect(0, 0, 200, 160, 0);
  a.fillRect(0, 18, 200, 1, 3);
  a.call('sp_draw_hud');
  a.ret();

  a.label('sp_respawn_enemy');
  // Pseudo-random X using V_TICK * 37
  a.movMem(6, V_TICK);
  a.movRImm(7, 37);
  a.mul(6);
  a.andImm(7, 0x7f);
  a.addRImm(7, 24);
  a.movMem(V_ENEMY_X, 7);
  a.movImm(V_ENEMY_Y, 22);
  a.ret();

  a.label('sp_draw_hud');
  a.fillRect(0, 0, 200, 18, 1);
  a.movwLabel(2, 'str_sp_title');
  a.movRImm(4, 6);
  a.movRImm(5, 6);
  a.call('draw_text');
  a.movwLabel(2, 'str_sp_sc');
  a.movRImm(4, 110);
  a.movRImm(5, 6);
  a.call('draw_text');
  a.movMem(0, V_SCORE);
  a.movRImm(4, 126);
  a.movRImm(5, 6);
  a.call('draw_2digits');
  a.movwLabel(2, 'str_sp_hp');
  a.movRImm(4, 158);
  a.movRImm(5, 6);
  a.call('draw_text');
  a.movMem(0, V_HP);
  a.movRImm(4, 174);
  a.movRImm(5, 6);
  a.call('draw_digit');
  a.ret();

  a.label('sp_sfx_laser');
  a.movImm(REG_SG0L, 0x80);
  a.movImm(REG_SG0H, 0x00);
  a.movImm(REG_SG0V, 0x16);
  a.movImm(V_SFX, 5);
  a.ret();

  a.label('sp_sfx_boom');
  a.movImm(REG_SG2C, 0x60);
  a.movImm(REG_SG2V, 0x1e);
  a.movImm(V_SFX, 12);
  a.ret();

  emitFontHelper(a, 'font_2bpp');
  emitFontData(a, 'font_2bpp');

  a.label('str_sp_title'); a.asciiZ('STAR PATROL');
  a.label('str_sp_sc'); a.asciiZ('SC:');
  a.label('str_sp_hp'); a.asciiZ('HP:');
  a.label('str_sp_go'); a.asciiZ('GAME OVER - PRESS A');

  // 12x10 2bpp Player Ship Sprite (3 bytes per row * 10 rows)
  const packSprite = (rows: string[]): number[] => {
    const out: number[] = [];
    for (const row of rows) {
      for (let bx = 0; bx < row.length; bx += 4) {
        let byte = 0;
        for (let k = 0; k < 4; k++) {
          const ch = row[bx + k] || '0';
          const v = ch === '3' ? 3 : ch === '2' ? 2 : ch === '1' ? 1 : 0;
          byte |= v << (6 - k * 2);
        }
        out.push(byte);
      }
    }
    return out;
  };

  a.label('sprite_ship');
  a.db(...packSprite([
    '000003300000',
    '000003300000',
    '000032230000',
    '000332233000',
    '003233332300',
    '032233332230',
    '331332233133',
    '330333333033',
    '300030030003',
    '000020020000',
  ]));

  a.label('sprite_enemy');
  a.db(...packSprite([
    '003300003300',
    '000330033000',
    '003333333300',
    '033113311330',
    '333333333333',
    '303332233303',
    '303000000303',
    '000330033000',
  ]));

  const bytes = a.build(8192);
  return {
    bytes,
    info: parseTgcRom(
      bytes,
      'star_patrol.tgc',
      true,
      'Space shooter with scrolling stars, laser & explosion synthesis, and touch/D-Pad flight control.'
    ),
  };
}

let cachedBuiltInRoms: BuiltInRomEntry[] | null = null;

export function getBuiltInRoms(): BuiltInRomEntry[] {
  if (!cachedBuiltInRoms) {
    cachedBuiltInRoms = [
      buildLightsOutRom(),
      buildCyberPaddleRom(),
      buildStarPatrolRom(),
    ];
  }
  return cachedBuiltInRoms;
}

export function downloadTgcFile(bytes: Uint8Array, filename: string): void {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const blob = new Blob([copy.buffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.tgc') ? filename : `${filename}.tgc`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
