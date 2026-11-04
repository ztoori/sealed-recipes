/**
 * Durable, content-addressed storage for everything the marketplace keeps on behalf of others:
 * sealed recipe versions (runner-readable), creator copies (creator-readable) and run checkpoints
 * (runner-readable). The marketplace can read none of it.
 *
 * Content addressing: a blob's id is `sha256(canonical(envelope))`, the same hash that is committed on-chain
 * (`sealed_hash`, `state_hash`). Every read re-hashes the blob, so a corrupted or substituted file is detected
 * before it reaches a runner or a creator.
 *
 * Backends: `FileBlobStore` (local disk, atomic writes) is what the demo uses. The same interface fits IPFS
 * (CID = content hash), S3/R2 (key = hash) or Arweave; only `put`/`get` change.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sealedHash, type SealedEnvelope } from '../../core/src/seal.js';

export interface BlobStore {
  put(env: SealedEnvelope): string;
  get(hash: string): SealedEnvelope | undefined;
  has(hash: string): boolean;
}

export class BlobCorrupted extends Error {}

export class FileBlobStore implements BlobStore {
  constructor(readonly dir: string) { mkdirSync(join(dir, 'blobs'), { recursive: true }); mkdirSync(join(dir, 'meta'), { recursive: true }); }
  private path(hash: string) {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('bad blob id');
    return join(this.dir, 'blobs', `${hash}.json`);
  }
  /** atomic write: a crash mid-write never leaves a truncated blob behind */
  private writeAtomic(path: string, text: string) {
    const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  }
  put(env: SealedEnvelope): string {
    const hash = sealedHash(env);
    const p = this.path(hash);
    if (!existsSync(p)) this.writeAtomic(p, JSON.stringify(env));
    return hash;
  }
  get(hash: string): SealedEnvelope | undefined {
    const p = this.path(hash);
    if (!existsSync(p)) return undefined;
    const env = JSON.parse(readFileSync(p, 'utf8')) as SealedEnvelope;
    if (sealedHash(env) !== hash) throw new BlobCorrupted(`blob ${hash.slice(0, 12)}… does not match its hash`);
    return env;
  }
  has(hash: string) { return existsSync(this.path(hash)); }
  /** small mutable metadata (indexes, pointers): JSON documents, written atomically */
  readMeta<T>(name: string, fallback: T): T {
    const p = join(this.dir, 'meta', `${name}.json`);
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : fallback;
  }
  writeMeta(name: string, value: unknown) { this.writeAtomic(join(this.dir, 'meta', `${name}.json`), JSON.stringify(value)); }
  count() { return readdirSync(join(this.dir, 'blobs')).filter((f) => f.endsWith('.json')).length; }
}

/** Index of versions per recipe, kept next to the blobs so a restarted marketplace can still serve every version. */
export interface VaultIndex { recipes: Record<string, { versions: string[]; creator_copies: Record<string, string> }> }
