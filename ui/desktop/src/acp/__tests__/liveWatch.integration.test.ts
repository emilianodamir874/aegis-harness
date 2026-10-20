import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { methods } from '@agentclientprotocol/sdk';
import { createWebSocketStream } from '@agentclientprotocol/sdk/experimental/ws-client';
import { connectAegisAcpClient } from '../aegisAcpClient';
import { MessageEvent as UndiciMessageEvent, WebSocket as UndiciWebSocket } from 'undici';
import { getAcpClient } from '../acpConnection';
import { acpChatSessionController } from '../chatSessionController';
import { acpChatSessionActions, acpChatSessionStore } from '../chatSessionStore';
import { acpDeleteSession, acpNewSession, acpUnwatchSession, acpWatchSession } from '../sessions';

const endpoint = process.env.ACP_WATCH_TEST_URL;
const live = endpoint ? describe : describe.skip;

live('desktop ACP load/watch on an isolated live server', () => {
  let sessionId: string;
  let client: Awaited<ReturnType<typeof getAcpClient>> | undefined;
  let other: ReturnType<typeof connectAegisAcpClient> | undefined;
  let originalEvent: typeof Event;
  let originalWebSocket: typeof globalThis.WebSocket;
  let originalGetAcpUrl: typeof window.electron.getAcpUrl;

  beforeAll(() => {
    originalEvent = globalThis.Event;
    originalWebSocket = globalThis.WebSocket;
    originalGetAcpUrl = window.electron.getAcpUrl;
    globalThis.Event = Object.getPrototypeOf(UndiciMessageEvent.prototype)
      .constructor as typeof Event;
    globalThis.WebSocket = UndiciWebSocket as typeof globalThis.WebSocket;
    window.electron.getAcpUrl = async () => endpoint!;
  });

  afterAll(async () => {
    if (sessionId) {
      await acpUnwatchSession(sessionId).catch(() => undefined);
      await acpDeleteSession(sessionId).catch(() => undefined);
      acpChatSessionActions.deleteSnapshot(sessionId);
    }
    other?.connection.close();
    client?.connection.close();
    window.electron.getAcpUrl = originalGetAcpUrl;
    globalThis.WebSocket = originalWebSocket;
    globalThis.Event = originalEvent;
  });

  it('retries an ambiguous load/watch handoff while a second ACP client runs a turn', async () => {
    client = await getAcpClient();
    const created = await acpNewSession('C:/Aegis-Proyects/src', []);
    sessionId = created.sessionId;
    await Promise.all([
      acpChatSessionController.restoreSession(sessionId),
      acpChatSessionController.restoreSession(sessionId),
    ]);
    const snapshot = acpChatSessionStore.getSnapshot(sessionId);
    expect(snapshot?.sessionLoadError).toBeUndefined();
    expect(snapshot?.session?.id).toBe(sessionId);
    const watch = await acpWatchSession(sessionId);
    expect(watch.epoch).toBeTruthy();
    expect(watch.cursor).toBeGreaterThanOrEqual(0);
    expect(watch.replay).toEqual([]);
    expect(snapshot?.messages).toEqual([]);

    other = connectAegisAcpClient(createWebSocketStream(endpoint!, { protocols: [] }), {
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      sessionUpdate: async () => undefined,
      createElicitation: async () => ({ action: 'decline' }),
      unstable_sessionRecipeRequestParams: async () => ({ action: 'cancel' }),
      unstable_sessionUpdate: async () => undefined,
      unstable_providerDeviceCode: async () => undefined,
    } as Parameters<typeof connectAegisAcpClient>[1]);
    await other.connection.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'desktop-watch-race', version: '1' },
    });
    await other.connection.agent.request(methods.agent.session.load, {
      sessionId,
      cwd: 'C:/Aegis-Proyects/src',
      mcpServers: [],
    });

    let releaseLoad!: () => void;
    let loadStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      loadStarted = resolve;
    });
    const originalRequest = client.connection.agent.request.bind(client.connection.agent);
    let heldLoads = 0;
    const spy = vi.spyOn(client.connection.agent, 'request').mockImplementation(((
      method: string,
      params: unknown
    ) => {
      const response = originalRequest(method as never, params as never);
      if (method !== methods.agent.session.load) return response;
      heldLoads += 1;
      if (heldLoads > 1) return response;
      loadStarted();
      return Promise.all([
        response,
        new Promise<void>((resolve) => {
          releaseLoad = resolve;
        }),
      ]).then(([result]) => result);
    }) as typeof client.connection.agent.request);
    try {
      const loading = acpChatSessionController.restoreSession(sessionId);
      await started;
      expect((await acpWatchSession(sessionId)).epoch).toBe(watch.epoch);
      const prompted = other!.connection.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: 'Respond with exactly ACP-ACTIVE-LOAD-CHECK.' }],
      });
      let advanced:
        { cursor: number; epoch: string; replay: Array<{ method: string }> } | undefined;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        advanced = (await other!.connection.agent.request(
          '_aegis/unstable/session/watch' as never,
          {
            sessionId,
            since: watch.cursor,
            epoch: watch.epoch,
          } as never
        )) as typeof advanced;
        if (advanced && advanced.cursor > watch.cursor) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!advanced) throw new Error('watch never returned a snapshot');
      expect(advanced.epoch).toBe(watch.epoch);
      expect(advanced.cursor).toBeGreaterThan(watch.cursor);
      expect(
        advanced.replay.some((event) => event.method === '_aegis/unstable/session/replay_gap')
      ).toBe(false);
      releaseLoad();
      await loading;
      expect(heldLoads).toBe(2);
      expect(acpChatSessionStore.getSnapshot(sessionId)?.sessionLoadError).toBeUndefined();
      await Promise.race([
        prompted,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('prompt completion timed out')), 40_000)
        ),
      ]);
    } finally {
      releaseLoad?.();
      spy.mockRestore();
    }
    await acpChatSessionController.loadSession(sessionId);
    expect(acpChatSessionStore.getSnapshot(sessionId)?.sessionLoadError).toBeUndefined();
  }, 60_000);
});
