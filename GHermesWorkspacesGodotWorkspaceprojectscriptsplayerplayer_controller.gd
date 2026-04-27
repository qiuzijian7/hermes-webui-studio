## 玩家车辆控制器
## 核心机制：无刹车系统，只能通过转向和加速控制

class_name PlayerController
extends RigidBody2D

# ===== 移动参数 =====
@export_group("Movement")
@export var max_speed: float = 400.0          ## 最大速度(像素/秒)
@export var acceleration: float = 800.0      ## 加速度
@export var turn_speed: float = 180.0         ## 转向速度(度/秒)
@export var friction: float = 0.98            ## 摩擦系数(每帧衰减)

# ===== 氮气参数 =====
@export_group("Boost")
@export var boost_max_speed: float = 600.0    ## 氮气最大速度
@export var boost_acceleration: float = 1200.0 ## 氮气加速度
@export var boost_duration: float = 1.5       ## 氮气持续时间(秒)
@export var boost_cooldown: float = 3.0       ## 氮气冷却时间(秒)

# ===== 状态变量 =====
var _boost_active: bool = false
var _boost_cooldown_timer: float = 0.0
var _boost_duration_timer: float = 0.0

# ===== 节点引用 =====
@onready var _sprite: Sprite2D = $Sprite2D
@onready var _boost_particles: GPUParticles2D = $BoostParticles

# ===== 物理材质 =====
var _physics_material: PhysicsMaterial


func _ready() -> void:
	# 创建物理材质
	_physics_material = PhysicsMaterial.new()
	_physics_material.friction = 0.0  # 无摩擦
	_physics_material.bounce = 0.2     # 轻微弹跳
	physics_material_override = _physics_material
	
	# 设置质量
	mass = 1000.0
	angular_damp = 0.5


func _physics_process(delta: float) -> void:
	_handle_input(delta)
	_apply_physics(delta)
	_update_boost(delta)


func _handle_input(delta: float) -> void:
	# ===== 转向输入 =====
	var turn_input := 0.0
	if Input.is_action_pressed("move_left"):
		turn_input -= 1.0
	if Input.is_action_pressed("move_right"):
		turn_input += 1.0
	
	# 应用转向(基于当前速度调整转向幅度)
	var speed_factor := linear_velocity.length() / max_speed
	var actual_turn_speed := turn_speed * (1.0 + speed_factor * 0.5)
	rotation_degrees += turn_input * actual_turn_speed * delta
	
	# ===== 加速输入 =====
	if Input.is_action_pressed("accelerate"):
		_apply_acceleration(delta)
	
	# ===== 氮气输入 =====
	if Input.is_action_just_pressed("boost"):
		_try_activate_boost()
	
	# ===== 快速重启 =====
	if Input.is_action_just_pressed("restart"):
		_restart_level()


func _apply_acceleration(delta: float) -> void:
	var current_accel: float
	var current_max: float
	
	if _boost_active:
		current_accel = boost_acceleration
		current_max = boost_max_speed
	else:
		current_accel = acceleration
		current_max = max_speed
	
	# 沿车辆朝向加速
	var acceleration_vector := transform.x * current_accel * delta
	linear_velocity += acceleration_vector
	
	# 限制最大速度
	linear_velocity = linear_velocity.limit_length(current_max)


func _apply_physics(delta: float) -> void:
	# ===== 摩擦力(模拟无刹车 - 只有自然减速) =====
	linear_velocity *= friction
	
	# ===== 速度过低时停止 =====
	if linear_velocity.length() < 10.0:
		linear_velocity = Vector2.ZERO


func _update_boost(delta: float) -> void:
	# 更新冷却计时器
	if _boost_cooldown_timer > 0:
		_boost_cooldown_timer -= delta
	
	# 更新持续时间
	if _boost_active:
		_boost_duration_timer -= delta
		if _boost_duration_timer <= 0:
			_deactivate_boost()
	
	# 更新粒子效果
	if _boost_particles:
		_boost_particles.emitting = _boost_active


func _try_activate_boost() -> void:
	if _boost_cooldown_timer <= 0 and not _boost_active:
		_boost_active = true
		_boost_duration_timer = boost_duration
		_boost_cooldown_timer = boost_cooldown
		
		# 播放音效
		AudioManager.play_sfx("boost")


func _deactivate_boost() -> void:
	_boost_active = false


func _restart_level() -> void:
	# 通知关卡管理器重新开始
	LevelManager.restart_current_level()


# ===== 碰撞处理 =====
func _on_body_entered(body: Node) -> void:
	if body.is_in_group("obstacle"):
		# 碰撞减速
		linear_velocity *= 0.5
		
		# 播放碰撞音效
		AudioManager.play_sfx("collision")
		
		# 触发碰撞特效
		_create_collision_effect()


func _create_collision_effect() -> void:
	# 创建碰撞火花效果(后续实现)
	pass


# ===== 公共接口 =====
func get_boost_cooldown_ratio() -> float:
	"""获取氮气冷却进度(0-1)"""
	if _boost_cooldown_timer <= 0:
		return 1.0
	return 1.0 - (_boost_cooldown_timer / boost_cooldown)


func get_current_speed_ratio() -> float:
	"""获取当前速度比例(0-1)"""
	var current_max := boost_max_speed if _boost_active else max_speed
	return linear_velocity.length() / current_max