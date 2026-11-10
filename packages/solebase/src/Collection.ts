import type { WorkerBridge } from './WorkerBridge.js';
import type { Document, NotifyEvent } from './types.js';
import { SolebaseError } from './types.js';

export type CollectionSubscriber<T extends Document> = (docs: T[]) => void;

/**
 * Typed document collection backed by a Layer 3 CRR JSON table (`sb_<name>`).
 * Mutations go through WorkerBridge → db-worker (never main-thread SQLite).
 */
export class Collection<T extends Document = Document> {
  readonly name: string;
  private readonly bridge: WorkerBridge;
  private readonly subscribers = new Set<CollectionSubscriber<T>>();
  private ensured: Promise<void> | null = null;
  private cache: T[] | null = null;
  private unsubNotify: (() => void) | null = null;

  constructor(bridge: WorkerBridge, name: string) {
    this.bridge = bridge;
    this.name = name;
  }

  private async ensure(): Promise<void> {
    if (!this.ensured) {
      this.ensured = this.bridge
        .request('collection_ensure', { name: this.name })
        .then(() => undefined);
    }
    await this.ensured;
    if (!this.unsubNotify) {
      this.unsubNotify = this.bridge.onNotify((event) => {
        void this.onNotify(event);
      });
    }
  }

  private async onNotify(event: NotifyEvent): Promise<void> {
    if (event.collection !== this.name) return;
    // Invalidate + refresh so subscribers see authoritative rows.
    this.cache = null;
    if (this.subscribers.size === 0) return;
    try {
      const docs = await this.find();
      this.emit(docs);
    } catch (err) {
      console.error('[Collection] notify refresh failed', err);
    }
  }

  private emit(docs: T[]): void {
    for (const cb of this.subscribers) {
      try {
        cb(docs);
      } catch (err) {
        console.error('[Collection] subscriber error', err);
      }
    }
  }

  async insert(doc: Omit<T, 'id'> & { id?: string }): Promise<T> {
    await this.ensure();
    const id =
      typeof doc.id === 'string' && doc.id.length > 0 ? doc.id : crypto.randomUUID();
    const stored = { ...(doc as object), id } as T;
    const result = await this.bridge.request<T>('collection_insert', {
      name: this.name,
      docId: id,
      doc: stored,
    });
    this.cache = null;
    return result;
  }

  async update(id: string, patch: Partial<Omit<T, 'id'>>): Promise<T> {
    if (!id) throw new SolebaseError('update requires id', 'INVALID_ID');
    await this.ensure();
    const result = await this.bridge.request<T>('collection_update', {
      name: this.name,
      docId: id,
      doc: patch,
    });
    this.cache = null;
    return result;
  }

  async delete(id: string): Promise<void> {
    if (!id) throw new SolebaseError('delete requires id', 'INVALID_ID');
    await this.ensure();
    await this.bridge.request('collection_delete', {
      name: this.name,
      docId: id,
    });
    this.cache = null;
  }

  async findById(id: string): Promise<T | null> {
    if (!id) return null;
    await this.ensure();
    return this.bridge.request<T | null>('collection_findById', {
      name: this.name,
      docId: id,
    });
  }

  /**
   * Return all documents, optionally filtered by shallow equality on fields.
   * Filter runs in memory after QUERY (fine for hobby-scale collections).
   */
  async find(filter?: Partial<T>): Promise<T[]> {
    await this.ensure();
    let docs =
      this.cache ??
      (await this.bridge.request<T[]>('collection_find', { name: this.name }));
    this.cache = docs;
    if (filter && Object.keys(filter).length > 0) {
      docs = docs.filter((doc) => matchesFilter(doc, filter));
    }
    return docs;
  }

  /**
   * Subscribe to collection snapshots. Emits immediately (async fetch) and
   * again on local / remote NOTIFY changes. Returns unsubscribe.
   */
  subscribe(cb: CollectionSubscriber<T>): () => void {
    this.subscribers.add(cb);
    void this.ensure()
      .then(() => this.find())
      .then((docs) => {
        if (this.subscribers.has(cb)) cb(docs);
      })
      .catch((err) => {
        console.error('[Collection] initial subscribe failed', err);
      });

    return () => {
      this.subscribers.delete(cb);
    };
  }
}

function matchesFilter<T extends Document>(doc: T, filter: Partial<T>): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if ((doc as Record<string, unknown>)[key] !== value) return false;
  }
  return true;
}
