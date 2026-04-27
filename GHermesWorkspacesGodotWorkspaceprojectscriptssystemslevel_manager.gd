## 关卡管理器
## 负责关卡加载、解锁、进度管理

class_name LevelManager
extends Node

# ===== 单例实例 =====
static var instance: LevelManager

# ===== 关卡数据 =====
var _current_level_id: int = 0
var _unlocked_levels: Array[int] = [1]
var _level_scores: Dictionary = {}  # {level_id: {time, stars, perfect}}

# ===== 关卡配置 =====
const TOTAL_LEVELS: int = 52
const CHAPTER_SIZE: Array[int] = [8, 10, 10, 12, 12]

# ===== 信号 =====
signal level_loaded(level_id: int)
signal level_completed(level_id: int, time: float, stars: int, perfect: bool)
signal level_unlocked(level_id: int)


func _ready() -> void:
	instance = self
	_load_save_data()


# ===== 关卡加载 =====
func load_level(level_id: int) -> bool:
	if level_id < 1 or level_id > TOTAL_LEVELS:
		push_error("Invalid level ID: ", level_id)
		return false
	
	if level_id not in _unlocked_levels:
		push_warning("Level locked: ", level_id)
		return false
	
	_current_level_id = level_id
	
	# 加载关卡场景
	var level_path := _get_level_path(level_id)
	var level_scene := load(level_path)
	if level_scene:
		get_tree().change_scene_to_packed(level_scene)
		level_loaded.emit(level_id)
		return true
	
	return false


func _get_level_path(level_id: int) -> String:
	# 根据关卡ID计算章节
	var chapter := _get_chapter(level_id)
	return "res://scenes/levels/chapter_%d/level_%02d.tscn" % [chapter, level_id]


func _get_chapter(level_id: int) -> int:
	# 计算关卡所属章节
	var accumulated := 0
	for i in range(CHAPTER_SIZE.size()):
		accumulated += CHAPTER_SIZE[i]
		if level_id <= accumulated:
			return i + 1
	return 1


# ===== 关卡完成 =====
func complete_level(time: float, perfect: bool = false) -> void:
	var stars := _calculate_stars(time)
	
	# 保存成绩
	if _current_level_id not in _level_scores or time < _level_scores[_current_level_id].time:
		_level_scores[_current_level_id] = {
			"time": time,
			"stars": stars,
			"perfect": perfect
		}
	
	# 解锁下一关
	var next_level := _current_level_id + 1
	if next_level <= TOTAL_LEVELS and next_level not in _unlocked_levels:
		_unlocked_levels.append(next_level)
		level_unlocked.emit(next_level)
	
	# 保存数据
	_save_save_data()
	
	# 发送完成信号
	level_completed.emit(_current_level_id, time, stars, perfect)


func _calculate_stars(time: float) -> int:
	# 从关卡数据获取星级要求
	var level_data := _get_level_data(_current_level_id)
	if level_data:
		if time <= level_data.three_star_time:
			return 3
		elif time <= level_data.two_star_time:
			return 2
		elif time <= level_data.one_star_time:
			return 1
	return 0


func _get_level_data(level_id: int) -> Dictionary:
	# 返回关卡配置数据(后续从资源加载)
	return {
		"three_star_time": 15.0,
		"two_star_time": 25.0,
		"one_star_time": 40.0
	}


# ===== 重启 =====
func restart_current_level() -> void:
	load_level(_current_level_id)


# ===== 数据持久化 =====
func _load_save_data() -> void:
	var save_system := SaveSystem.instance
	if save_system:
		_unlocked_levels = save_system.get_unlocked_levels()
		_level_scores = save_system.get_level_scores()


func _save_save_data() -> void:
	var save_system := SaveSystem.instance
	if save_system:
		save_system.save_progress(_current_level_id, _unlocked_levels, _level_scores)


# ===== 公共接口 =====
func get_current_level_id() -> int:
	return _current_level_id


func get_unlocked_levels() -> Array[int]:
	return _unlocked_levels.duplicate()


func get_level_score(level_id: int) -> Dictionary:
	return _level_scores.get(level_id, {})


func is_level_unlocked(level_id: int) -> bool:
	return level_id in _unlocked_levels


func get_total_stars() -> int:
	var total := 0
	for score in _level_scores.values():
		total += score.get("stars", 0)
	return total