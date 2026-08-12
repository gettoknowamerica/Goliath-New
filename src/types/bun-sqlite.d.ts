declare module "bun:sqlite" {
  export class Database {
    constructor(filename: string);
    run(sql: string, ...params: unknown[]): { lastInsertRowid: number; changes: number };
    query<T = Record<string, unknown>>(sql: string): {
      all(...params: unknown[]): T[];
      get(...params: unknown[]): T | null;
    };
    close(): void;
  }
}
