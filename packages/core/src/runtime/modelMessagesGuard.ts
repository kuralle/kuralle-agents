import type { ModelMessage } from 'ai';

/** AI SDK 7 rejects `role: 'system'` inside the model `messages` array. */
export function assertNoSystemRoleInModelMessages(
  messages: readonly ModelMessage[],
  context?: string,
): void {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role === 'system') {
      const where = context ? ` (${context})` : '';
      throw new Error(`Model message at index ${index} has role 'system'${where}`);
    }
  }
}

export function hasSystemRoleInModelMessages(messages: readonly ModelMessage[]): boolean {
  return messages.some((message) => message.role === 'system');
}
