export type HistoryChat = {
  id: string;
  title: string;
  createdAt: string;
};

export type ChatHistory = {
  chats: HistoryChat[];
  hasMore: boolean;
};
