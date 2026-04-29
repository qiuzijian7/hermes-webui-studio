{% if params and params|length > 0 -%}
## 配置参数
以下参数由用户配置，你应据此调整行为：
{% for key, value in params.items() %}
- **{{ key }}**：{{ value }}
{%- endfor %}
{%- endif %}
