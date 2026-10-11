{#
  This template renders structured compaction output for the resumed agent.
  Keep continuation-critical state first. A user override belongs in Goose's
  configured prompts directory. key_code uses code_fence so embedded fences
  cannot close the block early.
#}
# Conversation Summary
{% if user_intent %}
## Current User Intent and Constraints
{% for item in user_intent %}
- {{ item }}
{% endfor %}

{% endif %}
{% if current_work %}
## Current Work and Verification
{{ current_work }}

{% endif %}
{% if pending_tasks %}
## Pending Tasks
{% for item in pending_tasks %}
- {{ item }}
{% endfor %}

{% endif %}
{% if next_step %}
## Next Step
{{ next_step }}

{% endif %}
{% if problem_solving %}
## Decisions and Verified Outcomes
{% for item in problem_solving %}
- {{ item }}
{% endfor %}

{% endif %}
{% if errors_and_fixes %}
## Errors and Fixes
{% for item in errors_and_fixes %}
- {{ item }}
{% endfor %}

{% endif %}
{% if files %}
## Relevant Files and Code
{% for file in files %}
{% if file.path %}
### {{ file.path }}
{% endif %}
{{ file.summary }}
{% if file.key_code %}
{{ file.key_code | code_fence }}
{% endif %}

{% endfor %}
{% endif %}
{% if technical_concepts %}
## Technical Context
{% for item in technical_concepts %}
- {{ item }}
{% endfor %}

{% endif %}
{% if user_messages %}
## Relevant User Corrections
{% for item in user_messages %}
- {{ item }}
{% endfor %}
{% endif %}
