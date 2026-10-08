/**
 * Ordered schema migrations. Never edit a shipped entry; append a new one.
 *
 * Conventions (see docs/PLAN.md §6):
 * - primary keys are UUIDv7 text
 * - every row has created_at / updated_at / deleted_at (soft delete) / device_id
 * - messages are append-only; edits and regenerations create a new row with parent_id
 * - binary content lives in content-addressed blobs, rows only reference sha256
 */
const SYNC_COLUMNS = `
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  device_id  TEXT NOT NULL`

export const migrations: readonly string[] = [
  /* 1: initial schema */ `
  CREATE TABLE providers (
    id       TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    base_url TEXT NOT NULL,
    type     TEXT NOT NULL CHECK (type IN ('auto', 'openai', 'anthropic')),
    key_ref  TEXT,
    ${SYNC_COLUMNS}
  );

  CREATE TABLE models (
    id           TEXT PRIMARY KEY,
    provider_id  TEXT NOT NULL REFERENCES providers(id),
    model_id     TEXT NOT NULL,
    protocol     TEXT,
    capabilities TEXT NOT NULL DEFAULT '[]',
    display_name TEXT,
    ${SYNC_COLUMNS}
  );
  CREATE UNIQUE INDEX models_provider_model ON models(provider_id, model_id);

  CREATE TABLE projects (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    root_path        TEXT,
    instructions     TEXT,
    default_model_id TEXT REFERENCES models(id),
    permission_mode  TEXT NOT NULL DEFAULT 'ask',
    ${SYNC_COLUMNS}
  );

  CREATE TABLE conversations (
    id            TEXT PRIMARY KEY,
    project_id    TEXT REFERENCES projects(id),
    title         TEXT,
    model_id      TEXT REFERENCES models(id),
    system_prompt TEXT,
    params_json   TEXT NOT NULL DEFAULT '{}',
    ${SYNC_COLUMNS}
  );
  CREATE INDEX conversations_updated ON conversations(updated_at DESC);

  CREATE TABLE messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    parent_id       TEXT REFERENCES messages(id),
    role            TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
    parts_json      TEXT NOT NULL,
    model_id        TEXT,
    usage_json      TEXT,
    status          TEXT NOT NULL DEFAULT 'complete',
    ${SYNC_COLUMNS}
  );
  CREATE INDEX messages_conversation ON messages(conversation_id, id);

  CREATE TABLE blobs (
    sha256     TEXT PRIMARY KEY,
    mime       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE image_jobs (
    id              TEXT PRIMARY KEY,
    prompt          TEXT NOT NULL,
    params_json     TEXT NOT NULL DEFAULT '{}',
    model_id        TEXT,
    result_blob_ids TEXT NOT NULL DEFAULT '[]',
    status          TEXT NOT NULL DEFAULT 'pending',
    error           TEXT,
    ${SYNC_COLUMNS}
  );

  CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
]
