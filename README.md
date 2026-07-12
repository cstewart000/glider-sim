# Low Poly Glider

A lightweight **glider flight simulator** with low-poly visuals. Built with **Three.js / WebGL** — no Unity, no engine install. Runs great in any modern browser on Linux.

## Features

- Simplified but satisfying sailplane physics (lift, drag, stall, airbrakes)
- Ridge launch + thermal soaring
- Low-poly terrain, trees, and glider
- HUD: altitude, airspeed, variometer, heading, mini attitude
- Chase / wing / cinematic cameras

## Run (Linux)

```bash
cd ~/glider-sim
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

Production build:

```bash
npm run build
npm run preview
```

## Controls

| Key | Action |
|-----|--------|
| `W` `S` / `↑` `↓` | Pitch |
| `A` `D` / `←` `→` | Roll |
| `Q` `E` | Yaw (rudder) |
| `Space` | Airbrakes |
| `C` | Cycle camera |
| `R` | Restart flight |

## How to fly

1. **Launch** from the ridge pad — you start with airspeed.
2. **Pitch gently** — too nose-up and you’ll stall; too nose-down and you dive fast.
3. **Bank into thermals** (pale green columns / rising flecks) to climb.
4. **Airbrakes** for steep approaches into the valley meadow.
5. Land soft and wings-level for a good landing score.

## Stack

- [Three.js](https://threejs.org/) — WebGL renderer
- [Vite](https://vitejs.dev/) — dev server & build
- Vanilla JS modules — no framework overhead

Designed to stay performant on integrated GPUs: modest poly counts, instanced trees, basic shadow maps, capped pixel ratio.
