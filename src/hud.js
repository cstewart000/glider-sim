/** Cyan holographic HUD + 2D cockpit overlay */

import { controls } from './input.js';
import { getTerrainProfile } from './terrain.js';
import { scenarioRuntime, isLaunchAttached } from './scenarios.js';

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

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
  towBarVert: document.getElementById('tow-bar-vert'),
  towBarLat: document.getElementById('tow-bar-lat'),
  towCue: document.getElementById('tow-cue'),
  slipBall: document.getElementById('slip-ball'),
  landPanel: document.getElementById('landing-panel'),
  landTitle: document.getElementById('land-title'),
  landPath: document.getElementById('land-path'),
  landIas: document.getElementById('land-ias'),
  landCfg: document.getElementById('land-cfg'),
  landPapi: document.getElementById('land-papi'),
  xcPanel: document.getElementById('xc-panel'),
  xcTitle: document.getElementById('xc-title'),
  xcDist: document.getElementById('xc-dist'),
  xcBrg: document.getElementById('xc-brg'),
  xcLegs: document.getElementById('xc-legs'),
  sandboxPanel: document.getElementById('sandbox-panel'),
  sandboxTitle: document.getElementById('sandbox-title'),
  sandboxTime: document.getElementById('sandbox-time'),
  sandboxAlt: document.getElementById('sandbox-alt'),
  sandboxTrack: document.getElementById('sandbox-track'),
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
  upset: 'TOW · TUG UPSET',
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
  if (el.sandboxPanel) el.sandboxPanel.classList.add('hidden');
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
  // Prefer sandbox soar score, then landing/XC; else physics quality
  const sandbox = scenarioRuntime.sandboxScore;
  const scored =
    sandbox || scenarioRuntime.landScore || scenarioRuntime.xcScore;
  const landQ = scenarioRuntime.landScore?.grade || physics.landingQuality;
  const q = sandbox?.grade || scored?.grade || physics.landingQuality;
  el.crash.classList.toggle(
    'is-crash',
    landQ === 'crash' || q === 'F' || afterCrash
  );
  if (el.crashTitle) {
    if (sandbox) {
      const label =
        sandbox.grade === 'soar'
          ? 'SOAR'
          : sandbox.grade === 'cruise'
            ? 'CRUISE'
            : sandbox.grade === 'hop'
              ? 'HOP'
              : 'SANDBOX';
      el.crashTitle.textContent = `${label} · ${sandbox.total}`;
    } else if (scored && scenarioRuntime.xcScore) {
      el.crashTitle.textContent = scenarioRuntime.xcDone
        ? `TASK · ${scored.total}`
        : `XC · ${scored.total}`;
    } else if (scored && landQ !== 'crash' && scored.total != null) {
      const label =
        landQ === 'runway'
          ? 'RUNWAY'
          : landQ === 'good'
            ? 'GOOD'
            : landQ === 'rough'
              ? 'ROUGH'
              : 'LANDED';
      el.crashTitle.textContent = `${label} · ${scored.total}`;
    } else {
      el.crashTitle.textContent = landQ === 'crash' ? 'CRASH' : 'LANDED';
    }
  }
  const msgs = {
    runway: 'Runway landing — textbook roll-out.',
    good: 'Nice landing! Soft as a feather.',
    rough: 'Rough landing — you walked away.',
    crash: 'Hard impact. The wing survives. Barely.',
    soar: 'Great free flight — you worked the sky.',
    cruise: 'Solid cruise — more climb next time.',
    hop: 'Short hop — thermals are your friends.',
    brief: 'Brief flight — try staying with the lift.',
    explore: 'Nice explore.',
    A: 'Excellent cross-country flight.',
    B: 'Solid triangle — good soaring.',
    C: 'Partial task — keep working the lift.',
    D: 'Short hop — try the thermals next time.',
    F: 'Task incomplete.',
  };
  // Merge sandbox soaring debrief + landing lines when both exist
  const lines = [];
  if (sandbox?.debrief?.length) lines.push(...sandbox.debrief);
  if (
    scenarioRuntime.landScore?.debrief?.length &&
    sandbox
  ) {
    lines.push(...scenarioRuntime.landScore.debrief.slice(0, 2));
  } else if (scored?.debrief?.length && !sandbox) {
    lines.push(...scored.debrief);
  }
  if (lines.length) {
    el.crashMsg.textContent = lines.slice(0, 3).join(' ');
  } else {
    el.crashMsg.textContent = msgs[q] || msgs[landQ] || msgs.crash;
  }
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
  if (lines.length) {
    stats +=
      `<br><br><b>Debrief</b><ul style="text-align:left;margin:8px 0 0 1.1em;padding:0;font-size:13px;line-height:1.45">` +
      lines.slice(0, 6).map((d) => `<li>${d}</li>`).join('') +
      `</ul>`;
  }
  el.flightStats.innerHTML = stats;

  if (el.landPanel) el.landPanel.classList.add('hidden');
  if (el.sandboxPanel) el.sandboxPanel.classList.add('hidden');

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

  // Slip ball (HUD inclinometer) — center when coordinated
  if (el.slipBall) {
    const beta = physics.sideslip || 0;
    const pct = Math.max(-42, Math.min(42, -beta * 55)); // deg → % of tube
    el.slipBall.style.transform = `translateX(calc(-50% + ${pct}%))`;
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
      el.towPanel.classList.toggle(
        'warn',
        st !== 'ok' && st !== 'danger' && st !== 'upset'
      );
      el.towPanel.classList.toggle(
        'danger',
        st === 'danger' || st === 'upset' || scenarioRuntime.weakLinkWarn
      );
      if (el.towStation) {
        let label = STATION_LABEL[st] || STATION_LABEL.ok;
        if (st === 'ok' && (scenarioRuntime.tugStress || 0) > 0.35) {
          label = 'TOW · TUG STRAIN';
        }
        el.towStation.textContent = label;
      }
      // Tension bar follows smoothed physics tension (light visual wobble)
      const ten = Math.min(
        1,
        Math.max(
          0,
          (scenarioRuntime.ropeTension || 0) +
            (scenarioRuntime.ropeOsc || 0) * 0.06 * Math.sin(performance.now() * 0.006)
        )
      );
      if (el.towFill) {
        el.towFill.style.width = `${(ten * 100).toFixed(0)}%`;
        if (ten > 0.85 || st === 'danger') el.towFill.style.background = 'rgba(200, 60, 50, 0.9)';
        else if (ten > 0.55 || st === 'upset') el.towFill.style.background = 'rgba(200, 150, 40, 0.9)';
        else if (ten > 0.12) el.towFill.style.background = 'rgba(80, 160, 120, 0.85)';
        else el.towFill.style.background = 'rgba(120, 130, 140, 0.55)';
      }
      if (el.towHint) {
        el.towHint.classList.toggle('hidden', !scenarioRuntime.releaseReady);
      }
      // Station offset bars: center mark = on station
      const vErr = scenarioRuntime.stationVert || 0;
      const lErr = scenarioRuntime.stationLat || 0;
      const vPct = 50 + clamp((vErr / 14) * 42, -42, 42);
      const lPct = 50 + clamp((lErr / 14) * 42, -42, 42);
      if (el.towBarVert) el.towBarVert.style.left = `${vPct}%`;
      if (el.towBarLat) el.towBarLat.style.left = `${lPct}%`;
      // Coaching cue when off-station
      if (el.towCue) {
        let cue = '';
        if (st === 'high') cue = 'LOWER · EASE BACK';
        else if (st === 'low') cue = 'CLIMB · DON\'T SINK';
        else if (st === 'left') cue = 'RIGHT RUDDER / BANK';
        else if (st === 'right') cue = 'LEFT RUDDER / BANK';
        else if (st === 'upset' || st === 'danger') cue = 'RELEASE IF NEEDED · R';
        else if ((scenarioRuntime.tugStress || 0) > 0.35) cue = 'EASE THE ROPE';
        else cue = 'LOW TOW · CENTER';
        el.towCue.textContent = cue;
        el.towCue.classList.toggle('hidden', false);
        el.towCue.classList.toggle('warn', st !== 'ok');
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
      const phase = scenarioRuntime.landPhase || 'final';
      const phaseLabel =
        phase === 'base' ? 'BASE' : phase === 'over' ? 'OVER' : 'FINAL';
      const distLabel =
        dist > 50
          ? `${(dist / 1000).toFixed(2)} km`
          : dist > 0
            ? `${dist.toFixed(0)} m`
            : 'THR';
      const lat = Math.abs(scenarioRuntime.landAlign || 0);
      if (el.landTitle) {
        el.landTitle.textContent =
          phase === 'base'
            ? `${phaseLabel} · LAT ${lat.toFixed(0)} m`
            : `${phaseLabel} · ${distLabel}`;
      }

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

  // Free-flight sandbox stats
  if (el.sandboxPanel) {
    const onSb =
      scenarioRuntime.sandboxActive &&
      physics.alive &&
      !physics.rolling &&
      !physics.wingStrike;
    el.sandboxPanel.classList.toggle('hidden', !onSb);
    if (onSb) {
      const t = physics.flightTime || 0;
      const mins = Math.floor(t / 60);
      const secs = Math.floor(t % 60);
      if (el.sandboxTime) {
        el.sandboxTime.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
      }
      const maxY = Math.max(
        scenarioRuntime.sandboxMaxAlt || 0,
        physics.maxAlt || 0
      );
      const startY = scenarioRuntime.sandboxStartY || maxY;
      const gain = Math.max(0, maxY - startY);
      if (el.sandboxAlt) {
        el.sandboxAlt.textContent =
          gain > 5
            ? `MAX ${maxY.toFixed(0)} m · +${gain.toFixed(0)}`
            : `MAX ${maxY.toFixed(0)} m`;
      }
      const km = (scenarioRuntime.sandboxTrack || 0) / 1000;
      if (el.sandboxTrack) {
        el.sandboxTrack.textContent = `${km.toFixed(1)} km`;
      }
    }
  }

  // Cross-country task panel
  if (el.xcPanel) {
    const onXc =
      scenarioRuntime.xcActive &&
      physics.alive &&
      !physics.rolling &&
      !physics.wingStrike;
    el.xcPanel.classList.toggle('hidden', !onXc);
    if (onXc) {
      const done = scenarioRuntime.xcDone;
      const legs = scenarioRuntime.xcLegs || 0;
      if (el.xcTitle) {
        el.xcTitle.textContent = done
          ? 'TASK COMPLETE'
          : `XC · LEG ${Math.min(legs + 1, 3)}/3`;
      }
      el.xcPanel.classList.toggle('done', !!done);
      const dist = scenarioRuntime.xcDist || 0;
      if (el.xcDist) {
        el.xcDist.textContent =
          dist >= 1000
            ? `TP ${(dist / 1000).toFixed(2)} km`
            : `TP ${dist.toFixed(0)} m`;
      }
      if (el.xcBrg) {
        el.xcBrg.textContent = `BRG ${Math.round(scenarioRuntime.xcBearing || 0)}°`;
      }
      if (el.xcLegs) {
        const labels = ['TP1', 'TP2', 'HOME'];
        el.xcLegs.textContent = done
          ? '▲ ▲ ▲'
          : labels.map((n, i) => (i < legs ? '▲' : '·')).join(' ') +
            (legs < 3 ? `  → ${labels[legs]}` : '');
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
