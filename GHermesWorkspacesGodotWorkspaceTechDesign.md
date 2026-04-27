# NO BRAKE: Turbo Rush - 技术设计文档

## 1. 系统架构

### 1.1 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                      游戏主循环                           │
├─────────────────────────────────────────────────────────┤
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐    │
│  │ 输入系统 │  │ 物理系统│  │ 渲染系统│  │ 音频系统│    │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘    │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────┐ │
│  │                   游戏状态机                         │ │
│  │  [主菜单] → [游戏中] → [暂停] → [结算] → [主菜单]   │ │
│  └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### 1.2 核心模块

| 模块 | 描述 | 优先级 |
|------|------|--------|
| PlayerController | 玩家车辆控制 | P0 |
| PhysicsEngine | 车辆物理模拟 | P0 |
| LevelManager | 关卡管理 | P0 |
| UIManager | 用户界面 | P0 |
| AudioManager | 音效管理 | P1 |
| SaveSystem | 存档系统 | P1 |
| AchievementSystem | 成就系统 | P2 |
| LeaderboardSystem | 排行榜系统 | P2 |
| SteamIntegration | Steam集成 | P2 |

---

## 2. 车辆物理系统

### 2.1 核心参数

```gdscript
# PlayerVehicle.gd
extends RigidBody2D

# 移动参数
@export var max_speed: float = 400.0        # 最大速度
@export var acceleration: float = 800.0     # 加速度
@export var turn_speed: float = 180.0       # 转向速度(度/秒)
@export var friction: float = 0.98          # 摩擦系数(每帧)

# 氮气参数
@export var boost_speed: float = 600.0      # 氮气最大速度
@export var boost_acceleration: float = 1200.0
@export var boost_cooldown: float = 3.0     # 冷却时间(秒)
@export var boost_duration: float = 1.5    # 持续时间(秒)

# 物理参数
@export var mass: float = 1000.0             # 质量(kg)
@export var angular_damp: float = 0.5       # 角阻尼
```

### 2.2 核心逻辑

```gdscript
func _physics_process(delta: float) -> void:
    # 处理输入
    var turn_input = Input.get_axis("turn_left", "turn_right")
    var accelerate_input = Input.is_action_pressed("accelerate")
    var boost_input = Input.is_action_just_pressed("boost")
    
    # 转向
    if turn_input != 0:
        rotation_degrees += turn_input * turn_speed * delta
    
    # 加速
    if accelerate_input:
        var current_accel = boost_active * boost_acceleration if boost_active else acceleration
        var current_max = boost_speed if boost_active else max_speed
        linear_velocity += transform.x * current_accel * delta
        linear_velocity = linear_velocity.limit_length(current_max)
    
    # 摩擦力(模拟无刹车)
    linear_velocity *= friction
    
    # 氮气处理
    if boost_input and can_boost:
        start_boost()
```

---

## 3. 关卡系统

### 3.1 关卡数据结构

```gdscript
# Level.gd
class_name Level

@export var level_id: int
@export var level_name: String
@export var chapter: int
@export var difficulty: int  # 1-5
@export var level_type: LevelType  # RACE, TIME, COLLECT, DODGE

# 时间要求(秒)
@export var three_star_time: float
@export var two_star_time: float
@export var one_star_time: float

# 资源路径
@export var tilemap_path: String
@export var music_path: String

enum LevelType { RACE, TIME, COLLECT, DODGE }
```

### 3.2 关卡加载

```gdscript
# LevelManager.gd
class_name LevelManager
extends Node

var current_level: Level
var unlocked_levels: Array[int] = [1]
var level_times: Dictionary = {}  # level_id -> best_time

func load_level(level_id: int) -> void:
    var level_data = load_level_data(level_id)
    current_level = level_data
    # 加载关卡场景
    # 初始化障碍物
    # 播放背景音乐

func complete_level(time: float, stars: int, perfect: bool) -> void:
    # 保存成绩
    # 解锁下一关
    # 检查成就
    # 更新排行榜
```

---

## 4. 存档系统

### 4.1 存档结构

```gdscript
# SaveData.gd
class_name SaveData
extends Resource

@export var player_name: String = "Player"
@export var unlocked_levels: Array[int] = [1]
@export var level_scores: Dictionary = {}  # level_id -> {time, stars, perfect}
@export var total_playtime: float = 0.0
@export var achievements: Array[String] = []
@export var settings: Dictionary = {}
```

### 4.2 存档位置

- **Windows**: `%APPDATA%/NO BRAKE Turbo Rush/`
- **Mac**: `~/Library/Application Support/NO BRAKE Turbo Rush/`
- **Linux**: `~/.local/share/NO BRAKE Turbo Rush/`

---

## 5. Steam集成

### 5.1 Steam API功能

| 功能 | 实现方式 |
|------|----------|
| 成就 | SteamAchievements |
| 排行榜 | SteamLeaderboards |
| 云存档 | SteamRemoteStorage |
| 集换式卡牌 | 静态配置 |
| 好友邀请 | SteamFriends |

### 5.2 成就列表

| 成就ID | 名称 | 条件 |
|--------|------|------|
| first_drive | 初次驾驶 | 完成第一关 |
| no_brake_master | 无刹车大师 | 完成教程章节 |
| speed_demon | 速度恶魔 | 单关<10秒 |
| perfect_run | 完美运行 | 无碰撞通关 |
| boost_addict | 氮气狂人 | 使用氮气100次 |
| chapter_2 | 城镇探索 | 解锁第二章 |
| chapter_3 | 工厂探险 | 解锁第三章 |
| chapter_4 | 山路征服 | 解锁第四章 |
| chapter_5 | 城市传奇 | 解锁第五章 |
| all_stars | 全星王者 | 获得所有三星 |
| speedrunner | 速通王者 | 速通模式完成 |
| collector | 收藏家 | 收集所有金币 |

---

## 6. 目录结构

```
NO BRAKE Turbo Rush/
├── assets/
│   ├── sprites/
│   │   ├── player/
│   │   ├── enemies/
│   │   ├── tiles/
│   │   └── effects/
│   ├── audio/
│   │   ├── music/
│   │   └── sfx/
│   └── fonts/
├── scenes/
│   ├── levels/
│   │   ├── chapter_1/
│   │   ├── chapter_2/
│   │   ├── chapter_3/
│   │   ├── chapter_4/
│   │   └── chapter_5/
│   ├── ui/
│   │   ├── main_menu.tscn
│   │   ├── pause_menu.tscn
│   │   ├── level_select.tscn
│   │   └── result_screen.tscn
│   └── objects/
│       ├── player.tscn
│       ├── obstacle.tscn
│       ├── coin.tscn
│       └── boost_pad.tscn
├── scripts/
│   ├── player/
│   │   └── player_controller.gd
│   ├── systems/
│   │   ├── level_manager.gd
│   │   ├── save_system.gd
│   │   ├── audio_manager.gd
│   │   └── steam_manager.gd
│   └── ui/
│       └── ui_manager.gd
├── resources/
│   ├── levels/
│   │   └── level_data.tres
│   └── achievements/
│       └── achievement_data.tres
└── project.godot
```

---

## 7. 性能优化

### 7.1 优化策略

- **对象池**：障碍物、粒子使用对象池
- **LOD**：远处物体降低渲染精度
- **批处理**：相同材质物体批量绘制
- **异步加载**：关卡资源异步加载

### 7.2 目标性能

| 指标 | 目标值 |
|------|--------|
| 帧率 | 60 FPS |
| 加载时间 | < 3秒 |
| 内存占用 | < 200MB |
| 包体大小 | < 200MB |

---

*文档版本：1.0*
*更新日期：2026-04-21*