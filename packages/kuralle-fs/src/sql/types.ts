export type SqlParam = string | number | boolean | null;

export interface SqlBackend {
  query<T = Record<string, SqlParam>>(
    sql: string,
    ...params: SqlParam[]
  ): T[] | Promise<T[]>;
  run(sql: string, ...params: SqlParam[]): void | Promise<void>;
}

export interface BlobStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, data: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}