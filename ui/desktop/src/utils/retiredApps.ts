import type { AegisApp } from '../types/apps';

export function isRetiredAegisChatApp(app: AegisApp) {
  return (
    app.mcpServers?.includes('apps') &&
    app.uri === 'ui://apps/chat' &&
    app.name === 'chat' &&
    app.description === 'Simple Chat UI' &&
    app.width === 400 &&
    app.height === 500 &&
    app.resizable === true
  );
}
