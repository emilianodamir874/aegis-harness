import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SkillsPanel } from '../src/ui/SkillsPanel';
import type { AegisStore } from '../src/domain/store';

const skills = [
  { type: 'skill', name: 'aegis-infra-map', description: 'dónde corre el harness', content: '# mapa', path: 'C:/s/aegis-infra-map', global: true, writable: true },
  { type: 'skill', name: 'web-search', description: 'buscar en la web', content: '# search', path: 'C:/s/web-search', global: true, writable: true },
];

const storeCon = (overrides: Partial<Record<string, (params: unknown) => unknown>> = {}) => {
  const llamadas: Array<{ method: string; params: unknown }> = [];
  const store = {
    request: async (method: string, params: unknown) => {
      llamadas.push({ method, params });
      if (overrides[method]) return overrides[method](params);
      if (method === '_aegis/unstable/sources/list') return { sources: skills };
      if (method === '_aegis/unstable/sources/create') return { source: skills[0] };
      if (method === '_aegis/unstable/sources/update') return { source: skills[0] };
      if (method === '_aegis/unstable/sources/delete') return {};
      throw new Error(`método inesperado ${method}`);
    },
  } as unknown as AegisStore;
  return { store, llamadas };
};

const busca = (method: string, llamadas: Array<{ method: string; params: unknown }>) =>
  llamadas.find((llamada) => llamada.method === method)?.params;

afterEach(() => vi.unstubAllGlobals());

describe('panel de skills', () => {
  it('lista y filtra por nombre o descripción', async () => {
    const { store } = storeCon();
    render(<SkillsPanel store={store} />);
    expect(await screen.findByText('aegis-infra-map')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Filtrar skills'), { target: { value: 'web' } });
    await waitFor(() => expect(screen.queryByText('aegis-infra-map')).toBeNull());
    expect(screen.getByText('web-search')).toBeTruthy();
  });

  it('crea con el payload que el motor acepta', async () => {
    const { store, llamadas } = storeCon();
    render(<SkillsPanel store={store} />);
    await screen.findByText('aegis-infra-map');
    fireEvent.click(screen.getByRole('button', { name: 'Nueva' }));
    fireEvent.change(screen.getByLabelText('Nombre de la skill'), { target: { value: 'zz-prueba' } });
    fireEvent.change(screen.getByLabelText('Descripción de la skill'), { target: { value: 'probar el CRUD (usar cuando se pruebe)' } });
    fireEvent.change(screen.getByLabelText('Contenido de la skill'), { target: { value: '---\nname: zz-prueba\n---\n\ncuerpo\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Crear skill' }));
    await waitFor(() => expect(busca('_aegis/unstable/sources/create', llamadas)).toBeTruthy());
    expect(busca('_aegis/unstable/sources/create', llamadas)).toMatchObject({
      type: 'skill',
      name: 'zz-prueba',
      description: 'probar el CRUD (usar cuando se pruebe)',
      target: { scope: 'global' },
    });
  });

  it('no manda nada si falta la descripción', async () => {
    const { store, llamadas } = storeCon();
    render(<SkillsPanel store={store} />);
    await screen.findByText('aegis-infra-map');
    fireEvent.click(screen.getByRole('button', { name: 'Nueva' }));
    fireEvent.change(screen.getByLabelText('Nombre de la skill'), { target: { value: 'sin-descripcion' } });
    fireEvent.click(screen.getByRole('button', { name: 'Crear skill' }));
    expect(await screen.findByText(/Nombre, descripción y contenido son obligatorios/)).toBeTruthy();
    expect(busca('_aegis/unstable/sources/create', llamadas)).toBeUndefined();
  });

  it('edita una existente mandando el path', async () => {
    const { store, llamadas } = storeCon();
    render(<SkillsPanel store={store} />);
    fireEvent.click(await screen.findByText('aegis-infra-map'));
    await waitFor(() => expect((screen.getByLabelText('Nombre de la skill') as HTMLInputElement).value).toBe('aegis-infra-map'));
    fireEvent.change(screen.getByLabelText('Descripción de la skill'), { target: { value: 'descripción nueva' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(busca('_aegis/unstable/sources/update', llamadas)).toBeTruthy());
    expect(busca('_aegis/unstable/sources/update', llamadas)).toMatchObject({
      type: 'skill',
      path: 'C:/s/aegis-infra-map',
      description: 'descripción nueva',
    });
  });

  it('borra pidiendo confirmación', async () => {
    vi.stubGlobal('confirm', () => true);
    const { store, llamadas } = storeCon();
    render(<SkillsPanel store={store} />);
    fireEvent.click(await screen.findByText('aegis-infra-map'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Borrar' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Borrar' }));
    await waitFor(() => expect(busca('_aegis/unstable/sources/delete', llamadas)).toBeTruthy());
    expect(busca('_aegis/unstable/sources/delete', llamadas)).toEqual({ type: 'skill', path: 'C:/s/aegis-infra-map' });
  });

  it('un método caído se informa', async () => {
    const { store } = storeCon({
      '_aegis/unstable/sources/list': () => {
        throw new Error('boom');
      },
    });
    render(<SkillsPanel store={store} />);
    expect(await screen.findByText(/No se pudo leer las skills: boom/)).toBeTruthy();
  });
});
