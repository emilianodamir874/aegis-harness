import { describe, expect, it, vi } from 'vitest';
import { methods } from '@agentclientprotocol/sdk';
import { getAcpClient } from '../acpConnection';
import type { Message } from '../../types/message';
import { acpPromptSession, messageToAcpPromptContent } from '../prompt';

vi.mock('../acpConnection', () => ({ getAcpClient: vi.fn() }));

describe('ACP prompt identity', () => {
  it('sends optional promptId under Aegis metadata without changing legacy requests', async () => {
    const request = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });
    vi.mocked(getAcpClient).mockResolvedValue({ connection: { agent: { request } } } as never);
    const message = {
      id: 'user-1',
      role: 'user',
      created: 1,
      content: [{ type: 'text', text: 'Hello' }],
      metadata: { userVisible: true, agentVisible: true },
    } as Message;
    await acpPromptSession('session-1', message, 'attempt-1');
    expect(request).toHaveBeenLastCalledWith(methods.agent.session.prompt, {
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: 'Hello' }],
      _meta: { aegis: { promptId: 'attempt-1' } },
    });
    await acpPromptSession('session-1', message);
    expect(request).toHaveBeenLastCalledWith(methods.agent.session.prompt, {
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: 'Hello' }],
    });
  });
});

describe('messageToAcpPromptContent', () => {
  it('converts text and image content into ACP prompt blocks', () => {
    const message: Message = {
      id: 'message-1',
      role: 'user',
      created: 123,
      content: [
        { type: 'text', text: 'Describe this' },
        {
          type: 'image',
          data: 'abc123',
          mimeType: 'image/png',
          _meta: { source: 'acp' },
          annotations: { priority: 0.5 },
        },
      ],
      metadata: { userVisible: true, agentVisible: true },
    };

    expect(messageToAcpPromptContent(message)).toEqual([
      { type: 'text', text: 'Describe this' },
      {
        type: 'image',
        data: 'abc123',
        mimeType: 'image/png',
        _meta: { source: 'acp' },
        annotations: { priority: 0.5 },
      },
    ]);
  });

  it('omits empty text content and unsupported content blocks', () => {
    const message: Message = {
      id: 'message-1',
      role: 'user',
      created: 123,
      content: [
        { type: 'text', text: '   ' },
        {
          type: 'toolResponse',
          id: 'tool-1',
          toolResult: { status: 'success', value: [] },
        },
      ],
      metadata: { userVisible: true, agentVisible: true },
    } as Message;

    expect(messageToAcpPromptContent(message)).toEqual([]);
  });
});
