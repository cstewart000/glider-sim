/** Cyan holographic HUD + 2D cockpit overlay */

import { controls } from './input.js';
import { getTerrainProfile } from './terrain.js';
import { scenarioRuntime, isLaunchAttached } from './scenarios.js';

const el = {
  alt: document.getElementById('alt'),
  spd: document.getElementById('spd'),
  vario: document.getElementById('var'),
  hdg: document.getElementById('hdg'),
  gear: document.getElementById('gear'),
  energy: document.getElementById('energy'),
  ld: document.getElementById('ld'),
  varioFill: document.getElementById('vario-fill'),
  varioNeedle: document.getElementById('vario-needle'),
  altNeedle: document.getElementById('alt-needle'),
  thermalHint: document.getElementById('thermal-hint'),
  towPanel: document.getElementById('tow-panel'),
  towStation: document.getElementById('tow-station'),
  towFill: document.getElementById('tow-tension-fill'),
  towHint: document.getElementById('tow-hint'),
  landPanel: document.getElementById('landing-panel'),
  landTitle: document.getElementById('land-title'),
  landPath: document.getElementById('land-path'),
  landIas: document.getElementById('land-ias'),
  landCfg: document.getElementById('land-cfg'),
  landPapi: document.getElementById('land-papi'),
  hud: document.getElementById('hud'),
  fps: document.getElementById('fps'),
  title: document.getElementById('title-screen'),
  crash: document.getElementById('crash-screen'),
  crashTitle: document.getElementById('crash-title'),
  crashMsg: document.getElementById('crash-msg'),
  flightStats: document.getElementById('flight-stats'),
  cockpit: document.getElementById('cockpit-overlay'),
  stall: document.getElementById('stall-banner'),
  crashFx: document.getElementById('crash-fx'),
};

const STATION_LABEL = {
  ok: 'TOW · OK',
  high: 'TOW · HIGH',
  low: 'TOW · LOW',
  left: 'TOW · LEFT',
  right: 'TOW · RIGHT',
  danger: 'TOW · WEAK LINK',
};

/** Post-landing delay before menu (crash FX or quiet hold after roll stop) */
const RESULT_HOLD_SEC = 3;
let crashSeq = null; // { t, physics, shown, mode: 'crash'|'land' }

let frameCount = 0;
let fpsTimer = 0;

export function showHUD() {
  el.hud.classList.add('visible');
  el.title.classList.add('hidden');
  el.crash.classList.add('hidden');
  hideCrashFx();
  crashSeq = null;
}

export function showTitle() {
  el.hud.classList.remove('visible');
  el.title.classList.remove('hidden');
  el.crash.classList.add('hidden');
  if (el.landPanel) el.landPanel.classList.add('hidden');
  if (el.towPanel) el.towPanel.classList.add('hidden');
  hideCrashFx();
  crashSeq = null;
}

export function hideCrashFx() {
  if (!el.crashFx) return;
  el.crashFx.classList.add('hidden');
  el.crashFx.style.setProperty('--vignette', '0');
  el.crashFx.style.setProperty('--blackout', '0');
}

/**
 * Crash cinematic: tunnel + black, then menu after RESULT_HOLD_SEC.
 */
export function beginCrashSequence(physics) {
  crashSeq = { t: 0, physics, shown: false, mode: 'crash' };
  if (el.crashFx) {
    el.crashFx.classList.remove('hidden');
    el.crashFx.style.setProperty('--vignette', '0');
    el.crashFx.style.setProperty('--blackout', '0');
  }
  if (el.hud) el.hud.style.opacity = '0.35';
  return true;
}

/**
 * Successful / rough roll-out stop: wait RESULT_HOLD_SEC then menu (no crash FX).
 */
export function beginLandingHold(physics) {
  crashSeq = { t: 0, physics, shown: false, mode: 'land' };
  if (el.hud) el.hud.style.opacity = '0.85';
  return true;
}

/** Advance post-flight sequences. @returns {boolean} active */
export function updateCrashSequence(dt) {
  if (!crashSeq) return false;
  crashSeq.t += dt;
  const t = crashSeq.t;

  if (crashSeq.mode === 'crash') {
    const vignette = Math.min(1, t / 1.15);
    const blackout = Math.min(1, Math.max(0, (t - 0.35) / 1.5));
    if (el.crashFx) {
      el.crashFx.style.setProperty('--vignette', String(vignette));
      el.crashFx.style.setProperty('--blackout', String(blackout));
    }
  }

  if (t >= RESULT_HOLD_SEC && !crashSeq.shown) {
    crashSeq.shown = true;
    showLanding(crashSeq.physics, crashSeq.mode === 'crash');
    if (el.hud) el.hud.style.opacity = '';
  }
  return true;
}

export function isCrashSequenceActive() {
  return !!crashSeq && !crashSeq.shown;
}

export function isResultHoldActive() {
  return !!crashSeq && !crashSeq.shown;
}

export function showLanding(physics, afterCrash = false) {
  el.crash.classList.remove('hidden');
  // Prefer scored grade when landing scenario produced a debrief
  const scored = scenarioRuntime.landScore;
  const q = scored?.grade || physics.landingQuality;
  el.crash.classList.toggle('is-crash', q === 'crash' || afterCrash);
  if (el.crashTitle) {
    if (scored && q !== 'crash') {
      el.crashTitle.textContent = `LANDED · ${scored.total}`;
    } else {
      el.crashTitle.textContent = q === 'crash' ? 'CRASH' : 'LANDED';
    }
  }
  const msgs = {
    runway: 'Runway landing — textbook roll-out.',
    good: 'Nice landing! Soft as a feather.',
    rough: 'Rough landing — you walked away.',
    crash: 'Hard impact. The wing survives. Barely.',
  };
  el.crashMsg.textContent = msgs[q] || msgs.crash;
  const mins = Math.floor(physics.flightTime / 60);
  const secs = Math.floor(physics.flightTime % 60);
  const roll =
    physics.rollDistance > 1
      ? `<br>Roll-out: <b>${physics.rollDistance.toFixed(0)} m</b>`
      : '';
  const strip = physics.onRunway ? ' · on runway' : '';
  let stats =
    `Time aloft: <b>${mins}:${secs.toString().padStart(2, '0')}</b><br>` +
    `Max altitude: <b>${physics.maxAlt.toFixed(0)} m</b><br>` +
    `Distance: <b>${(physics.distance / 1000).toFixed(2)} km</b>${roll}${strip}`;
  if (scored?.debrief?.length) {
    stats +=
      `<br><br><b>Debrief</b><ul style="text-align:left;margin:8px 0 0 1.1em;padding:0;font-size:13px;line-height:1.45">` +
      scored.debrief.map((d) => `<li>${d}</li>`).join('') +
      `</ul>`;
  }
  el.flightStats.innerHTML = stats;

  if (el.landPanel) el.landPanel.classList.add('hidden');

  if (afterCrash && el.crashFx) {
    // Results sit on black; leave blackout full behind panel
    el.crashFx.style.setProperty('--blackout', '1');
    el.crashFx.style.setProperty('--vignette', '1');
  }
}

export function setCockpitOverlayVisible(visible) {
  if (!el.cockpit) return;
  el.cockpit.classList.toggle('hidden', !visible);
}

/** Rotate needle <g> around SVG center (50,50) — pure SVG, not CSS. */
function setNeedle(groupEl, angleDeg) {
  if (!groupEl) return;
  const a = Number.isFinite(angleDeg) ? angleDeg : 0;
  groupEl.setAttribute('transform', `rotate(${a} 50 50)`);
}

let _hudSkip = 0;

export function updateHUD(physics, dt) {
  // DOM updates are costly — ~20 Hz is plenty for instruments
  _hudSkip += dt;
  const doDom = _hudSkip >= 0.05;
  if (doDom) _hudSkip = 0;

  const alt = physics.position.y;
  const spd = physics.airspeed * 3.6;
  const v = physics.vario;
  const hdg = physics.heading();

  if (!doDom) {
    // still need FPS timer path below occasionally
  } else {
  el.alt.textContent = alt.toFixed(0);
  el.spd.textContent = spd.toFixed(0);
  el.hdg.textContent = hdg.toFixed(0);
  if (el.gear) {
    el.gear.textContent = controls.gear > 0.5 ? 'DN' : 'UP';
  }
  if (el.energy && physics.energyHeight != null) {
    el.energy.textContent = physics.energyHeight.toFixed(0);
  }
  if (el.ld && physics.ld != null) {
    el.ld.textContent = physics.ld > 0 && physics.ld < 80 ? physics.ld.toFixed(0) : '—';
  }

  const sign = v >= 0 ? '+' : '';
  el.vario.textContent = sign + v.toFixed(1);
  el.vario.classList.remove('up', 'down');
  if (v > 0.3) el.vario.classList.add('up');
  else if (v < -0.3) el.vario.classList.add('down');

  const varioAngle = Math.max(-120, Math.min(120, (v / 8) * 120));
  setNeedle(el.varioNeedle, varioAngle);

  const altAngle = ((alt % 1000) / 1000) * 360;
  setNeedle(el.altNeedle, altAngle);

  const maxV = 8;
  const pct = Math.min(1, Math.abs(v) / maxV) * 50;
  if (v >= 0) {
    el.varioFill.style.bottom = '50%';
    el.varioFill.style.top = 'auto';
    el.varioFill.style.height = pct + '%';
    el.varioFill.style.background = 'rgba(60, 200, 180, 0.85)';
  } else {
    el.varioFill.style.top = '50%';
    el.varioFill.style.bottom = 'auto';
    el.varioFill.style.height = pct + '%';
    el.varioFill.style.background = 'rgba(200, 100, 90, 0.75)';
  }

  if (physics.thermalLift > 1.5 && scenarioRuntime.phase !== 'tow') {
    // Ridge soaring (coastal) = orographic uplift; airfield = thermals
    el.thermalHint.textContent =
      getTerrainProfile() === 'coastal' ? '▲ UPLIFT' : '▲ THERMAL';
    el.thermalHint.classList.remove('hidden');
  } else {
    el.thermalHint.classList.add('hidden');
  }

  // Aerotow panel: station + rope tension
  if (el.towPanel) {
    const onTow =
      scenarioRuntime.phase === 'tow' &&
      !scenarioRuntime.released &&
      isLaunchAttached();
    el.towPanel.classList.toggle('hidden', !onTow);
    if (onTow) {
      const st = scenarioRuntime.station || 'ok';
      el.towPanel.classList.toggle('warn', st !== 'ok' && st !== 'danger');
      el.towPanel.classList.toggle('danger', st === 'danger' || scenarioRuntime.weakLinkWarn);
      if (el.towStation) {
        el.towStation.textContent = STATION_LABEL[st] || STATION_LABEL.ok;
      }
      const ten = Math.min(1, Math.max(0, scenarioRuntime.ropeTension || 0));
      if (el.towFill) {
        el.towFill.style.width = `${(ten * 100).toFixed(0)}%`;
        if (ten > 0.85) el.towFill.style.background = 'rgba(200, 60, 50, 0.9)';
        else if (ten > 0.55) el.towFill.style.background = 'rgba(200, 150, 40, 0.9)';
        else if (ten > 0.12) el.towFill.style.background = 'rgba(80, 160, 120, 0.85)';
        else el.towFill.style.background = 'rgba(120, 130, 140, 0.55)';
      }
      if (el.towHint) {
        el.towHint.classList.toggle('hidden', !scenarioRuntime.releaseReady);
      }
    }
  }

  // Landing approach panel
  if (el.landPanel) {
    const onLand =
      scenarioRuntime.landingActive &&
      physics.alive &&
      !physics.rolling &&
      !physics.wingStrike;
    el.landPanel.classList.toggle('hidden', !onLand);
    if (onLand) {
      const dist = scenarioRuntime.landDist;
      const distLabel =
        dist > 50
          ? `${(dist / 1000).toFixed(2)} km`
          : dist > 0
            ? `${dist.toFixed(0)} m`
            : 'OVER';
      if (el.landTitle) el.landTitle.textContent = `FINAL · ${distLabel}`;

      const path = scenarioRuntime.landPath || 'on';
      el.landPanel.classList.toggle('path-high', path === 'high');
      el.landPanel.classList.toggle('path-low', path === 'low');
      if (el.landPath) {
        el.landPath.textContent =
          path === 'on' ? 'PATH · ON' : path === 'high' ? 'PATH · HIGH' : 'PATH · LOW';
        el.landPath.classList.toggle('bad', path !== 'on');
      }
      const ias = scenarioRuntime.landIas || 'ok';
      if (el.landIas) {
        el.landIas.textContent =
          ias === 'ok' ? 'IAS · OK' : ias === 'high' ? 'IAS · HIGH' : 'IAS · LOW';
        el.landIas.classList.toggle('bad', ias !== 'ok');
      }
      if (el.landCfg) {
        const gOk = scenarioRuntime.landGearOk;
        el.landCfg.textContent = gOk ? 'GEAR DN' : 'GEAR UP !';
        el.landCfg.classList.toggle('bad', !gOk);
      }
      // HUD PAPI lamps
      if (el.landPapi) {
        const lamps = el.landPapi.querySelectorAll('.papi-lamp');
        const w = scenarioRuntime.landPapiWhite ?? 2;
        lamps.forEach((lamp, i) => {
          lamp.classList.toggle('white', i < w);
          lamp.classList.toggle('red', i >= w);
        });
      }
    }
  }

  if (el.stall) {
    el.stall.classList.toggle('hidden', !physics.stalled);
  }
  } // end doDom

  frameCount++;
  fpsTimer += dt;
  if (fpsTimer >= 0.5) {
    el.fps.textContent = Math.round(frameCount / fpsTimer) + ' fps';
    frameCount = 0;
    fpsTimer = 0;
  }
}

export function onStart(cb) {
  document.getElementById('start-btn').addEventListener('click', cb);
}
export function onRestart(cb) {
  document.getElementById('restart-btn').addEventListener('click', cb);
}

/**
 * Build scenario picker buttons.
 * @param {{ id: string, name: string, blurb: string }[]} list
 * @param {string} activeId
 * @param {(id: string) => void} onSelect
 */
export function setupScenarioMenu(list, activeId, onSelect) {
  const host = document.getElementById('scenario-list');
  const blurb = document.getElementById('scenario-blurb');
  if (!host) return;

  host.innerHTML = '';
  for (const s of list) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'scenario-btn' + (s.id === activeId ? ' active' : '');
    btn.dataset.id = s.id;
    btn.textContent = s.name;
    btn.addEventListener('click', () => {
      host.querySelectorAll('.scenario-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      if (blurb) blurb.textContent = s.blurb;
      onSelect(s.id);
    });
    host.appendChild(btn);
  }
  const active = list.find((s) => s.id === activeId) || list[0];
  if (blurb && active) blurb.textContent = active.blurb;
}
