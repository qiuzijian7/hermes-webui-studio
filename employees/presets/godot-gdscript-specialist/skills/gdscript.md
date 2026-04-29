---
name: gdscript
description: GDScript 编码规范、性能要点、Godot 4.x 最佳实践
version: 1.0.0
author: Hermes Agent
metadata:
  hermes:
    tags: [godot, gdscript, scripting]
---

# GDScript 实践技能

## 核心原则
**GDScript 是动态语言，但请像写静态语言一样写它。**

## 类型提示（强烈推荐）

```gdscript
# 坏
var speed = 5.0
func take_damage(amount): health -= amount

# 好
var speed: float = 5.0
@export var max_health: int = 100
func take_damage(amount: int) -> void:
    health -= amount
```

类型提示带来：编辑器补全 / 错误前置 / 性能提升。

## 信号优于轮询

```gdscript
# 坏（每帧检查）
func _process(_delta):
    if player.health <= 0:
        game_over()

# 好（事件驱动）
func _ready():
    player.died.connect(_on_player_died)
```

## 节点查找

```gdscript
# 坏（硬编码路径，改名即失效）
$"../../UI/HealthBar".value = health

# 好（导出引用或 @onready）
@onready var health_bar: ProgressBar = %HealthBar  # Unique Name
# 或
@export var health_bar: ProgressBar
```

## 性能要点

- `_process` 中不做耗时操作（> 1ms 要进线程）
- 不要每帧 `get_node` —— 用 `@onready` 缓存
- 大量对象用 **ObjectPool**（特别是子弹、粒子）
- 物理查询用 `PhysicsDirectSpaceState3D`，别把所有节点遍历
- 字符串拼接用 `"%s" % var`，不要 `"x" + str(x)`

## Resource 代替 JSON 配置

```gdscript
# weapon_data.tres（二进制资源，编辑器可视化编辑）
class_name WeaponData extends Resource
@export var damage: int
@export var cooldown: float
@export var icon: Texture2D
```

## 异步操作

```gdscript
# 好：await 关键字
func load_level() -> void:
    loading_screen.show()
    await get_tree().process_frame
    var scene = load("res://levels/level_1.tscn")
    get_tree().change_scene_to_packed(scene)
    loading_screen.hide()
```

## 调试

- `print_debug()` 代替 `print()`（带调用栈）
- 开发阶段 `assert(x > 0)` 明确约束
- `@warning_ignore()` 只用于**明确已理解**的告警

## 反模式

- ❌ 不写类型提示
- ❌ `_process` 每帧 `find_child()` / `get_node()`
- ❌ 用 `dictionary` 存配置（应该用 Resource）
- ❌ 滥用 `get_tree().root.get_node()`（耦合爆炸）
- ❌ 信号命名不用过去式（应 `health_changed` 不是 `change_health`）
