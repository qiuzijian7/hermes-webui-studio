# NO BRAKE: Turbo Rush - 项目结构

## Godot 4.x 项目结构

```
NO_BRAKE/
├── project.godot
├── icon.svg
├── assets/
│   ├── sprites/
│   │   ├── player/
│   │   │   ├── car_idle.png (32x32)
│   │   │   ├── car_boost.png (32x32)
│   │   │   └── car_crash.png (32x32)
│   │   ├── tiles/
│   │   │   ├── ground.png (16x16)
│   │   │   ├── wall.png (16x16)
│   │   │   ├── road.png (16x16)
│   │   │   └── boost_pad.png (16x16)
│   │   ├── collectibles/
│   │   │   └── coin.png (16x16)
│   │   └── effects/
│   │       ├── tire_track.png (8x8)
│   │       ├── spark.png (8x8)
│   │       └── fire.png (16x16)
│   ├── audio/
│   │   ├── music/
│   │   │   ├── chapter1.ogg
│   │   │   ├── chapter2.ogg
│   │   │   ├── chapter3.ogg
│   │   │   ├── chapter4.ogg
│   │   │   └── chapter5.ogg
│   │   └── sfx/
│   │       ├── engine.ogg
│   │       ├── boost.ogg
│   │       ├── crash.ogg
│   │       ├── coin.ogg
│   │       └── win.ogg
│   └── fonts/
│       ├── pixel_font.ttf
│       └── ui_font.ttf
├── scenes/
│   ├── main.tscn (主菜单)
│   ├── game.tscn (游戏主场景)
│   ├── levels/
│   │   ├── level_01.tscn
│   │   ├── level_02.tscn
│   │   └── ...
│   ├── objects/
│   │   ├── player.tscn
│   │   ├── coin.tscn
│   │   ├── checkpoint.tscn
│   │   ├── spike.tscn
│   │   └── door.tscn
│   └── ui/
│       ├── hud.tscn
│       ├── pause_menu.tscn
│       ├── level_select.tscn
│       └── settings.tscn
├── scripts/
│   ├── main.gd
│   ├── game.gd
│   ├── player/
│   │   ├── player.gd
│   │   └── player_state.gd
│   ├── level/
│   │   ├── level.gd
│   │   ├── checkpoint.gd
│   │   └── door.gd
│   ├── objects/
│   │   ├── coin.gd
│   │   ├── spike.gd
│   │   └── boost_pad.gd
│   ├── ui/
│   │   ├── hud.gd
│   │   ├── pause_menu.gd
│   │   └── level_select.gd
│   └── systems/
│       ├── game_manager.gd
│       ├── save_manager.gd
│       ├── time_manager.gd
│       └── audio_manager.gd
├── resources/
│   ├── themes/
│   │   └── ui_theme.tres
│   └── levels/
│       └── level_data.tres
└── export/
    └── presets.cfg
```

## 核心场景说明

### player.tscn 节点结构
```
Player (CharacterBody2D)
├── Sprite2D
├── CollisionShape2D
├── Camera2D
├── GPUParticles2D (轮胎痕迹)
├── GPUParticles2D (氮气火焰)
└── AudioStreamPlayer2D
```

### level.tscn 节点结构
```
Level (Node2D)
├── TileMapLayer (地面)
├── TileMapLayer (障碍物)
├── Node2D (检查点)
├── Node2D (金币)
├── Node2D (敌人/机关)
├── Door (终点)
├── Camera2D
└── CanvasLayer (UI)
```

---

*项目结构版本: 1.0*