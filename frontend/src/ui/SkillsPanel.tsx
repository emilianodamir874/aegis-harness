import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AegisStore } from '../domain/store';

/**
 * Skills: listar, crear, editar y borrar.
 *
 * Contrato real medido contra el motor (2026-10-28, `tools/acp-skills-probe.mjs`):
 * - `sources/list`   → `{sources:[{type,name,description,content,path,global,writable,supportingFiles}]}`
 * - `sources/create` → `{type:'skill', name, description, content, target:{scope:'global'}}` → `{source}`
 * - `sources/update` → `{type, path, name, description, content}`
 * - `sources/delete` → `{type, path}`
 * `target.scope:'global'` escribe en `C:\Users\Emiliano\.agents\skills\` (no en el store), y sólo se
 * puede borrar lo que reporta `writable: true`.
 */
interface SkillSource {
  readonly type: string;
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly path: string;
  readonly global: boolean;
  readonly writable: boolean;
}

export function SkillsPanel({ store }: { store: AegisStore }) {
  const [skills, setSkills] = useState<SkillSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState('');
  const [filtro, setFiltro] = useState('');
  const [editando, setEditando] = useState<SkillSource | null>(null);
  const [nombre, setNombre] = useState('');
  const [descripcion, setDescripcion] = useState('');
  const [contenido, setContenido] = useState('');
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(
    async (mensaje?: string) => {
      try {
        const out = await store.request<{ sources?: SkillSource[] }>('_aegis/unstable/sources/list', {});
        setSkills(out?.sources ?? []);
        setError(null);
        if (mensaje) setAviso(mensaje);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [store],
  );

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const visibles = useMemo(() => {
    const q = filtro.trim().toLowerCase();
    if (!skills) return [];
    if (!q) return skills;
    return skills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(q));
  }, [skills, filtro]);

  const empezarNueva = (): void => {
    setEditando(null);
    setNombre('');
    setDescripcion('');
    setContenido('');
    setAviso('Skill nueva: completá nombre, descripción y contenido.');
  };

  const abrir = (skill: SkillSource): void => {
    setEditando(skill);
    setNombre(skill.name);
    setDescripcion(skill.description);
    setContenido(skill.content);
    setAviso(skill.writable ? '' : 'Esta skill no es escribible desde acá.');
  };

  const guardar = async (): Promise<void> => {
    const limpio = nombre.trim();
    if (!limpio || !descripcion.trim() || !contenido.trim()) {
      setAviso('Nombre, descripción y contenido son obligatorios.');
      return;
    }
    setGuardando(true);
    try {
      if (editando) {
        await store.request('_aegis/unstable/sources/update', {
          type: 'skill',
          path: editando.path,
          name: limpio,
          description: descripcion.trim(),
          content: contenido,
        });
        await cargar(`Guardada ${limpio}.`);
      } else {
        await store.request('_aegis/unstable/sources/create', {
          type: 'skill',
          name: limpio,
          description: descripcion.trim(),
          content: contenido,
          target: { scope: 'global' },
        });
        await cargar(`Creada ${limpio}.`);
      }
      setEditando(null);
    } catch (caught) {
      setAviso(`No se pudo guardar: ${caught instanceof Error ? caught.message : String(caught)}`);
    } finally {
      setGuardando(false);
    }
  };

  const borrar = async (skill: SkillSource): Promise<void> => {
    if (!window.confirm(`¿Borrar la skill ${skill.name}?`)) return;
    try {
      await store.request('_aegis/unstable/sources/delete', { type: 'skill', path: skill.path });
      if (editando?.path === skill.path) setEditando(null);
      await cargar(`Borrada ${skill.name}.`);
    } catch (caught) {
      setAviso(`No se pudo borrar: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  };

  if (error) return <p className="muted">No se pudo leer las skills: {error}</p>;
  if (skills === null) return <p className="muted">Cargando skills…</p>;

  return (
    <div className="skills">
      <div className="skills-list">
        <div className="skills-tools">
          <input
            type="search"
            aria-label="Filtrar skills"
            placeholder="Filtrar…"
            value={filtro}
            onChange={(event) => setFiltro(event.target.value)}
          />
          <button type="button" onClick={empezarNueva}>
            Nueva
          </button>
        </div>
        <p className="muted">
          {visibles.length} de {skills.length}
        </p>
        <ul>
          {visibles.map((skill) => (
            <li key={skill.path}>
              <button
                type="button"
                className={editando?.path === skill.path ? 'active' : undefined}
                aria-pressed={editando?.path === skill.path}
                onClick={() => abrir(skill)}
              >
                <span className="skills-name">{skill.name}</span>
                <span className="skills-desc">{skill.description}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="skills-editor">
        <label className="kv-row">
          <span>nombre</span>
          <input value={nombre} onChange={(event) => setNombre(event.target.value)} aria-label="Nombre de la skill" />
        </label>
        <label className="kv-row">
          <span>descripción</span>
          <input
            value={descripcion}
            onChange={(event) => setDescripcion(event.target.value)}
            aria-label="Descripción de la skill"
          />
        </label>
        <textarea
          className="ho-area skills-body"
          aria-label="Contenido de la skill"
          value={contenido}
          onChange={(event) => setContenido(event.target.value)}
          placeholder="---&#10;name: mi-skill&#10;description: usar cuando…&#10;---&#10;&#10;cuerpo"
        />
        <div className="row-actions">
          <button type="button" className="primary" disabled={guardando} onClick={() => void guardar()}>
            {guardando ? 'Guardando…' : editando ? 'Guardar cambios' : 'Crear skill'}
          </button>
          {editando ? (
            <button type="button" className="danger" onClick={() => void borrar(editando)}>
              Borrar
            </button>
          ) : null}
          <span className="muted">{aviso}</span>
        </div>
      </div>
    </div>
  );
}
