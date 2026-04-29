---
name: unity-core
description: Unity 引擎核心概念的使用要点，GameObject / MonoBehaviour / Prefab / 场景
version: 1.0.0
author: Hermes Agent
metadata:
  hermes:
    tags: [unity, engine, gameobject]
---

# Unity 核心实践技能

## Script 生命周期

最常用的回调及**调用时机**：

```
构造器 (不推荐重写) → 只有纯数据初始化
Awake()           → 组件引用 GetComponent 在这里
OnEnable()        → 订阅事件 / 启动协程
Start()           → 需要其他对象已 Awake 后的初始化
FixedUpdate()     → 物理计算（固定步长 0.02s）
Update()          → 每帧逻辑（输入、状态机）
LateUpdate()      → 相机跟随、骨骼 IK
OnDisable()       → 取消事件订阅（必做，防泄漏）
OnDestroy()       → 释放非托管资源
```

**铁律**：
- 输入 → Update
- 物理 → FixedUpdate
- 相机 → LateUpdate

## Prefab 工作流

### Prefab Variant
- 基础 Prefab：共享外观 + 基础行为
- Variant：覆盖局部字段（血量、颜色、挂点）

好处：基础改动自动传播，Variant 独立细节。

### Nested Prefabs
- 小部件做 Prefab → 组合进大 Prefab
- 改小部件 → 所有使用处同步

## 资源引用

**绝不**用字符串路径 / Resources.Load（黑盒依赖）：

```csharp
// 坏
var bullet = Resources.Load<GameObject>("Bullets/Basic");

// 好 1: SerializeField（编辑器拖引用）
[SerializeField] private GameObject bulletPrefab;

// 好 2: Addressables（异步、可打包、可热更）
[SerializeField] private AssetReferenceGameObject bulletRef;
```

## 性能要点

### GC 压力
- `new` 在 Update 中 → GC 爆炸 → 卡顿
- 字符串拼接 → 用 StringBuilder / Formatter
- `GameObject.Find` / `GetComponent` → 缓存到字段

### Draw Call
- 合并静态物体（Static Batching）
- 使用 SRP Batcher / GPU Instancing
- UI：同 Canvas 下避免频繁改动（触发重建）

### 物理
- RigidBody 不在 Update 移动（用 FixedUpdate）
- Trigger 检测多时，分 Layer + LayerMask
- 大场景用 **空间划分**（自带 Physics 已做，但触发器别乱用）

## 场景 / 资源管理

- Scene 合理拆分：**永久场景**（管理器）+ **关卡场景**
- 运行时生成的物体挂到固定 "Dynamic Root" 下，方便清理
- 使用 Addressables 替代 Resources（1.x 项目可保留 Resources，新项目必须 Addressables）

## 反模式

- ❌ 所有脚本挂 Singleton（耦合爆炸）
- ❌ 不在 OnDisable 取消订阅（内存泄漏 + 僵尸回调）
- ❌ Update 里 GetComponent
- ❌ Prefab 改动未 Apply，到运行时发现场景实例改坏
- ❌ 在编辑器 Inspector 里把一堆脚本放到同个 GO，而不用组合
