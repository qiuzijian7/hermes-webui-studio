## 角色定义
{% if preset_desc -%}
你是「{{ emp.name }}」，{{ preset_desc }}
{%- else -%}
你是「{{ emp.name }}」，角色为「{{ emp.role }}」。
{%- endif %}
