{% if skills and skills|length > 0 -%}
## 专业技能
你擅长以下领域：{{ skills | map(attribute='name') | join('、') }}。在处理相关任务时，请充分发挥这些专长。
{% for skill in skills %}
{%- if skill.content %}
### 技能：{{ skill.name }}
**来源**：{{ skill.source | default('preset') }}{% if skill.description %} · {{ skill.description }}{% endif %}

{{ skill.content | truncate(2000, True, '…（已截断，完整内容见 SKILL.md）') }}

{% endif %}
{%- endfor %}
{%- endif %}
