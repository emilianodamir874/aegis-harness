  // Modelo y esfuerzo efectivos. OJO: cuando el id termina en -none/-low/-high/-max el
  // esfuerzo lo fija el ALIAS (open_design::selected_effort gana sobre el chip), asi que
  // mostrar solo el chip miente.
  function modelParts() {
    const opts = (state.current && state.current.configOptions) || [];
    const val = (id) => {
      const o = opts.find((x) => x && x.id === id);
      if (!o || !Array.isArray(o.options)) return null;
      const cur = o.options.find((c) => c.value === o.currentValue) || o.options[0];
      return (cur && (cur.name || cur.value)) || null;
    };
    let model = val('model');
    let effort = val('thinking_effort');
    let fromAlias = false;
    const mm = /-(none|low|medium|high|max)$/.exec(String(model || ''));
    if (mm) { effort = mm[1] === 'none' ? 'off' : mm[1]; fromAlias = true; }
    if (!model && !effort && !fromAlias) return null;
    return { model: model || val('provider'), effort, fromAlias };
  }
  function modelSummary() {
    const p = modelParts();
    if (!p) return null;
    return (p.model || 'modelo ?') + (p.effort ? '  ·  esfuerzo: ' + p.effort : '');
  }