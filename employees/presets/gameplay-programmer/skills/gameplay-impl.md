---
name: gameplay-impl
description: 实现核心玩法（战斗 / 移动 / 交互）的工程模式
version: 1.0.0
author: Hermes Agent
---

# 玩法实现技能

## 核心原则
**玩法代码优先保证"手感"和"可调性"，其次才是架构纯洁性。**

## 结构建议

### 1. Controller + State + Data 三件套
```
PlayerController.cs    <- 输入 -> 意图
PlayerState.cs         <- 当前状态（Idle/Moving/Attacking/Dead）
PlayerData.cs          <- 纯数据（移动速度、攻击力）从 ScriptableObject / YAML 读
```

数据外置的好处：策划可以不改代码调参。

### 2. 事件驱动
```
OnHit → 减血 + VFX + 音效 + 屏幕抖动 + 成就系统 + 统计
```

不要让一个函数管所有副作用。用事件总线 / Observer：
```csharp
events.Emit("player.hit", damage);
// 多个系统独立订阅
```

### 3. 状态可视化
每个实体的当前状态必须能在编辑器 / Debug 面板看到。排查玩法 bug 时这是救命的。

## 手感调优清单

- [ ] **输入缓冲**（jump buffer）：玩家提前按跳，着陆时自动跳
- [ ] **Coyote time**：离开平台 0.1 秒内还能跳
- [ ] **方向锁定**：空中改变方向的权重（过高会飘，过低会僵）
- [ ] **命中反馈**：受击有硬直 / 闪白 / 音效 / 相机震动 / 粒子 —— **至少三项**
- [ ] **加减速曲线**：不是线性（用 Curve / Tween 库）
- [ ] **动画过渡**：至少 0.1 秒 blend，避免生硬切换

## 可调参数外置模板

```yaml
# player.yaml
move:
  speed: 8.0
  accel: 50.0
  decel: 30.0
  air_control: 0.3
jump:
  height: 4.0
  buffer: 0.15
  coyote: 0.12
```

## 反模式

- ❌ 把速度 / 伤害等数值写死在代码里
- ❌ 一个 100 行的 Update() 函数
- ❌ 输入直接改状态（应先转成"意图"，再由状态机消化）
- ❌ 没有任何受击反馈 / 命中反馈
- ❌ 不提供 Debug 开关（无敌 / 飞行 / 传送）
