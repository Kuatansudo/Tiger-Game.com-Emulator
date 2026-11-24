import { AudioChannelState, RemoteAudioSnapshot } from './types';

const PCM_RING_SIZE = 16384;
const TARGET_BUFFER_SAMPLES = 2048;
const PREBUFFER_SAMPLES = 1024;
const MAX_FRAME_EVENTS = 4096;

const EV_REAL_REG = 0;
const EV_HOMEBREW_REG = 1;
const EV_FREQ_DIV0 = 2;
const EV_FREQ_DIV1 = 3;
const EV_WAVE0_BYTE = 4;
const EV_WAVE1_BYTE = 5;

export class GameComAudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private synthNode: ScriptProcessorNode | null = null;

  // Sample-accurate circular PCM buffer fed per frame and drained by AudioContext
  private pcmRing = new Float32Array(PCM_RING_SIZE);
  private pcmWritePos = 0;
  private pcmReadPos = 0;
  private draining = false;
  private lastOutputSample = 0;

  // Cycle-timestamped intra-frame register event queue (zero-GC)
  private inFrame = false;
  private currentFrameCycle = 0;
  private eventCount = 0;
  private evCycle = new Int32Array(MAX_FRAME_EVENTS);
  private evKind = new Uint8Array(MAX_FRAME_EVENTS);
  private evArg1 = new Uint16Array(MAX_FRAME_EVENTS);
  private evArg2 = new Uint16Array(MAX_FRAME_EVENTS);

  // Synthesizer internal phase & envelope state
  private phase0 = 0;
  private phase1 = 0;
  private noisePhase = 0;
  private lfsr = 0x7fff;
  private env0 = 0;
  private env1 = 0;
  private envNoise = 0;
  private dacDc = 0;
  private dacOut = 0;

  // UI-observable channel state
  private state: AudioChannelState = {
    wave0Enabled: true,
    wave1Enabled: true,
    noiseEnabled: true,
    dacEnabled: true,
    masterVolume: 0.55,
    muted: false,
    wave0FreqHz: 0,
    wave1FreqHz: 0,
    noiseLevel: 0,
    dacValue: 0x80,
  };

  private waveTable0 = new Uint8Array(32);
  private waveTable1 = new Uint8Array(32);
  private waveLen0: 16 | 32 = 16;
  private waveLen1: 16 | 32 = 16;
  private wave0Vol = 0;
  private wave1Vol = 0;
  private noiseVol = 0;
  private noiseHz = 1800;
  private soundControl = 0; // SGC register (0x0050 homebrew / 0x0040 real)
  private realAudioMode = false;
  private sg0t = 0;
  private sg1t = 0;
  private sg2t = 0;
  private freqDivider0 = 0;
  private freqDivider1 = 0;

  constructor() {
    for (let i = 0; i < 32; i++) {
      this.waveTable0[i] = (i & 15) < 8 ? 15 : 0;
      this.waveTable1[i] = (i & 15) < 4 ? 15 : 0;
    }
  }

  public init(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') {
        void this.ctx.resume();
      }
      return;
    }

    if (typeof window === 'undefined') return;
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    this.ctx = new AudioCtx();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.state.muted ? 0 : this.state.masterVolume;

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;

    this.masterGain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    // Unified 1024-sample PCM synthesizer sink (zero node desync, zero oscillator clicks)
    this.synthNode = this.ctx.createScriptProcessor(1024, 0, 1);
    this.synthNode.onaudioprocess = (e) => {
      const out = e.outputBuffer.getChannelData(0);
      const avail = this.getBufferedSampleCount();

      if (!this.draining) {
        if (avail >= PREBUFFER_SAMPLES) {
          this.draining = true;
        } else {
          out.fill(0);
          return;
        }
      }

      for (let i = 0; i < out.length; i++) {
        if (this.pcmReadPos !== this.pcmWritePos) {
          this.lastOutputSample = this.pcmRing[this.pcmReadPos];
          this.pcmReadPos = (this.pcmReadPos + 1) % PCM_RING_SIZE;
        } else {
          // Smooth zero decay on rare underrun instead of harsh click
          this.draining = false;
          this.lastOutputSample *= 0.985;
        }
        out[i] = this.lastOutputSample;
      }
    };

    this.synthNode.connect(this.masterGain);
    this.syncGains();
  }

  public resume(): void {
    if (!this.ctx) {
      this.init();
    } else if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
  }

  private getBufferedSampleCount(): number {
    return (this.pcmWritePos - this.pcmReadPos + PCM_RING_SIZE) % PCM_RING_SIZE;
  }

  private queueOrApply(kind: number, arg1: number, arg2: number): void {
    if (this.inFrame) {
      if (this.eventCount < MAX_FRAME_EVENTS) {
        const idx = this.eventCount++;
        this.evCycle[idx] = this.currentFrameCycle;
        this.evKind[idx] = kind;
        this.evArg1[idx] = arg1 & 0xffff;
        this.evArg2[idx] = arg2 & 0xffff;
      }
      // Keep UI-facing frequencies/levels updated immediately too
      this.applyEventStateOnly(kind, arg1, arg2);
    } else {
      this.applyEventStateOnly(kind, arg1, arg2);
    }
  }

  private applyEventStateOnly(kind: number, arg1: number, arg2: number): void {
    switch (kind) {
      case EV_REAL_REG:
        this.applyRealRegisterImmediate(arg1, arg2);
        break;
      case EV_HOMEBREW_REG:
        this.applyHomebrewRegisterImmediate(arg1, arg2);
        break;
      case EV_FREQ_DIV0:
        this.freqDivider0 = arg1 & 0x0fff;
        this.state.wave0FreqHz =
          this.freqDivider0 > 0
            ? Math.round(Math.max(40, Math.min(14000, 262144 / (this.freqDivider0 + 1))))
            : 0;
        break;
      case EV_FREQ_DIV1:
        this.freqDivider1 = arg1 & 0x0fff;
        this.state.wave1FreqHz =
          this.freqDivider1 > 0
            ? Math.round(Math.max(40, Math.min(14000, 262144 / (this.freqDivider1 + 1))))
            : 0;
        break;
      case EV_WAVE0_BYTE:
        this.waveLen0 = 16;
        this.waveTable0[arg1 & 0x0f] = arg2 & 0x0f;
        break;
      case EV_WAVE1_BYTE:
        this.waveLen1 = 16;
        this.waveTable1[arg1 & 0x0f] = arg2 & 0x0f;
        break;
    }
  }

  private applyHomebrewRegisterImmediate(reg: number, val: number): void {
    this.realAudioMode = false;
    const v = val & 0xff;
    if (reg === 0x50) {
      this.soundControl = v;
      return;
    }
    if (reg === 0x53) {
      this.wave0Vol = v & 0x1f;
      return;
    }
    if (reg === 0x56) {
      this.wave1Vol = v & 0x1f;
      return;
    }
    if (reg === 0x57) {
      const shift = (v >> 4) & 0x0f;
      this.noiseHz = Math.max(120, Math.min(8000, 7500 / (1 + shift * 0.6)));
      return;
    }
    if (reg === 0x59) {
      this.noiseVol = v & 0x1f;
      this.state.noiseLevel = this.noiseVol / 31;
      return;
    }
    if (reg === 0x58) {
      this.state.dacValue = v;
    }
  }

  private applyRealRegisterImmediate(reg: number, val: number): void {
    this.realAudioMode = true;
    const v = val & 0xff;
    switch (reg) {
      case 0x40: // SGC
        this.soundControl = v;
        this.state.wave0FreqHz =
          this.sg0t > 0 ? Math.round(Math.max(35, Math.min(14000, 2764800 / (32 * this.sg0t)))) : 0;
        this.state.wave1FreqHz =
          this.sg1t > 0 ? Math.round(Math.max(35, Math.min(14000, 2764800 / (32 * this.sg1t)))) : 0;
        return;
      case 0x42: // SG0L
        this.wave0Vol = v & 0x1f;
        return;
      case 0x44: // SG1L
        this.wave1Vol = v & 0x1f;
        return;
      case 0x46: // SG0TH
        this.sg0t = (this.sg0t & 0x00ff) | (v << 8);
        this.state.wave0FreqHz =
          this.sg0t > 0 ? Math.round(Math.max(35, Math.min(14000, 2764800 / (32 * this.sg0t)))) : 0;
        return;
      case 0x47: // SG0TL
        this.sg0t = (this.sg0t & 0xff00) | v;
        this.state.wave0FreqHz =
          this.sg0t > 0 ? Math.round(Math.max(35, Math.min(14000, 2764800 / (32 * this.sg0t)))) : 0;
        return;
      case 0x48: // SG1TH
        this.sg1t = (this.sg1t & 0x00ff) | (v << 8);
        this.state.wave1FreqHz =
          this.sg1t > 0 ? Math.round(Math.max(35, Math.min(14000, 2764800 / (32 * this.sg1t)))) : 0;
        return;
      case 0x49: // SG1TL
        this.sg1t = (this.sg1t & 0xff00) | v;
        this.state.wave1FreqHz =
          this.sg1t > 0 ? Math.round(Math.max(35, Math.min(14000, 2764800 / (32 * this.sg1t)))) : 0;
        return;
      case 0x4a: // SG2L
        this.noiseVol = v & 0x1f;
        this.state.noiseLevel = this.noiseVol / 31;
        return;
      case 0x4c: // SG2TH
        this.sg2t = (this.sg2t & 0x00ff) | (v << 8);
        if (this.sg2t > 0) {
          this.noiseHz = Math.max(120, Math.min(8000, 172800 / this.sg2t));
        }
        return;
      case 0x4d: // SG2TL
        this.sg2t = (this.sg2t & 0xff00) | v;
        if (this.sg2t > 0) {
          this.noiseHz = Math.max(120, Math.min(8000, 172800 / this.sg2t));
        }
        return;
      case 0x4e: // SGDA
        if ((this.soundControl & 0x88) === 0x88) {
          this.state.dacValue = v;
        }
        return;
      default:
        if (reg >= 0x60 && reg <= 0x6f) {
          const idx = (reg - 0x60) * 2;
          this.waveLen0 = 32;
          this.waveTable0[idx] = v & 0x0f;
          this.waveTable0[idx + 1] = (v >> 4) & 0x0f;
        } else if (reg >= 0x70 && reg <= 0x7f) {
          const idx = (reg - 0x70) * 2;
          this.waveLen1 = 32;
          this.waveTable1[idx] = v & 0x0f;
          this.waveTable1[idx + 1] = (v >> 4) & 0x0f;
        }
    }
  }

  public beginFrame(): void {
    this.capturePreFrameSnapshot();
    this.inFrame = true;
    this.currentFrameCycle = 0;
    this.eventCount = 0;
  }

  public setFrameCycle(cycle: number): void {
    this.currentFrameCycle = cycle;
  }

  public endFrame(totalCycles: number): void {
    const count = this.eventCount;
    this.inFrame = false;

    if (!this.ctx || this.ctx.state !== 'running') {
      // Ensure final register state stays synchronized even while audio is locked
      this.eventCount = 0;
      return;
    }

    // Rewind synth registers to start-of-frame snapshot? Wait:
    // Because queueOrApply already mutated live state incrementally,
    // wait: if there were multiple writes in one frame (e.g. 200 DAC writes in an 11kHz voice!),
    // we want to step through those exact 200 events across the frame!
    // To guarantee exact initial state + event playback without storing shadow copies,
    // we snapshot start-of-frame state in beginFrame? Or even simpler:
    // Wait: during a frame, waveTables/SGC/freq/vol/dac only diverge when events occur!
    // Let's synthesize directly from pre-frame state when events exist OR restore snapshot cleanly!
    const sampleRate = this.ctx.sampleRate;
    const safeTotalCycles = Math.max(1, totalCycles);
    const avail = this.getBufferedSampleCount();

    // Prevent excessive audio latency after tab switch / stall
    if (avail > 6144) {
      this.pcmReadPos = (this.pcmWritePos - TARGET_BUFFER_SAMPLES + PCM_RING_SIZE) % PCM_RING_SIZE;
    }

    const currentAvail = this.getBufferedSampleCount();
    const baseSamples = sampleRate / 60;
    // Dynamic Rate Control keeps buffer centered near TARGET_BUFFER_SAMPLES without pitch warble
    const rateCorrection = Math.max(-16, Math.min(16, (TARGET_BUFFER_SAMPLES - currentAvail) * 0.025));
    const outSamples = Math.max(256, Math.round(baseSamples + rateCorrection));

    this.synthesizeFrameBlock(outSamples, sampleRate, safeTotalCycles, count);
    this.eventCount = 0;
  }

  // Synthesize a block of samples using the frame's timestamped register events
  private synthesizeFrameBlock(
    outSamples: number,
    sampleRate: number,
    totalCycles: number,
    eventCount: number
  ): void {
    // Rewind register state? Notice that for fast intra-frame DAC streams (0x4E / 0x58) and
    // pitch/volume envelopes, replaying events in order from current frame start works best
    // when we snapshot before frame — wait: if we didn't snapshot, event[0..count-1] already
    // updated live state to end-of-frame, EXCEPT DAC samples written at cycle c_0..c_k!
    // Look how clean it is to reconstruct the exact DAC + register timeline:
    // Let's keep a tiny pre-frame snapshot so beginFrame() -> endFrame() replays 100% accurately!
    // Wait: let's add pre-frame snapshot capture in beginFrame() right below!
    let evIdx = 0;

    // Restore pre-frame snapshot so event replay steps cleanly from cycle 0 -> totalCycles
    if (eventCount > 0) {
      this.restorePreFrameSnapshot();
    }

    for (let i = 0; i < outSamples; i++) {
      const targetCycle = (i / outSamples) * totalCycles;
      while (evIdx < eventCount && this.evCycle[evIdx] <= targetCycle) {
        this.applyEventStateOnly(this.evKind[evIdx], this.evArg1[evIdx], this.evArg2[evIdx]);
        evIdx++;
      }

      const globalOn = (this.soundControl & 0x80) !== 0;
      const en0 = !this.realAudioMode || (this.soundControl & 0x01) !== 0;
      const en1 = !this.realAudioMode || (this.soundControl & 0x02) !== 0;
      const en2 = !this.realAudioMode || (this.soundControl & 0x04) !== 0;
      const enDac = !this.realAudioMode || (this.soundControl & 0x08) !== 0;

      // Channel 0: 4-bit Wavetable
      let s0 = 0;
      const targetGain0 =
        globalOn && en0 && this.state.wave0Enabled && this.state.wave0FreqHz > 0 && this.wave0Vol > 0
          ? (this.wave0Vol / 31) * 0.24
          : 0;
      this.env0 += (targetGain0 - this.env0) * 0.08;
      if (this.env0 > 0.0005 && this.state.wave0FreqHz > 0) {
        this.phase0 += (this.state.wave0FreqHz * this.waveLen0) / sampleRate;
        if (this.phase0 >= this.waveLen0) {
          this.phase0 %= this.waveLen0;
        }
        const i0 = this.phase0 | 0;
        const i1 = (i0 + 1) % this.waveLen0;
        const v0 = (this.waveTable0[i0] - 7.5) / 7.5;
        const v1 = (this.waveTable0[i1] - 7.5) / 7.5;
        s0 = (v0 * 0.78 + v1 * 0.22) * this.env0;
      }

      // Channel 1: 4-bit Wavetable
      let s1 = 0;
      const targetGain1 =
        globalOn && en1 && this.state.wave1Enabled && this.state.wave1FreqHz > 0 && this.wave1Vol > 0
          ? (this.wave1Vol / 31) * 0.24
          : 0;
      this.env1 += (targetGain1 - this.env1) * 0.08;
      if (this.env1 > 0.0005 && this.state.wave1FreqHz > 0) {
        this.phase1 += (this.state.wave1FreqHz * this.waveLen1) / sampleRate;
        if (this.phase1 >= this.waveLen1) {
          this.phase1 %= this.waveLen1;
        }
        const i0 = this.phase1 | 0;
        const i1 = (i0 + 1) % this.waveLen1;
        const v0 = (this.waveTable1[i0] - 7.5) / 7.5;
        const v1 = (this.waveTable1[i1] - 7.5) / 7.5;
        s1 = (v0 * 0.78 + v1 * 0.22) * this.env1;
      }

      // Channel 2: 15-bit LFSR Noise
      let s2 = 0;
      const targetNoise =
        globalOn && en2 && this.state.noiseEnabled && this.noiseVol > 0
          ? (this.noiseVol / 31) * 0.24
          : 0;
      this.envNoise += (targetNoise - this.envNoise) * 0.08;
      if (this.envNoise > 0.0005) {
        this.noisePhase += this.noiseHz / sampleRate;
        while (this.noisePhase >= 1) {
          this.noisePhase -= 1;
          const bit = (this.lfsr ^ (this.lfsr >> 1)) & 1;
          this.lfsr = (this.lfsr >> 1) | (bit << 14);
        }
        s2 = ((this.lfsr & 1) !== 0 ? 1 : -1) * this.envNoise;
      }

      // Channel 3: 8-bit PCM DAC with DC blocker & mild smoothing
      const dacActive = globalOn && enDac && this.state.dacEnabled;
      const rawDac = dacActive ? ((this.state.dacValue - 128) / 128) * 0.45 : 0;
      this.dacDc += (rawDac - this.dacDc) * 0.0015;
      const acDac = rawDac - this.dacDc;
      this.dacOut += (acDac - this.dacOut) * 0.55;

      let mix = s0 + s1 + s2 + this.dacOut;
      if (mix > 0.95) mix = 0.95 + (mix - 0.95) * 0.2;
      else if (mix < -0.95) mix = -0.95 + (mix + 0.95) * 0.2;

      this.pcmRing[this.pcmWritePos] = mix;
      this.pcmWritePos = (this.pcmWritePos + 1) % PCM_RING_SIZE;
      if (this.pcmWritePos === this.pcmReadPos) {
        this.pcmReadPos = (this.pcmReadPos + 1) % PCM_RING_SIZE;
      }
    }

    // Apply any remaining events at end of frame so post-frame state is exact
    while (evIdx < eventCount) {
      this.applyEventStateOnly(this.evKind[evIdx], this.evArg1[evIdx], this.evArg2[evIdx]);
      evIdx++;
    }
  }

  // Pre-frame state snapshot for accurate cycle-ordered event replay
  private snapSoundControl = 0;
  private snapRealMode = false;
  private snapWave0Vol = 0;
  private snapWave1Vol = 0;
  private snapNoiseVol = 0;
  private snapNoiseHz = 1800;
  private snapDacVal = 0x80;
  private snapSg0t = 0;
  private snapSg1t = 0;
  private snapSg2t = 0;
  private snapFreqDiv0 = 0;
  private snapFreqDiv1 = 0;
  private snapWaveLen0: 16 | 32 = 16;
  private snapWaveLen1: 16 | 32 = 16;
  private snapWave0 = new Uint8Array(32);
  private snapWave1 = new Uint8Array(32);

  public capturePreFrameSnapshot(): void {
    this.snapSoundControl = this.soundControl;
    this.snapRealMode = this.realAudioMode;
    this.snapWave0Vol = this.wave0Vol;
    this.snapWave1Vol = this.wave1Vol;
    this.snapNoiseVol = this.noiseVol;
    this.snapNoiseHz = this.noiseHz;
    this.snapDacVal = this.state.dacValue;
    this.snapSg0t = this.sg0t;
    this.snapSg1t = this.sg1t;
    this.snapSg2t = this.sg2t;
    this.snapFreqDiv0 = this.freqDivider0;
    this.snapFreqDiv1 = this.freqDivider1;
    this.snapWaveLen0 = this.waveLen0;
    this.snapWaveLen1 = this.waveLen1;
    this.snapWave0.set(this.waveTable0);
    this.snapWave1.set(this.waveTable1);
  }

  private restorePreFrameSnapshot(): void {
    this.soundControl = this.snapSoundControl;
    this.realAudioMode = this.snapRealMode;
    this.wave0Vol = this.snapWave0Vol;
    this.wave1Vol = this.snapWave1Vol;
    this.noiseVol = this.snapNoiseVol;
    this.noiseHz = this.snapNoiseHz;
    this.state.dacValue = this.snapDacVal;
    this.sg0t = this.snapSg0t;
    this.sg1t = this.snapSg1t;
    this.sg2t = this.snapSg2t;
    this.freqDivider0 = this.snapFreqDiv0;
    this.freqDivider1 = this.snapFreqDiv1;
    this.waveLen0 = this.snapWaveLen0;
    this.waveLen1 = this.snapWaveLen1;
    this.waveTable0.set(this.snapWave0);
    this.waveTable1.set(this.snapWave1);

    if (this.realAudioMode) {
      this.state.wave0FreqHz =
        this.sg0t > 0 ? Math.round(Math.max(35, Math.min(14000, 2764800 / (32 * this.sg0t)))) : 0;
      this.state.wave1FreqHz =
        this.sg1t > 0 ? Math.round(Math.max(35, Math.min(14000, 2764800 / (32 * this.sg1t)))) : 0;
    } else {
      this.state.wave0FreqHz =
        this.freqDivider0 > 0
          ? Math.round(Math.max(40, Math.min(14000, 262144 / (this.freqDivider0 + 1))))
          : 0;
      this.state.wave1FreqHz =
        this.freqDivider1 > 0
          ? Math.round(Math.max(40, Math.min(14000, 262144 / (this.freqDivider1 + 1))))
          : 0;
    }
    this.state.noiseLevel = this.noiseVol / 31;
  }

  public setWaveTableByte(channel: 0 | 1, index: number, value: number): void {
    this.queueOrApply(channel === 0 ? EV_WAVE0_BYTE : EV_WAVE1_BYTE, index, value);
  }

  public setWaveTables(t0: Uint8Array, t1: Uint8Array): void {
    this.waveLen0 = t0.length >= 32 ? 32 : 16;
    this.waveLen1 = t1.length >= 32 ? 32 : 16;
    this.waveTable0.set(t0.subarray(0, 32));
    this.waveTable1.set(t1.subarray(0, 32));
  }

  public getWaveTables(): { wave0: Uint8Array; wave1: Uint8Array } {
    return {
      wave0: new Uint8Array(this.waveTable0.subarray(0, this.waveLen0)),
      wave1: new Uint8Array(this.waveTable1.subarray(0, this.waveLen1)),
    };
  }

  public updateRegister(reg: number, val: number): void {
    this.queueOrApply(EV_HOMEBREW_REG, reg, val);
  }

  public updateRealRegister(reg: number, val: number): void {
    this.queueOrApply(EV_REAL_REG, reg, val);
  }

  public setFrequencyDivider(channel: 0 | 1, divider16: number): void {
    this.queueOrApply(channel === 0 ? EV_FREQ_DIV0 : EV_FREQ_DIV1, divider16, 0);
  }

  private syncGains(): void {
    if (!this.ctx || !this.masterGain) return;
    this.masterGain.gain.setTargetAtTime(
      this.state.muted ? 0 : this.state.masterVolume,
      this.ctx.currentTime,
      0.01
    );
  }

  public silenceAll(): void {
    this.inFrame = false;
    this.eventCount = 0;
    this.wave0Vol = 0;
    this.wave1Vol = 0;
    this.noiseVol = 0;
    this.env0 = 0;
    this.env1 = 0;
    this.envNoise = 0;
    this.dacOut = 0;
    this.state.wave0FreqHz = 0;
    this.state.wave1FreqHz = 0;
    this.state.noiseLevel = 0;
    this.pcmReadPos = 0;
    this.pcmWritePos = 0;
    this.draining = false;
    this.lastOutputSample = 0;
  }

  public setMasterVolume(volume: number): void {
    this.state.masterVolume = Math.max(0, Math.min(1, volume));
    this.syncGains();
  }

  public setMuted(muted: boolean): void {
    this.state.muted = muted;
    this.syncGains();
  }

  public toggleChannel(channel: 'wave0' | 'wave1' | 'noise' | 'dac'): void {
    if (channel === 'wave0') this.state.wave0Enabled = !this.state.wave0Enabled;
    if (channel === 'wave1') this.state.wave1Enabled = !this.state.wave1Enabled;
    if (channel === 'noise') this.state.noiseEnabled = !this.state.noiseEnabled;
    if (channel === 'dac') this.state.dacEnabled = !this.state.dacEnabled;
  }

  public getState(): AudioChannelState {
    return { ...this.state };
  }

  public exportRemoteSnapshot(): RemoteAudioSnapshot {
    return {
      realAudioMode: this.realAudioMode,
      soundControl: this.soundControl,
      wave0FreqHz: this.state.wave0FreqHz,
      wave1FreqHz: this.state.wave1FreqHz,
      wave0Vol: this.wave0Vol,
      wave1Vol: this.wave1Vol,
      noiseVol: this.noiseVol,
      noiseHz: this.noiseHz,
      dacValue: this.state.dacValue,
      waveLen0: this.waveLen0,
      waveLen1: this.waveLen1,
      waveTable0: Array.from(this.waveTable0.subarray(0, this.waveLen0)),
      waveTable1: Array.from(this.waveTable1.subarray(0, this.waveLen1)),
    };
  }

  public applyRemoteSnapshot(snap: RemoteAudioSnapshot): void {
    this.realAudioMode = snap.realAudioMode;
    this.soundControl = snap.soundControl;
    this.state.wave0FreqHz = snap.wave0FreqHz;
    this.state.wave1FreqHz = snap.wave1FreqHz;
    this.wave0Vol = snap.wave0Vol;
    this.wave1Vol = snap.wave1Vol;
    this.noiseVol = snap.noiseVol;
    this.state.noiseLevel = snap.noiseVol / 31;
    this.noiseHz = snap.noiseHz;
    this.state.dacValue = snap.dacValue;
    this.waveLen0 = snap.waveLen0 === 32 ? 32 : 16;
    this.waveLen1 = snap.waveLen1 === 32 ? 32 : 16;
    this.waveTable0.set(snap.waveTable0.slice(0, 32));
    this.waveTable1.set(snap.waveTable1.slice(0, 32));
  }

  public renderRemoteFrame(): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const sampleRate = this.ctx.sampleRate;
    const avail = this.getBufferedSampleCount();
    if (avail > 6144) {
      this.pcmReadPos = (this.pcmWritePos - TARGET_BUFFER_SAMPLES + PCM_RING_SIZE) % PCM_RING_SIZE;
    }
    const baseSamples = sampleRate / 60;
    const adj = Math.max(-16, Math.min(16, (TARGET_BUFFER_SAMPLES - this.getBufferedSampleCount()) * 0.025));
    this.synthesizeFrameBlock(Math.max(256, Math.round(baseSamples + adj)), sampleRate, 1, 0);
  }

  public getWaveformSamples(target: Uint8Array<ArrayBuffer>): void {
    if (this.analyser) {
      this.analyser.getByteTimeDomainData(target);
    } else {
      target.fill(128);
    }
  }

  public destroy(): void {
    try {
      this.synthNode?.disconnect();
      this.masterGain?.disconnect();
      this.analyser?.disconnect();
      void this.ctx?.close();
    } catch {
      // Ignore cleanup errors
    }
    this.ctx = null;
  }
}
