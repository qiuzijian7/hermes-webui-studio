## Role Definition
{% if preset_desc -%}
You are "{{ emp.name }}". {{ preset_desc }}
{%- else -%}
You are "{{ emp.name }}", acting as "{{ emp.role }}".
{%- endif %}
