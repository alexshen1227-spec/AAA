# Signature Structures — Blender-built GLBs

Four game-ready low-poly structures for The Wilds of Aerwyn (ancient magic-tech identity:
weathered stone + oxidized bronze + energy inlays). Built headlessly in Blender 5.1.2,
exported glTF 2.0 GLB, Y-up. All models: origin at BASE CENTER, real-world meters,
"front" faces +Z (three.js), flat-shaded, no textures — every mesh uses only contract
material names, which the game remaps to toon shading:
`Stone, StoneDark, Bronze, BronzeDark, EnergyGreen, EnergyAmber, Wood, Cloth, Rope`.

Load via `src/GLTFLoader.js`; look meshes up with `root.getObjectByName(...)`.
Coordinates below are three.js/glTF space (X right, Y up, Z toward viewer).

---

## beacon_shrine.glb — 2,496 tris, 170 KB

Stepped Mayan shrine with a floating orb-and-rings core in a bronze gate.
Bounding box: X 8.0 x Y 9.05 x Z 9.34 (8x8 terrace footprint; front staircase runs out to Z=+5.34).

| Mesh | Tris | Materials | Purpose |
|---|---|---|---|
| `Base` | 180 | StoneDark, Stone | 3 terraces + front staircase + corner blocks (static collider) |
| `FacePlateL` / `FacePlateR` | 120 ea | BronzeDark, Bronze | taotie face plates flanking the stairs on the terrace front |
| `Arch` | 440 | Bronze, BronzeDark, EnergyGreen, EnergyAmber | pillars + lintel, dragon-head finials, green pillar seams, samon ring on lintel |
| `Core` | 80 | EnergyAmber | floating orb, node at **(0, 5.0, 0)** — recolor/pulse when awakened |
| `Ring1` | 216 | Bronze | inner ring r0.85, node at (0, 5.0, 0), identity rotation — **spin freely** |
| `Ring2` | 240 | Bronze | middle ring r1.15, tilt baked into mesh, node at (0, 5.0, 0) |
| `Ring3` | 264 | BronzeDark | outer ring r1.45, tilt baked, node at (0, 5.0, 0) |
| `FloorInlay` | 836 | EnergyAmber | samon concentric floor rings on top terrace (Y = 2.42) |

Top terrace platform height: Y = 2.4. Archway gap: pillars at X = +/-2.0, clear opening ~1.6 wide.

## skywatch_tower.glb — 1,996 tris, 142 KB

40 m tapered octagonal spire, climbable. Bounding box: X 8.5 x Y 40.7 x Z 8.74.

| Mesh | Tris | Materials | Purpose |
|---|---|---|---|
| `Plinth1` / `Plinth2` | 28 ea | StoneDark / Stone | stepped octagonal base (r4.6 to Y1.2, r3.8 to Y2.2) |
| `Shaft` | 28 | Stone | octagonal cone, r3.0 at Y2.2 tapering to r1.5 at Y36.0 |
| `Door` | 728 | BronzeDark, Bronze, EnergyAmber | sealed gate on +Z face + samon ring motifs |
| `Ledge1..Ledge4` | 56 ea | Bronze, BronzeDark | **rest-ledge rings, centers at Y = 6.8 / 13.6 / 20.4 / 27.2 exactly**; each 0.8 thick (top faces at 7.2 / 14.0 / 20.8 / 27.6), protrudes 0.9 beyond shaft — outer radii ~3.70 / 3.39 / 3.09 / 2.79. Add colliders here. |
| `Seams` | 48 | EnergyGreen | 4 vertical energy seam strips, Y 3..35, on +/-X and +/-Z faces |
| `Crown` | 612 | Bronze, BronzeDark | stepped crown platform (top walkable surface Y = 37.6, r3.2) + taotie-banded parapet blocks |
| `Spire` | 28 | BronzeDark | tip cone Y 37.6..39.4 |
| `Beacon` | 8 | EnergyAmber | octahedron at **(0, 39.55, 0)** — beacon glow / quest state |
| `BeaconRing` | 264 | Bronze, BronzeDark | ouroboros ring (r1.05, vertical) around Beacon — spinnable |

## wind_bellows.glb — 2,540 tris, 172 KB

Stone plinth + dragon-mouth bronze horn + cloth sack, with ground vent plate.
Bounding box: X 2.4 x Y 3.37 x Z 4.03 (vent plate extends to Z=+2.56).

| Mesh | Tris | Materials | Purpose |
|---|---|---|---|
| `Plinth` | 24 | StoneDark, Stone | two-step stone base |
| `Sack` | 520 | Cloth, Rope, Wood | bellows sack + rope band + wooden press paddle/lever. Node at **(0, 1.35, -0.45), scale (1,1,1)** — game inflates via `Sack.scale`, origin at sack center |
| `Horn` | 968 | Bronze, BronzeDark, EnergyAmber | 5-segment curved horn with collars, dragon-maw bell opening straight UP over the vent plate (jaw wedges, teeth, amber eyes) |
| `Crest` | 244 | BronzeDark, Bronze | ouroboros ring crest on a post at the top rear |
| `VentPlate` | 784 | Stone, EnergyGreen | concentric samon vent plate on the ground, center **(0, 0.035, 1.5)** — spawn the updraft column here (mouth is directly above it) |

## treasure_chest.glb — 648 tris, 52 KB

Stone-and-bronze chest. Bounding box: X 1.27 x Y 0.95 x Z 1.03
(nominal body 1.2 x 0.9 footprint; side ring-handles and front clasp add the overhang).

| Mesh | Tris | Materials | Purpose |
|---|---|---|---|
| `Body` | 384 | BronzeDark, Stone, StoneDark, EnergyAmber, Bronze | base/skirt, stone core, bronze corner posts + top rim, dark interior inset (visible when open), amber seam strips at the lid junction, side ring handles. Node at origin. |
| `Lid` | 264 | Stone, Bronze, BronzeDark, EnergyAmber | faceted stone arch lid + bronze straps + taotie clasp (amber eyes) + back hinge plate. Node at **(0, 0.54, -0.45)** = back hinge line, identity rotation. |

**Opening:** rotate `Lid.rotation.x` NEGATIVE (e.g. tween 0 → -1.3 rad) — the lid swings
up and back around the hinge. Verified in the open-lid preview render.

---

## Files

| Model | GLB | Previews |
|---|---|---|
| Beacon shrine | `beacon_shrine.glb` | `beacon_shrine_preview.png`, `_preview2.png` (core close-up) |
| Skywatch tower | `skywatch_tower.glb` | `skywatch_tower_preview.png`, `_preview2.png` (crown), `_preview3.png` (base/door) |
| Wind bellows | `wind_bellows.glb` | `wind_bellows_preview.png`, `_preview2.png` (maw + vent) |
| Treasure chest | `treasure_chest.glb` | `treasure_chest_preview.png` (closed), `_preview2.png` (open, hinge test) |

Preview note: EnergyGreen/EnergyAmber materials carry a small emissive term in the GLB
(base color repeated as emission, strength 1.5) so they read as glowing even before the
game's toon remap; the game may override this freely (it remaps materials by name).
Build scripts (Blender Python) live in the session scratchpad (`build_*.py` + `helpers.py`).
