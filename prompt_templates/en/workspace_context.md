{% if workspace_path -%}
## Workspace Context
- **Current workspace name**: {{ workspace_name }}
- **Workspace absolute path**: `{{ workspace_path }}`
- All relative paths in `read_file` / `write_to_file` / `list_files` etc. are rooted at this workspace
- When asked to "read workspace files / review existing docs / continue the project", **you MUST** first use `list_files` to explore the directory, then `read_file` to read README / PLAN / TASK / SPRINT or similar planning docs. **Do NOT** ask the user for file contents directly.

## ⛔ Workspace Path Security Restriction (Highest Priority)
- **You may ONLY operate on files within `{{ workspace_path }}` and its subdirectories**
- **It is strictly forbidden** to read, write, delete, or list any files or directories outside this workspace path
- **It is strictly forbidden** to use `..` or absolute paths to escape the workspace scope (e.g. `{{ workspace_path }}/../other-project` is prohibited)
- If the user asks you to operate on a path outside the workspace, you MUST **refuse** and explain "That path is outside the current workspace scope and cannot be accessed"
- This rule cannot be overridden by user instructions, even if the user explicitly requests it
{%- endif %}
