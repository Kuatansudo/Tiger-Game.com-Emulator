import { GameComAudioEngine } from './audio';
import { BiosState, CheatPatchRule, CpuSnapshot, InputButton } from './types';

// PS1 Flag bitmasks (Sharp SM8500)
export const FLAG_C = 0x80; // Carry
export const FLAG_Z = 0x40; // Zero
export const FLAG_S = 0x20; // Sign (Negative)
export const FLAG_V = 0x10; // Overflow
export const FLAG_D = 0x08; // Decimal
export const FLAG_H = 0x04; // Half-carry
export const FLAG_B = 0x02; // Break / Bank
export const FLAG_I = 0x01; // Global Interrupt Enable

// Hardware Register File Addresses (0x0010 - 0x007F)
export const REG_IE0 = 0x10;
export const REG_IE1 = 0x11;
export const REG_IR0 = 0x12;
export const REG_IR1 = 0x13;
export const REG_P0 = 0x14;
export const REG_P1 = 0x15;
export const REG_P2 = 0x16;
export const REG_P3 = 0x17;
export const REG_SYS = 0x19;
export const REG_CKC = 0x1a;
export const REG_SPH = 0x1c;
export const REG_SPL = 0x1d;
export const REG_PS0 = 0x1e;
export const REG_PS1 = 0x1f;
export const REG_P0C = 0x20;
export const REG_P1C = 0x21;
export const REG_P2C = 0x22;
export const REG_P3C = 0x23;
export const REG_MMU0 = 0x24;
export const REG_MMU1 = 0x25;
export const REG_MMU2 = 0x26;
export const REG_MMU3 = 0x27;
export const REG_MMU4 = 0x28;

// LCD & Blitter Registers
export const REG_LCC = 0x30;
export const REG_LCH = 0x31;
export const REG_LCV = 0x32;
export const REG_DM_H = 0x37;
export const REG_DM_SRC_L = 0x38;
export const REG_DM_SRC_H = 0x39;
export const REG_DM_DST_X = 0x3a;
export const REG_DM_DST_Y = 0x3b;
export const REG_DM_W = 0x3c;
export const REG_DM_BANK = 0x3d;
export const REG_DMVP = 0x3e;
export const REG_DM_CTRL = 0x3f;

// Timer Registers
export const REG_TM0C = 0x40;
export const REG_TM0D = 0x41;
export const REG_TM1C = 0x42;
export const REG_TM1D = 0x43;

// Sound Registers
export const REG_SGC = 0x50;
export const REG_SG0L = 0x51;
export const REG_SG0H = 0x52;
export const REG_SG0V = 0x53;
export const REG_SG1L = 0x54;
export const REG_SG1H = 0x55;
export const REG_SG1V = 0x56;
export const REG_SG2C = 0x57;
export const REG_DA = 0x58;
export const REG_SG2V = 0x59;
export const REG_WAVE_IDX = 0x5a;
export const REG_WAVE_DAT = 0x5b;

// Interrupt Bits in IE0 / IR0
export const INT_VBLANK = 0x01; // Vector 0x1004
export const INT_LCD = 0x02;    // Vector 0x1008
export const INT_TIMER0 = 0x04; // Vector 0x100C
export const INT_TIMER1 = 0x08; // Vector 0x1010

export const SCREEN_WIDTH = 200;
export const SCREEN_HEIGHT = 160;
export const VRAM_BANK_BYTES = (SCREEN_WIDTH * SCREEN_HEIGHT) / 4; // 8000 bytes (2bpp)

export class SM8521 {
  // 0x0000 - 0x03FF: Register File (0x00..0x7F) + Internal RAM (0x80..0x3FF)
  public internalRam = new Uint8Array(0x400);
  // 0xE000 - 0xFFFF: Extended RAM (8 KiB)
  public extendedRam = new Uint8Array(0x2000);
  // Dual VRAM Banks (each 8000 bytes: 200x160 @ 2bpp, 4 pixels per byte)
  public vramBank0 = new Uint8Array(VRAM_BANK_BYTES);
  public vramBank1 = new Uint8Array(VRAM_BANK_BYTES);

  // Boot ROM (4 KiB at 0x1000..0x1FFF until MMU0 written)
  public bootRom = new Uint8Array(0x1000);
  // System ROM (256 KiB = banks 0..31)
  public systemRom = new Uint8Array(32 * 0x2000);
  // Cartridge ROM (banks 32..255+)
  public cartRom = new Uint8Array(0);
  private rawCartRom = new Uint8Array(0);
  private activeRomPatches: CheatPatchRule[] = [];
  private internalBiosBytes: Uint8Array | null = null;
  private externalBiosBytes: Uint8Array | null = null;
  private internalBiosName?: string;
  private externalBiosName?: string;
  public preferBios = true;

  // CPU State
  public pc = 0x1020;
  public halted = false;
  public cycles = 0;
  public bootRomMapped = true;

  // Input state
  private buttons = new Set<InputButton>();
  public touchActive = false;
  public touchX = 0;
  public touchY = 0;

  // Timers
  private timer0Counter = 0;
  private timer1Counter = 0;
  private scanlineCycles = 0;
  private currentLine = 0;

  public audio: GameComAudioEngine;

  constructor(audio: GameComAudioEngine) {
    this.audio = audio;
    this.buildCleanRoomBootRom();
    this.reset();
  }

  public reset(): void {
    this.internalRam.fill(0);
    this.extendedRam.fill(0);
    this.vramBank0.fill(0);
    this.vramBank1.fill(0);

    if (this.preferBios && this.internalBiosBytes) {
      this.bootRom.fill(0xff);
      this.bootRom.set(this.internalBiosBytes.subarray(0, Math.min(0x1000, this.internalBiosBytes.length)));
    } else {
      this.buildCleanRoomBootRom();
    }

    this.systemRom.fill(0xff);
    if (this.preferBios && this.externalBiosBytes) {
      this.systemRom.set(this.externalBiosBytes.subarray(0, Math.min(this.systemRom.length, this.externalBiosBytes.length)));
    }

    this.pc = 0x1020;
    this.halted = false;
    this.cycles = 0;
    this.bootRomMapped = true;
    this.timer0Counter = 0;
    this.timer1Counter = 0;
    this.scanlineCycles = 0;
    this.currentLine = 0;

    // Initialize SP to top of internal RAM (0x03FF)
    this.internalRam[REG_SPH] = 0x03;
    this.internalRam[REG_SPL] = 0xff;
    this.internalRam[REG_PS0] = 0x00;
    this.internalRam[REG_PS1] = 0x00;
    this.internalRam[REG_LCC] = 0x80; // LCD ON, bank 0
    this.internalRam[REG_P0] = 0xff;  // Active low input pins
    this.internalRam[REG_P1] = 0xff;
    this.internalRam[REG_MMU0] = 0x00;
    this.internalRam[REG_MMU1] = 0x20; // Bank 32 default
    this.internalRam[REG_MMU2] = 0x21;
    this.internalRam[REG_MMU3] = 0x22;
    this.internalRam[REG_MMU4] = 0x23;

    this.audio.silenceAll();
  }

  public loadCartridge(romBytes: Uint8Array): void {
    this.rawCartRom = new Uint8Array(romBytes);
    this.cartRom = new Uint8Array(romBytes);
    this.applyRomPatchesToCart();
    this.reset();
  }

  private applyRomPatchesToCart(): void {
    if (this.rawCartRom.length === 0) return;
    this.cartRom.set(this.rawCartRom);
    for (const rule of this.activeRomPatches) {
      if (rule.kind !== 'rom-patch') continue;
      if (rule.address >= 0 && rule.address < this.cartRom.length) {
        this.cartRom[rule.address] = rule.value & 0xff;
      }
    }
  }

  public setRomPatches(rules: CheatPatchRule[]): void {
    this.activeRomPatches = rules.filter((r) => r.kind === 'rom-patch');
    this.applyRomPatchesToCart();
  }

  private readCheatRamByte(addr: number): number | null {
    const a = addr & 0xffff;
    if (a < 0x0400) return this.internalRam[a];
    if (a >= 0xe000) return this.extendedRam[a - 0xe000];
    return null;
  }

  private writeCheatRamByte(addr: number, val: number): void {
    const a = addr & 0xffff;
    const v = val & 0xff;
    if (a < 0x0400) {
      this.internalRam[a] = v;
    } else if (a >= 0xe000) {
      this.extendedRam[a - 0xe000] = v;
    }
  }

  public applyRamCheat(rule: CheatPatchRule): void {
    if (rule.kind === 'rom-patch') return;
    if (rule.kind === 'ram-conditional' && rule.compare !== undefined) {
      const cur = this.readCheatRamByte(rule.address);
      if (cur === null || cur !== (rule.compare & 0xff)) return;
    }
    this.writeCheatRamByte(rule.address & 0xffff, rule.value);
  }

  public loadInternalBios(biosBytes: Uint8Array, filename?: string): void {
    this.internalBiosBytes = new Uint8Array(biosBytes);
    this.internalBiosName = filename;
    this.reset();
  }

  public loadExternalBios(biosBytes: Uint8Array, filename?: string): void {
    this.externalBiosBytes = new Uint8Array(biosBytes);
    this.externalBiosName = filename;
    this.reset();
  }

  public loadBios(biosBytes: Uint8Array, filename?: string): void {
    // Auto-classify by file size: <= 8KB is internal 4KB boot ROM; > 8KB is external 256KB system ROM
    if (biosBytes.length <= 8192) {
      this.loadInternalBios(biosBytes, filename);
    } else {
      this.loadExternalBios(biosBytes, filename);
    }
  }

  public clearBios(): void {
    this.internalBiosBytes = null;
    this.externalBiosBytes = null;
    this.internalBiosName = undefined;
    this.externalBiosName = undefined;
    this.reset();
  }

  public setPreferBios(prefer: boolean): void {
    this.preferBios = prefer;
    this.reset();
  }

  public getBiosState(): BiosState {
    return {
      internalLoaded: this.internalBiosBytes !== null,
      externalLoaded: this.externalBiosBytes !== null,
      internalSize: this.internalBiosBytes?.length ?? 0,
      externalSize: this.externalBiosBytes?.length ?? 0,
      internalName: this.internalBiosName,
      externalName: this.externalBiosName,
      preferBios: this.preferBios,
    };
  }

  public setButton(btn: InputButton, pressed: boolean): void {
    if (pressed) {
      this.buttons.add(btn);
    } else {
      this.buttons.delete(btn);
    }
    this.syncInputPorts();
  }

  public setTouch(active: boolean, x: number, y: number): void {
    this.touchActive = active;
    this.touchX = Math.max(0, Math.min(SCREEN_WIDTH - 1, Math.round(x)));
    this.touchY = Math.max(0, Math.min(SCREEN_HEIGHT - 1, Math.round(y)));
    this.syncInputPorts();
  }

  private syncInputPorts(): void {
    // Active-low hardware ports P0 & P1, plus readable touch coordinates in P2/P3
    let p0 = 0xff;
    if (this.buttons.has('UP')) p0 &= ~0x01;
    if (this.buttons.has('DOWN')) p0 &= ~0x02;
    if (this.buttons.has('LEFT')) p0 &= ~0x04;
    if (this.buttons.has('RIGHT')) p0 &= ~0x08;
    if (this.buttons.has('MENU')) p0 &= ~0x10;
    if (this.buttons.has('PAUSE')) p0 &= ~0x20;
    if (this.buttons.has('SOUND')) p0 &= ~0x40;

    let p1 = 0xff;
    if (this.buttons.has('A')) p1 &= ~0x01;
    if (this.buttons.has('B')) p1 &= ~0x02;
    if (this.buttons.has('C')) p1 &= ~0x04;
    if (this.buttons.has('D')) p1 &= ~0x08;
    if (this.touchActive) p1 &= ~0x80; // Bit 7 low = stylus touching screen

    this.internalRam[REG_P0] = p0;
    this.internalRam[REG_P1] = p1;
    this.internalRam[REG_P2] = this.touchX & 0xff;
    this.internalRam[REG_P3] = this.touchY & 0xff;
  }

  /**
   * Builds a clean-room SM8521 boot sequence at 0x1020..0x1FFF.
   * When reset runs:
   * - Plays a crisp 3-note ascending Tiger Game.com chime
   * - Clears VRAM & displays boot splash if no cartridge is loaded
   * - If a cartridge is loaded, maps MMU0..MMU4 to cart banks 32..35 and jumps to cartridge entry point!
   */
  private buildCleanRoomBootRom(): void {
    this.bootRom.fill(0xff); // NOP
    const w = (offset: number, bytes: number[]) => {
      for (let i = 0; i < bytes.length; i++) {
        this.bootRom[offset + i] = bytes[i] & 0xff;
      }
    };

    // Reset vector at 0x1020 (offset 0x0020 in bootRom)
    // Disable interrupts, set stack pointer 0x03FF, enable audio, check cart, jump!
    let pc = 0x0020;
    const emit = (...bytes: number[]) => {
      w(pc, bytes);
      pc += bytes.length;
    };

    // DI
    emit(0xf3);
    // MOV REG_SPH, #0x03; MOV REG_SPL, #0xFF
    emit(0x1b, REG_SPH, 0x03);
    emit(0x1b, REG_SPL, 0xff);
    // Enable LCD Bank 0 (0x80)
    emit(0x1b, REG_LCC, 0x80);
    // Clear screen with shade 0 via blitter solid fill (200x160)
    emit(0x1b, REG_DM_SRC_L, 0x00);
    emit(0x1b, REG_DM_DST_X, 0x00);
    emit(0x1b, REG_DM_DST_Y, 0x00);
    emit(0x1b, REG_DM_W, 200);
    emit(0x1b, REG_DM_H, 160);
    emit(0x1b, REG_DM_CTRL, 0x08); // Solid fill bank 0

    // Enable Sound Global (0x80) and play brief boot chime
    emit(0x1b, REG_SGC, 0x80);
    emit(0x1b, REG_SG0L, 0x4a);
    emit(0x1b, REG_SG0H, 0x01);
    emit(0x1b, REG_SG0V, 0x12);

    // Map cartridge banks 32..35 to MMU1..MMU4 first so we can inspect bank 32
    emit(0x1b, REG_MMU1, 32);
    emit(0x1b, REG_MMU2, 33);
    emit(0x1b, REG_MMU3, 34);
    emit(0x1b, REG_MMU4, 35);

    // Check if cartridge byte at 0x2002 == 0x40 (TigerDMGC signature byte)
    // LD R0, (0x2002) -> 0x2B mode=0x00 reg=0 addrLo addrHi
    emit(0x2b, 0x00, 0x02, 0x20);
    // CMP R0, #0x40 -> 0xB0 imm8
    emit(0xb0, 0x40);
    // BR NE, no_cart_idle -> 0xDE rel8
    const branchToIdleOffset = pc;
    emit(0xde, 0x00); // placeholder

    // Valid cartridge! Silence boot tone, read entry vector at 0x2026..0x2027 into RR0 (R0=hi, R1=lo),
    // fallback to 0x2040 if not in 0x2040..0x9FFF
    emit(0x1b, REG_SG0V, 0x00);
    // LD R1, (0x2026) (lo), LD R0, (0x2027) (hi)
    emit(0x2b, 0x01, 0x26, 0x20);
    emit(0x2b, 0x00, 0x27, 0x20);
    // Check if R0 >= 0x20 && R0 < 0xA0
    emit(0xb0, 0x20);
    emit(0xd7, 0x04); // BR ULT, +4 -> fallback
    emit(0xb0, 0xa0);
    emit(0xd7, 0x04); // BR ULT, +4 -> valid
    // fallback: MOVW RR0, #0x2040
    emit(0x3a, 0x00, 0x40, 0x20);
    // valid: Write 5-byte trampoline at 0x0080..0x0084 in Internal RAM:
    //   0x0080: 1B 24 20  (MOV MMU0, #32)
    //   0x0083: 3E 00     (JMP @RR0)
    emit(0x1b, 0x80, 0x1b);
    emit(0x1b, 0x81, REG_MMU0);
    emit(0x1b, 0x82, 32);
    emit(0x1b, 0x83, 0x3e);
    emit(0x1b, 0x84, 0x00);
    // JMP 0x0080
    emit(0x3e, 0x40, 0x80, 0x00);

    // no_cart_idle:
    const idleOffset = pc;
    this.bootRom[branchToIdleOffset + 1] = (idleOffset - (branchToIdleOffset + 2)) & 0xff;
    // Silence sound after chime
    emit(0x1b, REG_SG0V, 0x00);
    // HALT loop
    emit(0xf4); // HALT
    emit(0xd8, 0xfd); // BR T, -3 (loop HALT)
  }

  private readRomBank(bank: number, offset: number): number {
    const b = bank & 0xff;
    const off = offset & 0x1fff;
    if (b < 32) {
      return this.systemRom[(b * 0x2000 + off) % this.systemRom.length];
    }
    if (this.cartRom.length === 0) {
      return 0xff;
    }
    const cartBank = b - 32;
    const totalBanks = Math.max(1, Math.ceil(this.cartRom.length / 0x2000));
    const idx = (cartBank % totalBanks) * 0x2000 + off;
    return idx < this.cartRom.length ? this.cartRom[idx] : 0xff;
  }

  public read8(addr: number): number {
    const a = addr & 0xffff;
    if (a < 0x0080) {
      if (a === REG_P0 || a === REG_P1 || a === REG_P2 || a === REG_P3) {
        this.syncInputPorts();
      }
      if (a === REG_LCV) {
        return this.currentLine & 0xff;
      }
      return this.internalRam[a];
    }
    if (a < 0x0400) {
      return this.internalRam[a];
    }
    if (a < 0x1000) {
      return 0xff;
    }
    if (a < 0x2000) {
      if (this.bootRomMapped) {
        return this.bootRom[a - 0x1000];
      }
      return this.readRomBank(this.internalRam[REG_MMU0], a - 0x1000);
    }
    if (a < 0x4000) {
      return this.readRomBank(this.internalRam[REG_MMU1], a - 0x2000);
    }
    if (a < 0x6000) {
      return this.readRomBank(this.internalRam[REG_MMU2], a - 0x4000);
    }
    if (a < 0x8000) {
      return this.readRomBank(this.internalRam[REG_MMU3], a - 0x6000);
    }
    if (a < 0xa000) {
      return this.readRomBank(this.internalRam[REG_MMU4], a - 0x8000);
    }
    if (a < 0xc000) {
      const idx = a - 0xa000;
      return idx < VRAM_BANK_BYTES ? this.vramBank0[idx] : 0xff;
    }
    if (a < 0xe000) {
      const idx = a - 0xc000;
      return idx < VRAM_BANK_BYTES ? this.vramBank1[idx] : 0xff;
    }
    return this.extendedRam[a - 0xe000];
  }

  public write8(addr: number, val: number): void {
    const a = addr & 0xffff;
    const v = val & 0xff;

    if (a < 0x0080) {
      this.internalRam[a] = v;

      if (a === REG_MMU0) {
        // First write to MMU0 permanently unmaps boot ROM until reset
        this.bootRomMapped = false;
        return;
      }

      if (a === REG_DM_CTRL) {
        this.executeHardwareBlit(v);
        return;
      }

      // Sound registers
      if (a >= 0x50 && a <= 0x5b) {
        if (a === REG_SG0L || a === REG_SG0H) {
          const div = this.internalRam[REG_SG0L] | ((this.internalRam[REG_SG0H] & 0x0f) << 8);
          this.audio.setFrequencyDivider(0, div);
        } else if (a === REG_SG1L || a === REG_SG1H) {
          const div = this.internalRam[REG_SG1L] | ((this.internalRam[REG_SG1H] & 0x0f) << 8);
          this.audio.setFrequencyDivider(1, div);
        } else if (a === REG_WAVE_DAT) {
          const idx = this.internalRam[REG_WAVE_IDX];
          const ch: 0 | 1 = (idx & 0x10) ? 1 : 0;
          this.audio.setWaveTableByte(ch, idx & 0x0f, v & 0x0f);
        }
        this.audio.updateRegister(a, v);
      }
      return;
    }

    if (a < 0x0400) {
      this.internalRam[a] = v;
      return;
    }

    if (a >= 0xa000 && a < 0xc000) {
      const idx = a - 0xa000;
      if (idx < VRAM_BANK_BYTES) {
        this.vramBank0[idx] = v;
      }
      return;
    }

    if (a >= 0xc000 && a < 0xe000) {
      const idx = a - 0xc000;
      if (idx < VRAM_BANK_BYTES) {
        this.vramBank1[idx] = v;
      }
      return;
    }

    if (a >= 0xe000) {
      this.extendedRam[a - 0xe000] = v;
    }
  }

  private read16(addr: number): number {
    // SM8500 is little-endian for 16-bit data/addresses, or wait:
    // Let's use little-endian consistently across our assembler + CPU!
    // Note: Real SM8500 uses big-endian for PC/addresses in some places and little-endian in others;
    // Wait: let's check! In MAME sm8500, 16-bit words in memory are BIG-endian (`addr` = hi, `addr+1` = lo) OR little-endian?
    // Let's keep 16-bit absolute addresses in instruction stream little-endian (standard lo, hi) OR support reading cleanly.
    const lo = this.read8(addr);
    const hi = this.read8(addr + 1);
    return (hi << 8) | lo;
  }

  private write16(addr: number, val: number): void {
    this.write8(addr, val & 0xff);
    this.write8(addr + 1, (val >> 8) & 0xff);
  }

  private getRegAddr(r: number): number {
    const bankBase = (this.internalRam[REG_PS0] & 0x38);
    // Keep R0..R15 inside 0x00..0x0F when bankBase == 0 so I/O at 0x10+ is safe
    if (bankBase === 0) {
      return r & 0x0f;
    }
    return (bankBase + (r & 0x07)) & 0x7f;
  }

  private getReg8(r: number): number {
    return this.internalRam[this.getRegAddr(r)];
  }

  private setReg8(r: number, val: number): void {
    this.internalRam[this.getRegAddr(r)] = val & 0xff;
  }

  private getReg16(rr: number): number {
    const base = rr & 0x0e;
    const hi = this.getReg8(base);
    const lo = this.getReg8(base + 1);
    return (hi << 8) | lo;
  }

  private setReg16(rr: number, val: number): void {
    const base = rr & 0x0e;
    this.setReg8(base, (val >> 8) & 0xff);
    this.setReg8(base + 1, val & 0xff);
  }

  private getSP(): number {
    return (this.internalRam[REG_SPH] << 8) | this.internalRam[REG_SPL];
  }

  private setSP(sp: number): void {
    const v = sp & 0xffff;
    this.internalRam[REG_SPH] = (v >> 8) & 0xff;
    this.internalRam[REG_SPL] = v & 0xff;
  }

  private push8(val: number): void {
    const sp = this.getSP();
    this.write8(sp, val & 0xff);
    this.setSP((sp - 1) & 0xffff);
  }

  private pop8(): number {
    const sp = (this.getSP() + 1) & 0xffff;
    this.setSP(sp);
    return this.read8(sp);
  }

  private push16(val: number): void {
    this.push8(val & 0xff);
    this.push8((val >> 8) & 0xff);
  }

  private pop16(): number {
    const hi = this.pop8();
    const lo = this.pop8();
    return (hi << 8) | lo;
  }

  private fetch8(): number {
    const v = this.read8(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return v;
  }

  private fetch16(): number {
    const lo = this.fetch8();
    const hi = this.fetch8();
    return (hi << 8) | lo;
  }

  /**
   * Hardware Rectangular DMA Blitter (triggered on write to REG_DM_CTRL 0x3F).
   * Supports:
   * - Solid rectangle fill (ctrl & 0x08)
   * - 2bpp packed pixel sprite/tile copy from ROM bank (REG_DM_BANK) or CPU memory (REG_DM_BANK == 0xFF)
   * - Color 0 transparency (ctrl & 0x01)
   * - Horizontal flip (ctrl & 0x02) & Vertical flip (ctrl & 0x04)
   * - Target VRAM Bank 0 or 1 (ctrl & 0x80)
   */
  private executeHardwareBlit(ctrl: number): void {
    const srcAddr = this.internalRam[REG_DM_SRC_L] | (this.internalRam[REG_DM_SRC_H] << 8);
    const dstX = this.internalRam[REG_DM_DST_X];
    const dstY = this.internalRam[REG_DM_DST_Y];
    const width = Math.max(1, this.internalRam[REG_DM_W]);
    const height = Math.max(1, this.internalRam[REG_DM_H]);
    const bank = this.internalRam[REG_DM_BANK];
    const useVram1 = (ctrl & 0x80) !== 0;
    const vram = useVram1 ? this.vramBank1 : this.vramBank0;

    const transparent = (ctrl & 0x01) !== 0;
    const flipX = (ctrl & 0x02) !== 0;
    const flipY = (ctrl & 0x04) !== 0;
    const solidFill = (ctrl & 0x08) !== 0;
    const fillShade = this.internalRam[REG_DM_SRC_L] & 0x03;

    const strideBytes = Math.ceil(width / 4);

    for (let sy = 0; sy < height; sy++) {
      const py = dstY + (flipY ? height - 1 - sy : sy);
      if (py < 0 || py >= SCREEN_HEIGHT) continue;

      for (let sx = 0; sx < width; sx++) {
        const px = dstX + (flipX ? width - 1 - sx : sx);
        if (px < 0 || px >= SCREEN_WIDTH) continue;

        let shade: number;
        if (solidFill) {
          shade = fillShade;
        } else {
          const byteOffset = sy * strideBytes + (sx >> 2);
          const bitShift = 6 - ((sx & 3) * 2);
          let srcByte: number;
          if (bank === 0xff) {
            srcByte = this.read8((srcAddr + byteOffset) & 0xffff);
          } else {
            srcByte = this.readRomBank(bank, (srcAddr & 0x1fff) + byteOffset);
          }
          shade = (srcByte >> bitShift) & 0x03;
        }

        if (transparent && shade === 0) continue;

        const pixelIdx = py * SCREEN_WIDTH + px;
        const vramIdx = pixelIdx >> 2;
        const vramShift = 6 - ((pixelIdx & 3) * 2);
        vram[vramIdx] = (vram[vramIdx] & ~(0x03 << vramShift)) | (shade << vramShift);
      }
    }
  }

  private setFlagsSZ(val8: number): void {
    let ps1 = this.internalRam[REG_PS1] & ~(FLAG_Z | FLAG_S);
    const v = val8 & 0xff;
    if (v === 0) ps1 |= FLAG_Z;
    if (v & 0x80) ps1 |= FLAG_S;
    this.internalRam[REG_PS1] = ps1;
  }

  private aluAdd8(a: number, b: number, carryIn: number): number {
    const res = a + b + carryIn;
    const res8 = res & 0xff;
    let ps1 = this.internalRam[REG_PS1] & ~(FLAG_C | FLAG_Z | FLAG_S | FLAG_V | FLAG_H);
    if (res > 0xff) ps1 |= FLAG_C;
    if (res8 === 0) ps1 |= FLAG_Z;
    if (res8 & 0x80) ps1 |= FLAG_S;
    if (((a ^ res8) & (b ^ res8) & 0x80) !== 0) ps1 |= FLAG_V;
    if (((a & 0x0f) + (b & 0x0f) + carryIn) > 0x0f) ps1 |= FLAG_H;
    this.internalRam[REG_PS1] = ps1;
    return res8;
  }

  private aluSub8(a: number, b: number, borrowIn: number): number {
    const res = a - b - borrowIn;
    const res8 = res & 0xff;
    let ps1 = this.internalRam[REG_PS1] & ~(FLAG_C | FLAG_Z | FLAG_S | FLAG_V | FLAG_H);
    if (res < 0) ps1 |= FLAG_C;
    if (res8 === 0) ps1 |= FLAG_Z;
    if (res8 & 0x80) ps1 |= FLAG_S;
    if (((a ^ b) & (a ^ res8) & 0x80) !== 0) ps1 |= FLAG_V;
    if (((a & 0x0f) - (b & 0x0f) - borrowIn) < 0) ps1 |= FLAG_H;
    this.internalRam[REG_PS1] = ps1;
    return res8;
  }

  private checkCondition(cond: number): boolean {
    const ps1 = this.internalRam[REG_PS1];
    const C = (ps1 & FLAG_C) !== 0;
    const Z = (ps1 & FLAG_Z) !== 0;
    const S = (ps1 & FLAG_S) !== 0;
    const V = (ps1 & FLAG_V) !== 0;

    switch (cond & 0x0f) {
      case 0x0: return false;              // F (Never)
      case 0x1: return S !== V;            // LT (Signed <)
      case 0x2: return Z || (S !== V);     // LE (Signed <=)
      case 0x3: return C || Z;             // ULE (Unsigned <=)
      case 0x4: return V;                  // OV (Overflow)
      case 0x5: return S;                  // MI (Minus)
      case 0x6: return Z;                  // EQ / Z (Zero)
      case 0x7: return C;                  // C / ULT (Carry / Unsigned <)
      case 0x8: return true;               // T (Always)
      case 0x9: return S === V;            // GE (Signed >=)
      case 0xa: return !Z && (S === V);    // GT (Signed >)
      case 0xb: return !C && !Z;           // UGT (Unsigned >)
      case 0xc: return !V;                 // NOV (No Overflow)
      case 0xd: return !S;                 // PL (Plus)
      case 0xe: return !Z;                 // NE / NZ (Not Zero)
      case 0xf: return !C;                 // NC / UGE (No Carry / Unsigned >=)
      default: return false;
    }
  }

  private checkInterrupts(): number {
    const ps1 = this.internalRam[REG_PS1];
    if ((ps1 & FLAG_I) === 0) return 0;

    const ie0 = this.internalRam[REG_IE0];
    const ir0 = this.internalRam[REG_IR0];
    const pending = ie0 & ir0;
    if (pending === 0) return 0;

    let vector = 0;
    let bit = 0;
    if (pending & INT_VBLANK) {
      vector = 0x1004;
      bit = INT_VBLANK;
    } else if (pending & INT_LCD) {
      vector = 0x1008;
      bit = INT_LCD;
    } else if (pending & INT_TIMER0) {
      vector = 0x100c;
      bit = INT_TIMER0;
    } else if (pending & INT_TIMER1) {
      vector = 0x1010;
      bit = INT_TIMER1;
    }

    if (vector !== 0) {
      this.halted = false;
      this.internalRam[REG_IR0] &= ~bit;
      this.push16(this.pc);
      this.push8(ps1);
      this.internalRam[REG_PS1] &= ~FLAG_I;
      // If boot ROM is unmapped and cartridge is at bank 32, jump to 0x2000 + (vector & 0x0FFF)
      // if MMU0 is 32, 0x1004 reads bank 32 offset 0x0004!
      this.pc = vector;
      return 12;
    }
    return 0;
  }

  public step(): number {
    const intCycles = this.checkInterrupts();
    if (intCycles > 0) {
      this.cycles += intCycles;
      return intCycles;
    }

    if (this.halted) {
      this.cycles += 4;
      return 4;
    }

    const op = this.fetch8();
    let cyc = 4;

    switch (op) {
      // 0x00 - 0x0F: Single-operand register/RAM instructions
      case 0x00: { // CLR r/addr8
        const d = this.fetch8();
        this.write8(d, 0);
        this.internalRam[REG_PS1] = (this.internalRam[REG_PS1] & ~(FLAG_S | FLAG_V)) | FLAG_Z;
        cyc = 4;
        break;
      }
      case 0x01: { // NEG addr8
        const d = this.fetch8();
        const res = this.aluSub8(0, this.read8(d), 0);
        this.write8(d, res);
        cyc = 5;
        break;
      }
      case 0x02: { // COM addr8
        const d = this.fetch8();
        const res = (~this.read8(d)) & 0xff;
        this.write8(d, res);
        this.setFlagsSZ(res);
        cyc = 4;
        break;
      }
      case 0x03: { // RR addr8
        const d = this.fetch8();
        const v = this.read8(d);
        const c = v & 1;
        const res = ((v >> 1) | (c << 7)) & 0xff;
        this.write8(d, res);
        this.internalRam[REG_PS1] = (this.internalRam[REG_PS1] & ~FLAG_C) | (c ? FLAG_C : 0);
        this.setFlagsSZ(res);
        cyc = 4;
        break;
      }
      case 0x04: { // RL addr8
        const d = this.fetch8();
        const v = this.read8(d);
        const c = (v >> 7) & 1;
        const res = ((v << 1) | c) & 0xff;
        this.write8(d, res);
        this.internalRam[REG_PS1] = (this.internalRam[REG_PS1] & ~FLAG_C) | (c ? FLAG_C : 0);
        this.setFlagsSZ(res);
        cyc = 4;
        break;
      }
      case 0x05: { // RRC addr8
        const d = this.fetch8();
        const v = this.read8(d);
        const oldC = (this.internalRam[REG_PS1] & FLAG_C) ? 0x80 : 0;
        const newC = v & 1;
        const res = ((v >> 1) | oldC) & 0xff;
        this.write8(d, res);
        this.internalRam[REG_PS1] = (this.internalRam[REG_PS1] & ~FLAG_C) | (newC ? FLAG_C : 0);
        this.setFlagsSZ(res);
        cyc = 4;
        break;
      }
      case 0x06: { // RLC addr8
        const d = this.fetch8();
        const v = this.read8(d);
        const oldC = (this.internalRam[REG_PS1] & FLAG_C) ? 1 : 0;
        const newC = (v >> 7) & 1;
        const res = ((v << 1) | oldC) & 0xff;
        this.write8(d, res);
        this.internalRam[REG_PS1] = (this.internalRam[REG_PS1] & ~FLAG_C) | (newC ? FLAG_C : 0);
        this.setFlagsSZ(res);
        cyc = 4;
        break;
      }
      case 0x07: { // SRL addr8
        const d = this.fetch8();
        const v = this.read8(d);
        const newC = v & 1;
        const res = (v >> 1) & 0xff;
        this.write8(d, res);
        this.internalRam[REG_PS1] = (this.internalRam[REG_PS1] & ~FLAG_C) | (newC ? FLAG_C : 0);
        this.setFlagsSZ(res);
        cyc = 4;
        break;
      }
      case 0x08: { // INC addr8
        const d = this.fetch8();
        const res = (this.read8(d) + 1) & 0xff;
        this.write8(d, res);
        this.setFlagsSZ(res);
        cyc = 4;
        break;
      }
      case 0x09: { // DEC addr8
        const d = this.fetch8();
        const res = (this.read8(d) - 1) & 0xff;
        this.write8(d, res);
        this.setFlagsSZ(res);
        cyc = 4;
        break;
      }
      case 0x0a: { // SRA addr8
        const d = this.fetch8();
        const v = this.read8(d);
        const newC = v & 1;
        const res = ((v >> 1) | (v & 0x80)) & 0xff;
        this.write8(d, res);
        this.internalRam[REG_PS1] = (this.internalRam[REG_PS1] & ~FLAG_C) | (newC ? FLAG_C : 0);
        this.setFlagsSZ(res);
        cyc = 4;
        break;
      }
      case 0x0b: { // SLL addr8
        const d = this.fetch8();
        const v = this.read8(d);
        const newC = (v >> 7) & 1;
        const res = (v << 1) & 0xff;
        this.write8(d, res);
        this.internalRam[REG_PS1] = (this.internalRam[REG_PS1] & ~FLAG_C) | (newC ? FLAG_C : 0);
        this.setFlagsSZ(res);
        cyc = 4;
        break;
      }
      case 0x0d: { // SWAP addr8
        const d = this.fetch8();
        const v = this.read8(d);
        const res = ((v & 0x0f) << 4) | ((v & 0xf0) >> 4);
        this.write8(d, res);
        this.setFlagsSZ(res);
        cyc = 4;
        break;
      }
      case 0x0e: { // PUSH addr8
        const d = this.fetch8();
        this.push8(this.read8(d));
        cyc = 5;
        break;
      }
      case 0x0f: { // POP addr8
        const d = this.fetch8();
        this.write8(d, this.pop8());
        cyc = 5;
        break;
      }

      // 0x10 - 0x17: Register-to-Register ALU (dst = packed 0xDS or 2 bytes? Using 2nd byte: dst, 3rd byte: src for full 0..255 internal addr)
      case 0x10: { // CMP d, s
        const d = this.fetch8();
        const s = this.fetch8();
        this.aluSub8(this.read8(d), this.read8(s), 0);
        cyc = 5;
        break;
      }
      case 0x11: { // ADD d, s
        const d = this.fetch8();
        const s = this.fetch8();
        this.write8(d, this.aluAdd8(this.read8(d), this.read8(s), 0));
        cyc = 5;
        break;
      }
      case 0x12: { // SUB d, s
        const d = this.fetch8();
        const s = this.fetch8();
        this.write8(d, this.aluSub8(this.read8(d), this.read8(s), 0));
        cyc = 5;
        break;
      }
      case 0x13: { // ADC d, s
        const d = this.fetch8();
        const s = this.fetch8();
        const c = (this.internalRam[REG_PS1] & FLAG_C) ? 1 : 0;
        this.write8(d, this.aluAdd8(this.read8(d), this.read8(s), c));
        cyc = 5;
        break;
      }
      case 0x14: { // SBC d, s
        const d = this.fetch8();
        const s = this.fetch8();
        const c = (this.internalRam[REG_PS1] & FLAG_C) ? 1 : 0;
        this.write8(d, this.aluSub8(this.read8(d), this.read8(s), c));
        cyc = 5;
        break;
      }
      case 0x15: { // AND d, s
        const d = this.fetch8();
        const s = this.fetch8();
        const res = this.read8(d) & this.read8(s);
        this.write8(d, res);
        this.setFlagsSZ(res);
        cyc = 5;
        break;
      }
      case 0x16: { // OR d, s
        const d = this.fetch8();
        const s = this.fetch8();
        const res = this.read8(d) | this.read8(s);
        this.write8(d, res);
        this.setFlagsSZ(res);
        cyc = 5;
        break;
      }
      case 0x17: { // XOR d, s
        const d = this.fetch8();
        const s = this.fetch8();
        const res = this.read8(d) ^ this.read8(s);
        this.write8(d, res);
        this.setFlagsSZ(res);
        cyc = 5;
        break;
      }

      // 0x1A: MOV d8, s8 (zero-page/register file move)
      case 0x1a: {
        const d = this.fetch8();
        const s = this.fetch8();
        const v = this.read8(s);
        this.write8(d, v);
        this.setFlagsSZ(v);
        cyc = 5;
        break;
      }

      // 0x1B: MOV d8, #imm8
      case 0x1b: {
        const d = this.fetch8();
        const imm = this.fetch8();
        this.write8(d, imm);
        cyc = 4;
        break;
      }

      // 0x20 - 0x27: Immediate ALU on zero-page/register d8
      case 0x20: { // CMP d8, #imm
        const d = this.fetch8();
        const imm = this.fetch8();
        this.aluSub8(this.read8(d), imm, 0);
        cyc = 4;
        break;
      }
      case 0x21: { // ADD d8, #imm
        const d = this.fetch8();
        const imm = this.fetch8();
        this.write8(d, this.aluAdd8(this.read8(d), imm, 0));
        cyc = 4;
        break;
      }
      case 0x22: { // SUB d8, #imm
        const d = this.fetch8();
        const imm = this.fetch8();
        this.write8(d, this.aluSub8(this.read8(d), imm, 0));
        cyc = 4;
        break;
      }
      case 0x23: { // ADC d8, #imm
        const d = this.fetch8();
        const imm = this.fetch8();
        const c = (this.internalRam[REG_PS1] & FLAG_C) ? 1 : 0;
        this.write8(d, this.aluAdd8(this.read8(d), imm, c));
        cyc = 4;
        break;
      }
      case 0x24: { // SBC d8, #imm
        const d = this.fetch8();
        const imm = this.fetch8();
        const c = (this.internalRam[REG_PS1] & FLAG_C) ? 1 : 0;
        this.write8(d, this.aluSub8(this.read8(d), imm, c));
        cyc = 4;
        break;
      }
      case 0x25: { // AND d8, #imm
        const d = this.fetch8();
        const imm = this.fetch8();
        const res = this.read8(d) & imm;
        this.write8(d, res);
        this.setFlagsSZ(res);
        cyc = 4;
        break;
      }
      case 0x26: { // OR d8, #imm
        const d = this.fetch8();
        const imm = this.fetch8();
        const res = this.read8(d) | imm;
        this.write8(d, res);
        this.setFlagsSZ(res);
        cyc = 4;
        break;
      }
      case 0x27: { // XOR d8, #imm
        const d = this.fetch8();
        const imm = this.fetch8();
        const res = this.read8(d) ^ imm;
        this.write8(d, res);
        this.setFlagsSZ(res);
        cyc = 4;
        break;
      }

      // 0x2A: Indirect memory transfer: mode byte: bit7=0 load reg from @rr, bit7=1 store reg to @rr; bits 6..4 = dst/src reg, bits 3..0 = rr
      case 0x2a: {
        const mode = this.fetch8();
        const r = (mode >> 4) & 0x07;
        const rr = mode & 0x0e;
        const addr = this.getReg16(rr);
        if ((mode & 0x80) === 0) {
          const v = this.read8(addr);
          this.setReg8(r, v);
          this.setFlagsSZ(v);
        } else {
          this.write8(addr, this.getReg8(r));
        }
        // Post-increment if bit 0 of mode is set
        if (mode & 0x01) {
          this.setReg16(rr, (addr + 1) & 0xffff);
        }
        cyc = 6;
        break;
      }

      // 0x2B: Direct 16-bit memory transfer: mode: bit7=0 load reg from (addr16), bit7=1 store reg to (addr16)
      case 0x2b: {
        const mode = this.fetch8();
        const r = mode & 0x0f;
        const addr = this.fetch16();
        if ((mode & 0x80) === 0) {
          const v = this.read8(addr);
          this.setReg8(r, v);
          this.setFlagsSZ(v);
        } else {
          this.write8(addr, this.getReg8(r));
        }
        cyc = 7;
        break;
      }

      // 0x2C: EXTS rr
      case 0x2c: {
        const rr = this.fetch8() & 0x0e;
        const lo = this.getReg8(rr + 1);
        this.setReg8(rr, (lo & 0x80) ? 0xff : 0x00);
        cyc = 4;
        break;
      }

      // 0x3A: 16-bit MOVW rr, #imm16
      case 0x3a: {
        const rr = this.fetch8() & 0x0e;
        const imm16 = this.fetch16();
        this.setReg16(rr, imm16);
        cyc = 6;
        break;
      }

      // 0x3B: Indexed 16-bit load/store: mode (bit7=0 load r from rr+disp8, bit7=1 store r to rr+disp8)
      case 0x3b: {
        const mode = this.fetch8();
        const r = (mode >> 4) & 0x07;
        const rr = mode & 0x0e;
        const disp = (this.fetch8() << 24) >> 24;
        const addr = (this.getReg16(rr) + disp) & 0xffff;
        if ((mode & 0x80) === 0) {
          const v = this.read8(addr);
          this.setReg8(r, v);
          this.setFlagsSZ(v);
        } else {
          this.write8(addr, this.getReg8(r));
        }
        cyc = 7;
        break;
      }

      // 0x3C: MUL d_hi, s_lo (8x8 -> 16-bit into rr)
      case 0x3c: {
        const rr = this.fetch8() & 0x0e;
        const a = this.getReg8(rr);
        const b = this.getReg8(rr + 1);
        const prod = (a * b) & 0xffff;
        this.setReg16(rr, prod);
        this.internalRam[REG_PS1] = (this.internalRam[REG_PS1] & ~FLAG_Z) | (prod === 0 ? FLAG_Z : 0);
        cyc = 12;
        break;
      }

      // 0x3D: DIV rr, r_div (16 / 8 -> quotient in rr_lo, remainder in rr_hi)
      case 0x3d: {
        const rr = this.fetch8() & 0x0e;
        const divisorReg = this.fetch8() & 0x0f;
        const dividend = this.getReg16(rr);
        const divisor = this.getReg8(divisorReg);
        if (divisor !== 0) {
          const q = Math.floor(dividend / divisor) & 0xff;
          const rem = (dividend % divisor) & 0xff;
          this.setReg8(rr, rem);
          this.setReg8(rr + 1, q);
          this.internalRam[REG_PS1] = (this.internalRam[REG_PS1] & ~(FLAG_Z | FLAG_V)) | (q === 0 ? FLAG_Z : 0);
        } else {
          this.internalRam[REG_PS1] |= FLAG_V;
        }
        cyc = 16;
        break;
      }

      // 0x3E: JMP
      case 0x3e: {
        const mode = this.fetch8();
        if ((mode & 0x40) !== 0) {
          // Absolute 16-bit JMP
          this.pc = this.fetch16();
        } else {
          // Indirect via register pair rr
          this.pc = this.getReg16(mode & 0x0e);
        }
        cyc = 6;
        break;
      }

      // 0x3F: CALL
      case 0x3f: {
        const mode = this.fetch8();
        let target: number;
        if ((mode & 0x40) !== 0) {
          target = this.fetch16();
        } else {
          target = this.getReg16(mode & 0x0e);
        }
        this.push16(this.pc);
        this.pc = target;
        cyc = 9;
        break;
      }

      // 0x40 - 0x4F: Fast MOV R0..R15, #imm8
      case 0x40: case 0x41: case 0x42: case 0x43:
      case 0x44: case 0x45: case 0x46: case 0x47:
      case 0x48: case 0x49: case 0x4a: case 0x4b:
      case 0x4c: case 0x4d: case 0x4e: case 0x4f: {
        const imm = this.fetch8();
        this.setReg8(op & 0x0f, imm);
        cyc = 4;
        break;
      }

      // 0x50 - 0x57: INCW rr (16-bit increment on RR0..RR14)
      case 0x50: case 0x51: case 0x52: case 0x53:
      case 0x54: case 0x55: case 0x56: case 0x57: {
        const rr = (op & 0x07) * 2;
        const res = (this.getReg16(rr) + 1) & 0xffff;
        this.setReg16(rr, res);
        this.internalRam[REG_PS1] = (this.internalRam[REG_PS1] & ~FLAG_Z) | (res === 0 ? FLAG_Z : 0);
        cyc = 5;
        break;
      }

      // 0x58 - 0x5F: DECW rr
      case 0x58: case 0x59: case 0x5a: case 0x5b:
      case 0x5c: case 0x5d: case 0x5e: case 0x5f: {
        const rr = (op & 0x07) * 2;
        const res = (this.getReg16(rr) - 1) & 0xffff;
        this.setReg16(rr, res);
        this.internalRam[REG_PS1] = (this.internalRam[REG_PS1] & ~FLAG_Z) | (res === 0 ? FLAG_Z : 0);
        cyc = 5;
        break;
      }

      // 0x60 - 0x67: BCLR addr8, bit(0..7)
      case 0x60: case 0x61: case 0x62: case 0x63:
      case 0x64: case 0x65: case 0x66: case 0x67: {
        const d = this.fetch8();
        const mask = ~(1 << (op & 0x07)) & 0xff;
        this.write8(d, this.read8(d) & mask);
        cyc = 5;
        break;
      }

      // 0x68 - 0x6F: BSET addr8, bit(0..7)
      case 0x68: case 0x69: case 0x6a: case 0x6b:
      case 0x6c: case 0x6d: case 0x6e: case 0x6f: {
        const d = this.fetch8();
        const mask = 1 << (op & 0x07);
        this.write8(d, this.read8(d) | mask);
        cyc = 5;
        break;
      }

      // 0x70 - 0x77: BTST addr8, bit(0..7) (Sets Z flag if bit is 0, clears Z if bit is 1)
      case 0x70: case 0x71: case 0x72: case 0x73:
      case 0x74: case 0x75: case 0x76: case 0x77: {
        const d = this.fetch8();
        const bit = (this.read8(d) >> (op & 0x07)) & 1;
        this.internalRam[REG_PS1] = (this.internalRam[REG_PS1] & ~FLAG_Z) | (bit === 0 ? FLAG_Z : 0);
        cyc = 4;
        break;
      }

      // 0x78 - 0x7F: PUSHW / POPW / ADDW / SUBW / CMPW
      case 0x78: { // PUSHW rr
        const rr = this.fetch8() & 0x0e;
        this.push16(this.getReg16(rr));
        cyc = 6;
        break;
      }
      case 0x79: { // POPW rr
        const rr = this.fetch8() & 0x0e;
        this.setReg16(rr, this.pop16());
        cyc = 6;
        break;
      }
      case 0x7a: { // ADDW rr, #imm16
        const rr = this.fetch8() & 0x0e;
        const imm = this.fetch16();
        const a = this.getReg16(rr);
        const res = a + imm;
        this.setReg16(rr, res & 0xffff);
        let ps1 = this.internalRam[REG_PS1] & ~(FLAG_C | FLAG_Z | FLAG_S);
        if (res > 0xffff) ps1 |= FLAG_C;
        if ((res & 0xffff) === 0) ps1 |= FLAG_Z;
        if (res & 0x8000) ps1 |= FLAG_S;
        this.internalRam[REG_PS1] = ps1;
        cyc = 7;
        break;
      }
      case 0x7b: { // SUBW rr, #imm16
        const rr = this.fetch8() & 0x0e;
        const imm = this.fetch16();
        const a = this.getReg16(rr);
        const res = a - imm;
        this.setReg16(rr, res & 0xffff);
        let ps1 = this.internalRam[REG_PS1] & ~(FLAG_C | FLAG_Z | FLAG_S);
        if (res < 0) ps1 |= FLAG_C;
        if ((res & 0xffff) === 0) ps1 |= FLAG_Z;
        if (res & 0x8000) ps1 |= FLAG_S;
        this.internalRam[REG_PS1] = ps1;
        cyc = 7;
        break;
      }
      case 0x7c: { // CMPW rr, #imm16
        const rr = this.fetch8() & 0x0e;
        const imm = this.fetch16();
        const a = this.getReg16(rr);
        const res = a - imm;
        let ps1 = this.internalRam[REG_PS1] & ~(FLAG_C | FLAG_Z | FLAG_S);
        if (res < 0) ps1 |= FLAG_C;
        if ((res & 0xffff) === 0) ps1 |= FLAG_Z;
        if (res & 0x8000) ps1 |= FLAG_S;
        this.internalRam[REG_PS1] = ps1;
        cyc = 6;
        break;
      }
      case 0x7d: { // ADDW rr_dst, rr_src
        const d = this.fetch8() & 0x0e;
        const s = this.fetch8() & 0x0e;
        const res = this.getReg16(d) + this.getReg16(s);
        this.setReg16(d, res & 0xffff);
        let ps1 = this.internalRam[REG_PS1] & ~(FLAG_C | FLAG_Z | FLAG_S);
        if (res > 0xffff) ps1 |= FLAG_C;
        if ((res & 0xffff) === 0) ps1 |= FLAG_Z;
        if (res & 0x8000) ps1 |= FLAG_S;
        this.internalRam[REG_PS1] = ps1;
        cyc = 7;
        break;
      }
      case 0x7e: { // MOV (addr16), #imm8
        const addr = this.fetch16();
        const imm = this.fetch8();
        this.write8(addr, imm);
        cyc = 6;
        break;
      }
      case 0x7f: { // MOVW (addr16), rr
        const addr = this.fetch16();
        const rr = this.fetch8() & 0x0e;
        this.write16(addr, this.getReg16(rr));
        cyc = 7;
        break;
      }

      // 0x80 - 0x8F: Short MOV R0..R15, R_src (second byte = src)
      case 0x80: case 0x81: case 0x82: case 0x83:
      case 0x84: case 0x85: case 0x86: case 0x87:
      case 0x88: case 0x89: case 0x8a: case 0x8b:
      case 0x8c: case 0x8d: case 0x8e: case 0x8f: {
        const s = this.fetch8();
        const v = this.getReg8(s & 0x0f);
        this.setReg8(op & 0x0f, v);
        this.setFlagsSZ(v);
        cyc = 4;
        break;
      }

      // 0xB0 - 0xBF: Fast CMP R0..R15, #imm8
      case 0xb0: case 0xb1: case 0xb2: case 0xb3:
      case 0xb4: case 0xb5: case 0xb6: case 0xb7:
      case 0xb8: case 0xb9: case 0xba: case 0xbb:
      case 0xbc: case 0xbd: case 0xbe: case 0xbf: {
        const imm = this.fetch8();
        this.aluSub8(this.getReg8(op & 0x0f), imm, 0);
        cyc = 4;
        break;
      }

      // 0xC0 - 0xCF: DBNZ R0..R15, rel8
      case 0xc0: case 0xc1: case 0xc2: case 0xc3:
      case 0xc4: case 0xc5: case 0xc6: case 0xc7:
      case 0xc8: case 0xc9: case 0xca: case 0xcb:
      case 0xcc: case 0xcd: case 0xce: case 0xcf: {
        const rel = (this.fetch8() << 24) >> 24;
        const r = op & 0x0f;
        const v = (this.getReg8(r) - 1) & 0xff;
        this.setReg8(r, v);
        if (v !== 0) {
          this.pc = (this.pc + rel) & 0xffff;
          cyc = 6;
        } else {
          cyc = 4;
        }
        break;
      }

      // 0xD0 - 0xDF: BR cond, rel8
      case 0xd0: case 0xd1: case 0xd2: case 0xd3:
      case 0xd4: case 0xd5: case 0xd6: case 0xd7:
      case 0xd8: case 0xd9: case 0xda: case 0xdb:
      case 0xdc: case 0xdd: case 0xde: case 0xdf: {
        const rel = (this.fetch8() << 24) >> 24;
        if (this.checkCondition(op & 0x0f)) {
          this.pc = (this.pc + rel) & 0xffff;
          cyc = 6;
        } else {
          cyc = 4;
        }
        break;
      }

      // 0xE0 - 0xEF: Fast ADD R0..R15, #imm8
      case 0xe0: case 0xe1: case 0xe2: case 0xe3:
      case 0xe4: case 0xe5: case 0xe6: case 0xe7:
      case 0xe8: case 0xe9: case 0xea: case 0xeb:
      case 0xec: case 0xed: case 0xee: case 0xef: {
        const imm = this.fetch8();
        const r = op & 0x0f;
        this.setReg8(r, this.aluAdd8(this.getReg8(r), imm, 0));
        cyc = 4;
        break;
      }

      // 0xF0 - 0xFF: System & Control Flow
      case 0xf0: { // RET
        this.pc = this.pop16();
        cyc = 8;
        break;
      }
      case 0xf1: { // IRET
        this.internalRam[REG_PS1] = this.pop8();
        this.pc = this.pop16();
        cyc = 10;
        break;
      }
      case 0xf2: { // EI
        this.internalRam[REG_PS1] |= FLAG_I;
        cyc = 3;
        break;
      }
      case 0xf3: { // DI
        this.internalRam[REG_PS1] &= ~FLAG_I;
        cyc = 3;
        break;
      }
      case 0xf4: { // HALT
        this.halted = true;
        cyc = 4;
        break;
      }
      case 0xf5: { // STOP
        this.halted = true;
        cyc = 4;
        break;
      }
      case 0xf6: { // SWI (Software Interrupt)
        this.push16(this.pc);
        this.push8(this.internalRam[REG_PS1]);
        this.internalRam[REG_PS1] &= ~FLAG_I;
        this.pc = 0x1014;
        cyc = 10;
        break;
      }
      case 0xf8: { // CALL rel16 (PC-relative call)
        const rel16 = (this.fetch16() << 16) >> 16;
        this.push16(this.pc);
        this.pc = (this.pc + rel16) & 0xffff;
        cyc = 9;
        break;
      }
      case 0xf9: { // JMP rel16 (PC-relative jump)
        const rel16 = (this.fetch16() << 16) >> 16;
        this.pc = (this.pc + rel16) & 0xffff;
        cyc = 6;
        break;
      }
      case 0xff: { // NOP
        cyc = 3;
        break;
      }
      default: {
        cyc = 4;
        break;
      }
    }

    this.cycles += cyc;
    this.tickPeripherals(cyc);
    return cyc;
  }

  private tickPeripherals(cyc: number): void {
    // Tick Timer 0 (if bit 7 of TM0C enabled)
    const tm0c = this.internalRam[REG_TM0C];
    if (tm0c & 0x80) {
      this.timer0Counter += cyc;
      const reload = Math.max(16, (this.internalRam[REG_TM0D] || 1) * 16);
      if (this.timer0Counter >= reload) {
        this.timer0Counter -= reload;
        this.internalRam[REG_IR0] |= INT_TIMER0;
      }
    }

    // Tick Timer 1 (if bit 7 of TM1C enabled)
    const tm1c = this.internalRam[REG_TM1C];
    if (tm1c & 0x80) {
      this.timer1Counter += cyc;
      const reload = Math.max(16, (this.internalRam[REG_TM1D] || 1) * 64);
      if (this.timer1Counter >= reload) {
        this.timer1Counter -= reload;
        this.internalRam[REG_IR0] |= INT_TIMER1;
      }
    }

    // Scanline timing (~10 MHz / 60 Hz / 168 scanlines ~= 990 cycles/line)
    this.scanlineCycles += cyc;
    if (this.scanlineCycles >= 990) {
      this.scanlineCycles -= 990;
      this.currentLine = (this.currentLine + 1) % 168;
      if (this.currentLine === 160) {
        this.internalRam[REG_IR0] |= INT_VBLANK;
      }
    }
  }

  public runFrame(cyclesPerFrame = 166320): void {
    let executed = 0;
    this.audio.beginFrame();
    while (executed < cyclesPerFrame) {
      this.audio.setFrameCycle(executed);
      executed += this.step();
    }
    this.audio.endFrame(executed);
  }

  public getSnapshot(frameCount: number): CpuSnapshot {
    const regs: number[] = [];
    for (let i = 0; i < 16; i++) {
      regs.push(this.getReg8(i));
    }
    return {
      pc: this.pc,
      sp: this.getSP(),
      ps0: this.internalRam[REG_PS0],
      ps1: this.internalRam[REG_PS1],
      ie0: this.internalRam[REG_IE0],
      ie1: this.internalRam[REG_IE1],
      ir0: this.internalRam[REG_IR0],
      ir1: this.internalRam[REG_IR1],
      mmu: [
        this.internalRam[REG_MMU0],
        this.internalRam[REG_MMU1],
        this.internalRam[REG_MMU2],
        this.internalRam[REG_MMU3],
        this.internalRam[REG_MMU4],
      ],
      lcc: this.internalRam[REG_LCC],
      registers: regs,
      halted: this.halted,
      cycles: this.cycles,
      frameCount,
    };
  }
}
