{% if scripts and scripts|length > 0 %}
## Available Scripts (run_employee_script)

You can call the following ready-made Python scripts directly via the
`run_employee_script` tool, instead of writing one-off code via `execute_code`:

{% for s in scripts %}- **`{{ s.name }}`** ({{ s.source or 'employee' }}){% if s.description %} — {{ s.description }}{% endif %}
{% endfor %}
Example:
```
run_employee_script(
  scope="{{ scripts[0].source or 'employee' }}",
  script_name="{{ scripts[0].name }}",
  args={...},              # JSON, delivered via stdin
  timeout=60
)
```

⚠️ Guidelines:
- Prefer existing scripts over ad-hoc code
- Scripts read args from stdin: `json.loads(sys.stdin.read())`
- Result shape: `{success, exit_code, stdout, stderr, duration_ms}`
- Only use `execute_code` for truly one-off logic
{% endif %}
