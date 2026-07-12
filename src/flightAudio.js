/**
 * Procedural flight audio — wind whoosh (airspeed) + vario beeps (climb/sink).
 * Web Audio API only; no external assets. Starts on first user gesture.
 */

export class FlightAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.enabled = true;
    this._beepTimer = 0;
    this._sinkPulseTimer = 0;
    this._master = null;
    this._windGain = null;
    this._windFilter = null;
    this._windSrc = null;
    this._varioGain = null;
    // Continuous sink tone (classic vario)
    this._sinkOsc = null;
    this._sinkOsc2 = null;
    this._sinkGain = null;
    this._sinkActive = false;
    // Landing gear motor
    this._gearGain = null;
    this._gearFilter = null;
    this._gearOsc = null;
    this._gearNoise = null;
    this._gearOscGain = null;
    this._gearNoiseGain = null;
    this._lastGearTarget = null;
    this._gearMotorUntil = 0;
    this._gearWasMoving = false;
    // Ground roll rumble
    this._rollGain = null;
    this._rollLow = null;
    this._rollMid = null;
    this._rollNoise = null;
    this._rollNoiseGain = null;
    this._rollOsc = null;
    this._rollOscGain = null;
    this._rollOsc2 = null;
    this._rollOsc2Gain = null;
    this._rollGritTimer = 0;
  }

  /** Call from a click/key handler so the browser unlocks audio. */
  async ensureStarted() {
    if (!this.enabled) return;
    if (this.ready && this.ctx?.state === 'running') return;

    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;

    if (!this.ctx) {
      this.ctx = new AC();
      this._buildGraph();
    }
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        /* ignore */
      }
    }
    this.ready = this.ctx.state === 'running';
  }

  _buildGraph() {
    const ctx = this.ctx;
    this._master = ctx.createGain();
    this._master.gain.value = 0.55;
    this._master.connect(ctx.destination);

    // —— Wind: looping filtered noise ——
    this._windGain = ctx.createGain();
    this._windGain.gain.value = 0;
    this._windFilter = ctx.createBiquadFilter();
    this._windFilter.type = 'bandpass';
    this._windFilter.frequency.value = 400;
    this._windFilter.Q.value = 0.7;

    // Gentle high-shelf so speed adds “air”
    this._windHigh = ctx.createBiquadFilter();
    this._windHigh.type = 'highshelf';
    this._windHigh.frequency.value = 2000;
    this._windHigh.gain.value = -6;

    const noiseBuf = this._makeNoiseBuffer(2);
    this._windSrc = ctx.createBufferSource();
    this._windSrc.buffer = noiseBuf;
    this._windSrc.loop = true;
    this._windSrc.connect(this._windFilter);
    this._windFilter.connect(this._windHigh);
    this._windHigh.connect(this._windGain);
    this._windGain.connect(this._master);
    this._windSrc.start();

    // Vario bus (climb beeps)
    this._varioGain = ctx.createGain();
    this._varioGain.gain.value = 0.45;
    this._varioGain.connect(this._master);

    // Continuous sink tone
    this._sinkGain = ctx.createGain();
    this._sinkGain.gain.value = 0.0001;
    this._sinkGain.connect(this._master);

    this._sinkOsc = ctx.createOscillator();
    this._sinkOsc.type = 'sine';
    this._sinkOsc.frequency.value = 320;
    this._sinkOsc2 = ctx.createOscillator();
    this._sinkOsc2.type = 'triangle';
    this._sinkOsc2.frequency.value = 320;
    const sinkMix = ctx.createGain();
    sinkMix.gain.value = 0.25;
    this._sinkOsc.connect(this._sinkGain);
    this._sinkOsc2.connect(sinkMix);
    sinkMix.connect(this._sinkGain);
    this._sinkOsc.start();
    this._sinkOsc2.start();
    this._sinkActive = true;

    // —— Gear motor (looping whir → destination, loud enough to hear) ——
    this._gearGain = ctx.createGain();
    this._gearGain.gain.value = 0.0001;
    this._gearGain.connect(ctx.destination); // not through soft master

    this._gearFilter = ctx.createBiquadFilter();
    this._gearFilter.type = 'lowpass';
    this._gearFilter.frequency.value = 2200;
    this._gearFilter.Q.value = 0.7;
    this._gearFilter.connect(this._gearGain);

    this._gearNoise = ctx.createBufferSource();
    this._gearNoise.buffer = this._makeNoiseBuffer(1.2);
    this._gearNoise.loop = true;
    this._gearNoiseGain = ctx.createGain();
    this._gearNoiseGain.gain.value = 0.35; // moderate whir
    this._gearNoise.connect(this._gearNoiseGain);
    this._gearNoiseGain.connect(this._gearFilter);
    this._gearNoise.start();

    this._gearOsc = ctx.createOscillator();
    this._gearOsc.type = 'sawtooth';
    this._gearOsc.frequency.value = 95;
    this._gearOscGain = ctx.createGain();
    this._gearOscGain.gain.value = 0.08;
    this._gearOsc.connect(this._gearOscGain);
    this._gearOscGain.connect(this._gearGain);
    this._gearOsc.start();

    // Second harmonic for more mechanical character
    this._gearOsc2 = ctx.createOscillator();
    this._gearOsc2.type = 'square';
    this._gearOsc2.frequency.value = 190;
    const g2 = ctx.createGain();
    g2.gain.value = 0.03;
    this._gearOsc2.connect(g2);
    g2.connect(this._gearGain);
    this._gearOsc2.start();

    // Ground-roll tire rumble — hot bus (not soft master) so it cuts through wind
    this._rollGain = ctx.createGain();
    this._rollGain.gain.value = 0.0001;
    this._rollGain.connect(ctx.destination);

    // Low rumble (asphalt / wheel thump)
    this._rollLow = ctx.createBiquadFilter();
    this._rollLow.type = 'lowpass';
    this._rollLow.frequency.value = 280;
    this._rollLow.Q.value = 0.8;
    this._rollLow.connect(this._rollGain);

    // Mid grit / gravel (audible on laptop speakers)
    this._rollMid = ctx.createBiquadFilter();
    this._rollMid.type = 'bandpass';
    this._rollMid.frequency.value = 900;
    this._rollMid.Q.value = 0.55;
    this._rollMid.connect(this._rollGain);

    // Shared noise source → both filters
    this._rollNoise = ctx.createBufferSource();
    this._rollNoise.buffer = this._makeRollNoiseBuffer(1.8);
    this._rollNoise.loop = true;
    this._rollNoiseGain = ctx.createGain();
    this._rollNoiseGain.gain.value = 1.0;
    this._rollNoise.connect(this._rollNoiseGain);
    this._rollNoiseGain.connect(this._rollLow);
    this._rollNoiseGain.connect(this._rollMid);
    this._rollNoise.start();

    // Wheel thump oscillator (speed-linked)
    this._rollOsc = ctx.createOscillator();
    this._rollOsc.type = 'triangle';
    this._rollOsc.frequency.value = 42;
    this._rollOscGain = ctx.createGain();
    this._rollOscGain.gain.value = 0.0001;
    this._rollOsc.connect(this._rollOscGain);
    this._rollOscGain.connect(this._rollGain);
    this._rollOsc.start();

    // Second partial for more tire "wobble"
    this._rollOsc2 = ctx.createOscillator();
    this._rollOsc2.type = 'sawtooth';
    this._rollOsc2.frequency.value = 84;
    this._rollOsc2Gain = ctx.createGain();
    this._rollOsc2Gain.gain.value = 0.0001;
    this._rollOsc2.connect(this._rollOsc2Gain);
    this._rollOsc2Gain.connect(this._rollGain);
    this._rollOsc2.start();

    this._rollGritTimer = 0;
  }

  _makeNoiseBuffer(seconds) {
    const rate = this.ctx.sampleRate;
    const n = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(1, n, rate);
    const data = buf.getChannelData(0);
    // Pink-ish noise (simple filter on white)
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < n; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + white * 0.099046;
      b1 = 0.963 * b1 + white * 0.2965164;
      b2 = 0.57 * b2 + white * 1.0526913;
      data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.11;
    }
    return buf;
  }

  /** Louder gravel / tire noise for ground roll (not shared with quiet wind). */
  _makeRollNoiseBuffer(seconds) {
    const rate = this.ctx.sampleRate;
    const n = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(1, n, rate);
    const data = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < n; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + white * 0.099046;
      b1 = 0.963 * b1 + white * 0.2965164;
      b2 = 0.57 * b2 + white * 1.0526913;
      // Stronger pink + occasional grit spikes (stones / joint seams)
      let s = (b0 + b1 + b2 + white * 0.35) * 0.42;
      if (Math.random() < 0.004) s += (Math.random() * 2 - 1) * 0.55;
      data[i] = Math.max(-1, Math.min(1, s));
    }
    return buf;
  }

  /**
   * @param {number} dt
   * @param {{ airspeed: number, vario: number, stalled?: boolean, alive?: boolean, brakes?: number, rolling?: boolean, gear?: number, gearPos?: number }} state
   */
  update(dt, state) {
    if (!this.ready || !this.ctx || this.ctx.state !== 'running') return;
    if (!state || (state.alive === false && !state.rolling)) {
      this._fadeWind(0.02, 0.15);
      this._setGearMotor(0);
      this._setRollNoise(0);
      return;
    }

    this._updateGearAudio(state);

    const spd = Math.max(0, state.airspeed); // m/s
    const brakes = Math.min(1, Math.max(0, state.brakes || 0));

    // Ground roll: tire rumble + wind, both fall with speed
    if (state.rolling) {
      this._updateRollNoise(dt, spd, brakes);
      this._beepTimer = 0;
      this._setSinkTone(0, 300, this.ctx.currentTime);
      return;
    }
    this._setRollNoise(0);
    this._rollGritTimer = 0;

    // Cruise ~28, dive 45+, stall low
    const spd01 = Math.min(1, Math.max(0, (spd - 8) / 50));
    const stallBoost = state.stalled ? 0.12 : 0;
    // Airbrakes: big buffeting whoosh (scales with speed so parked-deploy is quiet)
    const brakeBoost = brakes * (0.1 + spd01 * 0.38);

    // Whoosh volume & brightness track speed + airbrakes
    const targetVol = Math.min(0.85, 0.04 + spd01 * 0.42 + stallBoost + brakeBoost);
    const targetHz = 280 + spd01 * 1400 + (state.stalled ? 200 : 0) + brakes * 900;
    const targetShelf = -8 + spd01 * 10 + brakes * 8;

    const t = this.ctx.currentTime;
    this._windGain.gain.cancelScheduledValues(t);
    this._windGain.gain.setTargetAtTime(targetVol, t, 0.06);
    this._windFilter.frequency.setTargetAtTime(targetHz, t, 0.08);
    this._windHigh.gain.setTargetAtTime(targetShelf, t, 0.1);

    // Slight noise rate change via playback... buffer source rate not easily changed after start;
    // filter sweep carries the whoosh character enough.

    // —— Vario ——
    // Climb: interrupted beeps (higher / faster with lift)
    // Sink: continuous tone (lower / louder with more sink) — classic electronic vario
    const vs = state.vario; // m/s
    const tSink = this.ctx.currentTime;

    if (vs > 0.3) {
      // Silence sink tone while climbing
      this._setSinkTone(0, 400, tSink);

      const climb01 = Math.min(1, (vs - 0.3) / 4.5);
      const interval = 0.85 - climb01 * 0.7; // 0.85s → 0.15s
      this._beepTimer -= dt;
      if (this._beepTimer <= 0) {
        this._beepTimer = interval;
        const freq = 620 + climb01 * 520;
        this._beep(freq, 0.055 + climb01 * 0.02, 0.28 + climb01 * 0.15);
      }
    } else if (vs < -0.25) {
      // Continuous sink tone from mild descent through strong sink
      const sinkMag = -vs; // positive m/s down
      const sink01 = Math.min(1, (sinkMag - 0.25) / 5.5); // 0 at -0.25, 1 at ~-5.75
      // Pitch drops as sink increases (~340 Hz → ~140 Hz)
      const freq = 340 - sink01 * 200;
      // Louder with more sink
      const vol = 0.08 + sink01 * 0.26;
      this._setSinkTone(vol, freq, tSink);

      // Extra low pulses in heavy sink
      if (sinkMag > 2.2) {
        this._sinkPulseTimer -= dt;
        if (this._sinkPulseTimer <= 0) {
          this._sinkPulseTimer = Math.max(0.35, 0.95 - (sinkMag - 2.2) * 0.12);
          this._beep(freq * 0.85, 0.08, 0.14 + sink01 * 0.12);
        }
      } else {
        this._sinkPulseTimer = 0;
      }
    } else {
      // Near zero: quiet
      this._setSinkTone(0, 320, tSink);
      this._beepTimer = Math.min(this._beepTimer, 0.05);
      this._sinkPulseTimer = 0;
    }
  }

  _setSinkTone(volume, freq, t) {
    if (!this._sinkGain || !this._sinkOsc) return;
    const v = Math.max(0.0001, volume);
    this._sinkGain.gain.cancelScheduledValues(t);
    this._sinkGain.gain.setTargetAtTime(volume <= 0.001 ? 0.0001 : v, t, 0.06);
    this._sinkOsc.frequency.setTargetAtTime(freq, t, 0.08);
    if (this._sinkOsc2) this._sinkOsc2.frequency.setTargetAtTime(freq, t, 0.08);
  }

  _beep(freq, duration, peakGain) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    // Soft triangle-ish blend via second partial
    const osc2 = ctx.createOscillator();
    const g2 = ctx.createGain();
    osc2.type = 'triangle';
    osc2.frequency.value = freq;
    g2.gain.value = 0.2;

    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, peakGain), t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

    osc.connect(g);
    osc2.connect(g2);
    g2.connect(g);
    g.connect(this._varioGain);
    osc.start(t0);
    osc2.start(t0);
    osc.stop(t0 + duration + 0.02);
    osc2.stop(t0 + duration + 0.02);
  }

  _fadeWind(level, timeConst) {
    if (!this._windGain || !this.ctx) return;
    const t = this.ctx.currentTime;
    this._windGain.gain.setTargetAtTime(level, t, timeConst);
  }

  stop() {
    this._fadeWind(0, 0.2);
    this._beepTimer = 0;
    this._setGearMotor(0);
    this._setRollNoise(0);
    if (this.ctx && this._sinkGain) {
      this._setSinkTone(0, 300, this.ctx.currentTime);
    }
  }

  _updateRollNoise(dt, spd, brakes) {
    if (!this._rollGain || !this.ctx) return;
    const t = this.ctx.currentTime;
    const r01 = Math.min(1, Math.max(0, spd / 28));
    // Soft underlay rumble — present but not overpowering
    const moving = r01 > 0.02;
    const vol = moving
      ? 0.07 + r01 * 0.14 + brakes * 0.08
      : 0.0001;
    this._setRollNoise(vol);

    if (this._rollLow) {
      this._rollLow.frequency.setTargetAtTime(160 + r01 * 180 + brakes * 60, t, 0.06);
    }
    if (this._rollMid) {
      this._rollMid.frequency.setTargetAtTime(550 + r01 * 600 + brakes * 350, t, 0.06);
    }
    if (this._rollNoiseGain) {
      this._rollNoiseGain.gain.setTargetAtTime(moving ? 0.35 + r01 * 0.2 + brakes * 0.12 : 0.0001, t, 0.05);
    }

    // Wheel thump rate ~ speed (≈ tyre revs)
    const wheelHz = 28 + r01 * 70;
    if (this._rollOsc) {
      this._rollOsc.frequency.setTargetAtTime(wheelHz, t, 0.06);
    }
    if (this._rollOsc2) {
      this._rollOsc2.frequency.setTargetAtTime(wheelHz * 2.05, t, 0.06);
    }
    if (this._rollOscGain) {
      this._rollOscGain.gain.setTargetAtTime(moving ? 0.03 + r01 * 0.06 + brakes * 0.03 : 0.0001, t, 0.06);
    }
    if (this._rollOsc2Gain) {
      this._rollOsc2Gain.gain.setTargetAtTime(moving ? 0.012 + r01 * 0.025 + brakes * 0.02 : 0.0001, t, 0.06);
    }

    // Light wind under the roll
    this._fadeWind(0.03 + r01 * 0.1 + brakes * 0.04, 0.1);
    if (this._windFilter) {
      this._windFilter.frequency.setTargetAtTime(180 + r01 * 320, t, 0.1);
    }

    // Sparse grit clicks (joint seams / stones)
    if (moving) {
      this._rollGritTimer = (this._rollGritTimer || 0) - Math.max(0.001, dt || 0.016);
      const interval = 0.28 - r01 * 0.1;
      if (this._rollGritTimer <= 0) {
        this._rollGritTimer = interval + Math.random() * 0.08;
        this._playRollGrit(0.018 + r01 * 0.03 + brakes * 0.02);
      }
    } else {
      this._rollGritTimer = 0;
    }
  }

  /** Short gravel / seam click while on the ground. */
  _playRollGrit(peak) {
    if (!this.ctx || this.ctx.state !== 'running' || !this._rollGain) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const dur = 0.045 + Math.random() * 0.03;

    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const env = 1 - i / n;
      data[i] = (Math.random() * 2 - 1) * env * env;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 700 + Math.random() * 1400;
    bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, peak), t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(this._rollGain);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  _setRollNoise(volume) {
    if (!this._rollGain || !this.ctx) return;
    const t = this.ctx.currentTime;
    const v = volume <= 0.001 ? 0.0001 : Math.min(0.28, volume);
    this._rollGain.gain.cancelScheduledValues(t);
    if (volume > 0.01) {
      const cur = Math.max(0.001, this._rollGain.gain.value);
      this._rollGain.gain.setValueAtTime(cur, t);
      this._rollGain.gain.linearRampToValueAtTime(v, t + 0.04);
    } else {
      this._rollGain.gain.setTargetAtTime(0.0001, t, 0.06);
      if (this._rollOscGain) this._rollOscGain.gain.setTargetAtTime(0.0001, t, 0.05);
      if (this._rollOsc2Gain) this._rollOsc2Gain.gain.setTargetAtTime(0.0001, t, 0.05);
      if (this._rollNoiseGain) this._rollNoiseGain.gain.setTargetAtTime(0.0001, t, 0.05);
    }
  }

  /**
   * Loud, long crash thud — deep sub + body rumble (no high ring).
   * Dedicated hot bus so it hits hard over normal mix.
   */
  playCrash() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;

    // Hot path — loudest sound in the game (above gear/wind)
    const bus = ctx.createGain();
    bus.gain.value = 2.4;
    // Very light limiting only — keep punch
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -6;
    lim.knee.value = 20;
    lim.ratio.value = 2;
    lim.attack.value = 0.02;
    lim.release.value = 0.5;
    bus.connect(lim);
    lim.connect(ctx.destination);

    // Long decaying sub thud (linear sustain then fade — longer than exp decay)
    const tone = (type, f0, f1, tAttack, tHold, tDecay, peak, start = 0) => {
      const o = ctx.createOscillator();
      o.type = type;
      const t = t0 + start;
      const end = tAttack + tHold + tDecay;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(18, f1), t + end);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(peak, t + tAttack);
      g.gain.linearRampToValueAtTime(peak * 0.55, t + tAttack + tHold);
      g.gain.linearRampToValueAtTime(0.0001, t + end);
      o.connect(g);
      g.connect(bus);
      o.start(t);
      o.stop(t + end + 0.05);
    };

    // Layered low thud — loudest + long
    tone('sine', 48, 18, 0.015, 0.28, 1.2, 1.6, 0);    // deep sub
    tone('sine', 72, 24, 0.012, 0.22, 1.0, 1.4, 0);    // body
    tone('triangle', 60, 22, 0.012, 0.18, 0.85, 0.95, 0);
    tone('sine', 95, 32, 0.01, 0.1, 0.55, 0.9, 0.03);  // chest slap
    // Delayed ground settle
    tone('sine', 55, 20, 0.02, 0.18, 0.85, 0.75, 0.12);

    // Low rumble noise — long tail
    const makeNoise = (dur, amp, start, fStart, fEnd) => {
      const n = Math.floor(ctx.sampleRate * dur);
      const buf = ctx.createBuffer(1, n, ctx.sampleRate);
      const data = buf.getChannelData(0);
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < n; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + white * 0.099046;
        b1 = 0.963 * b1 + white * 0.2965164;
        b2 = 0.57 * b2 + white * 1.0526913;
        const pink = (b0 + b1 + b2 + white * 0.1848) * 0.28;
        // Slower decay so rumble lasts
        const e = Math.pow(1 - i / n, 1.15);
        const spike = i < n * 0.04 ? 1.4 : 1;
        data[i] = pink * e * spike;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      const t = t0 + start;
      lp.frequency.setValueAtTime(fStart, t);
      lp.frequency.exponentialRampToValueAtTime(fEnd, t + dur * 0.9);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(amp, t + 0.012);
      g.gain.linearRampToValueAtTime(amp * 0.4, t + dur * 0.45);
      g.gain.linearRampToValueAtTime(0.0001, t + dur);
      src.connect(lp);
      lp.connect(g);
      g.connect(bus);
      src.start(t);
    };

    makeNoise(1.25, 1.45, 0, 350, 55);   // main ground thud
    makeNoise(1.0, 1.0, 0.04, 220, 40);  // dirt settle
    makeNoise(1.4, 0.7, 0.08, 120, 30);  // long low rumble

    // Duck wind under the thud
    if (this._master) {
      const m = this._master.gain;
      m.cancelScheduledValues(t0);
      m.setValueAtTime(this._master.gain.value, t0);
      m.linearRampToValueAtTime(0.06, t0 + 0.04);
      m.linearRampToValueAtTime(0.55, t0 + 2.0);
    }
    this._fadeWind(0, 0.03);
    this._setSinkTone(0, 200, t0);
    this._setGearMotor(0);
  }

  /** Explicit edge from input (G key) — most reliable trigger */
  notifyGearToggle(gearDown) {
    if (!this.ready || !this.ctx) {
      // Try to start audio if user hit G before LAUNCH somehow mid-flight should be ready
      return;
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    const target = gearDown > 0.5 ? 1 : 0;
    const t = this.ctx.currentTime;
    this._lastGearTarget = target;
    // Short whir — clunk → brief motor → lock clunk
    const MOTOR_SEC = 0.55;
    this._gearMotorUntil = t + MOTOR_SEC;
    this._gearMotorDur = MOTOR_SEC;
    this._gearWasMoving = true;
    // Clunk first; motor starts slightly after so clunk is audible
    this._playGearClunk(target === 1 ? 'down' : 'up');
    this._setGearMotor(0.0001);
    if (this._gearGain) {
      this._gearGain.gain.cancelScheduledValues(t);
      this._gearGain.gain.setValueAtTime(0.0001, t);
      this._gearGain.gain.linearRampToValueAtTime(0.0001, t + 0.06);
      this._gearGain.gain.linearRampToValueAtTime(0.2, t + 0.1); // moderate motor
    }
  }

  /**
   * Gear transit audio — timer-based motor (matches ~1s animation), loud clunks.
   * gear = command 0|1 (1 = down). gearPos optional for pitch sweep.
   */
  _updateGearAudio(state) {
    if (!this._gearGain || !this.ctx) return;
    const t = this.ctx.currentTime;
    const target = state.gear !== undefined ? (state.gear > 0.5 ? 1 : 0) : 1;
    const pos = state.gearPos !== undefined ? state.gearPos : target;

    if (this._lastGearTarget === null) {
      this._lastGearTarget = target;
    }

    // Fallback edge detect if notifyGearToggle missed
    if (target !== this._lastGearTarget) {
      this._playGearClunk(target === 1 ? 'down' : 'up');
      this._lastGearTarget = target;
      const MOTOR_SEC = 0.55;
      this._gearMotorUntil = t + MOTOR_SEC;
      this._gearMotorDur = MOTOR_SEC;
      this._gearWasMoving = true;
    }

    const motorDur = this._gearMotorDur || 0.55;
    if (this._gearWasMoving && t < this._gearMotorUntil) {
      const remaining = Math.max(0, this._gearMotorUntil - t);
      const travel = 1 - Math.min(1, remaining / motorDur);
      this._setGearMotor(0.2);
      if (this._gearOsc) {
        const base = target === 0 ? 125 : 95;
        this._gearOsc.frequency.setTargetAtTime(base + travel * 40, t, 0.06);
      }
      if (this._gearOsc2) {
        this._gearOsc2.frequency.setTargetAtTime((target === 0 ? 250 : 190) + travel * 50, t, 0.06);
      }
      if (this._gearFilter) {
        this._gearFilter.frequency.setTargetAtTime(1800 + travel * 600, t, 0.08);
      }
    } else if (this._gearWasMoving && t >= this._gearMotorUntil) {
      this._playGearClunk(target === 1 ? 'lock-down' : 'lock-up');
      this._gearWasMoving = false;
      this._setGearMotor(0);
    } else {
      this._setGearMotor(0);
    }
  }

  _setGearMotor(volume) {
    if (!this._gearGain || !this.ctx) return;
    const t = this.ctx.currentTime;
    // Cap motor so it stays under wind/crash
    const v = volume <= 0.001 ? 0.0001 : Math.min(0.22, volume);
    this._gearGain.gain.cancelScheduledValues(t);
    if (volume > 0.01) {
      this._gearGain.gain.setValueAtTime(Math.max(this._gearGain.gain.value, 0.001), t);
      this._gearGain.gain.linearRampToValueAtTime(v, t + 0.04);
    } else {
      this._gearGain.gain.setTargetAtTime(0.0001, t, 0.05);
    }
  }

  _playGearClunk(kind) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const out = ctx.destination;
    const isLock = kind.startsWith('lock');
    const isUp = kind.includes('up');

    // Dip motor so clunk is not masked
    if (this._gearGain) {
      const cur = Math.max(0.0001, this._gearGain.gain.value);
      this._gearGain.gain.cancelScheduledValues(t0);
      this._gearGain.gain.setValueAtTime(cur, t0);
      this._gearGain.gain.linearRampToValueAtTime(0.0001, t0 + 0.02);
      // restore after clunk if still in transit
      if (this._gearWasMoving && t0 < this._gearMotorUntil) {
        this._gearGain.gain.linearRampToValueAtTime(0.2, t0 + 0.12);
      }
    }

    // 1) Noise slam — moderate (under crash)
    const dur = isLock ? 0.14 : 0.12;
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const e = Math.pow(1 - i / n, 1.15);
      const spike = i < n * 0.12 ? 1.4 : 1;
      data[i] = (Math.random() * 2 - 1) * e * spike;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 80;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = isUp ? 1400 : 800;
    const g = ctx.createGain();
    g.gain.setValueAtTime(isLock ? 0.38 : 0.32, t0);
    g.gain.linearRampToValueAtTime(0, t0 + dur);
    src.connect(hp);
    hp.connect(lp);
    lp.connect(g);
    g.connect(out);
    src.start(t0);

    // 2) Body thump — moderate
    const boom = ctx.createOscillator();
    boom.type = 'sine';
    boom.frequency.setValueAtTime(isUp ? 160 : 90, t0);
    boom.frequency.exponentialRampToValueAtTime(isUp ? 75 : 40, t0 + 0.16);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.28, t0);
    bg.gain.linearRampToValueAtTime(0, t0 + 0.18);
    boom.connect(bg);
    bg.connect(out);
    boom.start(t0);
    boom.stop(t0 + 0.2);

    // 3) Soft metal click
    const click = ctx.createOscillator();
    click.type = 'square';
    click.frequency.setValueAtTime(isUp ? 420 : 280, t0);
    click.frequency.exponentialRampToValueAtTime(isUp ? 200 : 130, t0 + 0.05);
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.1, t0);
    cg.gain.linearRampToValueAtTime(0, t0 + 0.06);
    click.connect(cg);
    cg.connect(out);
    click.start(t0);
    click.stop(t0 + 0.07);
  }
}

export const flightAudio = new FlightAudio();
