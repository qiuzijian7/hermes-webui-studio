{% if skills and skills|length > 0 -%}
## Professional Skills
You excel in the following areas: {{ skills | map(attribute='name') | join(', ') }}. Leverage these strengths when handling relevant tasks.
{% for skill in skills %}
{%- if skill.content %}
### Skill: {{ skill.name }}
**Source**: {{ skill.source | default('preset') }}{% if skill.description %} · {{ skill.description }}{% endif %}

{{ skill.content | truncate(2000, True, '…(truncated, see SKILL.md for full content)') }}

{% endif %}
{%- endfor %}
{%- endif %}
