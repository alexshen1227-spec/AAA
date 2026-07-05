# Creature + Nature Set (Blender-authored GLBs)

Original stylized low-poly models for The Wilds of Aerwyn, built headlessly in
Blender 5.1.2 and exported as GLB (glTF 2.0, Y-up, meters). All materials use
the game's toon-remap name contract (Stone, StoneDark, Bronze, BronzeDark,
EnergyGreen, EnergyAmber, Wood, Leaf, LeafAutumn). Energy* materials carry
emission in the GLB but the game remaps by name regardless. Every model's
origin is at its base center (min Y = 0, +/- a few cm of ground-sink jitter on
the scatter pieces). Node transforms are translation-only; geometry is baked.
"Front" (where a model has one) faces +Z in glTF/three.js.

Load via `assets.js` patterns: `instantiate()` deep-clones fine; none of these
are rigged (the golem is animated by bobbing its named block nodes in code).

## construct_golem.glb — floating-block guardian
- Size: 2.07 x 2.62 x 0.78 m (W x H x D). ~2.6 m tall. 1,780 tris. 129 KB.
- 14 mesh nodes, all root-level, pivots at each block's center so the game can
  float/bob them individually (6-10 cm air gaps are modeled in):
  - `Torso` — stepped stone block, bronze edge bands + corner posts, taotie
    face plate (Bronze) with EnergyAmber eyes + nose ridge + amber nose ring.
  - `Head` — stone block, BronzeDark crest, single round EnergyGreen eye disc
    with two concentric rings (Bronze inner, BronzeDark outer).
  - `ShoulderL`, `ShoulderR` — capped stone blocks beside the torso top.
  - `ArmL` — forearm + bronze wrist band + fist block.
  - `ArmR` — club fist: downward-flaring stone club with bronze band.
  - `LegL`, `LegR` — stone legs, bronze ankle bands, toe blocks (toes face +Z).
  - `JointSpark1..6` — EnergyGreen octahedra floating in the gaps:
    1 neck, 2 shoulderL-torso, 3 shoulderR-torso, 4 armL, 5 armR, 6 pelvis.
- Materials: Stone, Bronze, BronzeDark, EnergyAmber, EnergyGreen.

## ouroboros_ring.glb — segmented dragon gate emblem
- Size: 1.54 x 1.59 x 0.38 m. ~1.6 m diameter, depth 0.38 m (wall/gate mount
  safe). 1,080 tris. 65 KB.
- Single mesh node `Ouroboros`: 12 tapering stone segments in a full circle
  (ring stands upright in the glTF XY plane), Bronze band collars on alternate
  segments, BronzeDark dorsal fins pointing radially outward, chunky wedge
  head at the top (open jaw, BronzeDark brow + swept horns, EnergyGreen
  octahedron eyes both sides) biting the tapered tail tip.
- Materials: Stone, Bronze, BronzeDark, EnergyGreen.

## gloom_flora.glb — bioluminescent Depths set
- Set spread: 3.07 x 1.47 x 1.03 m. 1,172 tris. 91 KB.
- 4 mesh nodes (each mushroom's pivot at its own base — safe to re-scatter):
  - `Mushroom_S` (0.50 m), `Mushroom_M` (0.90 m), `Mushroom_L` (1.40 m) —
    faceted EnergyGreen caps, two concentric EnergyGreen gill rings under each
    cap rim, StoneDark tapered stems.
  - `Root` — 3.0 m sinuous EnergyGreen tube, tapering 8.5 cm -> 1.6 cm, with
    three glowing nodules; hugs the ground (sinks ~7 cm for a buried look).
- Materials: StoneDark, EnergyGreen.

## sky_debris.glb — fallen-ruin scatter chunks
- Set spread: 6.81 x 1.80 x 2.05 m. 1,432 tris. 98 KB.
- 3 mesh nodes (pivots at each piece's base center; pieces sit ~2.5 m apart,
  re-scatter freely):
  - `Debris_A` (~3.0 m) — sheared stone block, BronzeDark strap fittings,
    snapped concentric-ring plate (Bronze, ~62% of the disc remains) with an
    EnergyAmber core, mossy top faces.
  - `Debris_B` (~2.1 m) — tilted broken pillar: 8-sided shaft with angled
    fracture, stepped capital discs, BronzeDark collar, Bronze samon ring.
  - `Debris_C` (~1.6 m) — offset slab pile, BronzeDark corner brackets,
    Bronze concentric samon ring inset on the top slab.
- Moss: `Leaf` material assigned to upward stone faces (normal Y > 0.72).
- Materials: Stone, StoneDark, Bronze, BronzeDark, EnergyAmber, Leaf.

## tree_autumn.glb — golden sky-layer tree
- Size: 5.00 x 6.92 x 3.93 m (~7 m tall). 686 tris. 21 KB.
- 5 mesh nodes:
  - `Trunk` — tapered 7-sided trunk, 3 branch cones, 3 root flares (Wood).
  - `Canopy` — 4 jittered faceted blob masses (LeafAutumn), one large + three
    satellites; separate node so wind sway can be applied to canopy only.
  - `FallLeaf1..3` — single diamond quads (LeafAutumn) floating beside the
    canopy at heights 3.2 / 2.1 / 1.3 m for drift/spin animation hooks.
- Materials: Wood, LeafAutumn.

## Provenance / rebuild
- Build script: scratchpad `build_models.py` (Blender 5.1.2,
  `--background --factory-startup`), deterministic seeds; validation via a
  node GLB parser (magic/JSON chunk/tri counts/bbox); previews rendered per
  model and visually reviewed (2 iteration rounds). Preview renders ship
  alongside as `<name>_preview.png`.
- License: original work for this project (no external assets).
