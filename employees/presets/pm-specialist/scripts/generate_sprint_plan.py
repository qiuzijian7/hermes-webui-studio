"""
Sprint 计划生成器。

输入（stdin JSON）：
    {
        "sprint_name": "Sprint 1",
        "start_date": "2026-05-01",
        "duration_days": 14,
        "tasks": [
            {"title": "...", "assignee": "...", "priority": "P0", "estimate_days": 1.5},
            ...
        ]
    }

输出（stdout）：格式化的 Markdown 计划文档。
退出码：0 成功 / 非 0 失败。
"""
import json
import sys
from datetime import datetime, timedelta


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError as exc:
        print(f"ERROR: invalid JSON input: {exc}", file=sys.stderr)
        return 2

    name = payload.get("sprint_name", "Untitled Sprint")
    start_raw = payload.get("start_date", "")
    duration = int(payload.get("duration_days", 14))
    tasks = payload.get("tasks", []) or []

    try:
        start = datetime.fromisoformat(start_raw) if start_raw else datetime.now()
    except ValueError:
        start = datetime.now()
    end = start + timedelta(days=duration)

    total_est = sum(float(t.get("estimate_days", 0) or 0) for t in tasks)
    by_priority: dict[str, list] = {}
    for t in tasks:
        by_priority.setdefault(t.get("priority", "P?"), []).append(t)

    lines = [
        f"# {name}",
        "",
        f"- **周期**：{start.date()} → {end.date()}（{duration} 天）",
        f"- **任务数**：{len(tasks)}",
        f"- **估时总和**：{total_est:.1f} 人天",
        "",
        "## 任务清单（按优先级）",
        "",
    ]

    for prio in sorted(by_priority.keys()):
        lines.append(f"### {prio}")
        lines.append("")
        lines.append("| # | 标题 | 负责人 | 估时 |")
        lines.append("| - | --- | --- | --- |")
        for i, t in enumerate(by_priority[prio], start=1):
            lines.append(
                f"| {i} | {t.get('title', '?')} | @{t.get('assignee', '?')} | "
                f"{t.get('estimate_days', '?')} 天 |"
            )
        lines.append("")

    # 简单风险检查
    overloaded: dict[str, float] = {}
    for t in tasks:
        a = t.get("assignee", "?")
        overloaded[a] = overloaded.get(a, 0) + float(t.get("estimate_days", 0) or 0)
    overloaded = {k: v for k, v in overloaded.items() if v > duration * 0.8}
    if overloaded:
        lines.append("## ⚠️ 风险：负载过高的成员")
        lines.append("")
        for k, v in sorted(overloaded.items(), key=lambda kv: -kv[1]):
            lines.append(f"- @{k}: {v:.1f} 天（超过 sprint 80%）")
        lines.append("")

    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
