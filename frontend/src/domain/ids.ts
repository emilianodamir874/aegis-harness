// Identidades del dominio. Son strings en el cable, pero el compilador no deja mezclarlas:
// una sesión no es un mensaje y un run no es un tool call, aunque los cuatro sean texto.
declare const brand: unique symbol;

export type Branded<T extends string, Name extends string> = T & { readonly [brand]: Name };

export type SessionId = Branded<string, 'SessionId'>;
export type MessageId = Branded<string, 'MessageId'>;
export type ToolCallId = Branded<string, 'ToolCallId'>;
export type RunId = Branded<string, 'RunId'>;
export type PermissionId = Branded<string, 'PermissionId'>;
export type AttachmentId = Branded<string, 'AttachmentId'>;
/** Id de un bloque de texto dentro de un mensaje (mensaje + ordinal). */
export type BlockId = Branded<string, 'BlockId'>;

const nonEmpty = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${what} vacío`);
  return value;
};

export const sessionId = (value: string): SessionId => nonEmpty(value, 'sessionId') as SessionId;
export const messageId = (value: string): MessageId => nonEmpty(value, 'messageId') as MessageId;
export const toolCallId = (value: string): ToolCallId => nonEmpty(value, 'toolCallId') as ToolCallId;
export const runId = (value: string): RunId => nonEmpty(value, 'runId') as RunId;
export const permissionId = (value: string): PermissionId => nonEmpty(value, 'permissionId') as PermissionId;
export const attachmentId = (value: string): AttachmentId => nonEmpty(value, 'attachmentId') as AttachmentId;

/** Id local para mensajes que todavía no tienen id del servidor (eco optimista, steer en cola). */
export const localId = (kind: 'msg' | 'tool' | 'perm', seed: string): string => `local:${kind}:${seed}`;

export const blockId = (message: MessageId, index: number): BlockId => `${message}#${index}` as BlockId;

/** Marca de tiempo monótona para ordenar sin depender del reloj del servidor. */
export type Seq = number;
