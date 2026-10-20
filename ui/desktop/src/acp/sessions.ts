import {
  methods,
  type ForkSessionRequest,
  type ListSessionsRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type SessionInfo,
} from '@agentclientprotocol/sdk';
import type { AegisExtension, SessionExportFormat } from '@aaif/goose-acp-client';
import { getAcpClient } from './acpConnection';
import {
  handleAcpAegisSessionNotification,
  handleAcpSessionNotification,
} from './chatNotifications';
import { acpChatSessionActions, acpChatSessionStore } from './chatSessionStore';
import type { ExtensionLoadResult } from '../types/extensions';
import type { Session } from '../types/session';
import type { Recipe } from '../recipe';

interface AegisSessionInfoMeta {
  messageCount?: number;
  createdAt?: string;
  lastMessageAt?: string;
  archivedAt?: string;
  projectId?: string;
  providerId?: string;
  modelId?: string;
  sessionType?: Session['session_type'];
  userSetName?: boolean;
  hasRecipe?: boolean;
  lastMessageSnippet?: string;
}

export interface SessionListItem {
  id: string;
  name: string;
  workingDir: string;
  updatedAt: string;
  messageCount: number;
  lastMessageAt?: string;
  createdAt: string;
  archivedAt?: string;
  projectId?: string;
  providerId?: string;
  modelId?: string;
  userSetName?: boolean;
  hasRecipe?: boolean;
  sessionType?: Session['session_type'];
}

export interface SessionListPage {
  sessions: SessionListItem[];
  nextCursor: string | null;
}

export interface LoadSessionMeta {
  recipe?: Recipe | null;
  userRecipeValues?: Record<string, string> | null;
  extensionResults?: ExtensionLoadResult[] | null;
  workingDir?: string;
}

export interface AcpLoadSessionResult {
  sessionInfo: SessionInfo;
  response: LoadSessionResponse;
  meta: LoadSessionMeta;
}

const inFlightSessionLoads = new Map<string, Promise<AcpLoadSessionResult>>();

const WATCH_METHOD = '_aegis/unstable/session/watch';
const UNWATCH_METHOD = '_aegis/unstable/session/unwatch';
const REPLAY_GAP_METHOD = '_aegis/unstable/session/replay_gap';

type WatchResponse = {
  activeRunId: string | null;
  cursor: number;
  epoch?: string;
  replay: Array<{ method: string; params: unknown }>;
};

// The custom watch method is not yet part of the generated extension client.
function customRequest(client: Awaited<ReturnType<typeof getAcpClient>>) {
  return client.connection.agent as unknown as {
    request(method: string, params: unknown): Promise<unknown>;
  };
}

type AcpClient = Awaited<ReturnType<typeof getAcpClient>>;
type WatchEvent = WatchResponse['replay'][number];
type WatchState = {
  client: AcpClient;
  cursor: number | null;
  epoch: string | null;
  response?: WatchResponse;
  pending?: Promise<WatchResponse>;
  pendingApplyReplay?: boolean;
  buffered: Map<number, WatchEvent>;
  loading: boolean;
  failed: boolean;
  loadCursor?: number;
  loadEpoch?: string;
  requiresLoad: boolean;
};
const watchedSessions = new Map<string, WatchState>();
const loadIntervals = new Set<string>();
const unsupportedWatchClients = new WeakSet<AcpClient>();

function isWatchUnsupported(error: unknown): boolean {
  return (
    error instanceof Error &&
    (/method not found/i.test(error.message) || /-32601/.test(error.message))
  );
}
export const ACP_WATCH_REPLAY_GAP_ERROR = 'ACP watch replay gap; session must be reloaded';
const GAP_ERROR = ACP_WATCH_REPLAY_GAP_ERROR;

function eventCursor(params: unknown): number | null {
  const cursor = (params as { _meta?: { aegis?: { cursor?: unknown } } })?._meta?.aegis?.cursor;
  return typeof cursor === 'number' && Number.isSafeInteger(cursor) && cursor > 0 ? cursor : null;
}

function applyWatchEvent(event: WatchEvent): void {
  if (event.method === 'session/update') {
    void handleAcpSessionNotification(
      event.params as Parameters<typeof handleAcpSessionNotification>[0]
    );
  } else if (event.method === '_aegis/unstable/session/update') {
    void handleAcpAegisSessionNotification(
      event.params as Parameters<typeof handleAcpAegisSessionNotification>[0]
    );
  }
}

function drainBuffered(sessionId: string, state: WatchState): void {
  if (state.loading || state.pending || !state.response || state.failed) return;
  for (const cursor of [...state.buffered.keys()].sort((a, b) => a - b)) {
    if (cursor <= (state.cursor ?? 0)) state.buffered.delete(cursor);
  }
  while (state.buffered.has((state.cursor ?? 0) + 1)) {
    const cursor = (state.cursor ?? 0) + 1;
    const event = state.buffered.get(cursor)!;
    state.buffered.delete(cursor);
    applyWatchEvent(event);
    state.cursor = cursor;
  }
  if (state.buffered.size) {
    // Request the missing interval rather than applying later chunks out of order.
    state.response = undefined;
    void acpWatchSession(sessionId, true, true).catch(() => {
      if (watchedSessions.get(sessionId) !== state) return;
      state.failed = true;
      state.requiresLoad = true;
      state.buffered.clear();
      acpChatSessionActions.setSessionLoadError(sessionId, GAP_ERROR);
    });
  }
}

export function beginAcpWatchLoad(sessionId: string): void {
  loadIntervals.add(sessionId);
  const state = watchedSessions.get(sessionId);
  if (state) {
    state.loading = true;
    state.loadCursor = undefined;
    state.loadEpoch = undefined;
    state.response = undefined;
    state.cursor = null;
    state.epoch = null;
    state.failed = false;
    state.requiresLoad = false;
    state.buffered.clear();
  }
}

export function markAcpWatchLoadBoundary(
  sessionId: string,
  client: AcpClient,
  cursor: number,
  epoch?: string
): void {
  let state = watchedSessions.get(sessionId);
  if (!state || state.client !== client) {
    state = {
      client,
      cursor: null,
      epoch: null,
      buffered: new Map(),
      loading: true,
      failed: false,
      requiresLoad: false,
    };
    watchedSessions.set(sessionId, state);
  }
  if (state.loading && Number.isSafeInteger(cursor) && cursor >= 0) {
    state.loadCursor = cursor;
    state.loadEpoch = epoch;
  }
}

export function endAcpWatchLoad(sessionId: string): void {
  loadIntervals.delete(sessionId);
  const state = watchedSessions.get(sessionId);
  if (state) {
    state.loading = false;
    state.loadCursor = undefined;
    state.loadEpoch = undefined;
    drainBuffered(sessionId, state);
  }
}

export function handleAcpWatchedNotification(
  client: AcpClient,
  method: string,
  params: { sessionId: string; _meta?: unknown; update?: unknown }
): void {
  const cursor = eventCursor(params);
  const state = watchedSessions.get(params.sessionId);
  if (cursor === null) {
    if (state?.client && state.client !== client) return;
    applyWatchEvent({ method, params });
    return;
  }
  // A new connection may deliver events before its watch response. Never let
  // notifications from a retired socket mutate the current session.
  if (state && state.client !== client) return;
  const current = state ?? {
    client,
    cursor: null,
    epoch: null,
    buffered: new Map<number, WatchEvent>(),
    loading: loadIntervals.has(params.sessionId),
    failed: false,
    requiresLoad: false,
  };
  if (!state) watchedSessions.set(params.sessionId, current);
  if (current.failed) return;
  if (cursor > (current.cursor ?? 0)) current.buffered.set(cursor, { method, params });
  drainBuffered(params.sessionId, current);
}

export async function acpWatchSession(
  sessionId: string,
  applyReplay = true,
  force = false
): Promise<WatchResponse> {
  const client = await getAcpClient();
  let state = watchedSessions.get(sessionId);
  if (!state || state.client !== client) {
    state = {
      client,
      cursor: state?.cursor ?? null,
      epoch: state?.epoch ?? null,
      buffered: new Map(),
      loading: loadIntervals.has(sessionId),
      failed: false,
      requiresLoad: false,
    };
    watchedSessions.set(sessionId, state);
  }
  if (unsupportedWatchClients.has(client)) return { activeRunId: null, cursor: 0, replay: [] };
  if (state.pending) {
    if (state.pendingApplyReplay === false) return state.pending;
    if (!applyReplay) {
      try {
        await state.pending;
      } catch {
        // Even a failed in-flight watch cannot replace the post-load snapshot.
      }
      return acpWatchSession(sessionId, false, true);
    }
    return state.pending;
  }
  if (state.failed && !state.loading) {
    acpChatSessionActions.setSessionLoadError(sessionId, GAP_ERROR);
    throw new Error(GAP_ERROR);
  }
  if (state.requiresLoad) throw new Error(GAP_ERROR);
  if (state.response && !force && applyReplay) return state.response;
  const current = state;
  const since = applyReplay ? current.cursor : null;
  if (
    applyReplay &&
    since === null &&
    !loadIntervals.has(sessionId) &&
    acpChatSessionStore.getSnapshot(sessionId)?.messages.length
  ) {
    current.failed = true;
    current.requiresLoad = true;
    acpChatSessionActions.setSessionLoadError(sessionId, GAP_ERROR);
    throw new Error(GAP_ERROR);
  }
  const request = async (): Promise<WatchResponse> => {
    try {
      const result = (await customRequest(client).request(WATCH_METHOD, {
        sessionId,
        since,
        epoch: since === null ? null : current.epoch,
      })) as WatchResponse;
      if (watchedSessions.get(sessionId) !== current || (await getAcpClient()) !== client) {
        throw new Error('ACP watch connection is no longer current');
      }
      if (
        !Array.isArray(result.replay) ||
        result.replay.some((event) => event.method === REPLAY_GAP_METHOD)
      ) {
        throw new Error(GAP_ERROR);
      }
      if (!Number.isSafeInteger(result.cursor) || result.cursor < 0) throw new Error(GAP_ERROR);
      if (!result.epoch) throw new Error(GAP_ERROR);
      if (since !== null && current.epoch && result.epoch !== current.epoch) {
        throw new Error(GAP_ERROR);
      }
      if (applyReplay) {
        for (const event of result.replay) {
          const cursor = eventCursor(event.params);
          if (cursor === null || cursor > result.cursor || (since !== null && cursor <= since)) {
            throw new Error(GAP_ERROR);
          }
          if (!current.buffered.has(cursor)) current.buffered.set(cursor, event);
        }
        const cursors = [...current.buffered.keys()]
          .filter((cursor) => cursor <= result.cursor)
          .sort((a, b) => a - b);
        let verifiedCursor = since ?? (cursors.length ? cursors[0] - 1 : result.cursor);
        for (const cursor of cursors) {
          if (cursor <= verifiedCursor) continue;
          if (cursor !== verifiedCursor + 1) throw new Error(GAP_ERROR);
          verifiedCursor = cursor;
        }
        if (verifiedCursor !== result.cursor) throw new Error(GAP_ERROR);
        for (const cursor of cursors) {
          if (cursor <= (current.cursor ?? 0)) {
            current.buffered.delete(cursor);
            continue;
          }
          applyWatchEvent(current.buffered.get(cursor)!);
          current.buffered.delete(cursor);
          current.cursor = cursor;
        }
        current.cursor = result.cursor;
      } else {
        // session/load replays persisted history but has no atomic cursor of
        // that history. A concurrent publish may already be in the load replay;
        // applying it again would duplicate a chunk. Retry if the hub moved.
        if (
          current.loadCursor === undefined ||
          current.loadCursor !== result.cursor ||
          current.loadEpoch !== result.epoch
        ) {
          throw new Error(GAP_ERROR);
        }
        current.cursor = result.cursor;
        for (const cursor of current.buffered.keys()) {
          if (cursor <= result.cursor) current.buffered.delete(cursor);
        }
      }
      acpChatSessionActions.setActiveWatchedRun(sessionId, result.activeRunId);
      current.failed = false;
      current.requiresLoad = false;
      current.epoch = result.epoch ?? null;
      current.response = result;
      return result;
    } catch (error) {
      if (
        isWatchUnsupported(error) &&
        watchedSessions.get(sessionId) === current &&
        (await getAcpClient()) === client
      ) {
        // Older backends still send uncursored updates on the owning connection.
        unsupportedWatchClients.add(client);
        current.buffered.clear();
        return { activeRunId: null, cursor: 0, replay: [] };
      }
      if (
        watchedSessions.get(sessionId) === current &&
        error instanceof Error &&
        error.message === GAP_ERROR
      ) {
        current.failed = true;
        current.requiresLoad = applyReplay || !current.loading;
        current.response = undefined;
        current.buffered.clear();
        acpChatSessionActions.setSessionLoadError(sessionId, GAP_ERROR);
      }
      throw error;
    }
  };
  const promise = request();
  current.pending = promise;
  current.pendingApplyReplay = applyReplay;
  try {
    return await promise;
  } finally {
    if (current.pending === promise) {
      current.pending = undefined;
      current.pendingApplyReplay = undefined;
      if (current.response && watchedSessions.get(sessionId) === current)
        drainBuffered(sessionId, current);
    }
  }
}

export async function recoverAcpWatches(): Promise<void> {
  const sessions = [...watchedSessions.entries()]
    .filter(
      ([sessionId, state]) =>
        !state.loading &&
        !loadIntervals.has(sessionId) &&
        acpChatSessionStore.getSnapshot(sessionId)?.session
    )
    .map(([sessionId]) => sessionId);
  for (const sessionId of sessions) {
    try {
      await acpWatchSession(sessionId);
    } catch {
      acpChatSessionActions.setSessionLoadError(sessionId, GAP_ERROR);
    }
  }
}

export async function acpUnwatchSession(sessionId: string): Promise<void> {
  const watched = watchedSessions.get(sessionId);
  watchedSessions.delete(sessionId);
  loadIntervals.delete(sessionId);
  if (watched) await customRequest(watched.client).request(UNWATCH_METHOD, { sessionId });
}

function parseSessionResponseMeta(rawMeta: unknown): LoadSessionMeta {
  const meta = (rawMeta ?? {}) as LoadSessionMeta;
  return {
    recipe: meta.recipe,
    userRecipeValues: meta.userRecipeValues,
    extensionResults: meta.extensionResults,
    workingDir: typeof meta.workingDir === 'string' ? meta.workingDir : undefined,
  };
}

export function parseLoadMeta(response: LoadSessionResponse): LoadSessionMeta {
  return parseSessionResponseMeta(response._meta);
}

function sessionInfoMeta(s: SessionInfo): AegisSessionInfoMeta {
  return (s._meta ?? {}) as AegisSessionInfoMeta;
}

export function sessionInfoToSession(s: SessionInfo, loadMeta: LoadSessionMeta = {}): Session {
  const meta = sessionInfoMeta(s);
  const createdAt = meta.createdAt ?? s.updatedAt ?? '';
  const updatedAt = s.updatedAt ?? createdAt;
  const modelConfig: Session['model_config'] = meta.modelId
    ? {
        model_name: meta.modelId,
        toolshim: false,
      }
    : null;

  return {
    id: String(s.sessionId),
    name: s.title ?? '',
    working_dir: loadMeta.workingDir ?? s.cwd,
    created_at: createdAt,
    updated_at: updatedAt,
    last_message_at: meta.lastMessageAt,
    message_count: meta.messageCount ?? 0,
    extension_data: {},
    archived_at: meta.archivedAt,
    project_id: meta.projectId,
    provider_name: meta.providerId,
    model_config: modelConfig,
    session_type: meta.sessionType,
    recipe: loadMeta.recipe as Session['recipe'],
    user_recipe_values: loadMeta.userRecipeValues,
    user_set_name: meta.userSetName,
    last_message_snippet: meta.lastMessageSnippet,
  };
}

function sessionInfoToListItem(s: SessionInfo): SessionListItem {
  const meta = sessionInfoMeta(s);
  return {
    id: String(s.sessionId),
    name: s.title ?? '',
    workingDir: s.cwd,
    updatedAt: s.updatedAt ?? '',
    messageCount: meta.messageCount ?? 0,
    lastMessageAt: meta.lastMessageAt,
    createdAt: meta.createdAt ?? s.updatedAt ?? '',
    archivedAt: meta.archivedAt,
    projectId: meta.projectId,
    providerId: meta.providerId,
    modelId: meta.modelId,
    userSetName: meta.userSetName,
    hasRecipe: meta.hasRecipe,
    sessionType: meta.sessionType,
  };
}

export interface SessionListFilter {
  keyword?: string;
  includeAcp: boolean;
}

const SESSION_LIST_TYPES = ['user', 'scheduled'] as const;
const SESSION_LIST_TYPES_WITH_ACP = [...SESSION_LIST_TYPES, 'acp'] as const;

export async function acpListSessions(
  cursor?: string | null,
  filter: SessionListFilter = { includeAcp: false }
): Promise<SessionListPage> {
  const client = await getAcpClient();
  const request: ListSessionsRequest = {};
  if (cursor) {
    request.cursor = cursor;
  }
  const meta: Record<string, unknown> = {
    types: filter.includeAcp ? SESSION_LIST_TYPES_WITH_ACP : SESSION_LIST_TYPES,
  };
  const keyword = filter.keyword?.trim();
  if (keyword) {
    meta.query = keyword;
  }
  request._meta = meta;
  const response = await client.connection.agent.request(methods.agent.session.list, request);
  return {
    sessions: response.sessions.map(sessionInfoToListItem),
    nextCursor: response.nextCursor ?? null,
  };
}

export async function acpListRecentSessions(maxSessions: number): Promise<SessionListItem[]> {
  if (maxSessions <= 0) {
    return [];
  }

  const client = await getAcpClient();
  const response = await client.connection.agent.request(methods.agent.session.list, {
    _meta: { types: SESSION_LIST_TYPES },
  });
  return response.sessions.slice(0, maxSessions).map(sessionInfoToListItem);
}

export async function acpGetSessionListItem(sessionId: string): Promise<SessionListItem> {
  const client = await getAcpClient();
  const response = await client.aegis.sessionInfo_unstable({ sessionId });
  return sessionInfoToListItem(response.session);
}

export async function acpLoadSession(sessionId: string): Promise<AcpLoadSessionResult> {
  const pendingLoad = inFlightSessionLoads.get(sessionId);
  if (pendingLoad) {
    return pendingLoad;
  }

  const loadPromise = loadAcpSession(sessionId);
  inFlightSessionLoads.set(sessionId, loadPromise);
  try {
    return await loadPromise;
  } finally {
    if (inFlightSessionLoads.get(sessionId) === loadPromise) {
      inFlightSessionLoads.delete(sessionId);
    }
  }
}

export function isAcpSessionLoadInFlight(sessionId: string): boolean {
  return inFlightSessionLoads.has(sessionId);
}

async function loadAcpSession(sessionId: string): Promise<AcpLoadSessionResult> {
  const client = await getAcpClient();
  const initialSessionInfoResponse = await client.aegis.sessionInfo_unstable({ sessionId });
  const initialSessionInfo = initialSessionInfoResponse.session;
  if (
    loadIntervals.has(sessionId) &&
    (watchedSessions.get(sessionId)?.client !== client ||
      watchedSessions.get(sessionId)?.loadCursor === undefined)
  ) {
    let boundary: WatchResponse | undefined;
    try {
      boundary = (await customRequest(client).request(WATCH_METHOD, {
        sessionId,
        since: null,
        epoch: null,
      })) as WatchResponse;
    } catch (error) {
      if (!isWatchUnsupported(error)) throw error;
      if ((await getAcpClient()) !== client) throw new Error(GAP_ERROR, { cause: error });
      unsupportedWatchClients.add(client);
      const state = watchedSessions.get(sessionId);
      if (state?.client === client) {
        state.buffered.clear();
        watchedSessions.delete(sessionId);
      }
    }
    if (
      boundary &&
      (!Number.isSafeInteger(boundary.cursor) ||
        boundary.cursor < 0 ||
        !boundary.epoch ||
        boundary.replay.some((event) => event.method === REPLAY_GAP_METHOD))
    ) {
      throw new Error(GAP_ERROR);
    }
    if ((await getAcpClient()) !== client) throw new Error(GAP_ERROR);
    if (boundary) markAcpWatchLoadBoundary(sessionId, client, boundary.cursor, boundary.epoch);
  }
  const response = await client.connection.agent.request(methods.agent.session.load, {
    sessionId,
    cwd: initialSessionInfo.cwd,
    mcpServers: [],
  });
  // Loading can populate missing provider/model metadata.
  const sessionInfoResponse = await client.aegis.sessionInfo_unstable({ sessionId });

  return {
    sessionInfo: sessionInfoResponse.session,
    response,
    meta: parseLoadMeta(response),
  };
}

export interface AcpNewSessionResult {
  sessionId: string;
  sessionInfo: SessionInfo;
  meta: LoadSessionMeta;
}

export interface AcpRecipeOptions {
  recipeId?: string;
  recipeDeeplink?: string;
  recipeParameterScopeId?: string;
}

/**
 * `aegisExtensions` is three-valued: `undefined` leaves the key out so the backend
 * uses the configured set, while `[]` asks for a session with no extensions. The
 * backend already distinguishes the two, so the client has to as well.
 */
export async function acpNewSession(
  cwd: string,
  aegisExtensions: AegisExtension[] | undefined,
  recipe?: AcpRecipeOptions
): Promise<AcpNewSessionResult> {
  const client = await getAcpClient();
  const meta: Record<string, unknown> = { client: 'aegis-desktop' };
  if (aegisExtensions !== undefined) {
    meta.enabledExtensions = aegisExtensions;
  }
  if (recipe?.recipeId) {
    meta.recipeId = recipe.recipeId;
  } else if (recipe?.recipeDeeplink) {
    meta.recipeDeeplink = recipe.recipeDeeplink;
  }
  if (recipe?.recipeParameterScopeId) {
    meta.recipeParameterScopeId = recipe.recipeParameterScopeId;
  }
  const request: NewSessionRequest = { cwd, mcpServers: [], _meta: meta };
  const response = await client.connection.agent.request(methods.agent.session.new, request);
  const sessionId = String(response.sessionId);
  const sessionInfoResponse = await client.aegis.sessionInfo_unstable({ sessionId });

  return {
    sessionId,
    sessionInfo: sessionInfoResponse.session,
    meta: parseSessionResponseMeta(response._meta),
  };
}

export async function acpDeleteSession(sessionId: string): Promise<void> {
  const client = await getAcpClient();
  await client.connection.agent.request(methods.agent.session.delete, { sessionId });
}

export async function acpCloseSession(sessionId: string): Promise<void> {
  const client = await getAcpClient();
  await client.connection.agent.request(methods.agent.session.close, { sessionId });
}

export async function acpRenameSession(sessionId: string, title: string): Promise<void> {
  const client = await getAcpClient();
  await client.aegis.sessionRename_unstable({ sessionId, title });
}

export async function acpUpdateWorkingDir(sessionId: string, workingDir: string): Promise<void> {
  const client = await getAcpClient();
  await client.aegis.sessionWorkingDirUpdate_unstable({ sessionId, workingDir });
}

export async function acpTruncateSessionConversation(
  sessionId: string,
  truncateFrom: number
): Promise<void> {
  const client = await getAcpClient();
  await client.aegis.sessionConversationTruncate_unstable({ sessionId, truncateFrom });
}

export async function acpForkSession(
  sessionId: string,
  conversationBefore?: number
): Promise<string> {
  const client = await getAcpClient();
  const sessionInfo = await client.aegis.sessionInfo_unstable({ sessionId });
  const { cwd } = sessionInfo.session;
  const request: ForkSessionRequest = { sessionId, cwd };
  if (conversationBefore !== undefined) {
    request._meta = { conversationBefore };
  }
  const response = await client.connection.agent.request(methods.agent.session.fork, request);
  return String(response.sessionId);
}

export async function acpExportSession(
  sessionId: string,
  format: SessionExportFormat = 'json'
): Promise<string> {
  const client = await getAcpClient();
  const response = await client.aegis.sessionExport_unstable({ sessionId, format });
  return response.data;
}

export async function acpImportSession(input: string): Promise<void> {
  const client = await getAcpClient();
  await client.aegis.sessionImport_unstable({ input });
}
