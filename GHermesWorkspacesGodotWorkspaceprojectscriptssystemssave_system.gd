## 存档系统
## 负责游戏数据持久化

class_name SaveSystem
extends Node

# ===== 单例实例 =====
static var instance: SaveSystem

# ===== 保存路径 =====
const SAVE_FILE := "user://savegame.json"

# ===== 保存数据结构 =====
var _save_data: Dictionary = {
	"version": "1.0",
	"player_name": "Player",
	"unlocked_levels": [1],
	"level_scores": {},
	"total_playtime": 0.0,
	"achievements": [],
	"settings": {
		"sfx_volume": 0.8,
		"music_volume": 0.7,
		"fullscreen": false
	}
}

# ===== 信号 =====
signal data_loaded
signal data_saved


func _ready() -> void:
	instance = self
	load_game()


# ===== 存档操作 =====
func load_game() -> void:
	if FileAccess.file_exists(SAVE_FILE):
		var file := FileAccess.open(SAVE_FILE, FileAccess.READ)
		if file:
			var json_str := file.get_as_text()
			file.close()
			
			var json := JSON.new()
			var parse_result := json.parse(json_str)
			if parse_result == OK:
				_save_data = json.data
				print("Save data loaded successfully")
	
	data_loaded.emit()


func save_game() -> void:
	var file := FileAccess.open(SAVE_FILE, FileAccess.WRITE)
	if file:
		var json := JSON.new()
		var json_str := json.stringify(_save_data, "\t")
		file.store_string(json_str)
		file.close()
		print("Save data saved successfully")
	
	data_saved.emit()


# ===== 数据读写 =====
func save_progress(level_id: int, unlocked: Array, scores: Dictionary) -> void:
	_save_data["unlocked_levels"] = unlocked
	_save_data["level_scores"] = scores
	save_game()


func get_unlocked_levels() -> Array[int]:
	return _save_data.get("unlocked_levels", [1])


func get_level_scores() -> Dictionary:
	return _save_data.get("level_scores", {})


func get_settings() -> Dictionary:
	return _save_data.get("settings", {})


func save_settings(settings: Dictionary) -> void:
	_save_data["settings"] = settings
	save_game()


# ===== 设置操作 =====
func set_volume(channel: String, value: float) -> void:
	var settings := get_settings()
	settings[channel + "_volume"] = clamp(value, 0.0, 1.0)
	save_settings(settings)


func get_volume(channel: String) -> float:
	var settings := get_settings()
	return settings.get(channel + "_volume", 0.8)


func set_fullscreen(enabled: bool) -> void:
	var settings := get_settings()
	settings["fullscreen"] = enabled
	save_settings(settings)


# ===== 成就 =====
func unlock_achievement(achievement_id: String) -> void:
	var achievements: Array = _save_data.get("achievements", [])
	if achievement_id not in achievements:
		achievements.append(achievement_id)
		_save_data["achievements"] = achievements
		save_game()
		print("Achievement unlocked: ", achievement_id)


func has_achievement(achievement_id: String) -> bool:
	var achievements: Array = _save_data.get("achievements", [])
	return achievement_id in achievements


func get_all_achievements() -> Array:
	return _save_data.get("achievements", [])