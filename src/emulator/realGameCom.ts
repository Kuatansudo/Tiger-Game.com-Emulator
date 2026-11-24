import { GameComAudioEngine } from './audio';
import { BiosState, CheatPatchRule, CpuSnapshot, InputButton } from './types';

export const REAL_SCREEN_WIDTH = 200;
export const REAL_SCREEN_HEIGHT = 160;
const CYCLES_PER_FRAME = 92573; // 11.0592 MHz / 2 / 59.732155 Hz
const VBLANK_START_CYCLE = 80000;

// SM8500 Status Flags (PS1)
const FLAG_C = 0x80;
const FLAG_Z = 0x40;
const FLAG_S = 0x20;
const FLAG_V = 0x10;
const FLAG_D = 0x08;
const FLAG_H = 0x04;
const FLAG_B = 0x02;
const FLAG_I = 0x01;

// SM8500 Interrupt Lines
const ILL_INT = 0;
const DMA_INT = 1;
const TIM0_INT = 2;
const EXT_INT = 3;
const UART_INT = 4;
const LCDC_INT = 5;
const TIM1_INT = 6;
const CK_INT = 7;
const PIO_INT = 8;
const WDT_INT = 9;
const NMI_INT = 10;

// Register index -> 16-bit pair offset mapping (non-linear on SM8500)
const SM8500_B2W = [0, 8, 2, 10, 4, 12, 6, 14] as const;

// Timer prescaler limits (halved when passed to upcounter as in MAME gamecom_m.cpp)
const TIMER_LIMIT = [2, 1024, 2048, 4096, 8192, 16384, 32768, 65536] as const;

// SM8521 Internal Register Offsets
const SM8521_IE0 = 0x10;
const SM8521_IE1 = 0x11;
const SM8521_IR0 = 0x12;
const SM8521_IR1 = 0x13;
const SM8521_P0 = 0x14;
const SM8521_P1 = 0x15;
const SM8521_P2 = 0x16;
const SM8521_P3 = 0x17;
const SM8521_SYS = 0x19;
const SM8521_CKC = 0x1a;
const SM8521_SPH = 0x1c;
const SM8521_SPL = 0x1d;
const SM8521_PS0 = 0x1e;
const SM8521_PS1 = 0x1f;

const SM8521_MMU0 = 0x24;
const SM8521_MMU1 = 0x25;
const SM8521_MMU2 = 0x26;
const SM8521_MMU3 = 0x27;
const SM8521_MMU4 = 0x28;
const SM8521_URTT = 0x2b;
const SM8521_URTS = 0x2d;

const SM8521_LCDC = 0x30;
const SM8521_LCH = 0x31;
const SM8521_LCV = 0x32;
const SM8521_DMC = 0x34;
const SM8521_DMX1 = 0x35;
const SM8521_DMY1 = 0x36;
const SM8521_DMDX = 0x37;
const SM8521_DMDY = 0x38;
const SM8521_DMX2 = 0x39;
const SM8521_DMY2 = 0x3a;
const SM8521_DMPL = 0x3b;
const SM8521_DMBR = 0x3c;
const SM8521_DMVP = 0x3d;

const SM8521_TM0C = 0x50;
const SM8521_TM0D = 0x51;
const SM8521_TM1C = 0x52;
const SM8521_TM1D = 0x53;
const SM8521_CLKT = 0x54;
const SM8521_WDTC = 0x5f;

interface BankMapping {
  kind: 'ext' | 'cart' | 'open';
  offset: number;
}

export class RealGameComCore {
  private audio: GameComAudioEngine;

  // CPU State
  public pc = 0x1020;
  public sp = 0x0000;
  public ie0 = 0;
  public ie1 = 0;
  public ir0 = 0;
  public ir1 = 0;
  public sys = 0;
  public ckc = 0;
  public clockChanged = 0;
  public ps0 = 0;
  public ps1 = 0;
  public iflags = 0;
  public checkInterrupts = 0;
  public halted = false;
  public cycles = 0;

  // CPU Register File (0x108 bytes) & Internal RAM / SFRs (0x400 bytes)
  public registerRam = new Uint8Array(0x108);
  public internalRam = new Uint8Array(0x400);
  public extendedRam = new Uint8Array(0x2000); // 0xE000..0xFFFF
  public vram = new Uint8Array(0x4000);        // 0xA000..0xDFFF (2 x 8 KB banks)

  // Firmware & Cartridge Regions
  private internalBios = new Uint8Array(0x1000); // 4 KB @ 0x1000..0x1FFF
  private externalBios = new Uint8Array(0x40000); // 256 KB (32 x 8 KB banks)
  private cartRom = new Uint8Array(0x200000);     // 2 MB mirrored cartridge space
  private rawCartBytes: Uint8Array | null = null;
  private activeRomPatches: CheatPatchRule[] = [];
  private hasCartridge = false;
  private cartEnabled = false;

  public biosState: BiosState = {
    internalLoaded: false,
    externalLoaded: false,
    internalSize: 0,
    externalSize: 0,
    preferBios: true,
  };

  // MMU Bank Sources for slots 1..4 (0x2000..0x9FFF)
  private bankMap: [BankMapping, BankMapping, BankMapping, BankMapping, BankMapping] = [
    { kind: 'ext', offset: 0 },
    { kind: 'ext', offset: 0 },
    { kind: 'ext', offset: 0 },
    { kind: 'ext', offset: 0 },
    { kind: 'ext', offset: 0 },
  ];

  // Timers & Clock
  private timer0 = { enabled: false, prescaleMax: 1, prescaleCount: 0, upcounterMax: 0 };
  private timer1 = { enabled: false, prescaleMax: 1, prescaleCount: 0, upcounterMax: 0 };
  private clockTimerEnabled = false;
  private clockTimerMinutes = false;
  private clockFrameCounter = 0;

  // Active-low hardware button ports
  private ioIn0 = 0xff; // UP, DOWN, LEFT, RIGHT, MENU, PAUSE, SOUND, A
  private ioIn1 = 0xff; // bit0=B, bit1=C
  private ioIn2 = 0xff; // bit0=RESET, bit1=D

  // Stylus 13x10 grid (13 columns, each 10-bit active-high bitmask)
  public touchActive = false;
  public touchX = 0;
  public touchY = 0;
  private gridCols = new Uint16Array(13);

  constructor(audio: GameComAudioEngine) {
    this.audio = audio;
    this.reset();
  }

  public loadInternalBios(bytes: Uint8Array, filename?: string): void {
    this.internalBios.fill(0);
    this.internalBios.set(bytes.subarray(0, 0x1000));
    this.biosState.internalLoaded = true;
    this.biosState.internalSize = bytes.length;
    this.biosState.internalName = filename;
  }

  public loadExternalBios(bytes: Uint8Array, filename?: string): void {
    this.externalBios.fill(0);
    const len = Math.min(bytes.length, 0x40000);
    this.externalBios.set(bytes.subarray(0, len));
    if (len > 0 && len < 0x40000) {
      // Mirror smaller dumps cleanly
      let filled = len;
      while (filled < 0x40000) {
        const chunk = Math.min(filled, 0x40000 - filled);
        this.externalBios.copyWithin(filled, 0, chunk);
        filled += chunk;
      }
    }
    this.biosState.externalLoaded = true;
    this.biosState.externalSize = bytes.length;
    this.biosState.externalName = filename;
  }

  public clearBios(): void {
    this.internalBios.fill(0);
    this.externalBios.fill(0);
    this.biosState = {
      internalLoaded: false,
      externalLoaded: false,
      internalSize: 0,
      externalSize: 0,
      preferBios: this.biosState.preferBios,
    };
  }

  public clearCartridge(): void {
    this.rawCartBytes = null;
    this.cartRom.fill(0xff);
    this.hasCartridge = false;
  }

  public loadCartridge(bytes: Uint8Array): void {
    this.rawCartBytes = new Uint8Array(bytes);
    this.rebuildCartRom();
    this.hasCartridge = true;
  }

  private rebuildCartRom(): void {
    if (!this.rawCartBytes) {
      this.cartRom.fill(0xff);
      return;
    }
    const bytes = new Uint8Array(this.rawCartBytes);
    for (const rule of this.activeRomPatches) {
      if (rule.kind !== 'rom-patch') continue;
      if (rule.address >= 0 && rule.address < bytes.length) {
        bytes[rule.address] = rule.value & 0xff;
      }
    }

    this.cartRom.fill(0);
    const size = Math.min(bytes.length, 0x200000);
    const loadOffset = size === 0x1c0000 ? 0x40000 : 0;
    this.cartRom.set(bytes.subarray(0, size), loadOffset);

    // Mirror content across 2 MB address space per MAME common_load
    if (size > 0 && size !== 0x1c0000) {
      if (size <= 0x008000) this.cartRom.copyWithin(0x008000, 0, 0x008000);
      if (size <= 0x010000) this.cartRom.copyWithin(0x010000, 0, 0x010000);
      if (size <= 0x020000) this.cartRom.copyWithin(0x020000, 0, 0x020000);
      if (size <= 0x040000) this.cartRom.copyWithin(0x040000, 0, 0x040000);
      if (size <= 0x080000) this.cartRom.copyWithin(0x080000, 0, 0x080000);
      if (size <= 0x100000) this.cartRom.copyWithin(0x100000, 0, 0x100000);
    }
  }

  public setRomPatches(rules: CheatPatchRule[]): void {
    this.activeRomPatches = rules.filter((r) => r.kind === 'rom-patch');
    if (this.hasCartridge) {
      this.rebuildCartRom();
    }
  }

  private readCheatRamByte(addr: number): number | null {
    const a = addr & 0xffff;
    if (a < 0x0010) {
      return this.registerRam[a + (this.ps0 & 0xf8)];
    }
    if (a < 0x0400) {
      return this.internalRam[a];
    }
    if (a >= 0xe000) {
      return this.extendedRam[a - 0xe000];
    }
    return null;
  }

  private writeCheatRamByte(addr: number, val: number): void {
    const a = addr & 0xffff;
    const v = val & 0xff;
    if (a < 0x0010) {
      this.registerRam[a + (this.ps0 & 0xf8)] = v;
      this.internalRam[a] = v;
    } else if (a < 0x0400) {
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

  public reset(): void {
    this.registerRam.fill(0);
    this.internalRam.fill(0);
    this.extendedRam.fill(0);
    this.vram.fill(0);

    this.pc = 0x1020;
    this.clockChanged = 0;
    this.checkInterrupts = 0;
    this.halted = false;
    this.iflags = 0;
    this.cycles = 0;

    this.ie0 = 0;
    this.ie1 = 0;
    this.ir0 = 0;
    this.ir1 = 0;
    this.sys = 0;
    this.ckc = 0;
    this.ps0 = 0;
    this.ps1 = 0;
    this.sp = 0;

    this.cartEnabled = false;
    for (let i = 0; i < 5; i++) {
      this.bankMap[i] = { kind: 'ext', offset: 0 };
    }

    this.timer0 = { enabled: false, prescaleMax: 1, prescaleCount: 0, upcounterMax: 0 };
    this.timer1 = { enabled: false, prescaleMax: 1, prescaleCount: 0, upcounterMax: 0 };
    this.clockTimerEnabled = false;
    this.clockTimerMinutes = false;
    this.clockFrameCounter = 0;

    // SM8500 reset register defaults
    this.internalRam[SM8521_P0] = 0xff;
    this.internalRam[SM8521_P1] = 0xff;
    this.internalRam[SM8521_P2] = 0xff;
    this.internalRam[SM8521_P3] = 0x00;
    this.internalRam[SM8521_URTT] = 0xff;
    this.internalRam[SM8521_URTS] = 0x42;
    this.internalRam[SM8521_WDTC] = 0x38;

    // Game.com machine reset LCD defaults
    this.internalRam[SM8521_LCH] = 0x07;
    this.internalRam[SM8521_LCV] = 0x27;
    this.internalRam[SM8521_LCDC] = 0xb0;

    this.audio.silenceAll();
  }

  public setButton(btn: InputButton, pressed: boolean): void {
    const setActiveLow = (port: 0 | 1 | 2, mask: number) => {
      if (port === 0) {
        this.ioIn0 = pressed ? this.ioIn0 & ~mask : this.ioIn0 | mask;
      } else if (port === 1) {
        this.ioIn1 = pressed ? this.ioIn1 & ~mask : this.ioIn1 | mask;
      } else {
        this.ioIn2 = pressed ? this.ioIn2 & ~mask : this.ioIn2 | mask;
      }
    };

    switch (btn) {
      case 'UP': setActiveLow(0, 0x01); break;
      case 'DOWN': setActiveLow(0, 0x02); break;
      case 'LEFT': setActiveLow(0, 0x04); break;
      case 'RIGHT': setActiveLow(0, 0x08); break;
      case 'MENU': setActiveLow(0, 0x10); break;
      case 'PAUSE': setActiveLow(0, 0x20); break;
      case 'SOUND': setActiveLow(0, 0x40); break;
      case 'A': setActiveLow(0, 0x80); break;
      case 'B': setActiveLow(1, 0x01); break;
      case 'C': setActiveLow(1, 0x02); break;
      case 'D': setActiveLow(2, 0x02); break;
    }

    // Re-apply current P1/P2 input mux immediately if active
    this.handleInputPress(this.internalRam[SM8521_P1] | (this.internalRam[SM8521_P2] << 8));
  }

  public setTouch(active: boolean, x: number, y: number): void {
    this.touchActive = active;
    this.touchX = Math.max(0, Math.min(REAL_SCREEN_WIDTH - 1, Math.round(x)));
    this.touchY = Math.max(0, Math.min(REAL_SCREEN_HEIGHT - 1, Math.round(y)));
    this.gridCols.fill(0);
    if (active) {
      // 13 columns: cols 0..11 are 16px wide (0..191), col 12 is 8px wide (192..199)
      const col = Math.min(12, this.touchX >> 4);
      const row = Math.min(9, this.touchY >> 4);
      this.gridCols[col] = (1 << row) & 0x3ff;
    }
    this.handleInputPress(this.internalRam[SM8521_P1] | (this.internalRam[SM8521_P2] << 8));
  }

  private getSp(): void {
    this.sp = this.internalRam[SM8521_SPL];
    if (this.sys & 0x40) {
      this.sp |= this.internalRam[SM8521_SPH] << 8;
    }
  }

  private pushByte(val: number): void {
    this.sp = (this.sp - 1) & 0xffff;
    if ((this.sys & 0x40) === 0) {
      this.sp &= 0xff;
    }
    this.memWriteByte(this.sp, val & 0xff);
  }

  private popByte(): number {
    const val = this.memReadByte(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    if ((this.sys & 0x40) === 0) {
      this.sp &= 0xff;
    }
    return val;
  }

  private readBusByte(addr: number): number {
    addr &= 0xffff;
    if (addr < 0x0400) {
      return this.internalRam[addr];
    }
    if (addr < 0x1000) {
      return 0x00;
    }
    if (addr < 0x2000) {
      return this.internalBios[addr - 0x1000];
    }
    if (addr < 0xa000) {
      const slot = addr >> 13; // 1..4
      const map = this.bankMap[slot];
      const rel = addr & 0x1fff;
      if (map.kind === 'cart') {
        return this.cartRom[(map.offset + rel) & 0x1fffff];
      }
      if (map.kind === 'open') {
        return 0xff;
      }
      return this.externalBios[(map.offset + rel) & 0x3ffff];
    }
    if (addr < 0xe000) {
      // VRAM is write-only on Game.com (returns 0 on read, as expected by games)
      return 0x00;
    }
    return this.extendedRam[addr - 0xe000];
  }

  private writeBusByte(addr: number, data: number): void {
    addr &= 0xffff;
    data &= 0xff;

    if (addr < 0x0400) {
      if (addr >= 0x14 && addr <= 0x17) {
        this.writePio(addr, data);
        return;
      }
      if (addr >= 0x20 && addr <= 0x7f) {
        this.writeInternalReg(addr, data);
        return;
      }
      this.internalRam[addr] = data;
      return;
    }
    if (addr < 0xa000) {
      return; // ROM / open bus
    }
    if (addr < 0xe000) {
      this.vram[addr - 0xa000] = data;
      return;
    }
    this.extendedRam[addr - 0xe000] = data;
  }

  public memReadByte(offset: number): number {
    offset &= 0xffff;
    if (offset < 0x10) {
      return this.registerRam[offset + (this.ps0 & 0xf8)];
    }
    return this.readBusByte(offset);
  }

  public memWriteByte(offset: number, data: number): void {
    offset &= 0xffff;
    data &= 0xff;
    if (offset < 0x10) {
      this.registerRam[offset + (this.ps0 & 0xf8)] = data;
    }
    this.writeBusByte(offset, data);

    switch (offset) {
      case SM8521_IE0: this.ie0 = data; break;
      case SM8521_IE1: this.ie1 = data; break;
      case SM8521_IR0: this.ir0 = data; break;
      case SM8521_IR1: this.ir1 = data; break;
      case SM8521_SYS: this.sys = data; break;
      case SM8521_CKC: this.ckc = data; break;
      case SM8521_SPH:
      case SM8521_SPL:
        this.getSp();
        break;
      case SM8521_PS0:
        this.ps0 = data;
        for (let i = 0; i < 16; i++) {
          this.internalRam[i] = this.registerRam[i + (this.ps0 & 0xf8)];
        }
        break;
      case SM8521_PS1: this.ps1 = data; break;
    }
  }

  public memReadWord(addr: number): number {
    return (this.memReadByte(addr) << 8) | this.memReadByte((addr + 1) & 0xffff);
  }

  public memWriteWord(addr: number, val: number): void {
    this.memWriteByte(addr, (val >> 8) & 0xff);
    this.memWriteByte((addr + 1) & 0xffff, val & 0xff);
  }

  private setMmuBank(slot: 1 | 2 | 3 | 4, bank: number): void {
    if (bank < 0x20) {
      this.bankMap[slot] = { kind: 'ext', offset: (bank << 13) & 0x3ffff };
    } else if (this.cartEnabled && this.hasCartridge) {
      this.bankMap[slot] = { kind: 'cart', offset: (bank << 13) & 0x1fffff };
    } else {
      this.bankMap[slot] = { kind: 'open', offset: 0 };
    }
  }

  private handleStylusPress(column: number): void {
    const data = this.gridCols[column] ?? 0;
    if (data !== 0) {
      const stylusY = data ^ 0x3ff;
      this.internalRam[SM8521_P0] = stylusY & 0xff;
      this.internalRam[SM8521_P1] = (this.internalRam[SM8521_P1] & 0xfc) | ((stylusY >> 8) & 0x03);
    } else {
      this.internalRam[SM8521_P0] = 0xff;
      this.internalRam[SM8521_P1] |= 0x03;
    }
  }

  private handleInputPress(muxData: number): void {
    switch (muxData) {
      case 0xfffb: this.handleStylusPress(0); break;
      case 0xfff7: this.handleStylusPress(1); break;
      case 0xffef: this.handleStylusPress(2); break;
      case 0xffdf: this.handleStylusPress(3); break;
      case 0xffbf: this.handleStylusPress(4); break;
      case 0xff7f: this.handleStylusPress(5); break;
      case 0xfeff: this.handleStylusPress(6); break;
      case 0xfdff: this.handleStylusPress(7); break;
      case 0xfbff: this.handleStylusPress(8); break;
      case 0xf7ff: this.handleStylusPress(9); break;
      case 0xefff: this.handleStylusPress(10); break;
      case 0xdfff: this.handleStylusPress(11); break;
      case 0xbfff: this.handleStylusPress(12); break;
      case 0x7fff:
        this.internalRam[SM8521_P0] = this.ioIn0;
        this.internalRam[SM8521_P1] = (this.internalRam[SM8521_P1] & 0xfc) | (this.ioIn1 & 0x03);
        break;
      case 0xffff:
        this.internalRam[SM8521_P0] = (this.internalRam[SM8521_P0] & 0xfc) | (this.ioIn2 & 0x03);
        this.internalRam[SM8521_P1] = 0xff;
        break;
    }
  }

  private writePio(offset: number, data: number): void {
    this.internalRam[offset] = data;
    if (offset === SM8521_P1 || offset === SM8521_P2) {
      this.handleInputPress(this.internalRam[SM8521_P1] | (this.internalRam[SM8521_P2] << 8));
    } else if (offset === SM8521_P3) {
      // Slot 1 active on (P3 & 0xC0) === 0x40; Slot 2 active on 0x80 (unpopulated)
      const nextEnabled = (data & 0xc0) === 0x40 && this.hasCartridge;
      if (nextEnabled !== this.cartEnabled) {
        this.cartEnabled = nextEnabled;
        this.setMmuBank(1, this.internalRam[SM8521_MMU1]);
        this.setMmuBank(2, this.internalRam[SM8521_MMU2]);
        this.setMmuBank(3, this.internalRam[SM8521_MMU3]);
        this.setMmuBank(4, this.internalRam[SM8521_MMU4]);
      }
    }
  }

  private writeInternalReg(offset: number, data: number): void {
    switch (offset) {
      case SM8521_MMU0:
        break; // Never swapped out on Game.com
      case SM8521_MMU1:
        this.setMmuBank(1, data);
        break;
      case SM8521_MMU2:
        this.setMmuBank(2, data);
        break;
      case SM8521_MMU3:
        this.setMmuBank(3, data);
        break;
      case SM8521_MMU4:
        this.setMmuBank(4, data);
        break;
      case SM8521_DMBR:
        data &= 0x7f;
        break;
      case SM8521_TM0D:
        this.timer0.upcounterMax = data;
        data = 0;
        break;
      case SM8521_TM0C:
        this.timer0.enabled = (data & 0x80) !== 0;
        this.timer0.prescaleMax = TIMER_LIMIT[data & 0x07] >> 1;
        this.timer0.prescaleCount = 0;
        this.internalRam[SM8521_TM0D] = 0;
        break;
      case SM8521_TM1D:
        this.timer1.upcounterMax = data;
        data = 0;
        break;
      case SM8521_TM1C:
        this.timer1.enabled = (data & 0x80) !== 0;
        this.timer1.prescaleMax = TIMER_LIMIT[data & 0x07] >> 1;
        this.timer1.prescaleCount = 0;
        this.internalRam[SM8521_TM1D] = 0;
        break;
      case SM8521_CLKT:
        if (data & 0x80) {
          this.clockTimerEnabled = true;
          this.clockTimerMinutes = (data & 0x40) !== 0;
        } else {
          this.clockTimerEnabled = false;
          data &= 0xc0;
        }
        break;
      default:
        if ((offset >= 0x40 && offset <= 0x4e) || (offset >= 0x60 && offset <= 0x7f)) {
          this.audio.updateRealRegister(offset, data);
        }
        break;
    }
    this.internalRam[offset] = data;
  }

  private setInputLine(irq: number, asserted: boolean): void {
    this.ir0 = this.internalRam[SM8521_IR0];
    this.ir1 = this.internalRam[SM8521_IR1];
    if (asserted) {
      this.iflags |= 1 << irq;
      this.checkInterrupts = 1;
      switch (irq) {
        case DMA_INT: this.ir0 |= 0x80; break;
        case TIM0_INT: this.ir0 |= 0x40; break;
        case EXT_INT: this.ir0 |= 0x10; break;
        case UART_INT: this.ir0 |= 0x08; break;
        case LCDC_INT: this.ir0 |= 0x01; break;
        case TIM1_INT: this.ir1 |= 0x40; break;
        case CK_INT: this.ir1 |= 0x10; break;
        case PIO_INT: this.ir1 |= 0x04; break;
      }
    } else {
      this.iflags &= ~(1 << irq);
      switch (irq) {
        case DMA_INT: this.ir0 &= ~0x80; break;
        case TIM0_INT: this.ir0 &= ~0x40; break;
        case EXT_INT: this.ir0 &= ~0x10; break;
        case UART_INT: this.ir0 &= ~0x08; break;
        case LCDC_INT: this.ir0 &= ~0x01; break;
        case TIM1_INT: this.ir1 &= ~0x40; break;
        case CK_INT: this.ir1 &= ~0x10; break;
        case PIO_INT: this.ir1 &= ~0x04; break;
      }
      if (this.iflags === 0) {
        this.checkInterrupts = 0;
      }
    }
    this.internalRam[SM8521_IR0] = this.ir0;
    this.internalRam[SM8521_IR1] = this.ir1;
  }

  private takeInterrupt(vector: number): void {
    this.getSp();
    this.sys = this.internalRam[SM8521_SYS];
    this.ps1 = this.internalRam[SM8521_PS1];
    this.pushByte(this.pc & 0xff);
    this.pushByte((this.pc >> 8) & 0xff);
    this.pushByte(this.ps1);
    this.ps1 &= ~FLAG_I;
    this.internalRam[SM8521_PS1] = this.ps1;
    this.internalRam[SM8521_SPL] = this.sp & 0xff;
    if (this.sys & 0x40) {
      this.internalRam[SM8521_SPH] = (this.sp >> 8) & 0xff;
    }
    this.pc = this.memReadWord(vector);
  }

  private processInterrupts(): void {
    if (!this.checkInterrupts) return;
    for (let irqline = 0; irqline < 11; irqline++) {
      if ((this.iflags & (1 << irqline)) !== 0) {
        this.halted = false;
        this.ie0 = this.internalRam[SM8521_IE0];
        this.ie1 = this.internalRam[SM8521_IE1];
        this.ir0 = this.internalRam[SM8521_IR0];
        this.ir1 = this.internalRam[SM8521_IR1];
        this.ps0 = this.internalRam[SM8521_PS0];
        this.ps1 = this.internalRam[SM8521_PS1];
        const prio = this.ps0 & 0x07;
        const ei = (this.ps1 & FLAG_I) !== 0;

        switch (irqline) {
          case WDT_INT:
            this.takeInterrupt(0x101c);
            break;
          case ILL_INT:
          case NMI_INT:
            this.takeInterrupt(0x101e);
            break;
          case DMA_INT:
            this.ir0 |= 0x80;
            if ((this.ie0 & 0x80) && ei) this.takeInterrupt(0x1000);
            break;
          case TIM0_INT:
            this.ir0 |= 0x40;
            if ((this.ie0 & 0x40) && ei) this.takeInterrupt(0x1002);
            break;
          case EXT_INT:
            this.ir0 |= 0x10;
            if ((this.ie0 & 0x10) && prio < 7 && ei) this.takeInterrupt(0x1006);
            break;
          case UART_INT:
            this.ir0 |= 0x08;
            if ((this.ie0 & 0x08) && prio < 6 && ei) this.takeInterrupt(0x1008);
            break;
          case LCDC_INT:
            this.ir0 |= 0x01;
            if ((this.ie0 & 0x01) && prio < 5 && ei) this.takeInterrupt(0x100e);
            break;
          case TIM1_INT:
            this.ir1 |= 0x40;
            if ((this.ie1 & 0x40) && prio < 4 && ei) this.takeInterrupt(0x1012);
            break;
          case CK_INT:
            this.ir1 |= 0x10;
            if ((this.ie1 & 0x10) && prio < 3 && ei) this.takeInterrupt(0x1016);
            break;
          case PIO_INT:
            this.ir1 |= 0x04;
            if ((this.ie1 & 0x04) && prio < 2 && ei) this.takeInterrupt(0x101a);
            break;
        }
        this.iflags &= ~(1 << irqline);
        this.internalRam[SM8521_IR0] = this.ir0;
        this.internalRam[SM8521_IR1] = this.ir1;
      }
    }
    if (this.iflags === 0) {
      this.checkInterrupts = 0;
    }
  }

  private handleDma(): void {
    const dmc = this.internalRam[SM8521_DMC];
    if ((dmc & 0x80) === 0) return;

    const overwrite = (dmc & 0x01) !== 0;
    const transferMode = dmc & 0x06;
    const adjustX = (dmc & 0x08) !== 0 ? -1 : 1;
    const decrementY = (dmc & 0x10) !== 0;

    const blockWidth = this.internalRam[SM8521_DMDX];
    const blockHeight = this.internalRam[SM8521_DMDY];
    const sourceX = this.internalRam[SM8521_DMX1];
    const sourceY = this.internalRam[SM8521_DMY1];
    const destX = this.internalRam[SM8521_DMX2];
    const destY = this.internalRam[SM8521_DMY2];
    const palette = this.internalRam[SM8521_DMPL];
    const dmvp = this.internalRam[SM8521_DMVP];
    const dmbr = this.internalRam[SM8521_DMBR];

    let sourceWidth = (this.internalRam[SM8521_LCH] & 0x20) !== 0 ? 50 : 40;
    let destWidth = sourceWidth;
    let sourceMask = 0x1fff;
    const destMask = 0x1fff;

    let srcArr = this.vram;
    let srcBase = (dmvp & 0x01) !== 0 ? 0x2000 : 0x0000;
    let dstArr = this.vram;
    let dstBase = (dmvp & 0x02) !== 0 ? 0x2000 : 0x0000;

    switch (transferMode) {
      case 0x00: // VRAM -> VRAM
        break;
      case 0x02: // ROM -> VRAM
        sourceWidth = 64;
        sourceMask = 0x3fff;
        if (dmbr < 16) {
          srcArr = this.externalBios;
          srcBase = (dmbr << 14) & 0x3ffff;
        } else if (this.cartEnabled && this.hasCartridge) {
          srcArr = this.cartRom;
          srcBase = (dmbr << 14) & 0x1fffff;
        }
        break;
      case 0x04: // ExtRAM -> VRAM
        sourceWidth = 64;
        srcArr = this.extendedRam;
        srcBase = 0;
        break;
      case 0x06: // VRAM -> ExtRAM
        destWidth = 64;
        dstArr = this.extendedRam;
        dstBase = 0;
        break;
    }

    let sourceLine = sourceWidth * sourceY + (sourceX >> 2);
    let destLine = destWidth * destY + (destX >> 2);
    let sourceCurrent = sourceLine;
    let destCurrent = destLine;
    let sourceXCurrent = sourceX & 3;
    let destXCurrent = destX & 3;

    for (let yc = 0; yc <= blockHeight; yc++) {
      for (let xc = 0; xc <= blockWidth; xc++) {
        const srcAddr = srcBase + (sourceCurrent & sourceMask);
        const dstAddr = dstBase + (destCurrent & destMask);
        const dstAdj = (destXCurrent ^ 3) << 1;
        const srcAdj = (sourceXCurrent ^ 3) << 1;

        const sourcePixel = (srcArr[srcAddr] >> srcAdj) & 0x03;
        if (overwrite || sourcePixel !== 0) {
          const otherPixels = dstArr[dstAddr] & ~(3 << dstAdj);
          const mapped = (palette >> (sourcePixel << 1)) & 0x03;
          dstArr[dstAddr] = otherPixels | (mapped << dstAdj);
        }

        sourceXCurrent += adjustX;
        if ((sourceXCurrent & 4) !== 0) {
          sourceCurrent += adjustX;
          sourceXCurrent &= 3;
        }
        destXCurrent += 1;
        if ((destXCurrent & 4) !== 0) {
          destCurrent += 1;
          destXCurrent &= 3;
        }
      }

      sourceXCurrent = sourceX & 3;
      destXCurrent = destX & 3;
      sourceLine += decrementY ? -sourceWidth : sourceWidth;
      sourceCurrent = sourceLine;
      destLine += destWidth;
      destCurrent = destLine;
    }

    this.internalRam[SM8521_DMC] &= 0x7f;
    this.setInputLine(DMA_INT, true);
  }

  private updateTimers(deltaCycles: number): void {
    if (this.timer0.enabled) {
      this.timer0.prescaleCount += deltaCycles;
      while (this.timer0.prescaleCount >= this.timer0.prescaleMax) {
        this.timer0.prescaleCount -= this.timer0.prescaleMax;
        this.internalRam[SM8521_TM0D] = (this.internalRam[SM8521_TM0D] + 1) & 0xff;
        if (this.internalRam[SM8521_TM0D] >= this.timer0.upcounterMax) {
          this.internalRam[SM8521_TM0D] = 0;
          if ((this.internalRam[SM8521_IE0] & 0x40) !== 0 && (this.internalRam[SM8521_PS1] & 0x01) !== 0) {
            this.setInputLine(TIM0_INT, true);
          }
        }
      }
    }

    if (this.timer1.enabled) {
      this.timer1.prescaleCount += deltaCycles;
      while (this.timer1.prescaleCount >= this.timer1.prescaleMax) {
        this.timer1.prescaleCount -= this.timer1.prescaleMax;
        this.internalRam[SM8521_TM1D] = (this.internalRam[SM8521_TM1D] + 1) & 0xff;
        if (this.internalRam[SM8521_TM1D] >= this.timer1.upcounterMax) {
          this.internalRam[SM8521_TM1D] = 0;
          if (
            (this.internalRam[SM8521_IE1] & 0x40) !== 0 &&
            (this.internalRam[SM8521_PS1] & 0x01) !== 0 &&
            (this.internalRam[SM8521_PS0] & 0x07) < 4
          ) {
            this.setInputLine(TIM1_INT, true);
          }
        }
      }
    }
  }

  public step(): number {
    this.processInterrupts();

    let mycycles = 0;
    if (!this.halted) {
      mycycles = this.executeOneInstruction();
    } else {
      mycycles = 4;
      this.handleDma();
    }
    this.updateTimers(mycycles);
    this.cycles += mycycles;
    return mycycles;
  }

  public runFrame(): void {
    let frameCycles = 0;
    let vblankTriggered = false;
    // Active display scan: clear LCV bit 7
    this.internalRam[SM8521_LCV] &= 0x7f;

    this.audio.beginFrame();
    while (frameCycles < CYCLES_PER_FRAME) {
      this.audio.setFrameCycle(frameCycles);
      const c = this.step();
      frameCycles += c;
      if (!vblankTriggered && frameCycles >= VBLANK_START_CYCLE) {
        vblankTriggered = true;
        this.internalRam[SM8521_LCV] |= 0x80;
        this.setInputLine(LCDC_INT, true);
      }
    }
    this.audio.endFrame(frameCycles);

    // Real-time Clock timer (CLKT) at 1 Hz (60 frames) or 1/60 Hz (3600 frames)
    if (this.clockTimerEnabled) {
      this.clockFrameCounter++;
      const threshold = this.clockTimerMinutes ? 3600 : 60;
      if (this.clockFrameCounter >= threshold) {
        this.clockFrameCounter = 0;
        const val = (this.internalRam[SM8521_CLKT] + 1) & 0x3f;
        this.internalRam[SM8521_CLKT] = (this.internalRam[SM8521_CLKT] & 0xc0) | val;
        this.setInputLine(CK_INT, true);
      }
    }
  }

  private executeOneInstruction(): number {
    const op = this.memReadByte(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    this.sys = this.internalRam[SM8521_SYS];
    this.ps0 = this.internalRam[SM8521_PS0];
    this.ps1 = this.internalRam[SM8521_PS1];
    this.getSp();

    let mycycles = 0;
    let r1 = 0;
    let r2 = 0;
    let s1 = 0;
    let s2 = 0;
    let d1 = 0;
    let d2 = 0;
    let res = 0;

    const fetchByte = (): number => {
      const v = this.memReadByte(this.pc);
      this.pc = (this.pc + 1) & 0xffff;
      return v;
    };

    const fetchWord = (): number => {
      const v = this.memReadWord(this.pc);
      this.pc = (this.pc + 2) & 0xffff;
      return v;
    };

    const s8 = (b: number): number => (b & 0x80 ? b - 256 : b);

    const argR = () => { r1 = fetchByte(); };
    const argRR = () => { r2 = fetchByte(); r1 = fetchByte(); };
    const argrR = () => { r1 = op & 0x07; r2 = fetchByte(); };
    const argiR = () => { r2 = fetchByte(); r1 = fetchByte(); };
    const argSw = () => { r1 = fetchByte(); s2 = fetchWord(); };
    const argrrw = () => { r1 = SM8500_B2W[op & 0x07]; s2 = fetchWord(); };
    const argri = () => { r1 = op & 0x07; r2 = fetchByte(); };
    const argpi = () => { r1 = 0x10 + (op & 0x07); r2 = fetchByte(); };
    const argd8 = () => { r1 = fetchByte(); s2 = (this.pc + s8(r1)) & 0xffff; };
    const argRbr = () => { r1 = fetchByte(); r2 = fetchByte(); s2 = (this.pc + s8(r2)) & 0xffff; };
    const argAd16 = () => { s2 = fetchWord(); };
    const argRiR = () => { r1 = fetchByte(); d1 = fetchByte(); r2 = fetchByte(); };
    const argRii = () => { r1 = fetchByte(); d1 = fetchByte(); r2 = fetchByte(); };

    const argRmb = () => {
      r1 = fetchByte();
      s2 = 0;
      switch (r1 & 0xc0) {
        case 0x00:
          s2 = this.memReadByte(r1 & 0x07);
          break;
        case 0x40:
          s2 = this.memReadByte(r1 & 0x07);
          this.memWriteByte(r1 & 0x07, (s2 + 1) & 0xff);
          break;
        case 0x80:
          s2 = fetchByte();
          if (r1 & 0x07) {
            s2 = (s2 + this.memReadByte(r1 & 0x07)) & 0xffff;
          }
          break;
        case 0xc0: {
          const prev = this.memReadByte(r1 & 0x07);
          s2 = prev;
          this.memWriteByte(r1 & 0x07, (prev - 1) & 0xff);
          break;
        }
      }
      r2 = r1;
      r1 = (r1 >> 3) & 0x07;
    };

    const argRmw = () => {
      r1 = fetchByte();
      s2 = 0;
      const regAddr = SM8500_B2W[r1 & 0x07];
      switch (r1 & 0xc0) {
        case 0x00:
          s2 = this.memReadWord(regAddr);
          break;
        case 0x40:
          s2 = this.memReadWord(regAddr);
          this.memWriteWord(regAddr, (s2 + 1) & 0xffff);
          break;
        case 0x80:
          s2 = fetchWord();
          if (r1 & 0x07) {
            s2 = (s2 + this.memReadWord(regAddr)) & 0xffff;
          }
          break;
        case 0xc0:
          s2 = (this.memReadWord(regAddr) - 1) & 0xffff;
          this.memWriteWord(regAddr, s2);
          break;
      }
      r2 = r1;
      r1 = (r1 >> 3) & 0x07;
    };

    const argSmw = () => {
      r1 = fetchByte();
      s2 = 0;
      const regAddr = SM8500_B2W[r1 & 0x07];
      switch (r1 & 0xc0) {
        case 0x00:
          s2 = this.memReadWord(regAddr);
          break;
        case 0x40:
          s2 = this.memReadWord(regAddr);
          this.memWriteWord(regAddr, (s2 + 2) & 0xffff);
          break;
        case 0x80:
          s2 = fetchWord();
          if (r1 & 0x07) {
            s2 = (s2 + this.memReadWord(regAddr)) & 0xffff;
          }
          break;
        case 0xc0:
          s2 = (this.memReadWord(regAddr) - 2) & 0xffff;
          this.memWriteWord(regAddr, s2);
          break;
      }
      r2 = r1;
      r1 = SM8500_B2W[(r1 >> 3) & 0x07];
    };

    const argrr = () => {
      r1 = fetchByte();
      r2 = 0;
      if ((r1 & 0xc0) === 0x00) {
        r2 = r1 & 0x07;
        r1 = (r1 >> 3) & 0x07;
      }
    };

    const argss = () => {
      r1 = fetchByte();
      r2 = 0;
      if ((r1 & 0xc0) === 0x00) {
        r2 = SM8500_B2W[r1 & 0x07];
        r1 = SM8500_B2W[(r1 >> 3) & 0x07];
      }
    };

    const arg2 = () => {
      r1 = fetchByte();
      s2 = 0;
      switch (r1 & 0xc0) {
        case 0x00:
          s2 = this.memReadWord(SM8500_B2W[r1 & 0x07]);
          break;
        case 0x40:
          s2 = fetchWord();
          if (r1 & 0x38) {
            s2 = (s2 + this.memReadByte((r1 >> 3) & 0x07)) & 0xffff;
          }
          s2 = this.memReadWord(s2);
          break;
      }
    };

    const argRiB = () => {
      r1 = fetchByte();
      s2 = 1 << (r1 & 0x07);
      d1 = fetchByte();
      if (r1 & 0x38) {
        s1 = (d1 + this.memReadByte((r1 >> 3) & 0x07)) & 0xffff;
      } else {
        s1 = (0xff00 + d1) & 0xffff;
      }
    };

    const argRiBd = () => {
      argRiB();
      d1 = fetchByte();
    };

    // Flag ALU Operations (>>> 0 matches C++ uint32_t unsigned borrow behavior!)
    const opIntSub8 = (x: number, y: number, mask: number) => {
      d1 = x;
      d2 = y;
      res = (d1 - d2) >>> 0;
      this.ps1 =
        (this.ps1 & mask) |
        (res > 0xff ? FLAG_C : 0) |
        ((res & 0xff) === 0 ? FLAG_Z : 0) |
        (res & 0x80 ? FLAG_S : 0) |
        (((d2 ^ d1) & (res ^ d1) & 0x80) !== 0 ? FLAG_V : 0);
    };
    const opCmp8 = (x: number, y: number) => opIntSub8(x, y, FLAG_B | FLAG_I | FLAG_H | FLAG_D);
    const opSub8 = (x: number, y: number) => {
      opIntSub8(x, y, FLAG_B | FLAG_I);
      this.ps1 |= FLAG_D | (((d1 ^ d2 ^ res) & 0x10) !== 0 ? FLAG_H : 0);
    };

    const opIntSub16 = (x: number, y: number, mask: number) => {
      d1 = x;
      d2 = y;
      res = (d1 - d2) >>> 0;
      this.ps1 =
        (this.ps1 & mask) |
        (res > 0xffff ? FLAG_C : 0) |
        ((res & 0xffff) === 0 ? FLAG_Z : 0) |
        (res & 0x8000 ? FLAG_S : 0) |
        (((d2 ^ d1) & (res ^ d1) & 0x8000) !== 0 ? FLAG_V : 0);
    };
    const opCmp16 = (x: number, y: number) => opIntSub16(x, y, FLAG_B | FLAG_I | FLAG_H | FLAG_D);
    const opSub16 = (x: number, y: number) => {
      opIntSub16(x, y, FLAG_B | FLAG_I);
      this.ps1 |= FLAG_D | (((d1 ^ d2 ^ res) & 0x0010) !== 0 ? FLAG_H : 0);
    };

    const opSbc8 = (x: number, y: number) => {
      d1 = x;
      d2 = y;
      res = (d1 - d2 - (this.ps1 & FLAG_C ? 1 : 0)) >>> 0;
      this.ps1 =
        (this.ps1 & (FLAG_B | FLAG_I)) |
        (res > 0xff ? FLAG_C : 0) |
        ((res & 0xff) === 0 ? FLAG_Z : 0) |
        (res & 0x80 ? FLAG_S : 0) |
        (((d2 ^ d1) & (res ^ d1) & 0x80) !== 0 ? FLAG_V : 0) |
        FLAG_D |
        (((d1 ^ d2 ^ res) & 0x10) !== 0 ? FLAG_H : 0);
    };

    const opSbc16 = (x: number, y: number) => {
      d1 = x;
      d2 = y;
      res = (d1 - d2 - (this.ps1 & FLAG_C ? 1 : 0)) >>> 0;
      this.ps1 =
        (this.ps1 & (FLAG_B | FLAG_I)) |
        (res > 0xffff ? FLAG_C : 0) |
        ((res & 0xffff) === 0 ? FLAG_Z : 0) |
        (res & 0x8000 ? FLAG_S : 0) |
        (((d2 ^ d1) & (res ^ d1) & 0x8000) !== 0 ? FLAG_V : 0) |
        FLAG_D |
        (((d1 ^ d2 ^ res) & 0x10) !== 0 ? FLAG_H : 0);
    };

    const opAdd8 = (x: number, y: number) => {
      d1 = x;
      d2 = y;
      res = (d1 + d2) >>> 0;
      this.ps1 =
        (this.ps1 & (FLAG_B | FLAG_I)) |
        (res > 0xff ? FLAG_C : 0) |
        ((res & 0xff) === 0 ? FLAG_Z : 0) |
        (res & 0x80 ? FLAG_S : 0) |
        (((d2 ^ d1 ^ 0x80) & (res ^ d1) & 0x80) !== 0 ? FLAG_V : 0) |
        (((d1 ^ d2 ^ res) & 0x10) !== 0 ? FLAG_H : 0);
    };

    const opAdd16 = (x: number, y: number) => {
      d1 = x;
      d2 = y;
      res = (d1 + d2) >>> 0;
      this.ps1 =
        (this.ps1 & (FLAG_B | FLAG_I)) |
        (res > 0xffff ? FLAG_C : 0) |
        ((res & 0xffff) === 0 ? FLAG_Z : 0) |
        (res & 0x8000 ? FLAG_S : 0) |
        (((d2 ^ d1) & (res ^ d1) & 0x8000) !== 0 ? FLAG_V : 0) |
        (((d2 ^ d1 ^ res) & 0x0010) !== 0 ? FLAG_H : 0);
    };

    const opAdc8 = (x: number, y: number) => {
      d1 = x;
      d2 = y;
      res = (d1 + d2 + (this.ps1 & FLAG_C ? 1 : 0)) >>> 0;
      this.ps1 =
        (this.ps1 & (FLAG_B | FLAG_I)) |
        (res > 0xff ? FLAG_C : 0) |
        ((res & 0xff) === 0 ? FLAG_Z : 0) |
        (res & 0x80 ? FLAG_S : 0) |
        (((d2 ^ d1) & (res ^ d1) & 0x80) !== 0 ? FLAG_V : 0) |
        (((d1 ^ d2 ^ res) & 0x10) !== 0 ? FLAG_H : 0);
    };

    const opAdc16 = (x: number, y: number) => {
      d1 = x;
      d2 = y;
      res = (d1 + d2 + (this.ps1 & FLAG_C ? 1 : 0)) >>> 0;
      this.ps1 =
        (this.ps1 & (FLAG_B | FLAG_I)) |
        (res > 0xffff ? FLAG_C : 0) |
        ((res & 0xffff) === 0 ? FLAG_Z : 0) |
        (res & 0x8000 ? FLAG_S : 0) |
        (((d2 ^ d1) & (res ^ d1) & 0x8000) !== 0 ? FLAG_V : 0) |
        (((d1 ^ d2 ^ res) & 0x10) !== 0 ? FLAG_H : 0);
    };

    const opNeg8 = (x: number) => {
      res = (-x) >>> 0;
      this.ps1 =
        (this.ps1 & (FLAG_D | FLAG_H | FLAG_B | FLAG_I)) |
        ((res & 0xff) === 0 ? FLAG_C | FLAG_Z : 0) |
        (res & 0x80 ? FLAG_S : 0) |
        ((res & 0xff) === 0x80 ? FLAG_V : 0);
    };

    const opCom8 = (x: number) => {
      res = (~x) & 0xff;
      this.ps1 =
        (this.ps1 & (FLAG_C | FLAG_D | FLAG_H | FLAG_B | FLAG_I)) |
        ((res & 0xff) === 0 ? FLAG_Z : 0) |
        (res & 0x80 ? FLAG_S : 0);
    };

    const opRr8 = (x: number) => {
      d1 = x;
      res = d1 >> 1;
      if (d1 & 0x01) res |= 0x80;
      this.ps1 =
        (this.ps1 & (FLAG_D | FLAG_H | FLAG_B | FLAG_I)) |
        (d1 & 0x01 ? FLAG_C : 0) |
        ((res & 0xff) === 0 ? FLAG_Z : 0) |
        (res & 0x80 ? FLAG_S : 0) |
        (((d1 ^ res) & 0x80) !== 0 && !(res & 0x80) ? FLAG_V : 0);
    };

    const opRl8 = (x: number) => {
      d1 = x;
      res = (d1 << 1) & 0xff;
      if (d1 & 0x80) res |= 0x01;
      this.ps1 =
        (this.ps1 & (FLAG_D | FLAG_H | FLAG_B | FLAG_I)) |
        (d1 & 0x80 ? FLAG_C : 0) |
        ((res & 0xff) === 0 ? FLAG_Z : 0) |
        (res & 0x80 ? FLAG_S : 0) |
        (((d1 ^ res) & 0x80) !== 0 ? FLAG_V : 0);
    };

    const opRrc8 = (x: number) => {
      d1 = x;
      res = d1 >> 1;
      if (this.ps1 & FLAG_C) res |= 0x80;
      this.ps1 =
        (this.ps1 & (FLAG_D | FLAG_H | FLAG_B | FLAG_I)) |
        (d1 & 0x01 ? FLAG_C : 0) |
        ((res & 0xff) === 0 ? FLAG_Z : 0) |
        (res & 0x80 ? FLAG_S : 0) |
        (((d1 ^ res) & 0x80) !== 0 && !(res & 0x80) ? FLAG_V : 0);
    };

    const opRlc8 = (x: number) => {
      d1 = x;
      res = (d1 << 1) & 0xff;
      if (this.ps1 & FLAG_C) res |= 0x01;
      this.ps1 =
        (this.ps1 & (FLAG_D | FLAG_H | FLAG_B | FLAG_I)) |
        (d1 & 0x80 ? FLAG_C : 0) |
        ((res & 0xff) === 0 ? FLAG_Z : 0) |
        (res & 0x80 ? FLAG_S : 0) |
        (((d1 ^ res) & 0x80) !== 0 ? FLAG_V : 0);
    };

    const opSrl8 = (x: number) => {
      d1 = x;
      res = d1 >> 1;
      this.ps1 =
        (this.ps1 & (FLAG_D | FLAG_H | FLAG_B | FLAG_I)) |
        (d1 & 0x01 ? FLAG_C : 0) |
        ((res & 0xff) === 0 ? FLAG_Z : 0);
    };

    const opSra8 = (x: number) => {
      d1 = x;
      res = d1 >> 1;
      if (d1 & 0x80) res |= 0x80;
      this.ps1 =
        (this.ps1 & (FLAG_D | FLAG_H | FLAG_B | FLAG_I)) |
        (d1 & 0x01 ? FLAG_C : 0) |
        ((res & 0xff) === 0 ? FLAG_Z : 0) |
        (res & 0x80 ? FLAG_S : 0);
    };

    const opSll8 = (x: number) => {
      d1 = x;
      res = (d1 << 1) & 0xff;
      this.ps1 =
        (this.ps1 & (FLAG_D | FLAG_H | FLAG_B | FLAG_I)) |
        (d1 & 0x80 ? FLAG_C : 0) |
        ((res & 0xff) === 0 ? FLAG_Z : 0) |
        (res & 0x80 ? FLAG_S : 0);
    };

    const opInc8 = (x: number) => {
      d1 = x;
      res = (d1 + 1) & 0xff;
      this.ps1 =
        (this.ps1 & (FLAG_C | FLAG_D | FLAG_H | FLAG_B | FLAG_I)) |
        (res === 0 ? FLAG_Z : 0) |
        (res & 0x80 ? FLAG_S : 0) |
        (((d1 ^ res) & 0x80) !== 0 && !(res & 0x80) ? FLAG_V : 0);
    };

    const opInc16 = (x: number) => {
      d1 = x;
      res = (d1 + 1) & 0xffff;
      this.ps1 =
        (this.ps1 & (FLAG_C | FLAG_D | FLAG_H | FLAG_B | FLAG_I)) |
        (res === 0 ? FLAG_Z : 0) |
        (res & 0x8000 ? FLAG_S : 0) |
        (((d1 ^ res) & 0x8000) !== 0 && !(res & 0x8000) ? FLAG_V : 0);
    };

    const opDec8 = (x: number) => {
      d1 = x;
      res = (d1 - 1) & 0xff;
      this.ps1 =
        (this.ps1 & (FLAG_C | FLAG_D | FLAG_H | FLAG_B | FLAG_I)) |
        (res === 0 ? FLAG_Z : 0) |
        (res & 0x80 ? FLAG_S : 0) |
        (((d1 ^ res) & 0x80) !== 0 && (res & 0x80) !== 0 ? FLAG_V : 0);
    };

    const opDec16 = (x: number) => {
      d1 = x;
      res = (d1 - 1) & 0xffff;
      this.ps1 =
        (this.ps1 & (FLAG_C | FLAG_D | FLAG_H | FLAG_B | FLAG_I)) |
        (res === 0 ? FLAG_Z : 0) |
        (res & 0x8000 ? FLAG_S : 0) |
        (((d1 ^ res) & 0x8000) !== 0 && (res & 0x8000) !== 0 ? FLAG_V : 0);
    };

    const opAnd8 = (x: number, y: number) => {
      res = x & y;
      this.ps1 =
        (this.ps1 & (FLAG_B | FLAG_C | FLAG_I | FLAG_H | FLAG_D)) |
        ((res & 0xff) === 0 ? FLAG_Z : 0) |
        (res & 0x80 ? FLAG_S : 0);
    };

    const opAnd16 = (x: number, y: number) => {
      res = x & y;
      this.ps1 =
        (this.ps1 & (FLAG_C | FLAG_S | FLAG_B | FLAG_I | FLAG_H | FLAG_D)) |
        ((res & 0xffff) === 0 ? FLAG_Z : 0);
    };

    const opOr8 = (x: number, y: number) => {
      res = x | y;
      this.ps1 =
        (this.ps1 & (FLAG_B | FLAG_C | FLAG_I | FLAG_H | FLAG_D)) |
        ((res & 0xff) === 0 ? FLAG_Z : 0) |
        (res & 0x80 ? FLAG_S : 0);
    };

    const opOr16 = (x: number, y: number) => {
      res = x | y;
      this.ps1 =
        (this.ps1 & (FLAG_B | FLAG_I | FLAG_H | FLAG_D | FLAG_C | FLAG_S)) |
        ((res & 0xffff) === 0 ? FLAG_Z : 0);
    };

    const opXor8 = (x: number, y: number) => {
      res = x ^ y;
      this.ps1 =
        (this.ps1 & (FLAG_B | FLAG_C | FLAG_I | FLAG_H | FLAG_D)) |
        ((res & 0xff) === 0 ? FLAG_Z : 0) |
        (res & 0x80 ? FLAG_S : 0);
    };

    const opXor16 = (x: number, y: number) => {
      res = x ^ y;
      this.ps1 =
        (this.ps1 & (FLAG_B | FLAG_I | FLAG_H | FLAG_D | FLAG_C | FLAG_S)) |
        ((res & 0xffff) === 0 ? FLAG_Z : 0);
    };

    const opDa8 = (x: number) => {
      res = x;
      if (this.ps1 & FLAG_D) {
        if (this.ps1 & FLAG_C) {
          res += this.ps1 & FLAG_H ? 0x9a : 0xa0;
        } else if (this.ps1 & FLAG_H) {
          res += 0xfa;
        }
      } else if (this.ps1 & FLAG_C) {
        if (this.ps1 & FLAG_H) {
          res += 0x66;
        } else {
          res += (res & 0x0f) < 10 ? 0x60 : 0x66;
        }
      } else if (this.ps1 & FLAG_H) {
        if ((res & 0xf0) < 0xa0) {
          res += 0x06;
        } else {
          res += 0x66;
          this.ps1 |= FLAG_C;
        }
      } else if ((res & 0x0f) < 10) {
        if ((res & 0xf0) >= 0xa0) {
          res += 0x60;
          this.ps1 |= FLAG_C;
        }
      } else if ((res & 0xf0) < 0x90) {
        res += 0x06;
      } else {
        res += 0x66;
        this.ps1 |= FLAG_C;
      }
      this.ps1 =
        (this.ps1 & ~(FLAG_Z | FLAG_S)) |
        ((res & 0xff) === 0 ? FLAG_Z : 0) |
        (res & 0x80 ? FLAG_S : 0);
    };

    const checkCC = (cc: number): boolean => {
      const fS = (this.ps1 & FLAG_S) !== 0;
      const fV = (this.ps1 & FLAG_V) !== 0;
      const fZ = (this.ps1 & FLAG_Z) !== 0;
      const fC = (this.ps1 & FLAG_C) !== 0;
      switch (cc & 0x0f) {
        case 0x00: return false;
        case 0x01: return fS !== fV;
        case 0x02: return (fS && !fV) || (fS && fV && fZ) || (!fS && (fZ || fV));
        case 0x03: return fZ || fC;
        case 0x04: return fV;
        case 0x05: return fS;
        case 0x06: return fZ;
        case 0x07: return fC;
        case 0x08: return true;
        case 0x09: return fS === fV;
        case 0x0a: return (!fZ && fS && fV) || (!fZ && !fV && !fS);
        case 0x0b: return !(fZ || fC);
        case 0x0c: return !fV;
        case 0x0d: return !fS;
        case 0x0e: return !fZ;
        case 0x0f: return !fC;
        default: return false;
      }
    };

    switch (op) {
      case 0x00: argR(); this.memWriteByte(r1, 0); mycycles += 4; break;
      case 0x01: argR(); opNeg8(this.memReadByte(r1)); this.memWriteByte(r1, res & 0xff); mycycles += 5; break;
      case 0x02: argR(); opCom8(this.memReadByte(r1)); this.memWriteByte(r1, res & 0xff); mycycles += 4; break;
      case 0x03: argR(); opRr8(this.memReadByte(r1)); this.memWriteByte(r1, res & 0xff); mycycles += 4; break;
      case 0x04: argR(); opRl8(this.memReadByte(r1)); this.memWriteByte(r1, res & 0xff); mycycles += 4; break;
      case 0x05: argR(); opRrc8(this.memReadByte(r1)); this.memWriteByte(r1, res & 0xff); mycycles += 4; break;
      case 0x06: argR(); opRlc8(this.memReadByte(r1)); this.memWriteByte(r1, res & 0xff); mycycles += 4; break;
      case 0x07: argR(); opSrl8(this.memReadByte(r1)); this.memWriteByte(r1, res & 0xff); mycycles += 4; break;
      case 0x08: argR(); opInc8(this.memReadByte(r1)); this.memWriteByte(r1, res & 0xff); mycycles += 4; break;
      case 0x09: argR(); opDec8(this.memReadByte(r1)); this.memWriteByte(r1, res & 0xff); mycycles += 4; break;
      case 0x0a: argR(); opSra8(this.memReadByte(r1)); this.memWriteByte(r1, res & 0xff); mycycles += 4; break;
      case 0x0b: argR(); opSll8(this.memReadByte(r1)); this.memWriteByte(r1, res & 0xff); mycycles += 4; break;
      case 0x0c: argR(); opDa8(this.memReadByte(r1)); this.memWriteByte(r1, res & 0xff); mycycles += 4; break;
      case 0x0d: argR(); d1 = this.memReadByte(r1); this.memWriteByte(r1, ((d1 << 4) | (d1 >> 4)) & 0xff); mycycles += 7; break;
      case 0x0e: argR(); this.pushByte(this.memReadByte(r1)); mycycles += this.sys & 0x40 ? 12 : 10; break;
      case 0x0f: argR(); r2 = this.popByte(); this.memWriteByte(r1, r2); mycycles += this.sys & 0x40 ? 9 : 8; break;

      case 0x10: argrr(); opCmp8(this.memReadByte(r1), this.memReadByte(r2)); mycycles += 5; break;
      case 0x11: argrr(); opAdd8(this.memReadByte(r1), this.memReadByte(r2)); this.memWriteByte(r1, res & 0xff); mycycles += 5; break;
      case 0x12: argrr(); opSub8(this.memReadByte(r1), this.memReadByte(r2)); this.memWriteByte(r1, res & 0xff); mycycles += 5; break;
      case 0x13: argrr(); opAdc8(this.memReadByte(r1), this.memReadByte(r2)); this.memWriteByte(r1, res & 0xff); mycycles += 5; break;
      case 0x14: argrr(); opSbc8(this.memReadByte(r1), this.memReadByte(r2)); this.memWriteByte(r1, res & 0xff); mycycles += 5; break;
      case 0x15: argrr(); opAnd8(this.memReadByte(r1), this.memReadByte(r2)); this.memWriteByte(r1, res & 0xff); mycycles += 5; break;
      case 0x16: argrr(); opOr8(this.memReadByte(r1), this.memReadByte(r2)); this.memWriteByte(r1, res & 0xff); mycycles += 5; break;
      case 0x17: argrr(); opXor8(this.memReadByte(r1), this.memReadByte(r2)); this.memWriteByte(r1, res & 0xff); mycycles += 5; break;
      case 0x18: argR(); opInc16(this.memReadWord(r1)); this.memWriteWord(r1, res & 0xffff); mycycles += 8; break;
      case 0x19: argR(); opDec16(this.memReadWord(r1)); this.memWriteWord(r1, res & 0xffff); mycycles += 8; break;

      case 0x1a:
        argrr();
        res = 0;
        s1 = this.memReadByte(r1);
        switch (r2) {
          case 0x00: res = 0; mycycles += 7; break;
          case 0x01: opNeg8(this.memReadByte(s1)); mycycles += 8; break;
          case 0x02: opCom8(this.memReadByte(s1)); mycycles += 7; break;
          case 0x03: opRr8(this.memReadByte(s1)); mycycles += 7; break;
          case 0x04: opRl8(this.memReadByte(s1)); mycycles += 7; break;
          case 0x05: opRrc8(this.memReadByte(s1)); mycycles += 7; break;
          case 0x06: opRlc8(this.memReadByte(s1)); mycycles += 7; break;
          case 0x07: opSrl8(this.memReadByte(s1)); mycycles += 6; break;
        }
        this.memWriteByte(s1, res & 0xff);
        break;

      case 0x1b:
        argrr();
        s1 = this.memReadByte(r1);
        switch (r2) {
          case 0x00: opInc8(this.memReadByte(s1)); this.memWriteByte(s1, res & 0xff); mycycles += 7; break;
          case 0x01: opDec8(this.memReadByte(s1)); this.memWriteByte(s1, res & 0xff); mycycles += 7; break;
          case 0x02: opSra8(this.memReadByte(s1)); this.memWriteByte(s1, res & 0xff); mycycles += 6; break;
          case 0x03: opSll8(this.memReadByte(s1)); this.memWriteByte(s1, res & 0xff); mycycles += 6; break;
          case 0x04: opDa8(this.memReadByte(s1)); this.memWriteByte(s1, res & 0xff); mycycles += 7; break;
          case 0x05: d1 = this.memReadByte(s1); this.memWriteByte(s1, ((d1 << 4) | (d1 >> 4)) & 0xff); mycycles += 9; break;
          case 0x06: this.pushByte(this.memReadByte(s1)); mycycles += this.sys & 0x40 ? 13 : 8; break;
          case 0x07: res = this.popByte(); this.memWriteByte(s1, res); mycycles += this.sys & 0x40 ? 12 : 11; break;
        }
        break;

      case 0x1c: argRiB(); this.memWriteByte(s1, this.memReadByte(s1) & ~s2); mycycles += r1 & 0x38 ? 8 : 12; break;
      case 0x1d: argRiB(); this.memWriteByte(s1, this.memReadByte(s1) | s2); mycycles += r1 & 0x38 ? 8 : 12; break;
      case 0x1e: argR(); this.pushByte(this.memReadByte(r1 + 1)); this.pushByte(this.memReadByte(r1)); mycycles += this.sys & 0x40 ? 12 : 9; break;
      case 0x1f: argR(); r2 = this.popByte(); this.memWriteByte(r1, r2); r2 = this.popByte(); this.memWriteByte(r1 + 1, r2); mycycles += this.sys & 0x40 ? 12 : 13; break;

      case 0x20: argRmb(); opCmp8(this.memReadByte(r1), this.memReadByte(s2)); mycycles += (r2 & 0xc0) === 0x00 ? 7 : (r2 & 0xc0) === 0x40 ? 8 : (r2 & 0xc0) === 0x80 ? (r2 & 0x07 ? 8 : 10) : 9; break;
      case 0x21: argRmb(); opAdd8(this.memReadByte(r1), this.memReadByte(s2)); this.memWriteByte(r1, res & 0xff); mycycles += (r2 & 0xc0) === 0x00 ? 7 : (r2 & 0xc0) === 0x40 ? 8 : (r2 & 0xc0) === 0x80 ? (r2 & 0x07 ? 8 : 10) : 9; break;
      case 0x22: argRmb(); opSub8(this.memReadByte(r1), this.memReadByte(s2)); this.memWriteByte(r1, res & 0xff); mycycles += (r2 & 0xc0) === 0x00 ? 7 : (r2 & 0xc0) === 0x40 ? 8 : (r2 & 0xc0) === 0x80 ? (r2 & 0x07 ? 8 : 10) : 9; break;
      case 0x23: argRmb(); opAdc8(this.memReadByte(r1), this.memReadByte(s2)); this.memWriteByte(r1, res & 0xff); mycycles += (r2 & 0xc0) === 0x00 ? 7 : (r2 & 0xc0) === 0x40 ? 8 : (r2 & 0xc0) === 0x80 ? (r2 & 0x07 ? 8 : 10) : 9; break;
      case 0x24: argRmb(); opSbc8(this.memReadByte(r1), this.memReadByte(s2)); this.memWriteByte(r1, res & 0xff); mycycles += (r2 & 0xc0) === 0x00 ? 7 : (r2 & 0xc0) === 0x40 ? 8 : (r2 & 0xc0) === 0x80 ? (r2 & 0x07 ? 8 : 10) : 9; break;
      case 0x25: argRmb(); opAnd8(this.memReadByte(r1), this.memReadByte(s2)); this.memWriteByte(r1, res & 0xff); mycycles += (r2 & 0xc0) === 0x00 ? 7 : (r2 & 0xc0) === 0x40 ? 8 : (r2 & 0xc0) === 0x80 ? (r2 & 0x07 ? 8 : 10) : 9; break;
      case 0x26: argRmb(); opOr8(this.memReadByte(r1), this.memReadByte(s2)); this.memWriteByte(r1, res & 0xff); mycycles += (r2 & 0xc0) === 0x00 ? 7 : (r2 & 0xc0) === 0x40 ? 8 : (r2 & 0xc0) === 0x80 ? (r2 & 0x07 ? 8 : 10) : 9; break;
      case 0x27: argRmb(); opXor8(this.memReadByte(r1), this.memReadByte(s2)); this.memWriteByte(r1, res & 0xff); mycycles += (r2 & 0xc0) === 0x00 ? 7 : (r2 & 0xc0) === 0x40 ? 8 : (r2 & 0xc0) === 0x80 ? (r2 & 0x07 ? 8 : 10) : 9; break;
      case 0x28: argRmb(); this.memWriteByte(r1, this.memReadByte(s2)); mycycles += (r2 & 0xc0) === 0x00 ? 6 : (r2 & 0xc0) === 0x40 ? 7 : (r2 & 0xc0) === 0x80 ? (r2 & 0x07 ? 7 : 10) : 8; break;
      case 0x29: argRmb(); this.memWriteByte(s2, this.memReadByte(r1)); mycycles += (r2 & 0xc0) === 0x00 ? 8 : (r2 & 0xc0) === 0x40 ? 8 : (r2 & 0xc0) === 0x80 ? (r2 & 0x07 ? 9 : 10) : 9; break;

      case 0x2a:
        argRiBd();
        if (this.memReadByte(s1) & s2) {
          mycycles += 10;
        } else {
          this.pc = (this.pc + s8(d1)) & 0xffff;
          mycycles += 14;
        }
        if ((r1 & 0x38) === 0) mycycles += 2;
        break;

      case 0x2b:
        argRiBd();
        if (this.memReadByte(s1) & s2) {
          this.pc = (this.pc + s8(d1)) & 0xffff;
          mycycles += 14;
        } else {
          mycycles += 10;
        }
        if ((r1 & 0x38) === 0) mycycles += 2;
        break;

      case 0x2c:
        argR();
        res = this.memReadWord(r1);
        res = res & 0x80 ? res | 0xff00 : res & 0x00ff;
        this.memWriteWord(r1, res);
        mycycles += 6;
        break;

      case 0x2d: mycycles += 4; break;
      case 0x2e: argR(); this.ps0 = r1; mycycles += 4; break;
      case 0x2f:
        argRR();
        this.ps1 &= ~FLAG_V;
        if ((this.memReadByte(r2) & r1) === 0) this.ps1 |= FLAG_Z;
        else this.ps1 &= ~FLAG_Z;
        mycycles += 6;
        break;

      case 0x30: argRmw(); opCmp8(this.memReadByte(r1), this.memReadByte(s2)); mycycles += (r2 & 0xc0) === 0x80 ? (r2 & 0x07 ? 11 : 15) : (r2 & 0xc0) === 0x00 ? 8 : 13; break;
      case 0x31: argRmw(); opAdd8(this.memReadByte(r1), this.memReadByte(s2)); this.memWriteByte(r1, res & 0xff); mycycles += (r2 & 0xc0) === 0x80 ? (r2 & 0x07 ? 11 : 15) : (r2 & 0xc0) === 0x00 ? 8 : 13; break;
      case 0x32: argRmw(); opSub8(this.memReadByte(r1), this.memReadByte(s2)); this.memWriteByte(r1, res & 0xff); mycycles += (r2 & 0xc0) === 0x80 ? (r2 & 0x07 ? 11 : 15) : (r2 & 0xc0) === 0x00 ? 8 : 13; break;
      case 0x33: argRmw(); opAdc8(this.memReadByte(r1), this.memReadByte(s2)); this.memWriteByte(r1, res & 0xff); mycycles += (r2 & 0xc0) === 0x80 ? (r2 & 0x07 ? 11 : 15) : (r2 & 0xc0) === 0x00 ? 8 : 13; break;
      case 0x34: argRmw(); opSbc8(this.memReadByte(r1), this.memReadByte(s2)); this.memWriteByte(r1, res & 0xff); mycycles += (r2 & 0xc0) === 0x80 ? (r2 & 0x07 ? 11 : 15) : (r2 & 0xc0) === 0x00 ? 8 : 13; break;
      case 0x35: argRmw(); opAnd8(this.memReadByte(r1), this.memReadByte(s2)); this.memWriteByte(r1, res & 0xff); mycycles += (r2 & 0xc0) === 0x80 ? (r2 & 0x07 ? 11 : 15) : (r2 & 0xc0) === 0x00 ? 8 : 13; break;
      case 0x36: argRmw(); opOr8(this.memReadByte(r1), this.memReadByte(s2)); this.memWriteByte(r1, res & 0xff); mycycles += (r2 & 0xc0) === 0x80 ? (r2 & 0x07 ? 11 : 15) : (r2 & 0xc0) === 0x00 ? 8 : 13; break;
      case 0x37: argRmw(); opXor8(this.memReadByte(r1), this.memReadByte(s2)); this.memWriteByte(r1, res & 0xff); mycycles += (r2 & 0xc0) === 0x80 ? (r2 & 0x07 ? 11 : 15) : (r2 & 0xc0) === 0x00 ? 8 : 13; break;
      case 0x38: argRmw(); this.memWriteByte(r1, this.memReadByte(s2)); mycycles += (r2 & 0xc0) === 0x80 ? (r2 & 0x07 ? 11 : 15) : (r2 & 0xc0) === 0x00 ? 8 : 13; break;
      case 0x39: argRmw(); this.memWriteByte(s2, this.memReadByte(r1)); mycycles += (r2 & 0xc0) === 0x80 ? (r2 & 0x07 ? 11 : 15) : (r2 & 0xc0) === 0x00 ? 8 : 13; break;
      case 0x3a: argSmw(); this.memWriteWord(r1, this.memReadWord(s2)); mycycles += (r2 & 0xc0) === 0x80 ? (r2 & 0x07 ? 18 : 14) : (r2 & 0xc0) === 0x00 ? 11 : 16; break;
      case 0x3b: argSmw(); this.memWriteWord(s2, this.memReadWord(r1)); mycycles += (r2 & 0xc0) === 0x80 ? (r2 & 0x07 ? 18 : 14) : (r2 & 0xc0) === 0x00 ? 11 : 16; break;
      case 0x3c: argss(); this.memWriteWord(r1, this.memReadWord(r2)); mycycles += 7; break;
      case 0x3d: mycycles += 4; break;

      case 0x3e:
        arg2();
        this.pc = s2;
        if ((r1 & 0xc0) === 0x00) mycycles += 7;
        else if ((r1 & 0xc0) === 0x40) mycycles += r1 & 0x38 ? 19 : 15;
        else mycycles += 4;
        break;

      case 0x3f:
        arg2();
        this.pushByte(this.pc & 0xff);
        this.pushByte((this.pc >> 8) & 0xff);
        this.pc = s2;
        if ((r1 & 0xc0) === 0x00) mycycles += this.sys & 0x40 ? 14 : 11;
        else if ((r1 & 0xc0) === 0x40) {
          mycycles += r1 & 0x38 ? (this.sys & 0x40 ? 26 : 23) : (this.sys & 0x40 ? 22 : 19);
        } else mycycles += 4;
        break;

      case 0x40: argRR(); opCmp8(this.memReadByte(r1), this.memReadByte(r2)); mycycles += 6; break;
      case 0x41: argRR(); opAdd8(this.memReadByte(r1), this.memReadByte(r2)); this.memWriteByte(r1, res & 0xff); mycycles += 6; break;
      case 0x42: argRR(); opSub8(this.memReadByte(r1), this.memReadByte(r2)); this.memWriteByte(r1, res & 0xff); mycycles += 6; break;
      case 0x43: argRR(); opAdc8(this.memReadByte(r1), this.memReadByte(r2)); this.memWriteByte(r1, res & 0xff); mycycles += 6; break;
      case 0x44: argRR(); opSbc8(this.memReadByte(r1), this.memReadByte(r2)); this.memWriteByte(r1, res & 0xff); mycycles += 6; break;
      case 0x45: argRR(); opAnd8(this.memReadByte(r1), this.memReadByte(r2)); this.memWriteByte(r1, res & 0xff); mycycles += 6; break;
      case 0x46: argRR(); opOr8(this.memReadByte(r1), this.memReadByte(r2)); this.memWriteByte(r1, res & 0xff); mycycles += 6; break;
      case 0x47: argRR(); opXor8(this.memReadByte(r1), this.memReadByte(r2)); this.memWriteByte(r1, res & 0xff); mycycles += 6; break;
      case 0x48: argRR(); this.memWriteByte(r1, this.memReadByte(r2)); mycycles += 6; break;
      case 0x49: argAd16(); this.pushByte(this.pc & 0xff); this.pushByte((this.pc >> 8) & 0xff); this.pc = s2; mycycles += this.sys & 0x40 ? 12 : 10; break;
      case 0x4a: argRR(); this.memWriteWord(r1, this.memReadWord(r2)); mycycles += 8; break;
      case 0x4b: argSw(); this.memWriteWord(r1, s2); mycycles += 9; break;

      case 0x4c:
        argRR();
        res = (this.memReadByte(r1 | 1) * this.memReadByte(r2)) & 0xffff;
        this.memWriteWord(r1, res);
        this.ps1 = (this.ps1 & ~(FLAG_Z | FLAG_V)) | (res === 0 ? FLAG_Z : 0);
        mycycles += 24;
        break;

      case 0x4d:
        argiR();
        res = (this.memReadByte(r1 | 1) * r2) & 0xffff;
        this.memWriteWord(r1, res);
        this.ps1 = (this.ps1 & ~(FLAG_Z | FLAG_V)) | (res === 0 ? FLAG_Z : 0);
        mycycles += 24;
        break;

      case 0x4e:
        r2 = fetchByte();
        r1 = fetchByte();
        if ((r2 & 0xc0) === 0x40) {
          res = this.memReadByte(r1);
          res = this.ps1 & FLAG_B ? res | (1 << (r2 & 0x07)) : res & ~(1 << (r2 & 0x07));
          this.memWriteByte(r1, res & 0xff);
        } else if ((r2 & 0xc0) === 0x00) {
          this.ps1 &= FLAG_C | FLAG_S | FLAG_D | FLAG_H | FLAG_I;
          if (this.memReadByte(r1) & (1 << (r2 & 0x07))) this.ps1 |= FLAG_B;
          else this.ps1 |= FLAG_Z;
        }
        mycycles += 6;
        break;

      case 0x4f:
        r2 = fetchByte();
        r1 = fetchByte();
        s1 = this.memReadByte(r1) & (1 << (r2 & 0x07));
        s2 = ((this.ps1 & FLAG_B) >> 1) << (r2 & 0x07);
        switch (r2 & 0xc0) {
          case 0x00:
            this.ps1 &= ~(FLAG_Z | FLAG_V);
            if (s1 === s2) this.ps1 |= FLAG_Z;
            break;
          case 0x40:
            this.ps1 = (this.ps1 & ~(FLAG_Z | FLAG_V | FLAG_B)) | (s1 & s2 ? FLAG_B : FLAG_Z);
            break;
          case 0x80:
            this.ps1 = (this.ps1 & ~(FLAG_Z | FLAG_V | FLAG_B)) | (s1 | s2 ? FLAG_B : FLAG_Z);
            break;
          case 0xc0:
            this.ps1 = (this.ps1 & ~(FLAG_Z | FLAG_V | FLAG_B)) | (s1 ^ s2 ? FLAG_B : FLAG_Z);
            break;
        }
        mycycles += 6;
        break;

      case 0x50: argiR(); opCmp8(this.memReadByte(r1), r2); mycycles += 6; break;
      case 0x51: argiR(); opAdd8(this.memReadByte(r1), r2); this.memWriteByte(r1, res & 0xff); mycycles += 6; break;
      case 0x52: argiR(); opSub8(this.memReadByte(r1), r2); this.memWriteByte(r1, res & 0xff); mycycles += 6; break;
      case 0x53: argiR(); opAdc8(this.memReadByte(r1), r2); this.memWriteByte(r1, res & 0xff); mycycles += 6; break;
      case 0x54: argiR(); opSbc8(this.memReadByte(r1), r2); this.memWriteByte(r1, res & 0xff); mycycles += 6; break;
      case 0x55: argiR(); opAnd8(this.memReadByte(r1), r2); this.memWriteByte(r1, res & 0xff); mycycles += 6; break;
      case 0x56: argiR(); opOr8(this.memReadByte(r1), r2); this.memWriteByte(r1, res & 0xff); mycycles += 6; break;
      case 0x57: argiR(); opXor8(this.memReadByte(r1), r2); this.memWriteByte(r1, res & 0xff); mycycles += 6; break;
      case 0x58: argiR(); this.memWriteByte(r1, r2); mycycles += 6; break;
      case 0x59: mycycles += 2; break;

      case 0x5a:
        argiR();
        switch (r2 & 0xc0) {
          case 0x00:
            s1 = this.memReadByte(r2 & 7);
            opCmp8(this.memReadByte(s1), r1);
            break;
          case 0x40:
            s1 = r2 & 7;
            res = this.memReadByte(s1);
            opCmp8(this.memReadByte(res), r1);
            this.memWriteByte(s1, (res + 1) & 0xff);
            break;
          case 0x80:
            s1 = r1;
            argR();
            s1 = (s1 + this.memReadByte(r2 & 7)) & 0xffff;
            opCmp8(this.memReadByte(s1), r1);
            mycycles += 4;
            break;
          case 0xc0:
            s1 = r2 & 7;
            res = (this.memReadByte(s1) - 1) & 0xff;
            this.memWriteByte(s1, res);
            opCmp8(this.memReadByte(res), r1);
            break;
        }
        mycycles += 7;
        break;

      case 0x5b:
        argiR();
        switch (r2 & 0xc0) {
          case 0x00:
            s1 = this.memReadByte(r2 & 7);
            this.memWriteByte(this.memReadByte(s1), r1);
            break;
          case 0x40:
            s1 = r2 & 7;
            res = this.memReadByte(s1);
            this.memWriteByte(res, r1);
            this.memWriteByte(s1, (res + 1) & 0xff);
            break;
          case 0x80:
            s1 = r1;
            argR();
            s1 = (s1 + this.memReadByte(r2 & 7)) & 0xffff;
            mycycles += 4;
            this.memWriteByte(this.memReadByte(s1), r1);
            break;
          case 0xc0:
            s1 = r2 & 7;
            res = (this.memReadByte(s1) - 1) & 0xff;
            this.memWriteByte(s1, res);
            this.memWriteByte(this.memReadByte(res), r1);
            break;
        }
        mycycles += 6;
        break;

      case 0x5c:
        argRR();
        this.ps1 &= ~(FLAG_Z | FLAG_V);
        s1 = this.memReadByte(r2 + 1);
        if (s1) {
          const dividend = this.memReadWord(r1);
          res = Math.floor(dividend / s1) & 0xffff;
          this.memWriteByte(r2, dividend % s1);
          this.memWriteWord(r1, res);
          if (res === 0) this.ps1 |= FLAG_Z;
        } else {
          this.ps1 |= FLAG_V;
        }
        mycycles += 47;
        break;

      case 0x5d:
        argiR();
        this.ps1 &= ~(FLAG_Z | FLAG_V);
        if (r2) {
          res = Math.floor(this.memReadWord(r1) / r2) & 0xffff;
          this.memWriteWord(r1, res);
          if (res === 0) this.ps1 |= FLAG_Z;
        } else {
          this.ps1 |= FLAG_V;
        }
        mycycles += 44;
        break;

      case 0x5e: argRiR(); this.memWriteByte(r1, (this.memReadByte(r1) & d1) | this.memReadByte(r2)); mycycles += 9; break;
      case 0x5f: argRii(); this.memWriteByte(r1, (this.memReadByte(r1) & d1) | r2); mycycles += 8; break;

      case 0x60: argRR(); opCmp16(this.memReadWord(r1), this.memReadWord(r2)); mycycles += 9; break;
      case 0x61: argRR(); opAdd16(this.memReadWord(r1), this.memReadWord(r2)); this.memWriteWord(r1, res & 0xffff); mycycles += 10; break;
      case 0x62: argRR(); opSub16(this.memReadWord(r1), this.memReadWord(r2)); this.memWriteWord(r1, res & 0xffff); mycycles += 10; break;
      case 0x63: argRR(); opAdc16(this.memReadWord(r1), this.memReadWord(r2)); this.memWriteWord(r1, res & 0xffff); mycycles += 10; break;
      case 0x64: argRR(); opSbc16(this.memReadWord(r1), this.memReadWord(r2)); this.memWriteWord(r1, res & 0xffff); mycycles += 10; break;
      case 0x65: argRR(); opAnd16(this.memReadWord(r1), this.memReadWord(r2)); this.memWriteWord(r1, res & 0xffff); mycycles += 14; break;
      case 0x66: argRR(); opOr16(this.memReadWord(r1), this.memReadWord(r2)); this.memWriteWord(r1, res & 0xffff); mycycles += 14; break;
      case 0x67: argRR(); opXor16(this.memReadWord(r1), this.memReadWord(r2)); this.memWriteWord(r1, res & 0xffff); mycycles += 14; break;

      case 0x68: argSw(); opCmp16(this.memReadWord(r1), s2); mycycles += 9; break;
      case 0x69: argSw(); opAdd16(this.memReadWord(r1), s2); this.memWriteWord(r1, res & 0xffff); mycycles += 10; break;
      case 0x6a: argSw(); opSub16(this.memReadWord(r1), s2); this.memWriteWord(r1, res & 0xffff); mycycles += 10; break;
      case 0x6b: argSw(); opAdc16(this.memReadWord(r1), s2); this.memWriteWord(r1, res & 0xffff); mycycles += 10; break;
      case 0x6c: argSw(); opSbc16(this.memReadWord(r1), s2); this.memWriteWord(r1, res & 0xffff); mycycles += 10; break;
      case 0x6d: argSw(); opAnd16(this.memReadWord(r1), s2); this.memWriteWord(r1, res & 0xffff); mycycles += 13; break;
      case 0x6e: argSw(); opOr16(this.memReadWord(r1), s2); this.memWriteWord(r1, res & 0xffff); mycycles += 13; break;
      case 0x6f: argSw(); opXor16(this.memReadWord(r1), s2); this.memWriteWord(r1, res & 0xffff); mycycles += 13; break;

      default: {
        const hi = op & 0xf8;
        if (hi === 0x70) {
          argd8();
          r1 = (this.memReadByte(op & 0x07) - 1) & 0xff;
          this.memWriteByte(op & 0x07, r1);
          if (r1 !== 0) {
            this.pc = s2;
            mycycles += 10;
          } else {
            mycycles += 6;
          }
        } else if (hi === 0x78) {
          argrrw();
          this.memWriteWord(r1, s2);
          mycycles += 6;
        } else if (hi === 0x80) {
          argRbr();
          if ((this.memReadByte(r1) & (1 << (op & 0x07))) === 0) {
            this.pc = s2;
            mycycles += 10;
          } else {
            mycycles += 6;
          }
        } else if (hi === 0x88) {
          argRbr();
          if (this.memReadByte(r1) & (1 << (op & 0x07))) {
            this.pc = s2;
            mycycles += 10;
          } else {
            mycycles += 6;
          }
        } else if ((op & 0xf0) === 0x90) {
          argAd16();
          if (checkCC(op)) this.pc = s2;
          mycycles += 6;
        } else if (hi === 0xa0) {
          argR();
          this.memWriteByte(r1, this.memReadByte(r1) & ~(1 << (op & 0x07)));
          mycycles += 4;
        } else if (hi === 0xa8) {
          argR();
          this.memWriteByte(r1, this.memReadByte(r1) | (1 << (op & 0x07)));
          mycycles += 4;
        } else if (hi === 0xb0) {
          argrR();
          this.memWriteByte(r1, this.memReadByte(r2));
          mycycles += 4;
        } else if (hi === 0xb8) {
          argrR();
          this.memWriteByte(r2, this.memReadByte(r1));
          mycycles += 4;
        } else if (hi === 0xc0) {
          argri();
          this.memWriteByte(r1, r2);
          mycycles += 4;
        } else if (hi === 0xc8) {
          argpi();
          this.memWriteByte(r1, r2);
          mycycles += 4;
        } else if ((op & 0xf0) === 0xd0) {
          argd8();
          if (checkCC(op)) {
            this.pc = s2;
            mycycles += 8;
          } else {
            mycycles += 4;
          }
        } else if ((op & 0xf0) === 0xe0) {
          argR();
          s2 = (0x1000 + ((op & 0x0f) << 8) + r1) & 0xffff;
          this.pushByte(this.pc & 0xff);
          this.pushByte((this.pc >> 8) & 0xff);
          this.pc = s2;
          mycycles += this.sys & 0x40 ? 12 : 9;
        } else {
          switch (op) {
            case 0xf0:
              mycycles += 2;
              if (this.clockChanged) this.clockChanged = 0;
              break;
            case 0xf1:
              this.halted = true;
              mycycles += 2;
              break;
            case 0xf8:
              r1 = this.popByte();
              r2 = this.popByte();
              this.pc = ((r1 << 8) | r2) & 0xffff;
              mycycles += this.sys & 0x40 ? 10 : 8;
              break;
            case 0xf9:
              this.ps1 = this.popByte();
              r1 = this.popByte();
              r2 = this.popByte();
              this.pc = ((r1 << 8) | r2) & 0xffff;
              mycycles += this.sys & 0x40 ? 12 : 10;
              break;
            case 0xfa: this.ps1 &= ~FLAG_C; mycycles += 2; break;
            case 0xfb: this.ps1 ^= FLAG_C; mycycles += 2; break;
            case 0xfc: this.ps1 |= FLAG_C; mycycles += 2; break;
            case 0xfd: this.ps1 |= FLAG_I; mycycles += 2; break;
            case 0xfe: this.ps1 &= ~FLAG_I; mycycles += 2; break;
            default: mycycles += 2; break;
          }
        }
      }
    }

    if (this.sys & 0x40) {
      this.internalRam[SM8521_SPH] = (this.sp >> 8) & 0xff;
    }
    this.internalRam[SM8521_SPL] = this.sp & 0xff;
    this.memWriteByte(SM8521_PS0, this.ps0);
    this.internalRam[SM8521_PS1] = this.ps1;
    this.ps1 = this.internalRam[SM8521_PS1];
    return mycycles;
  }

  public renderShadeBuffer(outShades: Uint8Array): void {
    const lcdc = this.internalRam[SM8521_LCDC];
    if ((lcdc & 0x80) === 0) {
      outShades.fill(0);
      return;
    }

    const baseAddr = (lcdc & 0x40) !== 0 ? 0x2000 : 0x0000;
    const contrastMode = lcdc & 0x30;
    // Map Game.com pixel value 0..3 -> 0=lightest, 3=darkest
    const p0 = 0;
    const p1 = contrastMode === 0x30 ? 2 : 1;
    const p2 = 2;
    const p3 = 3;

    for (let x = 0; x < REAL_SCREEN_WIDTH; x++) {
      const colBase = baseAddr + 40 * x;
      for (let i = 0; i < 40; i++) {
        const p = this.vram[colBase + i];
        const yBase = i * 4;
        const s0 = (p >> 6) & 3;
        const s1 = (p >> 4) & 3;
        const s2 = (p >> 2) & 3;
        const s3 = p & 3;
        outShades[yBase * REAL_SCREEN_WIDTH + x] = s0 === 0 ? p0 : s0 === 1 ? p1 : s0 === 2 ? p2 : p3;
        outShades[(yBase + 1) * REAL_SCREEN_WIDTH + x] = s1 === 0 ? p0 : s1 === 1 ? p1 : s1 === 2 ? p2 : p3;
        outShades[(yBase + 2) * REAL_SCREEN_WIDTH + x] = s2 === 0 ? p0 : s2 === 1 ? p1 : s2 === 2 ? p2 : p3;
        outShades[(yBase + 3) * REAL_SCREEN_WIDTH + x] = s3 === 0 ? p0 : s3 === 1 ? p1 : s3 === 2 ? p2 : p3;
      }
    }
  }

  public getSnapshot(frameCount: number): CpuSnapshot {
    const regs: number[] = [];
    const base = this.ps0 & 0xf8;
    for (let i = 0; i < 16; i++) {
      regs.push(this.registerRam[base + i]);
    }
    return {
      pc: this.pc,
      sp: this.sp,
      ps0: this.ps0,
      ps1: this.ps1,
      ie0: this.internalRam[SM8521_IE0],
      ie1: this.internalRam[SM8521_IE1],
      ir0: this.internalRam[SM8521_IR0],
      ir1: this.internalRam[SM8521_IR1],
      mmu: [
        this.internalRam[SM8521_MMU0],
        this.internalRam[SM8521_MMU1],
        this.internalRam[SM8521_MMU2],
        this.internalRam[SM8521_MMU3],
        this.internalRam[SM8521_MMU4],
      ],
      lcc: this.internalRam[SM8521_LCDC],
      registers: regs,
      halted: this.halted,
      cycles: this.cycles,
      frameCount,
    };
  }

  public captureRealCpuState() {
    return {
      sp: this.sp,
      ps0: this.ps0,
      ps1: this.ps1,
      sys: this.sys,
      ckc: this.ckc,
      ie0: this.ie0,
      ie1: this.ie1,
      ir0: this.ir0,
      ir1: this.ir1,
      mmu: [
        this.internalRam[SM8521_MMU0],
        this.internalRam[SM8521_MMU1],
        this.internalRam[SM8521_MMU2],
        this.internalRam[SM8521_MMU3],
        this.internalRam[SM8521_MMU4],
      ] as [number, number, number, number, number],
      iflags: this.iflags,
      cartEnabled: this.cartEnabled,
    };
  }

  public restoreRealState(params: {
    pc: number;
    halted: boolean;
    cycles: number;
    internalRam: number[];
    extendedRam: number[];
    vramBank0: number[];
    vramBank1: number[];
    registerRam?: number[];
    realCpuState?: {
      sp: number;
      ps0: number;
      ps1: number;
      sys: number;
      ckc: number;
      ie0: number;
      ie1: number;
      ir0: number;
      ir1: number;
      mmu: [number, number, number, number, number];
      iflags: number;
      cartEnabled: boolean;
    };
  }): void {
    this.internalRam.set(params.internalRam.slice(0, this.internalRam.length));
    this.extendedRam.set(params.extendedRam.slice(0, this.extendedRam.length));
    this.vram.set(params.vramBank0.slice(0, 0x2000), 0);
    this.vram.set(params.vramBank1.slice(0, 0x2000), 0x2000);
    if (params.registerRam) {
      this.registerRam.set(params.registerRam.slice(0, this.registerRam.length));
    }

    this.pc = params.pc & 0xffff;
    this.halted = params.halted;
    this.cycles = params.cycles;

    if (params.realCpuState) {
      const s = params.realCpuState;
      this.sp = s.sp;
      this.ps0 = s.ps0;
      this.ps1 = s.ps1;
      this.sys = s.sys;
      this.ckc = s.ckc;
      this.ie0 = s.ie0;
      this.ie1 = s.ie1;
      this.ir0 = s.ir0;
      this.ir1 = s.ir1;
      this.iflags = s.iflags;
      this.checkInterrupts = this.iflags !== 0 ? 1 : 0;
      this.cartEnabled = s.cartEnabled && this.hasCartridge;
      this.setMmuBank(1, s.mmu[1]);
      this.setMmuBank(2, s.mmu[2]);
      this.setMmuBank(3, s.mmu[3]);
      this.setMmuBank(4, s.mmu[4]);
    } else {
      this.sys = this.internalRam[SM8521_SYS];
      this.ps0 = this.internalRam[SM8521_PS0];
      this.ps1 = this.internalRam[SM8521_PS1];
      this.ie0 = this.internalRam[SM8521_IE0];
      this.ie1 = this.internalRam[SM8521_IE1];
      this.ir0 = this.internalRam[SM8521_IR0];
      this.ir1 = this.internalRam[SM8521_IR1];
      this.getSp();
      this.cartEnabled = (this.internalRam[SM8521_P3] & 0xc0) === 0x40 && this.hasCartridge;
      this.setMmuBank(1, this.internalRam[SM8521_MMU1]);
      this.setMmuBank(2, this.internalRam[SM8521_MMU2]);
      this.setMmuBank(3, this.internalRam[SM8521_MMU3]);
      this.setMmuBank(4, this.internalRam[SM8521_MMU4]);
    }

    // Re-sync audio registers
    this.audio.silenceAll();
    for (let r = 0x60; r <= 0x7f; r++) {
      this.audio.updateRealRegister(r, this.internalRam[r]);
    }
    for (let r = 0x40; r <= 0x4d; r++) {
      this.audio.updateRealRegister(r, this.internalRam[r]);
    }
  }
}
