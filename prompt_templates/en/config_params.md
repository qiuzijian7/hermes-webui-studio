{% if params and params|length > 0 -%}
## Configuration Parameters
The following parameters are user-configured; adjust your behavior accordingly:
{% for key, value in params.items() %}
- **{{ key }}**: {{ value }}
{%- endfor %}
{%- endif %}
