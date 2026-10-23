export interface IngestResult { itemsAdded: number; conversationsAdded: number; messagesAdded: number; skipped: number; }
export interface Connector { name: string; ingest(input: ArrayBuffer): Promise<IngestResult>; }
