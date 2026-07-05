// Sound asset manifest for The Wilds of Aerwyn.
// Every file shipped in assets/sfx/ is listed here; logical name = filename without extension.
// All sources are CC0 unless noted in SFX_CREDITS (amb_wind is CC-BY 3.0 — attribution required,
// see assets/licenses/SFX-CREDITS.md).

export const SFX_FILES = {
  // --- combat ---
  swing_1: "assets/sfx/swing_1.wav",
  swing_2: "assets/sfx/swing_2.wav",
  swing_3: "assets/sfx/swing_3.wav",
  club_swing: "assets/sfx/club_swing.wav",
  windup: "assets/sfx/windup.wav",
  exhaust: "assets/sfx/exhaust.wav",
  hit_1: "assets/sfx/hit_1.ogg",
  hit_2: "assets/sfx/hit_2.ogg",
  hurt: "assets/sfx/hurt.ogg",
  block: "assets/sfx/block.ogg",
  enemy_hit: "assets/sfx/enemy_hit.ogg",
  enemy_die: "assets/sfx/enemy_die.ogg",
  alert: "assets/sfx/alert.ogg",
  bone_rattle: "assets/sfx/bone_rattle.ogg",
  slam: "assets/sfx/slam.ogg",

  // --- traversal / movement ---
  step_grass_1: "assets/sfx/step_grass_1.ogg",
  step_grass_2: "assets/sfx/step_grass_2.ogg",
  step_grass_3: "assets/sfx/step_grass_3.ogg",
  step_stone_1: "assets/sfx/step_stone_1.ogg",
  step_stone_2: "assets/sfx/step_stone_2.ogg",
  jump: "assets/sfx/jump.ogg",
  land_soft: "assets/sfx/land_soft.ogg",
  land_hard: "assets/sfx/land_hard.ogg",
  glide_wind: "assets/sfx/glide_wind.ogg",
  splash: "assets/sfx/splash.ogg",
  swim_1: "assets/sfx/swim_1.ogg",
  swim_2: "assets/sfx/swim_2.ogg",
  thud: "assets/sfx/thud.ogg",
  grab: "assets/sfx/grab.ogg",

  // --- items / progression ---
  pickup_gem: "assets/sfx/pickup_gem.ogg",
  pickup_apple: "assets/sfx/pickup_apple.ogg",
  eat: "assets/sfx/eat.ogg",
  heart: "assets/sfx/heart.ogg",
  upgrade: "assets/sfx/upgrade.ogg",
  chest_open: "assets/sfx/chest_open.ogg",
  glimmer: "assets/sfx/glimmer.ogg",
  shrine_wake: "assets/sfx/shrine_wake.ogg",
  tower_wake: "assets/sfx/tower_wake.ogg",

  // --- ui ---
  ui_lock: "assets/sfx/ui_lock.ogg",
  ui_toast: "assets/sfx/ui_toast.ogg",
  ui_open: "assets/sfx/ui_open.ogg",
  ui_close: "assets/sfx/ui_close.ogg",

  // --- ambience / weather / music ---
  amb_birds: "assets/sfx/amb_birds.ogg",
  amb_night: "assets/sfx/amb_night.mp3",
  amb_river: "assets/sfx/amb_river.ogg",
  amb_wind: "assets/sfx/amb_wind.ogg",
  thunder: "assets/sfx/thunder.ogg",
  music_day: "assets/sfx/music_day.ogg",
  music_night: "assets/sfx/music_night.mp3",
};

export const SFX_CREDITS = [
  // Swishes Sound Pack — artisticdude — CC0
  { file: "swing_1.wav", source: "Swishes Sound Pack (swish-1.wav)", author: "artisticdude", license: "CC0", url: "https://opengameart.org/content/swishes-sound-pack" },
  { file: "swing_2.wav", source: "Swishes Sound Pack (swish-2.wav)", author: "artisticdude", license: "CC0", url: "https://opengameart.org/content/swishes-sound-pack" },
  { file: "swing_3.wav", source: "Swishes Sound Pack (swish-3.wav)", author: "artisticdude", license: "CC0", url: "https://opengameart.org/content/swishes-sound-pack" },
  { file: "club_swing.wav", source: "Swishes Sound Pack (swish-9.wav)", author: "artisticdude", license: "CC0", url: "https://opengameart.org/content/swishes-sound-pack" },
  { file: "windup.wav", source: "Swishes Sound Pack (swish-7.wav)", author: "artisticdude", license: "CC0", url: "https://opengameart.org/content/swishes-sound-pack" },
  { file: "exhaust.wav", source: "Swishes Sound Pack (swish-13.wav)", author: "artisticdude", license: "CC0", url: "https://opengameart.org/content/swishes-sound-pack" },

  // 80 CC0 RPG SFX — rubberduck — CC0
  { file: "hit_1.ogg", source: "80 CC0 RPG SFX (blade_02.ogg)", author: "rubberduck", license: "CC0", url: "https://opengameart.org/content/80-cc0-rpg-sfx" },
  { file: "hit_2.ogg", source: "80 CC0 RPG SFX (blade_03.ogg)", author: "rubberduck", license: "CC0", url: "https://opengameart.org/content/80-cc0-rpg-sfx" },
  { file: "hurt.ogg", source: "80 CC0 RPG SFX (creature_hurt_02.ogg)", author: "rubberduck", license: "CC0", url: "https://opengameart.org/content/80-cc0-rpg-sfx" },
  { file: "enemy_hit.ogg", source: "80 CC0 RPG SFX (creature_hurt_01.ogg)", author: "rubberduck", license: "CC0", url: "https://opengameart.org/content/80-cc0-rpg-sfx" },
  { file: "enemy_die.ogg", source: "80 CC0 RPG SFX (creature_die_01.ogg)", author: "rubberduck", license: "CC0", url: "https://opengameart.org/content/80-cc0-rpg-sfx" },
  { file: "alert.ogg", source: "80 CC0 RPG SFX (creature_roar_01.ogg)", author: "rubberduck", license: "CC0", url: "https://opengameart.org/content/80-cc0-rpg-sfx" },
  { file: "pickup_gem.ogg", source: "80 CC0 RPG SFX (item_gem_01.ogg)", author: "rubberduck", license: "CC0", url: "https://opengameart.org/content/80-cc0-rpg-sfx" },
  { file: "glimmer.ogg", source: "80 CC0 RPG SFX (item_gem_02.ogg)", author: "rubberduck", license: "CC0", url: "https://opengameart.org/content/80-cc0-rpg-sfx" },
  { file: "shrine_wake.ogg", source: "80 CC0 RPG SFX (spell_01.ogg)", author: "rubberduck", license: "CC0", url: "https://opengameart.org/content/80-cc0-rpg-sfx" },
  { file: "tower_wake.ogg", source: "80 CC0 RPG SFX (spell_02.ogg)", author: "rubberduck", license: "CC0", url: "https://opengameart.org/content/80-cc0-rpg-sfx" },
  { file: "grab.ogg", source: "80 CC0 RPG SFX (item_wood_01.ogg)", author: "rubberduck", license: "CC0", url: "https://opengameart.org/content/80-cc0-rpg-sfx" },
  { file: "thud.ogg", source: "80 CC0 RPG SFX (wood_04.ogg)", author: "rubberduck", license: "CC0", url: "https://opengameart.org/content/80-cc0-rpg-sfx" },
  { file: "block.ogg", source: "80 CC0 RPG SFX (metal_01.ogg)", author: "rubberduck", license: "CC0", url: "https://opengameart.org/content/80-cc0-rpg-sfx" },
  { file: "ui_lock.ogg", source: "80 CC0 RPG SFX (lock_01.ogg)", author: "rubberduck", license: "CC0", url: "https://opengameart.org/content/80-cc0-rpg-sfx" },

  // 40 CC0 water splash & slime SFX — rubberduck — CC0
  { file: "splash.ogg", source: "40 CC0 Water Splash & Slime SFX (splash_01.ogg)", author: "rubberduck", license: "CC0", url: "https://opengameart.org/content/40-cc0-water-splash-slime-sfx" },
  { file: "swim_1.ogg", source: "40 CC0 Water Splash & Slime SFX (splash_09.ogg)", author: "rubberduck", license: "CC0", url: "https://opengameart.org/content/40-cc0-water-splash-slime-sfx" },
  { file: "swim_2.ogg", source: "40 CC0 Water Splash & Slime SFX (splash_10.ogg)", author: "rubberduck", license: "CC0", url: "https://opengameart.org/content/40-cc0-water-splash-slime-sfx" },
  { file: "amb_river.ogg", source: "40 CC0 Water Splash & Slime SFX (loop_water_01.ogg)", author: "rubberduck", license: "CC0", url: "https://opengameart.org/content/40-cc0-water-splash-slime-sfx" },

  // 100 CC0 SFX #2 — rubberduck — CC0
  { file: "thunder.ogg", source: "100 CC0 SFX #2 (sfx100v2_thunder_01.ogg)", author: "rubberduck", license: "CC0", url: "https://opengameart.org/content/100-cc0-sfx-2" },

  // Bones Rattle — congusbongus — CC0 (adapted from freesound.org/people/blukotek/sounds/249319)
  { file: "bone_rattle.ogg", source: "Bones Rattle (3.ogg)", author: "congusbongus", license: "CC0", url: "https://opengameart.org/content/bones-rattle" },

  // Singles from OpenGameArt
  { file: "glide_wind.ogg", source: "Wind Whoosh Loop", author: "SketchMan3", license: "CC0", url: "https://opengameart.org/content/wind-whoosh-loop" },
  { file: "amb_wind.ogg", source: "Wind Loop (wind-01_0.ogg)", author: "Jonathan Shaw (InspectorJ, www.jshaw.co.uk); loop edit by AntumDeluge", license: "CC-BY 3.0", url: "https://opengameart.org/content/wind-loop" },
  { file: "amb_night.mp3", source: "Crickets Ambient Noise - loopable (crickets_1.mp3)", author: "Wolfgang_ (recording credited to Ted Kerr)", license: "CC0", url: "https://opengameart.org/content/crickets-ambient-noise-loopable" },
  { file: "amb_birds.ogg", source: "Ambient Bird Sounds (birds-isaiah658_0.ogg)", author: "isaiah658", license: "CC0", url: "https://opengameart.org/content/ambient-bird-sounds" },
  { file: "music_day.ogg", source: "Heavenly Loop (Heavenly Loop.ogg)", author: "isaiah658", license: "CC0", url: "https://opengameart.org/content/heavenly-loop" },
  { file: "music_night.mp3", source: "Contemplation (Contemplation.mp3)", author: "Joth", license: "CC0", url: "https://opengameart.org/content/contemplation-0" },

  // Kenney Impact Sounds — CC0
  { file: "step_grass_1.ogg", source: "Kenney Impact Sounds (footstep_grass_000.ogg)", author: "Kenney", license: "CC0", url: "https://kenney.nl/assets/impact-sounds" },
  { file: "step_grass_2.ogg", source: "Kenney Impact Sounds (footstep_grass_001.ogg)", author: "Kenney", license: "CC0", url: "https://kenney.nl/assets/impact-sounds" },
  { file: "step_grass_3.ogg", source: "Kenney Impact Sounds (footstep_grass_002.ogg)", author: "Kenney", license: "CC0", url: "https://kenney.nl/assets/impact-sounds" },
  { file: "step_stone_1.ogg", source: "Kenney Impact Sounds (footstep_concrete_000.ogg)", author: "Kenney", license: "CC0", url: "https://kenney.nl/assets/impact-sounds" },
  { file: "step_stone_2.ogg", source: "Kenney Impact Sounds (footstep_concrete_001.ogg)", author: "Kenney", license: "CC0", url: "https://kenney.nl/assets/impact-sounds" },
  { file: "land_soft.ogg", source: "Kenney Impact Sounds (impactSoft_medium_000.ogg)", author: "Kenney", license: "CC0", url: "https://kenney.nl/assets/impact-sounds" },
  { file: "land_hard.ogg", source: "Kenney Impact Sounds (impactSoft_heavy_000.ogg)", author: "Kenney", license: "CC0", url: "https://kenney.nl/assets/impact-sounds" },
  { file: "slam.ogg", source: "Kenney Impact Sounds (impactPunch_heavy_000.ogg)", author: "Kenney", license: "CC0", url: "https://kenney.nl/assets/impact-sounds" },

  // Kenney RPG Audio — CC0
  { file: "jump.ogg", source: "Kenney RPG Audio (cloth3.ogg)", author: "Kenney", license: "CC0", url: "https://kenney.nl/assets/rpg-audio" },
  { file: "pickup_apple.ogg", source: "Kenney RPG Audio (handleSmallLeather.ogg)", author: "Kenney", license: "CC0", url: "https://kenney.nl/assets/rpg-audio" },
  { file: "eat.ogg", source: "Kenney RPG Audio (chop.ogg)", author: "Kenney", license: "CC0", url: "https://kenney.nl/assets/rpg-audio" },
  { file: "chest_open.ogg", source: "Kenney RPG Audio (doorOpen_1.ogg)", author: "Kenney", license: "CC0", url: "https://kenney.nl/assets/rpg-audio" },

  // Kenney Interface Sounds — CC0
  { file: "heart.ogg", source: "Kenney Interface Sounds (confirmation_001.ogg)", author: "Kenney", license: "CC0", url: "https://kenney.nl/assets/interface-sounds" },
  { file: "ui_toast.ogg", source: "Kenney Interface Sounds (bong_001.ogg)", author: "Kenney", license: "CC0", url: "https://kenney.nl/assets/interface-sounds" },
  { file: "ui_open.ogg", source: "Kenney Interface Sounds (open_001.ogg)", author: "Kenney", license: "CC0", url: "https://kenney.nl/assets/interface-sounds" },
  { file: "ui_close.ogg", source: "Kenney Interface Sounds (close_001.ogg)", author: "Kenney", license: "CC0", url: "https://kenney.nl/assets/interface-sounds" },

  // Kenney Music Jingles — CC0
  { file: "upgrade.ogg", source: "Kenney Music Jingles (jingles_PIZZI10.ogg)", author: "Kenney", license: "CC0", url: "https://kenney.nl/assets/music-jingles" },
];
