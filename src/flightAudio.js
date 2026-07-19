/**
 * Procedural flight audio — layered wind, physics-driven vario, events.
 * Web Audio only; no external assets. Starts on first user gesture.
 *
 * Layers:
 *  - Ambient bed (quiet open-air hum)
 *  - Wind base (TAS)
 *  - Canopy rush (brakes + high speed)
 *  - Stall buffet (AoA / stalled)
 *  - Vario (climb beeps / sink tone; ridge vs thermal character)
 *  - Gear motor + clunks
 *  - Ground roll (runway vs grass)
 *  - Events: touchdown, cable release, crash
 */

export class FlightAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.enabled = true;
    this._userVolume = 0.7;
    /** Tron / neon digital SFX profile */
    this.tronMode = false;
    this._tronHum = null;
    this._tronHum2 = null;
    this._tronHumGain = null;
    this._tronLfo = null;
    this._tronShimmer = null;
    this._tronShimmerGain = null;
    this._tronFilter = null;
    this._tronWhooshTimer = 0;
    this._tronIdleTimer = 0;
    this._tronArpStep = 0;
    this._tronLastSpd = 0;
    this._tronPulse = null;
    this._tronPulseGain = null;
    this._beepTimer = 0;
    this._sinkPulseTimer = 0;
    this._buffetPhase = 0;
    this._stallBuzzTimer = 0;
    this._master = null;
    this._masterComp = null;
    this._masterHP = null;
    // Wind layers
    this._windBaseGain = null;
    this._windBaseFilter = null;
    this._windCanopyGain = null;
    this._windCanopyFilter = null;
    this._windBuffetGain = null;
    this._windBuffetFilter = null;
    this._windBuffetLfo = null;
    this._windBuffetDepth = null;
    this._ambGain = null;
    this._noiseSrc = null;
    // Vario
    this._varioGain = null;
    this._sinkOsc = null;
    this._sinkOsc2 = null;
    this._sinkGain = null;
    // Gear
    this._gearGain = null;
    this._gearFilter = null;
    this._gearOsc = null;
    this._gearNoise = null;
    this._gearOscGain = null;
    this._gearNoiseGain = null;
    this._gearOsc2 = null;
    this._lastGearTarget = null;
    this._gearMotorUntil = 0;
    this._gearWasMoving = false;
    this._gearMotorDur = 0.55;
    // Roll
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
    // Events bus
    this._fxGain = null;
    // Touchdown edge
    this._wasRolling = false;
    this._wasAlive = true;
    // Tow rope creak
    this._ropeGain = null;
    this._ropeFilter = null;
    this._ropeLfo = null;
    this._ropeDepth = null;
    this._ropeCreakTimer = 0;
    this._ropePrevTen = 0;
  }

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

    // —— Master: HPF → compressor → destination ——
    this._masterHP = ctx.createBiquadFilter();
    this._masterHP.type = 'highpass';
    this._masterHP.frequency.value = 45;
    this._masterHP.Q.value = 0.7;

    this._masterComp = ctx.createDynamicsCompressor();
    this._masterComp.threshold.value = -18;
    this._masterComp.knee.value = 12;
    this._masterComp.ratio.value = 3.5;
    this._masterComp.attack.value = 0.008;
    this._masterComp.release.value = 0.22;

    this._master = ctx.createGain();
    this._master.gain.value = 0.62 * (this._userVolume ?? 0.7);
    this._masterHP.connect(this._masterComp);
    this._masterComp.connect(this._master);
    this._master.connect(ctx.destination);

    // FX / events (through master)
    this._fxGain = ctx.createGain();
    this._fxGain.gain.value = 0.9;
    this._fxGain.connect(this._masterHP);

    // Shared pink noise
    const noiseBuf = this._makeNoiseBuffer(2.5);
    this._noiseSrc = ctx.createBufferSource();
    this._noiseSrc.buffer = noiseBuf;
    this._noiseSrc.loop = true;
    this._noiseSrc.start();

    // Ambient bed — quiet open-country hum
    this._ambGain = ctx.createGain();
    this._ambGain.gain.value = 0.0001;
    const ambLp = ctx.createBiquadFilter();
    ambLp.type = 'lowpass';
    ambLp.frequency.value = 280;
    ambLp.Q.value = 0.5;
    this._noiseSrc.connect(ambLp);
    ambLp.connect(this._ambGain);
    this._ambGain.connect(this._masterHP);

    // —— Wind base (far air / TAS) ——
    this._windBaseGain = ctx.createGain();
    this._windBaseGain.gain.value = 0.0001;
    this._windBaseFilter = ctx.createBiquadFilter();
    this._windBaseFilter.type = 'bandpass';
    this._windBaseFilter.frequency.value = 380;
    this._windBaseFilter.Q.value = 0.65;
    const windBaseShelf = ctx.createBiquadFilter();
    windBaseShelf.type = 'highshelf';
    windBaseShelf.frequency.value = 1800;
    windBaseShelf.gain.value = -8;
    this._noiseSrc.connect(this._windBaseFilter);
    this._windBaseFilter.connect(windBaseShelf);
    windBaseShelf.connect(this._windBaseGain);
    this._windBaseGain.connect(this._masterHP);
    this._windBaseShelf = windBaseShelf;

    // —— Canopy rush (brakes + high speed) ——
    this._windCanopyGain = ctx.createGain();
    this._windCanopyGain.gain.value = 0.0001;
    this._windCanopyFilter = ctx.createBiquadFilter();
    this._windCanopyFilter.type = 'bandpass';
    this._windCanopyFilter.frequency.value = 1200;
    this._windCanopyFilter.Q.value = 0.55;
    const canopyHP = ctx.createBiquadFilter();
    canopyHP.type = 'highpass';
    canopyHP.frequency.value = 400;
    this._noiseSrc.connect(canopyHP);
    canopyHP.connect(this._windCanopyFilter);
    this._windCanopyFilter.connect(this._windCanopyGain);
    this._windCanopyGain.connect(this._masterHP);

    // —— Stall buffet (modulated low-mid noise) ——
    this._windBuffetGain = ctx.createGain();
    this._windBuffetGain.gain.value = 0.0001;
    this._windBuffetFilter = ctx.createBiquadFilter();
    this._windBuffetFilter.type = 'lowpass';
    this._windBuffetFilter.frequency.value = 220;
    this._windBuffetFilter.Q.value = 1.1;
    this._noiseSrc.connect(this._windBuffetFilter);
    this._windBuffetFilter.connect(this._windBuffetGain);
    this._windBuffetGain.connect(this._masterHP);
    // LFO amplitude modulation (adds to AudioParam)
    this._windBuffetLfo = ctx.createOscillator();
    this._windBuffetLfo.type = 'sine';
    this._windBuffetLfo.frequency.value = 12;
    this._windBuffetDepth = ctx.createGain();
    this._windBuffetDepth.gain.value = 0;
    this._windBuffetLfo.connect(this._windBuffetDepth);
    this._windBuffetDepth.connect(this._windBuffetGain.gain);
    this._windBuffetLfo.start();

    // Vario climb bus
    this._varioGain = ctx.createGain();
    this._varioGain.gain.value = 0.48;
    this._varioGain.connect(this._masterHP);

    // Tow rope: filtered noise + slow LFO amplitude for tension creak
    this._ropeGain = ctx.createGain();
    this._ropeGain.gain.value = 0.0001;
    this._ropeFilter = ctx.createBiquadFilter();
    this._ropeFilter.type = 'bandpass';
    this._ropeFilter.frequency.value = 280;
    this._ropeFilter.Q.value = 2.2;
    this._noiseSrc.connect(this._ropeFilter);
    this._ropeFilter.connect(this._ropeGain);
    this._ropeGain.connect(this._masterHP);
    this._ropeLfo = ctx.createOscillator();
    this._ropeLfo.type = 'sine';
    this._ropeLfo.frequency.value = 6;
    this._ropeDepth = ctx.createGain();
    this._ropeDepth.gain.value = 0;
    this._ropeLfo.connect(this._ropeDepth);
    this._ropeDepth.connect(this._ropeGain.gain);
    this._ropeLfo.start();

    // Continuous sink tone
    this._sinkGain = ctx.createGain();
    this._sinkGain.gain.value = 0.0001;
    this._sinkGain.connect(this._masterHP);
    this._sinkOsc = ctx.createOscillator();
    this._sinkOsc.type = 'sine';
    this._sinkOsc.frequency.value = 320;
    this._sinkOsc2 = ctx.createOscillator();
    this._sinkOsc2.type = 'triangle';
    this._sinkOsc2.frequency.value = 320;
    const sinkMix = ctx.createGain();
    sinkMix.gain.value = 0.22;
    this._sinkOsc.connect(this._sinkGain);
    this._sinkOsc2.connect(sinkMix);
    sinkMix.connect(this._sinkGain);
    this._sinkOsc.start();
    this._sinkOsc2.start();

    // Gear motor → master (not raw destination) so compressor catches it
    this._gearGain = ctx.createGain();
    this._gearGain.gain.value = 0.0001;
    this._gearGain.connect(this._masterHP);
    this._gearFilter = ctx.createBiquadFilter();
    this._gearFilter.type = 'lowpass';
    this._gearFilter.frequency.value = 2200;
    this._gearFilter.Q.value = 0.7;
    this._gearFilter.connect(this._gearGain);
    this._gearNoise = ctx.createBufferSource();
    this._gearNoise.buffer = this._makeNoiseBuffer(1.2);
    this._gearNoise.loop = true;
    this._gearNoiseGain = ctx.createGain();
    this._gearNoiseGain.gain.value = 0.35;
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
    this._gearOsc2 = ctx.createOscillator();
    this._gearOsc2.type = 'square';
    this._gearOsc2.frequency.value = 190;
    const g2 = ctx.createGain();
    g2.gain.value = 0.03;
    this._gearOsc2.connect(g2);
    g2.connect(this._gearGain);
    this._gearOsc2.start();

    // Ground roll
    this._rollGain = ctx.createGain();
    this._rollGain.gain.value = 0.0001;
    this._rollGain.connect(this._masterHP);
    this._rollLow = ctx.createBiquadFilter();
    this._rollLow.type = 'lowpass';
    this._rollLow.frequency.value = 280;
    this._rollLow.Q.value = 0.8;
    this._rollLow.connect(this._rollGain);
    this._rollMid = ctx.createBiquadFilter();
    this._rollMid.type = 'bandpass';
    this._rollMid.frequency.value = 900;
    this._rollMid.Q.value = 0.55;
    this._rollMid.connect(this._rollGain);
    this._rollNoise = ctx.createBufferSource();
    this._rollNoise.buffer = this._makeRollNoiseBuffer(1.8);
    this._rollNoise.loop = true;
    this._rollNoiseGain = ctx.createGain();
    this._rollNoiseGain.gain.value = 1.0;
    this._rollNoise.connect(this._rollNoiseGain);
    this._rollNoiseGain.connect(this._rollLow);
    this._rollNoiseGain.connect(this._rollMid);
    this._rollNoise.start();
    this._rollOsc = ctx.createOscillator();
    this._rollOsc.type = 'triangle';
    this._rollOsc.frequency.value = 42;
    this._rollOscGain = ctx.createGain();
    this._rollOscGain.gain.value = 0.0001;
    this._rollOsc.connect(this._rollOscGain);
    this._rollOscGain.connect(this._rollGain);
    this._rollOsc.start();
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
      let s = (b0 + b1 + b2 + white * 0.35) * 0.42;
      if (Math.random() < 0.004) s += (Math.random() * 2 - 1) * 0.55;
      data[i] = Math.max(-1, Math.min(1, s));
    }
    return buf;
  }

  /**
   * @param {number} dt
   * @param {object|null} state
   */
  update(dt, state) {
    if (!this.ready || !this.ctx || this.ctx.state !== 'running') return;
    if (!state || (state.alive === false && !state.rolling)) {
      this._fadeAllWind(0.015, 0.12);
      if (this.tronMode) this._fadeTronLayers(0.12);
      this._setGearMotor(0);
      this._setRollNoise(0);
      this._setAmb(0.012);
      if (this._ropeGain && this.ctx) {
        this._ropeGain.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.1);
      }
      this._wasRolling = false;
      return;
    }

    this._updateGearAudio(state);

    const spd = Math.max(0, state.airspeed);
    const brakes = Math.min(1, Math.max(0, state.brakes || 0));
    const aoa = state.aoa ?? 0;
    const stalled = !!state.stalled;
    const onRunway = !!state.onRunway;
    const lift = state.thermalLift ?? 0;
    const upliftMode = state.liftMode === 'uplift' || state.coastal === true;

    // Touchdown edge: rolling just began while alive
    if (state.rolling && !this._wasRolling && state.alive !== false) {
      this.playTouchdown(spd, onRunway);
    }
    this._wasRolling = !!state.rolling;

    // Quiet ambient always under flight
    const ambBase = this.tronMode ? 0.015 : 0.028;
    this._setAmb(ambBase + Math.min(0.04, spd / 800));

    if (this.tronMode) {
      this._updateTronEngine(dt, spd, brakes, stalled, aoa, state.vario || 0, lift);
      this._updateRope(dt, state);
      return;
    }
    // Fade tron layers when leaving mode mid-flight
    this._fadeTronLayers(0.22);

    if (state.rolling) {
      this._updateRollNoise(dt, spd, brakes, onRunway);
      this._beepTimer = 0;
      this._setSinkTone(0, 300, this.ctx.currentTime);
      this._setBuffet(0, 8);
      this._setCanopy(0.0001, 800);
      this._updateRope(dt, state); // ground-roll tow still creaks
      return;
    }
    this._setRollNoise(0);
    this._rollGritTimer = 0;

    // —— Layered wind ——
    const spd01 = Math.min(1, Math.max(0, (spd - 6) / 52));
    const aoaAbs = Math.abs(aoa);
    // Stall onset before full stall flag
    const stallAmt = stalled
      ? 1
      : Math.min(1, Math.max(0, (aoaAbs - 0.18) / 0.12));

    // Base far-air
    const baseVol = Math.min(0.55, 0.03 + spd01 * 0.38);
    const baseHz = 260 + spd01 * 900;
    const baseShelf = -10 + spd01 * 9;
    const t = this.ctx.currentTime;
    this._windBaseGain.gain.setTargetAtTime(Math.max(0.0001, baseVol), t, 0.07);
    this._windBaseFilter.frequency.setTargetAtTime(baseHz, t, 0.09);
    if (this._windBaseShelf) {
      this._windBaseShelf.gain.setTargetAtTime(baseShelf, t, 0.1);
    }

    // Canopy / airbrake rush
    const canopy = brakes * (0.08 + spd01 * 0.42) + spd01 * spd01 * 0.06;
    const canopyHz = 900 + brakes * 1100 + spd01 * 600;
    this._setCanopy(canopy, canopyHz);

    // Stall buffet
    const buffetVol = stallAmt * (0.06 + spd01 * 0.22);
    const buffetRate = 8 + stallAmt * 14 + spd01 * 6;
    this._setBuffet(buffetVol, buffetRate);

    // Stick buzz near deep stall
    if (stallAmt > 0.55 && spd > 12) {
      this._stallBuzzTimer -= dt;
      if (this._stallBuzzTimer <= 0) {
        this._stallBuzzTimer = 0.045 + Math.random() * 0.04;
        this._playStallBuzz(0.04 + stallAmt * 0.08);
      }
    } else {
      this._stallBuzzTimer = 0;
    }

    // Soft “air mass” presence under lift (doesn't fight vario)
    if (lift > 1.2) {
      const airMass = Math.min(0.06, (lift - 1.2) * 0.012);
      this._setAmb(0.028 + airMass + Math.min(0.04, spd / 800));
      this._updateThermalHum(lift);
    } else {
      this._updateThermalHum(0);
    }

    // —— Vario (king of the mix) ——
    this._updateVario(dt, state.vario || 0, upliftMode, lift);

    // —— Tow rope tension creak ——
    this._updateRope(dt, state);
  }

  /**
   * User master volume 0..1 (multiplies default bus gain).
   * @param {number} v
   */
  setMasterVolume(v) {
    this._userVolume = Math.max(0, Math.min(1, v));
    if (this._master && this.ctx) {
      const target = 0.62 * this._userVolume;
      this._master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.05);
    }
  }

  /**
   * Neon digital sound profile (Tron / light-cycle).
   * @param {boolean} on
   */
  setTronMode(on) {
    this.tronMode = !!on;
    if (!this.ctx || !this.ready) return;
    const t = this.ctx.currentTime;
    if (this.tronMode) {
      this._ensureTronEngine();
      if (this._tronHumGain) {
        this._tronHumGain.gain.setTargetAtTime(0.07, t, 0.12);
      }
      if (this._tronShimmerGain) {
        this._tronShimmerGain.gain.setTargetAtTime(0.022, t, 0.12);
      }
      if (this._tronPulseGain) {
        this._tronPulseGain.gain.setTargetAtTime(0.04, t, 0.12);
      }
      // Power-up: rising grid zap + disc blip
      this._playTronZap(0.28, 180, 2400, 0.16);
      this._playTronBlip(1760, 0.06, 0.12);
    } else {
      if (this._tronHumGain) {
        this._tronHumGain.gain.setTargetAtTime(0.0001, t, 0.25);
      }
      if (this._tronShimmerGain) {
        this._tronShimmerGain.gain.setTargetAtTime(0.0001, t, 0.2);
      }
      if (this._tronPulseGain) {
        this._tronPulseGain.gain.setTargetAtTime(0.0001, t, 0.2);
      }
    }
  }

  /** Full light-cycle style synth stack (TRON grid / disc energy). */
  _ensureTronEngine() {
    if (!this.ctx || this._tronHum) return;
    const ctx = this.ctx;
    const dest = this._masterHP || ctx.destination;

    // —— Light-cycle engine: detuned saw + square through resonant filter ——
    this._tronHum = ctx.createOscillator();
    this._tronHum.type = 'sawtooth';
    this._tronHum.frequency.value = 55;
    this._tronHum2 = ctx.createOscillator();
    this._tronHum2.type = 'square';
    this._tronHum2.frequency.value = 110;
    const hum3 = ctx.createOscillator();
    hum3.type = 'sawtooth';
    hum3.frequency.value = 56.4; // slight detune = analog-digital grit
    this._tronHum3 = hum3;

    this._tronFilter = ctx.createBiquadFilter();
    this._tronFilter.type = 'lowpass';
    this._tronFilter.frequency.value = 380;
    this._tronFilter.Q.value = 8;

    this._tronLfo = ctx.createOscillator();
    this._tronLfo.type = 'sine';
    this._tronLfo.frequency.value = 0.32;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 14;
    this._tronLfo.connect(lfoG);
    lfoG.connect(this._tronHum.frequency);
    this._tronLfoDepth = lfoG;

    this._tronHumGain = ctx.createGain();
    this._tronHumGain.gain.value = 0.0001;
    const mix2 = ctx.createGain();
    mix2.gain.value = 0.28;
    const mix3 = ctx.createGain();
    mix3.gain.value = 0.2;
    this._tronHum.connect(this._tronFilter);
    this._tronHum2.connect(mix2);
    mix2.connect(this._tronFilter);
    hum3.connect(mix3);
    mix3.connect(this._tronFilter);
    this._tronFilter.connect(this._tronHumGain);
    this._tronHumGain.connect(dest);

    // —— Sub pulse (light-cycle “idle throb”) ——
    this._tronPulse = ctx.createOscillator();
    this._tronPulse.type = 'sine';
    this._tronPulse.frequency.value = 27.5;
    this._tronPulseGain = ctx.createGain();
    this._tronPulseGain.gain.value = 0.0001;
    const pulseLfo = ctx.createOscillator();
    pulseLfo.type = 'sine';
    pulseLfo.frequency.value = 2.2;
    const pulseDepth = ctx.createGain();
    pulseDepth.gain.value = 0.018;
    pulseLfo.connect(pulseDepth);
    pulseDepth.connect(this._tronPulseGain.gain);
    this._tronPulse.connect(this._tronPulseGain);
    this._tronPulseGain.connect(dest);
    this._tronPulseLfo = pulseLfo;

    // —— High disc shimmer / grid sparkle ——
    this._tronShimmer = ctx.createOscillator();
    this._tronShimmer.type = 'square';
    this._tronShimmer.frequency.value = 1320;
    const shimFilt = ctx.createBiquadFilter();
    shimFilt.type = 'bandpass';
    shimFilt.frequency.value = 3200;
    shimFilt.Q.value = 4;
    this._tronShimmerGain = ctx.createGain();
    this._tronShimmerGain.gain.value = 0.0001;
    const shimLfo = ctx.createOscillator();
    shimLfo.type = 'triangle';
    shimLfo.frequency.value = 7.5;
    const shimLfoG = ctx.createGain();
    shimLfoG.gain.value = 0.014;
    shimLfo.connect(shimLfoG);
    shimLfoG.connect(this._tronShimmerGain.gain);
    this._tronShimmer.connect(shimFilt);
    shimFilt.connect(this._tronShimmerGain);
    this._tronShimmerGain.connect(dest);
    this._tronShimFilt = shimFilt;

    this._tronHum.start();
    this._tronHum2.start();
    hum3.start();
    this._tronLfo.start();
    this._tronPulse.start();
    pulseLfo.start();
    this._tronShimmer.start();
    shimLfo.start();
    this._tronShimLfo = shimLfo;
  }

  /**
   * Continuous Tron flight bed + digital events.
   */
  _updateTronEngine(dt, spd, brakes, stalled, aoa, vario, lift) {
    this._ensureTronEngine();
    const t = this.ctx.currentTime;
    const spd01 = Math.min(1, Math.max(0, (spd - 4) / 48));

    // Kill organic layers — pure grid synth
    this._windBaseGain?.gain.setTargetAtTime(0.0001, t, 0.08);
    this._setCanopy(0.0001, 800);
    this._setBuffet(0, 8);
    this._setRollNoise(0);
    this._setSinkTone(0, 400, t);
    this._setAmb(0.008 + spd01 * 0.01);

    // Engine pitch + filter open with speed (light-cycle rev)
    const baseHz = 42 + spd01 * 165;
    if (this._tronHum) {
      this._tronHum.frequency.setTargetAtTime(baseHz, t, 0.09);
    }
    if (this._tronHum2) {
      this._tronHum2.frequency.setTargetAtTime(baseHz * 2, t, 0.09);
    }
    if (this._tronHum3) {
      this._tronHum3.frequency.setTargetAtTime(baseHz * 1.027, t, 0.09);
    }
    if (this._tronFilter) {
      // Resonant “vowel” opens as you accelerate — classic synth rev
      this._tronFilter.frequency.setTargetAtTime(
        220 + spd01 * 2800 + brakes * 500,
        t,
        0.07
      );
      this._tronFilter.Q.setTargetAtTime(6 + spd01 * 6 + brakes * 3, t, 0.1);
    }
    if (this._tronHumGain) {
      this._tronHumGain.gain.setTargetAtTime(0.045 + spd01 * 0.12 + brakes * 0.04, t, 0.07);
    }
    if (this._tronPulse) {
      this._tronPulse.frequency.setTargetAtTime(22 + spd01 * 38, t, 0.12);
    }
    if (this._tronPulseGain) {
      this._tronPulseGain.gain.setTargetAtTime(0.028 + spd01 * 0.045, t, 0.1);
    }
    if (this._tronPulseLfo) {
      this._tronPulseLfo.frequency.setTargetAtTime(1.8 + spd01 * 4.5, t, 0.12);
    }
    if (this._tronLfo) {
      this._tronLfo.frequency.setTargetAtTime(0.25 + spd01 * 0.9, t, 0.15);
    }
    if (this._tronLfoDepth) {
      this._tronLfoDepth.gain.setTargetAtTime(10 + spd01 * 18, t, 0.15);
    }
    if (this._tronShimmer) {
      this._tronShimmer.frequency.setTargetAtTime(880 + spd01 * 2200, t, 0.1);
    }
    if (this._tronShimFilt) {
      this._tronShimFilt.frequency.setTargetAtTime(2000 + spd01 * 2800, t, 0.12);
    }
    if (this._tronShimmerGain) {
      this._tronShimmerGain.gain.setTargetAtTime(0.01 + spd01 * 0.05 + brakes * 0.02, t, 0.1);
    }
    if (this._tronShimLfo) {
      this._tronShimLfo.frequency.setTargetAtTime(5 + spd01 * 12, t, 0.12);
    }

    // Acceleration whoosh / disc surge
    const dSpd = (spd - this._tronLastSpd) / Math.max(dt, 1e-3);
    this._tronLastSpd = spd;
    this._tronWhooshTimer -= dt;
    if (dSpd > 6 && this._tronWhooshTimer <= 0) {
      this._tronWhooshTimer = 0.16;
      this._playTronWhoosh(0.12 + Math.min(0.18, dSpd * 0.01), spd01);
    }

    // Stall = system alarm (descending digital zaps)
    if (stalled || Math.abs(aoa) > 0.22) {
      this._stallBuzzTimer -= dt;
      if (this._stallBuzzTimer <= 0) {
        this._stallBuzzTimer = 0.055;
        this._playTronZap(0.12, 220 + Math.random() * 80, 70, 0.05);
      }
    } else {
      this._stallBuzzTimer = 0;
    }

    // Digital arpeggio “vario” (neon UI)
    this._updateTronVario(dt, vario, lift, spd01);
  }

  _updateTronVario(dt, vs, lift, spd01) {
    // Climb: ascending neon arpeggio; sink: descending zaps
    if (vs > 0.25) {
      const climb01 = Math.min(1, (vs - 0.25) / 4);
      const interval = 0.12 - climb01 * 0.065;
      this._beepTimer -= dt;
      if (this._beepTimer <= 0) {
        this._beepTimer = Math.max(0.05, interval);
        // Minor pentatonic-ish neon ladder
        const steps = [0, 3, 5, 7, 10, 12, 15, 19];
        const step = steps[this._tronArpStep % steps.length];
        this._tronArpStep++;
        const base = 660 + climb01 * 320 + spd01 * 50;
        const freq = base * Math.pow(2, step / 12);
        this._playTronBlip(freq, 0.04 + climb01 * 0.025, 0.16 + climb01 * 0.12);
      }
    } else if (vs < -0.25) {
      const sink01 = Math.min(1, (-vs - 0.25) / 5);
      this._beepTimer -= dt;
      if (this._beepTimer <= 0) {
        this._beepTimer = 0.2 - sink01 * 0.09;
        const freq = 420 - sink01 * 180;
        this._playTronZap(0.1 + sink01 * 0.1, freq * 1.5, freq * 0.45, 0.08);
      }
    } else {
      this._beepTimer = Math.min(this._beepTimer, 0.05);
      // Sparse idle grid tick while cruising
      this._tronIdleTimer -= dt;
      if (this._tronIdleTimer <= 0 && spd01 > 0.2) {
        this._tronIdleTimer = 1.1 + Math.random() * 0.9;
        this._playTronBlip(180 + spd01 * 90, 0.028, 0.035);
      }
    }
  }

  /** Short glass/disc blip (vario / UI / power-on). */
  _playTronBlip(freq, duration, peakGain) {
    if (!this.ctx || this.ctx.state !== 'running' || !this._fxGain) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(freq, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.88), t0 + duration);
    const o2 = ctx.createOscillator();
    o2.type = 'triangle';
    o2.frequency.setValueAtTime(freq * 2.01, t0);
    o2.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 1.78), t0 + duration);
    const g = ctx.createGain();
    const g2 = ctx.createGain();
    g2.gain.value = 0.18;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, peakGain), t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq * 1.35;
    bp.Q.value = 4.5;
    // Soft ring-mod grit via high partial
    const o3 = ctx.createOscillator();
    o3.type = 'sine';
    o3.frequency.value = freq * 3.5;
    const g3 = ctx.createGain();
    g3.gain.value = 0.08;
    o.connect(bp);
    o2.connect(g2);
    g2.connect(bp);
    o3.connect(g3);
    g3.connect(bp);
    bp.connect(g);
    g.connect(this._fxGain);
    o.start(t0);
    o2.start(t0);
    o3.start(t0);
    o.stop(t0 + duration + 0.02);
    o2.stop(t0 + duration + 0.02);
    o3.stop(t0 + duration + 0.02);
  }

  /** Sweeping zap (power-up / sink / alarm). */
  _playTronZap(peak, f0, f1, duration) {
    if (!this.ctx || this.ctx.state !== 'running' || !this._fxGain) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(Math.max(40, f0), t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t0 + duration);
    const o2 = ctx.createOscillator();
    o2.type = 'square';
    o2.frequency.setValueAtTime(Math.max(40, f0 * 0.5), t0);
    o2.frequency.exponentialRampToValueAtTime(Math.max(40, f1 * 0.5), t0 + duration);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(Math.max(0.001, peak), t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 90;
    const mix2 = ctx.createGain();
    mix2.gain.value = 0.35;
    o.connect(hp);
    o2.connect(mix2);
    mix2.connect(hp);
    hp.connect(g);
    g.connect(this._fxGain);
    o.start(t0);
    o2.start(t0);
    o.stop(t0 + duration + 0.02);
    o2.stop(t0 + duration + 0.02);
  }

  /** Acceleration whoosh — light-cycle surge across the grid. */
  _playTronWhoosh(peak, spd01) {
    if (!this.ctx || this.ctx.state !== 'running' || !this._fxGain) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const dur = 0.12 + spd01 * 0.1;
    // Main rising saw
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    const f0 = 140 + spd01 * 220;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(f0 * 4.2, t0 + dur);
    // Octave square for digital edge
    const o2 = ctx.createOscillator();
    o2.type = 'square';
    o2.frequency.setValueAtTime(f0 * 2, t0);
    o2.frequency.exponentialRampToValueAtTime(f0 * 6.5, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    const g2 = ctx.createGain();
    g2.gain.value = 0.25;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(300, t0);
    bp.frequency.exponentialRampToValueAtTime(4200, t0 + dur);
    bp.Q.value = 2.4;
    o.connect(bp);
    o2.connect(g2);
    g2.connect(bp);
    bp.connect(g);
    g.connect(this._fxGain);
    o.start(t0);
    o2.start(t0);
    o.stop(t0 + dur + 0.02);
    o2.stop(t0 + dur + 0.02);
  }

  /** Fade all continuous Tron layers (crash / leave mode). */
  _fadeTronLayers(tc = 0.15) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (this._tronHumGain) this._tronHumGain.gain.setTargetAtTime(0.0001, t, tc);
    if (this._tronShimmerGain) this._tronShimmerGain.gain.setTargetAtTime(0.0001, t, tc);
    if (this._tronPulseGain) this._tronPulseGain.gain.setTargetAtTime(0.0001, t, tc);
  }

  _updateThermalHum(lift) {
    if (!this.ctx) return;
    if (!this._thermOsc) {
      // Lazy-build quiet rising air hum
      const ctx = this.ctx;
      this._thermOsc = ctx.createOscillator();
      this._thermOsc.type = 'sine';
      this._thermOsc.frequency.value = 85;
      this._thermGain = ctx.createGain();
      this._thermGain.gain.value = 0.0001;
      const filt = ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 220;
      this._thermOsc.connect(filt);
      filt.connect(this._thermGain);
      this._thermGain.connect(this._masterHP);
      this._thermOsc.start();
    }
    const t = this.ctx.currentTime;
    if (lift > 1.4) {
      const amt = Math.min(1, (lift - 1.4) / 5);
      this._thermGain.gain.setTargetAtTime(0.012 + amt * 0.04, t, 0.15);
      this._thermOsc.frequency.setTargetAtTime(70 + amt * 50, t, 0.2);
    } else {
      this._thermGain.gain.setTargetAtTime(0.0001, t, 0.2);
    }
  }

  _updateRope(dt, state) {
    if (!this._ropeGain || !this.ctx) return;
    const t = this.ctx.currentTime;
    const onTow = !!state.onTow;
    const ten = Math.max(0, Math.min(1.4, state.ropeTension || 0));
    const osc = Math.max(0, Math.min(1, state.ropeOsc || 0));
    if (!onTow || ten < 0.04) {
      this._ropeGain.gain.setTargetAtTime(0.0001, t, 0.12);
      if (this._ropeDepth) this._ropeDepth.gain.setTargetAtTime(0, t, 0.1);
      this._ropePrevTen = ten;
      return;
    }
    // Steady creak under load; louder off-station / oscillating
    const base = 0.012 + ten * 0.055 + osc * 0.04;
    this._ropeGain.gain.setTargetAtTime(base, t, 0.08);
    if (this._ropeFilter) {
      this._ropeFilter.frequency.setTargetAtTime(180 + ten * 420 + osc * 180, t, 0.1);
    }
    if (this._ropeDepth) {
      this._ropeDepth.gain.setTargetAtTime(base * (0.25 + osc * 0.55), t, 0.08);
    }
    if (this._ropeLfo) {
      this._ropeLfo.frequency.setTargetAtTime(4 + osc * 10 + ten * 3, t, 0.1);
    }
    // Snatch ticks when tension rises sharply
    const dTen = (ten - this._ropePrevTen) / Math.max(dt, 1e-3);
    this._ropePrevTen = ten;
    if (dTen > 1.8) {
      this._ropeCreakTimer = 0;
      this._playRopeSnatch(0.06 + Math.min(0.12, dTen * 0.03));
    } else if (osc > 0.45 && ten > 0.35) {
      this._ropeCreakTimer -= dt;
      if (this._ropeCreakTimer <= 0) {
        this._ropeCreakTimer = 0.18 + Math.random() * 0.22;
        this._playRopeSnatch(0.025 + osc * 0.04);
      }
    }
  }

  _playRopeSnatch(peak) {
    if (!this.ctx || this.ctx.state !== 'running' || !this._fxGain) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(140 + Math.random() * 80, t0);
    o.frequency.exponentialRampToValueAtTime(55, t0 + 0.07);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(Math.max(0.001, peak), t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);
    o.connect(g);
    g.connect(this._fxGain);
    o.start(t0);
    o.stop(t0 + 0.1);
  }

  _setAmb(level) {
    if (!this._ambGain || !this.ctx) return;
    this._ambGain.gain.setTargetAtTime(Math.max(0.0001, level), this.ctx.currentTime, 0.2);
  }

  _setCanopy(vol, hz) {
    if (!this._windCanopyGain || !this.ctx) return;
    const t = this.ctx.currentTime;
    this._windCanopyGain.gain.setTargetAtTime(Math.max(0.0001, vol), t, 0.06);
    if (this._windCanopyFilter && hz) {
      this._windCanopyFilter.frequency.setTargetAtTime(hz, t, 0.08);
    }
  }

  _setBuffet(vol, rateHz) {
    if (!this._windBuffetGain || !this.ctx) return;
    const t = this.ctx.currentTime;
    const base = Math.max(0.0001, vol * 0.75);
    const depth = vol > 0.01 ? vol * 0.5 : 0;
    this._windBuffetGain.gain.setTargetAtTime(base, t, 0.05);
    if (this._windBuffetDepth) {
      this._windBuffetDepth.gain.setTargetAtTime(depth, t, 0.05);
    }
    if (this._windBuffetLfo && rateHz) {
      this._windBuffetLfo.frequency.setTargetAtTime(rateHz, t, 0.08);
    }
    if (this._windBuffetFilter) {
      this._windBuffetFilter.frequency.setTargetAtTime(160 + vol * 280, t, 0.1);
    }
  }

  _fadeAllWind(level, tc) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (this._windBaseGain) this._windBaseGain.gain.setTargetAtTime(level, t, tc);
    if (this._windCanopyGain) this._windCanopyGain.gain.setTargetAtTime(0.0001, t, tc);
    this._setBuffet(0, 8);
  }

  _updateVario(dt, vs, upliftMode, lift) {
    const tSink = this.ctx.currentTime;
    // Duck vario slightly under heavy buffet via bus — kept loud overall
    if (this._varioGain) {
      this._varioGain.gain.setTargetAtTime(0.48, tSink, 0.1);
    }

    if (vs > 0.28) {
      this._setSinkTone(0, 400, tSink);
      const climb01 = Math.min(1, (vs - 0.28) / 4.2);
      // Ridge: slightly longer / lower beeps; thermal: classic sharp
      const interval = upliftMode
        ? 0.95 - climb01 * 0.72
        : 0.82 - climb01 * 0.68;
      this._beepTimer -= dt;
      if (this._beepTimer <= 0) {
        this._beepTimer = Math.max(0.12, this.tronMode ? interval * 0.75 : interval);
        const freq = this.tronMode
          ? 920 + climb01 * 980
          : upliftMode
            ? 520 + climb01 * 480
            : 620 + climb01 * 520;
        const dur = this.tronMode
          ? 0.04 + climb01 * 0.02
          : upliftMode
            ? 0.075 + climb01 * 0.025
            : 0.052 + climb01 * 0.02;
        const peak = 0.26 + climb01 * 0.16;
        this._beep(freq, dur, peak);
      }
    } else if (vs < -0.22) {
      const sinkMag = -vs;
      const sink01 = Math.min(1, (sinkMag - 0.22) / 5.5);
      const freq = 340 - sink01 * 200;
      const vol = 0.07 + sink01 * 0.24;
      this._setSinkTone(vol, freq, tSink);
      if (sinkMag > 2.2) {
        this._sinkPulseTimer -= dt;
        if (this._sinkPulseTimer <= 0) {
          this._sinkPulseTimer = Math.max(0.35, 0.95 - (sinkMag - 2.2) * 0.12);
          this._beep(freq * 0.85, 0.08, 0.12 + sink01 * 0.1);
        }
      } else {
        this._sinkPulseTimer = 0;
      }
    } else {
      // Deadband near zero — quiet cruise
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
    osc.type = this.tronMode ? 'square' : 'sine';
    osc.frequency.value = freq;
    const osc2 = ctx.createOscillator();
    const g2 = ctx.createGain();
    osc2.type = this.tronMode ? 'square' : 'triangle';
    osc2.frequency.value = this.tronMode ? freq * 1.5 : freq;
    g2.gain.value = this.tronMode ? 0.08 : 0.18;
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

  _playStallBuzz(peak) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const n = Math.floor(ctx.sampleRate * 0.035);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / n);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 90 + Math.random() * 80;
    bp.Q.value = 2.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, peak), t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.032);
    src.connect(bp);
    bp.connect(g);
    g.connect(this._fxGain);
    src.start(t0);
    src.stop(t0 + 0.04);
  }

  stop() {
    this._fadeAllWind(0.0001, 0.15);
    this._fadeTronLayers(0.12);
    this._setAmb(0.0001);
    this._beepTimer = 0;
    this._setGearMotor(0);
    this._setRollNoise(0);
    if (this.ctx && this._sinkGain) {
      this._setSinkTone(0, 300, this.ctx.currentTime);
    }
    if (this.ctx && this._ropeGain) {
      this._ropeGain.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.08);
      if (this._ropeDepth) this._ropeDepth.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
    }
    this._wasRolling = false;
    this._ropePrevTen = 0;
  }

  _updateRollNoise(dt, spd, brakes, onRunway) {
    if (!this._rollGain || !this.ctx) return;
    const t = this.ctx.currentTime;
    const r01 = Math.min(1, Math.max(0, spd / 28));
    const moving = r01 > 0.02;
    // Runway: smoother lower rumble; grass: louder mid grit
    const vol = moving
      ? (onRunway ? 0.055 : 0.09) + r01 * (onRunway ? 0.12 : 0.16) + brakes * 0.09
      : 0.0001;
    this._setRollNoise(vol);

    if (this._rollLow) {
      this._rollLow.frequency.setTargetAtTime(
        (onRunway ? 140 : 180) + r01 * (onRunway ? 160 : 200) + brakes * 50,
        t,
        0.06
      );
    }
    if (this._rollMid) {
      this._rollMid.frequency.setTargetAtTime(
        (onRunway ? 480 : 620) + r01 * (onRunway ? 450 : 700) + brakes * 400,
        t,
        0.06
      );
    }
    if (this._rollNoiseGain) {
      this._rollNoiseGain.gain.setTargetAtTime(
        moving ? (onRunway ? 0.28 : 0.42) + r01 * 0.22 + brakes * 0.14 : 0.0001,
        t,
        0.05
      );
    }

    const wheelHz = 28 + r01 * 70;
    if (this._rollOsc) this._rollOsc.frequency.setTargetAtTime(wheelHz, t, 0.06);
    if (this._rollOsc2) this._rollOsc2.frequency.setTargetAtTime(wheelHz * 2.05, t, 0.06);
    if (this._rollOscGain) {
      this._rollOscGain.gain.setTargetAtTime(
        moving ? 0.025 + r01 * 0.05 + brakes * 0.04 : 0.0001,
        t,
        0.06
      );
    }
    if (this._rollOsc2Gain) {
      this._rollOsc2Gain.gain.setTargetAtTime(
        moving ? 0.01 + r01 * 0.02 + brakes * 0.025 : 0.0001,
        t,
        0.06
      );
    }

    // Light base wind under roll
    this._windBaseGain?.gain.setTargetAtTime(0.025 + r01 * 0.08 + brakes * 0.04, t, 0.1);
    this._setCanopy(brakes * 0.06 * r01, 600 + brakes * 400);
    this._setBuffet(0, 8);

    // Grit: more frequent on grass; sparse on runway seams
    if (moving) {
      this._rollGritTimer -= Math.max(0.001, dt || 0.016);
      const interval = onRunway
        ? 0.38 - r01 * 0.12
        : 0.2 - r01 * 0.1;
      if (this._rollGritTimer <= 0) {
        this._rollGritTimer = interval + Math.random() * 0.08;
        this._playRollGrit(
          (onRunway ? 0.012 : 0.022) + r01 * 0.03 + brakes * 0.025
        );
      }
    } else {
      this._rollGritTimer = 0;
    }
  }

  _playRollGrit(peak) {
    if (!this.ctx || this.ctx.state !== 'running' || !this._rollGain) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const dur = 0.04 + Math.random() * 0.03;
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
    const v = volume <= 0.001 ? 0.0001 : Math.min(0.32, volume);
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

  /** Soft/hard touchdown thump — scales with speed. */
  playTouchdown(spd, onRunway = false) {
    if (!this.ctx || this.ctx.state !== 'running' || !this._fxGain) return;
    if (this.tronMode) {
      this._playTronTouchdown(spd);
      return;
    }
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const r01 = Math.min(1, Math.max(0.15, (spd || 12) / 30));
    const peak = 0.22 + r01 * 0.45;

    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(onRunway ? 95 : 70, t0);
    o.frequency.exponentialRampToValueAtTime(onRunway ? 40 : 28, t0 + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
    o.connect(g);
    g.connect(this._fxGain);
    o.start(t0);
    o.stop(t0 + 0.25);

    // Short wheel chirp / squeal (stronger on runway)
    const chirp = ctx.createOscillator();
    chirp.type = 'triangle';
    chirp.frequency.setValueAtTime(onRunway ? 780 : 420, t0);
    chirp.frequency.exponentialRampToValueAtTime(onRunway ? 220 : 140, t0 + 0.09);
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.0001, t0);
    cg.gain.linearRampToValueAtTime((onRunway ? 0.14 : 0.07) * r01, t0 + 0.008);
    cg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.1);
    chirp.connect(cg);
    cg.connect(this._fxGain);
    chirp.start(t0);
    chirp.stop(t0 + 0.12);

    // Short noise slap
    const n = Math.floor(ctx.sampleRate * 0.08);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 1.4);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = onRunway ? 600 : 400;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(peak * 0.55, t0);
    ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.1);
    src.connect(lp);
    lp.connect(ng);
    ng.connect(this._fxGain);
    src.start(t0);
  }

  /** Digital grid contact — touchdown in Tron. */
  _playTronTouchdown(spd) {
    const r01 = Math.min(1, Math.max(0.2, (spd || 12) / 30));
    this._playTronZap(0.2 + r01 * 0.25, 90, 40, 0.14);
    this._playTronBlip(520 + r01 * 400, 0.05, 0.12 + r01 * 0.1);
    this._playTronWhoosh(0.08 + r01 * 0.08, r01);
  }

  /** Cable / tow rope release snap. */
  playCableRelease() {
    if (!this.ctx || this.ctx.state !== 'running' || !this._fxGain) return;
    if (this.tronMode) {
      // Disconnect from grid power
      this._playTronZap(0.32, 1400, 120, 0.18);
      this._playTronBlip(880, 0.04, 0.14);
      return;
    }
    const ctx = this.ctx;
    const t0 = ctx.currentTime;

    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(420, t0);
    o.frequency.exponentialRampToValueAtTime(90, t0 + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.28, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.14);
    o.connect(g);
    g.connect(this._fxGain);
    o.start(t0);
    o.stop(t0 + 0.16);

    const n = Math.floor(ctx.sampleRate * 0.06);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 800;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.2, t0);
    ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.07);
    src.connect(hp);
    hp.connect(ng);
    ng.connect(this._fxGain);
    src.start(t0);
  }

  /** Weak-link overload pop. */
  playWeakLink() {
    if (!this.ctx || this.ctx.state !== 'running' || !this._fxGain) return;
    if (this.tronMode) {
      this._playTronZap(0.4, 600, 80, 0.12);
      this._playTronZap(0.25, 2000, 400, 0.08);
      return;
    }
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(180, t0);
    o.frequency.exponentialRampToValueAtTime(55, t0 + 0.08);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.35, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.1);
    o.connect(g);
    g.connect(this._fxGain);
    o.start(t0);
    o.stop(t0 + 0.12);
  }

  playCrash() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    if (this.tronMode) {
      this._playTronDerez();
      return;
    }
    const ctx = this.ctx;
    const t0 = ctx.currentTime;

    const bus = ctx.createGain();
    bus.gain.value = 2.0;
    bus.connect(this._masterHP || ctx.destination);

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

    tone('sine', 48, 18, 0.015, 0.28, 1.2, 1.5, 0);
    tone('sine', 72, 24, 0.012, 0.22, 1.0, 1.3, 0);
    tone('triangle', 60, 22, 0.012, 0.18, 0.85, 0.9, 0);
    tone('sine', 95, 32, 0.01, 0.1, 0.55, 0.85, 0.03);
    tone('sine', 55, 20, 0.02, 0.18, 0.85, 0.7, 0.12);

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
        const e = Math.pow(1 - i / n, 1.15);
        data[i] = pink * e * (i < n * 0.04 ? 1.4 : 1);
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

    makeNoise(1.25, 1.35, 0, 350, 55);
    makeNoise(1.0, 0.95, 0.04, 220, 40);
    makeNoise(1.4, 0.65, 0.08, 120, 30);

    if (this._master) {
      const m = this._master.gain;
      m.cancelScheduledValues(t0);
      m.setValueAtTime(this._master.gain.value, t0);
      m.linearRampToValueAtTime(0.2, t0 + 0.04);
      m.linearRampToValueAtTime(0.62, t0 + 2.0);
    }
    this._fadeAllWind(0, 0.03);
    this._setSinkTone(0, 200, t0);
    this._setGearMotor(0);
  }

  /** Derez — digital disintegration crash (TRON). */
  _playTronDerez() {
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const bus = ctx.createGain();
    bus.gain.value = 1.6;
    bus.connect(this._masterHP || ctx.destination);

    // Cascading downward zaps (identity shatter)
    const zaps = [
      [0, 1800, 200, 0.12, 0.55],
      [0.04, 1200, 90, 0.16, 0.48],
      [0.1, 800, 55, 0.22, 0.4],
      [0.18, 400, 40, 0.35, 0.35],
      [0.3, 220, 30, 0.5, 0.28],
    ];
    for (const [start, f0, f1, dur, peak] of zaps) {
      const o = ctx.createOscillator();
      o.type = start < 0.15 ? 'sawtooth' : 'square';
      const t = t0 + start;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(peak, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 60;
      o.connect(hp);
      hp.connect(g);
      g.connect(bus);
      o.start(t);
      o.stop(t + dur + 0.03);
    }

    // Bit-crush-ish noise spray
    const n = Math.floor(ctx.sampleRate * 1.1);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let hold = 0;
    let holdLeft = 0;
    for (let i = 0; i < n; i++) {
      if (holdLeft <= 0) {
        hold = Math.random() * 2 - 1;
        holdLeft = 2 + Math.floor(Math.random() * 18 * (1 - i / n));
      }
      holdLeft--;
      const e = Math.pow(1 - i / n, 0.85);
      data[i] = hold * e * (i < n * 0.05 ? 1.3 : 1);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(2400, t0);
    bp.frequency.exponentialRampToValueAtTime(180, t0 + 1.0);
    bp.Q.value = 1.2;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t0);
    ng.gain.linearRampToValueAtTime(0.9, t0 + 0.02);
    ng.gain.linearRampToValueAtTime(0.35, t0 + 0.35);
    ng.gain.linearRampToValueAtTime(0.0001, t0 + 1.1);
    src.connect(bp);
    bp.connect(ng);
    ng.connect(bus);
    src.start(t0);

    // Final glass disc shatter blips
    for (let i = 0; i < 5; i++) {
      const delay = 0.05 + i * 0.07;
      const f = 1600 - i * 280 + Math.random() * 120;
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      const g = ctx.createGain();
      const tt = t0 + delay;
      g.gain.setValueAtTime(0.0001, tt);
      g.gain.exponentialRampToValueAtTime(0.18 - i * 0.025, tt + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.05);
      o.connect(g);
      g.connect(bus);
      o.start(tt);
      o.stop(tt + 0.06);
    }

    if (this._master) {
      const m = this._master.gain;
      const vol = 0.62 * (this._userVolume ?? 0.7);
      m.cancelScheduledValues(t0);
      m.setValueAtTime(this._master.gain.value, t0);
      m.linearRampToValueAtTime(0.15, t0 + 0.03);
      m.linearRampToValueAtTime(vol, t0 + 1.8);
    }
    this._fadeTronLayers(0.04);
    this._fadeAllWind(0, 0.03);
    this._setSinkTone(0, 200, t0);
    this._setGearMotor(0);
  }

  notifyGearToggle(gearDown) {
    if (!this.ready || !this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const target = gearDown > 0.5 ? 1 : 0;
    const t = this.ctx.currentTime;
    this._lastGearTarget = target;
    const MOTOR_SEC = 0.55;
    this._gearMotorUntil = t + MOTOR_SEC;
    this._gearMotorDur = MOTOR_SEC;
    this._gearWasMoving = true;
    this._playGearClunk(target === 1 ? 'down' : 'up');
    this._setGearMotor(0.0001);
    if (this._gearGain) {
      this._gearGain.gain.cancelScheduledValues(t);
      this._gearGain.gain.setValueAtTime(0.0001, t);
      this._gearGain.gain.linearRampToValueAtTime(0.0001, t + 0.06);
      this._gearGain.gain.linearRampToValueAtTime(0.2, t + 0.1);
    }
  }

  _updateGearAudio(state) {
    if (!this._gearGain || !this.ctx) return;
    const t = this.ctx.currentTime;
    const target = state.gear !== undefined ? (state.gear > 0.5 ? 1 : 0) : 1;

    if (this._lastGearTarget === null) this._lastGearTarget = target;

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
      if (this.tronMode) {
        // Quiet digital servo hum instead of motor grind
        this._setGearMotor(0.06);
        if (this._gearOsc) {
          this._gearOsc.frequency.setTargetAtTime(180 + travel * 120, t, 0.05);
        }
        if (this._gearOsc2) {
          this._gearOsc2.frequency.setTargetAtTime(360 + travel * 200, t, 0.05);
        }
        if (this._gearFilter) {
          this._gearFilter.frequency.setTargetAtTime(2400 + travel * 800, t, 0.06);
        }
      } else {
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
    const isLock = kind.startsWith('lock');
    const isUp = kind.includes('up');
    if (this.tronMode) {
      // Servo blip instead of mechanical clunk
      const f = isLock ? (isUp ? 990 : 660) : isUp ? 440 : 330;
      this._playTronBlip(f, isLock ? 0.05 : 0.035, isLock ? 0.12 : 0.08);
      if (isLock) this._playTronZap(0.08, f * 1.5, f * 0.6, 0.06);
      return;
    }
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const out = this._fxGain || ctx.destination;

    if (this._gearGain) {
      const cur = Math.max(0.0001, this._gearGain.gain.value);
      this._gearGain.gain.cancelScheduledValues(t0);
      this._gearGain.gain.setValueAtTime(cur, t0);
      this._gearGain.gain.linearRampToValueAtTime(0.0001, t0 + 0.02);
      if (this._gearWasMoving && t0 < this._gearMotorUntil) {
        this._gearGain.gain.linearRampToValueAtTime(0.2, t0 + 0.12);
      }
    }

    const dur = isLock ? 0.14 : 0.12;
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const e = Math.pow(1 - i / n, 1.15);
      data[i] = (Math.random() * 2 - 1) * e * (i < n * 0.12 ? 1.4 : 1);
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
