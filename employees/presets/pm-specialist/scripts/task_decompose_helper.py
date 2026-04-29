"""
任务分解小助手：把大目标拆成可执行子任务。

输入（stdin JSON）：
    {
        "goal": "实现用户认证系统",
        "context": "使用 FastAPI + PostgreSQL",  // 可选
        "max_tasks": 10                          // 可选，默认 8
    }

输出（stdout JSON）：
    {
        "ok": true,
        "goal": "...",
        "tasks": [
            {
                "id": 1,
                "title": "...",
                "deliverable": "...",
                "estimate_days": 1.0,
                "depends_on": [],
                "parallelizable": true
            },
            ...
        ]
    }

注意：这是一个规则化的脚手架输出（启发式拆分），非 LLM 调用。
      真正的智能拆解由调用方 agent 自行完成；该脚本仅作模板示例。
"""
import json
import re
import sys


KEYWORDS = {
    "登录": ["数据模型", "后端接口", "前端 UI", "Session", "测试"],
    "支付": ["对接网关", "订单模型", "回调处理", "幂等", "测试"],
    "注册": ["表单校验", "邮箱验证", "存储", "欢迎流程"],
    "API": ["OpenAPI 定义", "Handler 实现", "参数校验", "错误响应", "测试"],
    "auth": ["data model", "backend API", "frontend UI", "session", "tests"],
}


def decompose_heuristic(goal: str, max_tasks: int = 8) -> list[dict]:
    """基于关键词的启发式拆解；无匹配时给通用模板。"""
    tasks: list[dict] = []
    lowered = goal.lower()

    matched = []
    for kw, subs in KEYWORDS.items():
        if kw.lower() in lowered:
            matched = subs
            break

    if not matched:
        matched = ["设计文档", "原型验证", "核心实现", "测试", "文档"]

    for i, sub in enumerate(matched[:max_tasks], start=1):
        tasks.append({
            "id": i,
            "title": f"{sub}",
            "deliverable": f"<提交物：{sub} 对应的文件/功能>",
            "estimate_days": 1.0 if i <= 3 else 0.5,
            "depends_on": [i - 1] if i > 1 else [],
            "parallelizable": i > 2,
        })
    return tasks


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError as exc:
        print(json.dumps({"ok": False, "error": f"invalid JSON: {exc}"}))
        return 2

    goal = (payload.get("goal") or "").strip()
    if not goal:
        print(json.dumps({"ok": False, "error": "goal is required"}))
        return 2

    max_tasks = int(payload.get("max_tasks", 8))
    tasks = decompose_heuristic(goal, max_tasks=max_tasks)

    print(json.dumps({
        "ok": True,
        "goal": goal,
        "context": payload.get("context", ""),
        "tasks": tasks,
        "note": "This is a heuristic template. The agent should refine each task with domain knowledge.",
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
