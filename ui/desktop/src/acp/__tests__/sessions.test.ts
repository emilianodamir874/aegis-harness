import { methods, type SessionInfo } from '@agentclientprotocol/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAcpClient } from '../acpConnection';
import { handleAcpWatchedNotification, beginAcpWatchLoad, endAcpWatchLoad } from '../sessions';
import {
  acpGetSessionListItem,
  acpListSessions,
  acpLoadSession,
  acpNewSession,
  acpWatchSession,
  acpUnwatchSession,
  markAcpWatchLoadBoundary,
  sessionInfoToSession,
} from '../sessions';

vi.mock('../acpConnection', () => ({
  getAcpClient: vi.fn(),
  isCurrentAcpClient: vi.fn().mockReturnValue(true),
}));

function sessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: 'session-1',
    cwd: '/tmp',
    title: 'Scheduled session',
    updatedAt: '2026-01-01T00:00:00Z',
    _meta: {
      createdAt: '2026-01-01T00:00:00Z',
      messageCount: 0,
      sessionType: 'scheduled',
    },
    ...overrides,
  } as unknown as SessionInfo;
}

function newSessionClient() {
  const client = {
    connection: {
      agent: {
        request: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      },
    },
    aegis: {
      sessionInfo_unstable: vi.fn().mockResolvedValue({ session: sessionInfo() }),
    },
  };
  vi.mocked(getAcpClient).mockResolvedValue(
    client as unknown as Awaited<ReturnType<typeof getAcpClient>>
  );
  return client;
}

describe('ACP watch continuity', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers once per connection and applies replay in order with run status', async () => {
    const request = vi.fn().mockResolvedValue({
      cursor: 2,
      epoch: 'epoch-test',
      activeRunId: 'run-1',
      replay: [
        {
          method: 'session/update',
          params: {
            sessionId: 'watch-test',
            _meta: { aegis: { cursor: 1 } },
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Hello' },
            },
          },
        },
        {
          method: 'session/update',
          params: {
            sessionId: 'watch-test',
            _meta: { aegis: { cursor: 2 } },
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: ' world' },
            },
          },
        },
      ],
    });
    const client = { connection: { agent: { request } } };
    vi.mocked(getAcpClient).mockResolvedValue(client as never);
    const { acpChatSessionStore, acpChatSessionActions } = await import('../chatSessionStore');
    await acpWatchSession('watch-test');
    await acpWatchSession('watch-test');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('_aegis/unstable/session/watch', {
      sessionId: 'watch-test',
      since: null,
      epoch: null,
    });
    expect(acpChatSessionStore.getSnapshot('watch-test')).toMatchObject({
      activeRunId: 'run-1',
      messages: [{ content: [{ text: 'Hello world' }] }],
    });
    await acpUnwatchSession('watch-test');
    expect(request).toHaveBeenLastCalledWith('_aegis/unstable/session/unwatch', {
      sessionId: 'watch-test',
    });
    acpChatSessionActions.deleteSnapshot('watch-test');
  });

  it('holds live events during watch, merges replay once, and applies after the snapshot cutoff', async () => {
    let resolveWatch!: (value: unknown) => void;
    const request = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveWatch = resolve;
          })
      )
      .mockResolvedValue({});
    const client = { connection: { agent: { request } } };
    vi.mocked(getAcpClient).mockResolvedValue(client as never);
    const id = 'race-watch';
    const event = (cursor: number, text: string) => ({
      sessionId: id,
      _meta: { aegis: { cursor } },
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    });
    const watch = acpWatchSession(id);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    handleAcpWatchedNotification(client as never, 'session/update', event(3, 'C'));
    handleAcpWatchedNotification(client as never, 'session/update', event(2, 'B'));
    resolveWatch({
      cursor: 2,
      epoch: 'epoch-test',
      activeRunId: null,
      replay: [
        { method: 'session/update', params: event(1, 'A') },
        { method: 'session/update', params: event(2, 'B') },
      ],
    });
    await watch;
    const { acpChatSessionStore, acpChatSessionActions } = await import('../chatSessionStore');
    expect(acpChatSessionStore.getSnapshot(id)?.messages).toMatchObject([
      { content: [{ text: 'ABC' }] },
    ]);
    await acpUnwatchSession(id);
    acpChatSessionActions.deleteSnapshot(id);
  });

  it('reconnects from the last applied cursor without replaying old chunks', async () => {
    const id = 'reconnect-cursor';
    const event = (cursor: number, text: string) => ({
      sessionId: id,
      _meta: { aegis: { cursor } },
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    });
    const oldClient = {
      connection: {
        agent: {
          request: vi.fn().mockResolvedValue({
            cursor: 1,
            epoch: 'epoch-one',
            activeRunId: 'run-1',
            replay: [{ method: 'session/update', params: event(1, 'A') }],
          }),
        },
      },
    };
    vi.mocked(getAcpClient).mockResolvedValue(oldClient as never);
    await acpWatchSession(id);
    const freshRequest = vi.fn().mockResolvedValue({
      cursor: 2,
      epoch: 'epoch-one',
      activeRunId: 'run-1',
      replay: [{ method: 'session/update', params: event(2, 'B') }],
    });
    const freshClient = { connection: { agent: { request: freshRequest } } };
    vi.mocked(getAcpClient).mockResolvedValue(freshClient as never);
    await acpWatchSession(id);
    expect(freshRequest).toHaveBeenCalledWith('_aegis/unstable/session/watch', {
      sessionId: id,
      since: 1,
      epoch: 'epoch-one',
    });
    handleAcpWatchedNotification(oldClient as never, 'session/update', event(3, 'stale'));
    const { acpChatSessionStore, acpChatSessionActions } = await import('../chatSessionStore');
    expect(acpChatSessionStore.getSnapshot(id)?.messages).toMatchObject([
      { content: [{ text: 'AB' }] },
    ]);
    await acpUnwatchSession(id);
    acpChatSessionActions.deleteSnapshot(id);
  });
  it('detects a new ring epoch even when the numeric cursor repeats', async () => {
    const id = 'epoch-reset';
    const event = (text: string) => ({
      sessionId: id,
      _meta: { aegis: { cursor: 1 } },
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    });
    const oldClient = {
      connection: {
        agent: {
          request: vi.fn().mockResolvedValue({
            cursor: 1,
            epoch: 'old-epoch',
            activeRunId: null,
            replay: [{ method: 'session/update', params: event('original') }],
          }),
        },
      },
    };
    vi.mocked(getAcpClient).mockResolvedValue(oldClient as never);
    await acpWatchSession(id);
    const freshRequest = vi.fn().mockResolvedValue({
      cursor: 1,
      epoch: 'new-epoch',
      activeRunId: null,
      replay: [{ method: '_aegis/unstable/session/replay_gap', params: { sessionId: id } }],
    });
    vi.mocked(getAcpClient).mockResolvedValue({
      connection: { agent: { request: freshRequest } },
    } as never);
    await expect(acpWatchSession(id)).rejects.toThrow('replay gap');
    expect(freshRequest).toHaveBeenCalledWith('_aegis/unstable/session/watch', {
      sessionId: id,
      since: 1,
      epoch: 'old-epoch',
    });
    const { acpChatSessionStore, acpChatSessionActions } = await import('../chatSessionStore');
    expect(acpChatSessionStore.getSnapshot(id)?.messages).toMatchObject([
      { content: [{ text: 'original' }] },
    ]);
    await acpUnwatchSession(id);
    acpChatSessionActions.deleteSnapshot(id);
  });
  it('ignores a late watch response from a replaced connection', async () => {
    const id = 'stale-watch';
    let resolveOld!: (value: unknown) => void;
    const oldRequest = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        })
    );
    const oldClient = { connection: { agent: { request: oldRequest } } };
    vi.mocked(getAcpClient).mockResolvedValue(oldClient as never);
    const oldWatch = acpWatchSession(id);
    await vi.waitFor(() => expect(oldRequest).toHaveBeenCalledTimes(1));
    const freshClient = {
      connection: {
        agent: {
          request: vi.fn().mockResolvedValue({
            cursor: 0,
            epoch: 'epoch-test',
            activeRunId: null,
            replay: [],
          }),
        },
      },
    };
    vi.mocked(getAcpClient).mockResolvedValue(freshClient as never);
    await acpWatchSession(id);
    resolveOld({ cursor: 0, activeRunId: 'stale-run', replay: [] });
    await expect(oldWatch).rejects.toThrow('no longer current');
    const { acpChatSessionStore, acpChatSessionActions } = await import('../chatSessionStore');
    expect(acpChatSessionStore.getSnapshot(id)?.activeRunId).toBeNull();
    await acpUnwatchSession(id);
    acpChatSessionActions.deleteSnapshot(id);
  });
  it('loads against a backend without watch without blocking session/load', async () => {
    const id = 'legacy-load';
    const request = vi.fn().mockImplementation((method: string) => {
      if (method === '_aegis/unstable/session/watch') throw new Error('Method not found (-32601)');
      return Promise.resolve({});
    });
    const client = {
      connection: { agent: { request } },
      aegis: {
        sessionInfo_unstable: vi
          .fn()
          .mockResolvedValue({ session: sessionInfo({ sessionId: id }) }),
      },
    };
    vi.mocked(getAcpClient).mockResolvedValue(client as never);
    beginAcpWatchLoad(id);
    await acpLoadSession(id);
    await acpWatchSession(id, false);
    endAcpWatchLoad(id);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      '_aegis/unstable/session/watch',
      methods.agent.session.load,
    ]);
    await acpUnwatchSession(id).catch(() => {});
  });

  it('checks the post-load boundary independently of a pending watch', async () => {
    const id = 'overlap-watch';
    let resolveWatch!: (value: unknown) => void;
    const request = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveWatch = resolve;
          })
      )
      .mockResolvedValue({ cursor: 2, epoch: 'epoch-1', activeRunId: null, replay: [] });
    const client = { connection: { agent: { request } } };
    vi.mocked(getAcpClient).mockResolvedValue(client as never);
    beginAcpWatchLoad(id);
    markAcpWatchLoadBoundary(id, client as never, 1, 'epoch-1');
    const pending = acpWatchSession(id);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const postLoad = acpWatchSession(id, false);
    resolveWatch({ cursor: 1, epoch: 'epoch-1', activeRunId: null, replay: [] });
    await pending;
    await expect(postLoad).rejects.toThrow('replay gap');
    expect(request).toHaveBeenCalledTimes(2);
    endAcpWatchLoad(id);
    await acpUnwatchSession(id);
  });
  it('shares an in-flight post-load watch without issuing another snapshot', async () => {
    const id = 'post-load-pending';
    let resolveWatch!: (value: unknown) => void;
    const request = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveWatch = resolve;
        })
    );
    const client = { connection: { agent: { request } } };
    vi.mocked(getAcpClient).mockResolvedValue(client as never);
    beginAcpWatchLoad(id);
    markAcpWatchLoadBoundary(id, client as never, 1, 'epoch-1');
    const first = acpWatchSession(id, false);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const second = acpWatchSession(id);
    resolveWatch({ cursor: 1, epoch: 'epoch-1', activeRunId: null, replay: [] });
    await Promise.all([first, second]);
    expect(request).toHaveBeenCalledTimes(1);
    endAcpWatchLoad(id);
    request.mockResolvedValue({});
    await acpUnwatchSession(id);
  });
  it('rejects a post-load epoch change even at the same cursor', async () => {
    const id = 'load-epoch-change';
    const client = {
      connection: {
        agent: {
          request: vi
            .fn()
            .mockResolvedValue({ cursor: 2, epoch: 'new-epoch', activeRunId: null, replay: [] }),
        },
      },
    };
    vi.mocked(getAcpClient).mockResolvedValue(client as never);
    beginAcpWatchLoad(id);
    markAcpWatchLoadBoundary(id, client as never, 2, 'old-epoch');
    await expect(acpWatchSession(id, false)).rejects.toThrow('replay gap');
    endAcpWatchLoad(id);
    await acpUnwatchSession(id);
  });
  it('accepts a loaded history only when no hub event occurred during load', async () => {
    const id = 'load-idle';
    const client = {
      connection: {
        agent: {
          request: vi.fn().mockResolvedValue({
            cursor: 2,
            epoch: 'epoch-test',
            activeRunId: null,
            replay: [],
          }),
        },
      },
    };
    vi.mocked(getAcpClient).mockResolvedValue(client as never);
    beginAcpWatchLoad(id);
    markAcpWatchLoadBoundary(id, client as never, 2, 'epoch-test');
    await acpWatchSession(id, false);
    endAcpWatchLoad(id);
    await acpUnwatchSession(id);
  });

  it('rejects an ambiguous load/watch interval rather than duplicating a chunk', async () => {
    const id = 'load-race';
    const client = {
      connection: {
        agent: {
          request: vi.fn().mockResolvedValue({
            cursor: 3,
            epoch: 'epoch-test',
            activeRunId: null,
            replay: [],
          }),
        },
      },
    };
    vi.mocked(getAcpClient).mockResolvedValue(client as never);
    const { acpChatSessionStore, acpChatSessionActions } = await import('../chatSessionStore');
    beginAcpWatchLoad(id);
    markAcpWatchLoadBoundary(id, client as never, 2, 'epoch-test');
    acpChatSessionActions.startSessionLoad(id);
    handleAcpWatchedNotification(client as never, 'session/update', {
      sessionId: id,
      _meta: { aegis: { cursor: 3 } },
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'ambiguous' },
      },
    });
    await expect(acpWatchSession(id, false)).rejects.toThrow('replay gap');
    acpChatSessionActions.finishSessionLoad(
      id,
      sessionInfoToSession(sessionInfo({ sessionId: id }))
    );
    endAcpWatchLoad(id);
    expect(acpChatSessionStore.getSnapshot(id)?.messages).toEqual([]);
    await acpUnwatchSession(id);
    acpChatSessionActions.deleteSnapshot(id);
  });
  it('clears stale active-run state when the watch snapshot has no active run', async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ cursor: 3, epoch: 'epoch-test', activeRunId: null, replay: [] });
    vi.mocked(getAcpClient).mockResolvedValue({ connection: { agent: { request } } } as never);
    const { acpChatSessionStore, acpChatSessionActions } = await import('../chatSessionStore');
    acpChatSessionActions.setActiveWatchedRun('ended-test', 'run-before-disconnect');
    await acpWatchSession('ended-test');
    expect(acpChatSessionStore.getSnapshot('ended-test')?.activeRunId).toBeNull();
    await acpUnwatchSession('ended-test');
    acpChatSessionActions.deleteSnapshot('ended-test');
  });

  it('blocks a replay gap until the session is reloaded', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      cursor: 2,
      epoch: 'epoch-test',
      activeRunId: null,
      replay: [{ method: '_aegis/unstable/session/replay_gap', params: { sessionId: 'gap-test' } }],
    });
    vi.mocked(getAcpClient).mockResolvedValue({ connection: { agent: { request } } } as never);
    await expect(acpWatchSession('gap-test')).rejects.toThrow('replay gap');
    await expect(acpWatchSession('gap-test')).rejects.toThrow('replay gap');
    expect(request).toHaveBeenCalledTimes(1);
    await acpUnwatchSession('gap-test');
  });
});

describe('ACP sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves session type from ACP session info metadata', () => {
    const session = sessionInfoToSession(sessionInfo());

    expect(session.session_type).toBe('scheduled');
  });

  it('does not synthesize a title when ACP omits one', () => {
    const session = sessionInfoToSession(sessionInfo({ title: undefined }));

    expect(session.name).toBe('');
  });

  it('only requests acp session types when explicitly included', async () => {
    const client = {
      connection: {
        agent: {
          request: vi.fn().mockResolvedValue({ sessions: [] }),
        },
      },
    };
    vi.mocked(getAcpClient).mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getAcpClient>>
    );

    await acpListSessions();
    expect(client.connection.agent.request).toHaveBeenLastCalledWith(methods.agent.session.list, {
      _meta: { types: ['user', 'scheduled'] },
    });

    await acpListSessions(undefined, { includeAcp: true });
    expect(client.connection.agent.request).toHaveBeenLastCalledWith(methods.agent.session.list, {
      _meta: { types: ['user', 'scheduled', 'acp'] },
    });
  });

  it('returns session info refreshed after loading the ACP session', async () => {
    const loadedSessionInfo = sessionInfo({
      _meta: {
        createdAt: '2026-01-01T00:00:00Z',
        messageCount: 0,
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-5',
      },
    });
    const client = {
      connection: {
        agent: {
          request: vi.fn().mockResolvedValue({}),
        },
      },
      aegis: {
        sessionInfo_unstable: vi
          .fn()
          .mockResolvedValueOnce({ session: sessionInfo() })
          .mockResolvedValueOnce({ session: loadedSessionInfo }),
      },
    };
    vi.mocked(getAcpClient).mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getAcpClient>>
    );

    const result = await acpLoadSession('session-1');

    expect(client.connection.agent.request).toHaveBeenCalledWith(methods.agent.session.load, {
      sessionId: 'session-1',
      cwd: '/tmp',
      mcpServers: [],
    });
    expect(client.aegis.sessionInfo_unstable).toHaveBeenCalledTimes(2);
    expect(result.sessionInfo).toBe(loadedSessionInfo);
    expect(sessionInfoToSession(result.sessionInfo).provider_name).toBe('anthropic');
    expect(sessionInfoToSession(result.sessionInfo).model_config?.model_name).toBe(
      'claude-sonnet-4-5'
    );
  });

  it('sends an explicitly empty extension set as an empty list', async () => {
    const client = newSessionClient();

    await acpNewSession('/tmp', []);

    expect(client.connection.agent.request).toHaveBeenCalledWith(methods.agent.session.new, {
      cwd: '/tmp',
      mcpServers: [],
      _meta: {
        client: 'aegis-desktop',
        enabledExtensions: [],
      },
    });
  });

  it('omits the extension key when the caller names no set', async () => {
    const client = newSessionClient();

    await acpNewSession('/tmp', undefined);

    expect(client.connection.agent.request).toHaveBeenCalledWith(methods.agent.session.new, {
      cwd: '/tmp',
      mcpServers: [],
      _meta: { client: 'aegis-desktop' },
    });
  });

  it('carries the recipe parameter scope id in new-session metadata', async () => {
    const createdSessionInfo = sessionInfo();
    const client = {
      connection: {
        agent: {
          request: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
        },
      },
      aegis: {
        sessionInfo_unstable: vi.fn().mockResolvedValue({ session: createdSessionInfo }),
      },
    };
    vi.mocked(getAcpClient).mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getAcpClient>>
    );

    await acpNewSession('/tmp', undefined, {
      recipeDeeplink: 'aegis://recipe?url=example',
      recipeParameterScopeId: 'scope-1',
    });

    expect(client.connection.agent.request).toHaveBeenCalledWith(methods.agent.session.new, {
      cwd: '/tmp',
      mcpServers: [],
      _meta: {
        client: 'aegis-desktop',
        recipeDeeplink: 'aegis://recipe?url=example',
        recipeParameterScopeId: 'scope-1',
      },
    });
  });

  it('returns a list item from ACP session info', async () => {
    const client = {
      aegis: {
        sessionInfo_unstable: vi.fn().mockResolvedValue({
          session: sessionInfo({
            title: 'Subagent session',
            _meta: {
              createdAt: '2026-01-01T00:00:00Z',
              lastMessageAt: '2026-01-01T00:01:00Z',
              messageCount: 3,
              sessionType: 'sub_agent',
              providerId: 'anthropic',
              modelId: 'claude-sonnet-4-5',
            },
          }),
        }),
      },
    };
    vi.mocked(getAcpClient).mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getAcpClient>>
    );

    const item = await acpGetSessionListItem('session-1');

    expect(client.aegis.sessionInfo_unstable).toHaveBeenCalledWith({ sessionId: 'session-1' });
    expect(item).toMatchObject({
      id: 'session-1',
      name: 'Subagent session',
      workingDir: '/tmp',
      messageCount: 3,
      lastMessageAt: '2026-01-01T00:01:00Z',
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
    });
  });
});
