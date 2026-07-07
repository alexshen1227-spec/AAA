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

## razorkite.glb — sail-winged aerial predator
- Size: 2.62 x 0.42 x 2.39 m (wingspan x height x length incl. tail whip);
  nose-to-tail-base body ~1.35 m. 402 tris. 31 KB.
- **FACING -Z in glTF** (creature convention — matches pale_hart/boglin, NOT
  the +Z front used by the nature/structure sets above). `wingL` is on -X.
- 5 root-level mesh nodes, translation-only, **pivots at the articulation
  joints** — animate via the boglin/pale_hart holder-wrap pattern (wrap each
  node in a Group placed at node.position, zero the node, rotate the holder):
  - `body` — slim faceted fuselage, pivot at body center (0, 0, 0); CreamBelly
    material on the downward faces.
  - `head` — skull + hooked charcoal beak + swept crest + emissive amber eyes,
    pivot at the neck joint **(0, 0.03, -0.44)**.
  - `wingL` / `wingR` — angular sail membranes (solidified 14 mm, double-sided,
    dark leading-edge spar strip), pivots at the wing roots
    **(-/+0.115, 0.045, -0.02)**; rest pose raised 12 deg; flap = rotate the
    holders around Z (roll axis), opposite signs per side.
  - `tail` — 1.04 m tapering whip with 3 charcoal barbs, pivot at the tail
    base **(0, 0.035, +0.55)**; extends rearward to z = +1.59.
- Materials (custom creature palette, NOT the toon-remap contract):
  SlateViolet, CreamBelly, DuskMembrane, MembraneEdge, Charcoal, EyeAmber.
  EyeAmber is the only emissive (1.0, 0.62, 0.08, strength 2.5) and satisfies
  the amber-eye finder used for boglins (r > 0.5, g > 0.5, b < 0.5).

## zephyr_pod.glb — bottled-updraft seed pod (throwable item)
- Size: 0.32 x 0.44 x 0.32 m (gourd body to 0.38, leaf-fin tips to 0.44).
  Origin at base center (min Y = 0). Radially symmetric — no facing. 726 tris.
  41 KB.
- 3 mesh nodes:
  - `Pod` — 10-sided faceted teardrop gourd (PodJade), pivot (0, 0, 0).
  - `Swirl` — 2.2-wrap raised spiral band embedded into the gourd surface,
    pivot (0, 0, 0) on the vertical axis — safe to spin around Y; carries the
    soft cyan emissive for pulsing.
  - `Cap` — bark collar + curled pig-tail stem + 3 leaf fins, pivot at the
    neck junction **(0, 0.37, 0)** for wobble/pop hooks.
- Materials (custom palette): PodJade, SwirlGlow (emissive 0.23/0.53/0.58 —
  soft cyan; its r < 0.5 keeps it clear of the amber-eye heuristic), CapBark,
  LeafFin.

## Provenance / rebuild
- Build script: scratchpad `build_models.py` (Blender 5.1.2,
  `--background --factory-startup`), deterministic seeds; validation via a
  node GLB parser (magic/JSON chunk/tri counts/bbox); previews rendered per
  model and visually reviewed (2 iteration rounds). Preview renders ship
  alongside as `<name>_preview.png`.
- razorkite + zephyr_pod: `build_razorkite.py` / `build_zephyr_pod.py`
  (Blender 5.1.2, same headless pattern, 2-3 iteration rounds each);
  previews `<name>_preview.png` + `<name>_preview2.png` (razorkite preview2
  is the from-below belly/membrane check, zephyr preview2 the cap close-up).
- License: original work for this project (no external assets).
