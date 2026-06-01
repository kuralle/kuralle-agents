/** Conversation ownership: bot vs human (RFC §4.7 / REQ-10). */
export type ConversationOwner = 'bot' | 'human';

export interface OwnershipStore {
  owner(threadId: string): Promise<ConversationOwner>;
  claim(threadId: string, by: string): Promise<void>;
  release(threadId: string): Promise<void>;
}
