# Future feature list

Ideas deferred from design discussions. Not scheduled — pick when ready.

## Landing scenario (remainder after A+B)

Phases **A** (approach HUD + 3° path / PAPI) and **B** (scoring + debrief) are implemented.

### C — Flare cue + go-around
- Near-ground **FLARE** prompt when sink is high
- Go-around if too hot/high (climb away, retry or fail after N attempts)
- Bounce count → rough landing

### D — Crosswind + pattern variants
- Crosswind day with weathercock on roll-out
- Base → final spawn; high-key pattern to lose energy
- Stop distance vs runway remaining (“ran off the end”)

### Other landing polish
- Chase cam optional for first-time short final
- Gear-up scrape audio / stronger penalty
- Lead-in lights / extended centerline
- Wind affecting final more strongly

## Tow scenario (remainder after A+B)

Phases **A** (shared tug + rope visuals) and **B** (station-keeping + weak-link feedback) are implemented.

### C — Ground-roll aerotow start
- Start on runway, gear down, rope attached
- Tug taxis / takes up slack → “all out” → rotate together → climb
- Only suppress ground during the first meters AGL so a bad low tow can touch dirt
- Tug power states: idle → take-up → full power

### D — Post-release objective
- After release: short goal (“find a thermal” or “join the circuit / land”)
- Tug turns clear left/right and departs
- Soft mission complete when thermal entered or runway in sight

### Other tow polish
- Difficulty modes (easy / normal / hard station box + gusts)
- Radio-lite cues: “take up slack”, “all out”, “release”
- Chase cam default for first ~10 s of tow (teaching)
- Rope force applied as nose-hook pitch moment more formally
- Match rest length / attach points even tighter to real club procedures
- Dual-aircraft AI refinements (not multiplayer)

## Sound design (later)
- Hybrid short samples for clunks/snaps
- Cockpit occlusion EQ by camera mode
- Optional sparse menu music only (never under vario)

## Physics / world (later)
- Ballast / water affecting wing loading
- Wave lift downwind of ridges
- Richer landing gear (tailwheel authority curve)
- More detailed winch weak-link and cable geometry

## Meta / platform
- WebXR polish (seated calibration, hand poses)
- QuestSoaring Unity parity features as needed
- HTTPS dev cert helper for Quest Browser LAN play

## UX
- In-flight pause / replay last 30 s
- Scenario free-flight goals (distance, height gain badges)
- Accessibility: colorblind tension bar patterns, reduced motion
