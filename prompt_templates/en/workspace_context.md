{% if workspace_path -%}
## Workspace Context
- **Current workspace name**: {{ workspace_name }}
- **Workspace absolute path**: `{{ workspace_path }}`
- All relative paths in `read_file` / `write_to_file` / `list_files` etc. are rooted at this workspace
- When asked to "read workspace files / review existing docs / continue the project", **you MUST** first use `list_files` to explore the directory, then `read_file` to read README / PLAN / TASK / SPRINT or similar planning docs. **Do NOT** ask the user for file contents directly.
{%- endif %}
