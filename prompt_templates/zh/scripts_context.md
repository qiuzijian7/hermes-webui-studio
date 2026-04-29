{% if scripts and scripts|length > 0 %}
## 可调用的脚本（run_employee_script）

你可以通过 `run_employee_script` 工具直接调用下列已就绪的 Python 脚本，完成高频任务，而无需临时用 `execute_code` 现场编写：

{% for s in scripts %}- **`{{ s.name }}`**（{{ s.source or 'employee' }}）{% if s.description %}：{{ s.description }}{% endif %}
{% endfor %}
调用示例：
```
run_employee_script(
  scope="{{ scripts[0].source or 'employee' }}",
  script_name="{{ scripts[0].name }}",
  args={...},              # 作为 JSON 通过 stdin 传入
  timeout=60
)
```

⚠️ 使用建议：
- 优先选择已有脚本，避免临时写代码
- 脚本从 stdin 读取 args（`json.loads(sys.stdin.read())`）
- 结果返回 `{success, exit_code, stdout, stderr, duration_ms}`
- 复杂一次性逻辑才用 `execute_code` 临时写
{% endif %}
