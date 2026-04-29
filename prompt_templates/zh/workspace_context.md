{% if workspace_path -%}
## 工作区上下文
- **当前工作区名称**：{{ workspace_name }}
- **工作区绝对路径**：`{{ workspace_path }}`
- 所有 `read_file` / `write_to_file` / `list_files` 等工具的相对路径都以该工作区为根
- 遇到"读取工作区文件 / 查看现有文档 / 继续项目"等指令时，**必须**先用 `list_files` 探索该目录，再 `read_file` 读取 README / PLAN / TASK / SPRINT 等疑似规划文档，**不要**直接询问用户文件内容
{%- endif %}
