import {
  newId,
  type Capability,
  type MessagePart,
  type MessageStatus,
  type Protocol,
  type ProviderType,
  type Role,
  type StoredMessage,
  type ThinkingLevel,
  type Usage,
} from '@aitech/core'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'

export interface ProviderRow {
  id: string
  name: string
  baseUrl: string
  type: ProviderType
  enabled: boolean
  /** Opaque, encrypted key reference. Never sent to the renderer. */
  keyRef: string | null
  createdAt: number
  updatedAt: number
}

export interface ModelRow {
  id: string
  providerId: string
  modelId: string
  protocol: Protocol | null
  capabilities: Capability[]
  displayName: string | null
  enabled: boolean
}

export type PermissionMode = 'ask' | 'auto-edit' | 'auto' | 'plan'

export interface ProjectRow {
  id: string
  name: string
  rootPath: string
  instructions: string | null
  defaultModelId: string | null
  permissionMode: PermissionMode
  createdAt: number
  updatedAt: number
}

export interface TrustedDeviceRow {
  deviceId: string
  name: string
  platform: string | null
  /** base64url Ed25519 public key */
  publicKey: string
  pairedAt: number
  lastSeen: number | null
}

export interface ScheduleRow {
  id: string
  name: string
  /** Runs as a task in this project; null: a plain chat. */
  projectId: string | null
  prompt: string
  /** Five-field cron expression, local time. */
  cron: string
  /** null: the project's / app's default model. */
  modelId: string | null
  enabled: boolean
  nextRunAt: number | null
  lastRunAt: number | null
  lastConversationId: string | null
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export type ScheduleInput = Pick<ScheduleRow, 'name' | 'projectId' | 'prompt' | 'cron' | 'modelId'>

export interface ConversationParams {
  temperature?: number
  maxOutputTokens?: number
}

export interface ConversationRow {
  id: string
  projectId: string | null
  title: string | null
  modelId: string | null
  systemPrompt: string | null
  params: ConversationParams
  thinking: ThinkingLevel
  activeLeafId: string | null
  pinned: boolean
  /** The agent works in this git worktree instead of the project root. */
  worktreePath: string | null
  worktreeBranch: string | null
  createdAt: number
  updatedAt: number
}

export interface MessageRow extends StoredMessage {
  error: string | null
}

export type ImageJobStatus = 'pending' | 'running' | 'done' | 'error'

export interface ImageJobParams {
  /** Media jobs share this table; absent means image. */
  kind?: 'image' | 'video'
  size?: string
  quality?: string
  n?: number
  background?: 'auto' | 'transparent' | 'opaque'
  /** video: duration in seconds, e.g. "8" */
  seconds?: string
  /** video: provider job id, so polling can resume after a restart */
  remoteId?: string
  /** video: 0-100 */
  progress?: number
}

export interface ImageJobRow {
  id: string
  prompt: string
  params: ImageJobParams
  modelId: string | null
  sourceBlobIds: string[]
  resultBlobIds: string[]
  status: ImageJobStatus
  error: string | null
  usage: Usage | null
  createdAt: number
}

type Row = Record<string, SQLInputValue>

const parse = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== 'string' || !s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

/**
 * Typed data access over the local database. Every write stamps
 * updated_at / device_id so a future sync layer can merge by last writer.
 */
export class Store {
  constructor(
    readonly db: DatabaseSync,
    readonly deviceId: string,
    private readonly now: () => number = Date.now,
  ) {}

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[]
  }

  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined
  }

  private run(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).run(...params)
  }

  private depth = 0

  /** Run fn atomically. Nested calls use savepoints, so composite operations compose. */
  transaction<T>(fn: () => T): T {
    const sp = `sp${this.depth}`
    this.db.exec(this.depth === 0 ? 'BEGIN' : `SAVEPOINT ${sp}`)
    this.depth++
    try {
      const out = fn()
      this.depth--
      this.db.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${sp}`)
      return out
    } catch (err) {
      this.depth--
      this.db.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`)
      throw err
    }
  }

  // ── providers ──────────────────────────────────────────────

  private toProvider = (r: Row): ProviderRow => ({
    id: r.id as string,
    name: r.name as string,
    baseUrl: r.base_url as string,
    type: r.type as ProviderType,
    enabled: r.enabled === 1,
    keyRef: (r.key_ref as string | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  })

  listProviders(): ProviderRow[] {
    return this.all('SELECT * FROM providers WHERE deleted_at IS NULL ORDER BY created_at').map(
      this.toProvider,
    )
  }

  getProvider(id: string): ProviderRow | undefined {
    const r = this.get('SELECT * FROM providers WHERE id = ? AND deleted_at IS NULL', id)
    return r && this.toProvider(r)
  }

  createProvider(input: {
    name: string
    baseUrl: string
    type: ProviderType
    keyRef: string | null
  }): ProviderRow {
    const id = newId()
    const t = this.now()
    this.run(
      `INSERT INTO providers (id, name, base_url, type, key_ref, enabled, created_at, updated_at, device_id)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      id,
      input.name,
      input.baseUrl,
      input.type,
      input.keyRef,
      t,
      t,
      this.deviceId,
    )
    return this.getProvider(id)!
  }

  updateProvider(
    id: string,
    patch: Partial<Pick<ProviderRow, 'name' | 'baseUrl' | 'type' | 'enabled' | 'keyRef'>>,
  ): ProviderRow {
    const cur = this.getProvider(id)
    if (!cur) throw new Error(`provider ${id} not found`)
    const next = { ...cur, ...patch }
    this.run(
      `UPDATE providers SET name = ?, base_url = ?, type = ?, enabled = ?, key_ref = ?, updated_at = ?, device_id = ?
       WHERE id = ?`,
      next.name,
      next.baseUrl,
      next.type,
      next.enabled ? 1 : 0,
      next.keyRef,
      this.now(),
      this.deviceId,
      id,
    )
    return this.getProvider(id)!
  }

  deleteProvider(id: string): void {
    const t = this.now()
    this.transaction(() => {
      this.run(
        'UPDATE providers SET deleted_at = ?, key_ref = NULL, updated_at = ?, device_id = ? WHERE id = ?',
        t,
        t,
        this.deviceId,
        id,
      )
      this.run(
        'UPDATE models SET deleted_at = ?, updated_at = ?, device_id = ? WHERE provider_id = ? AND deleted_at IS NULL',
        t,
        t,
        this.deviceId,
        id,
      )
    })
  }

  // ── models ─────────────────────────────────────────────────

  private toModel = (r: Row): ModelRow => ({
    id: r.id as string,
    providerId: r.provider_id as string,
    modelId: r.model_id as string,
    protocol: (r.protocol as Protocol | null) ?? null,
    capabilities: parse<Capability[]>(r.capabilities, []),
    displayName: (r.display_name as string | null) ?? null,
    enabled: r.enabled === 1,
  })

  listModels(providerId?: string): ModelRow[] {
    const rows = providerId
      ? this.all(
          'SELECT * FROM models WHERE provider_id = ? AND deleted_at IS NULL ORDER BY model_id',
          providerId,
        )
      : this.all(
          `SELECT m.* FROM models m JOIN providers p ON p.id = m.provider_id
           WHERE m.deleted_at IS NULL AND p.deleted_at IS NULL ORDER BY p.created_at, m.model_id`,
        )
    return rows.map(this.toModel)
  }

  /** Models the user can pick: enabled model on an enabled provider. */
  listAvailableModels(): ModelRow[] {
    return this.all(
      `SELECT m.* FROM models m JOIN providers p ON p.id = m.provider_id
       WHERE m.deleted_at IS NULL AND p.deleted_at IS NULL AND m.enabled = 1 AND p.enabled = 1
       ORDER BY p.created_at, m.model_id`,
    ).map(this.toModel)
  }

  getModel(id: string): ModelRow | undefined {
    const r = this.get('SELECT * FROM models WHERE id = ? AND deleted_at IS NULL', id)
    return r && this.toModel(r)
  }

  /**
   * Merge a freshly fetched model list. New ids are added; existing rows keep
   * the user's enable/protocol choices. Missing ids are left alone because
   * gateways sometimes hide models temporarily.
   */
  syncModels(
    providerId: string,
    remote: { id: string; capabilities: Capability[] }[],
  ): { added: number } {
    const existing = new Set(this.listModels(providerId).map((m) => m.modelId))
    const t = this.now()
    let added = 0
    this.transaction(() => {
      for (const m of remote) {
        if (existing.has(m.id)) continue
        // A soft-deleted row with the same id would violate the unique index; revive it instead.
        const revived = this.run(
          `UPDATE models SET deleted_at = NULL, capabilities = ?, updated_at = ?, device_id = ?
           WHERE provider_id = ? AND model_id = ? AND deleted_at IS NOT NULL`,
          JSON.stringify(m.capabilities),
          t,
          this.deviceId,
          providerId,
          m.id,
        )
        if (revived.changes === 0) {
          this.run(
            `INSERT INTO models (id, provider_id, model_id, capabilities, enabled, created_at, updated_at, device_id)
             VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
            newId(),
            providerId,
            m.id,
            JSON.stringify(m.capabilities),
            t,
            t,
            this.deviceId,
          )
        }
        added++
      }
    })
    return { added }
  }

  updateModel(
    id: string,
    patch: Partial<Pick<ModelRow, 'protocol' | 'capabilities' | 'displayName' | 'enabled'>>,
  ): ModelRow {
    const cur = this.getModel(id)
    if (!cur) throw new Error(`model ${id} not found`)
    const next = { ...cur, ...patch }
    this.run(
      `UPDATE models SET protocol = ?, capabilities = ?, display_name = ?, enabled = ?, updated_at = ?, device_id = ?
       WHERE id = ?`,
      next.protocol,
      JSON.stringify(next.capabilities),
      next.displayName,
      next.enabled ? 1 : 0,
      this.now(),
      this.deviceId,
      id,
    )
    return this.getModel(id)!
  }

  deleteModel(id: string): void {
    const t = this.now()
    this.run(
      'UPDATE models SET deleted_at = ?, updated_at = ?, device_id = ? WHERE id = ?',
      t,
      t,
      this.deviceId,
      id,
    )
  }

  // ── projects ───────────────────────────────────────────────

  private toProject = (r: Row): ProjectRow => ({
    id: r.id as string,
    name: r.name as string,
    rootPath: r.root_path as string,
    instructions: (r.instructions as string | null) ?? null,
    defaultModelId: (r.default_model_id as string | null) ?? null,
    permissionMode: (r.permission_mode as PermissionMode) ?? 'ask',
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  })

  listProjects(): ProjectRow[] {
    return this.all('SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY updated_at DESC').map(
      this.toProject,
    )
  }

  getProject(id: string): ProjectRow | undefined {
    const r = this.get('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL', id)
    return r && this.toProject(r)
  }

  createProject(input: {
    name: string
    rootPath: string
    permissionMode?: PermissionMode
  }): ProjectRow {
    const id = newId()
    const t = this.now()
    this.run(
      `INSERT INTO projects (id, name, root_path, permission_mode, created_at, updated_at, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.name,
      input.rootPath,
      input.permissionMode ?? 'ask',
      t,
      t,
      this.deviceId,
    )
    return this.getProject(id)!
  }

  updateProject(
    id: string,
    patch: Partial<
      Pick<ProjectRow, 'name' | 'rootPath' | 'instructions' | 'defaultModelId' | 'permissionMode'>
    >,
  ): ProjectRow {
    const cur = this.getProject(id)
    if (!cur) throw new Error(`project ${id} not found`)
    const next = { ...cur, ...patch }
    this.run(
      `UPDATE projects SET name = ?, root_path = ?, instructions = ?, default_model_id = ?, permission_mode = ?,
         updated_at = ?, device_id = ? WHERE id = ?`,
      next.name,
      next.rootPath,
      next.instructions,
      next.defaultModelId,
      next.permissionMode,
      this.now(),
      this.deviceId,
      id,
    )
    return this.getProject(id)!
  }

  /** Remove a project from the app. Files on disk are never touched. */
  deleteProject(id: string): void {
    const t = this.now()
    this.transaction(() => {
      this.run(
        'UPDATE projects SET deleted_at = ?, updated_at = ?, device_id = ? WHERE id = ?',
        t,
        t,
        this.deviceId,
        id,
      )
      for (const c of this.listConversations({ projectId: id })) this.deleteConversation(c.id)
      for (const s of this.listSchedules()) if (s.projectId === id) this.deleteSchedule(s.id)
    })
  }

  // ── schedules ──────────────────────────────────────────────

  private toSchedule = (r: Row): ScheduleRow => ({
    id: r.id as string,
    name: r.name as string,
    projectId: (r.project_id as string | null) ?? null,
    prompt: r.prompt as string,
    cron: r.cron as string,
    modelId: (r.model_id as string | null) ?? null,
    enabled: r.enabled === 1,
    nextRunAt: (r.next_run_at as number | null) ?? null,
    lastRunAt: (r.last_run_at as number | null) ?? null,
    lastConversationId: (r.last_conversation_id as string | null) ?? null,
    lastError: (r.last_error as string | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  })

  listSchedules(): ScheduleRow[] {
    return this.all('SELECT * FROM schedules WHERE deleted_at IS NULL ORDER BY created_at').map(
      this.toSchedule,
    )
  }

  getSchedule(id: string): ScheduleRow | undefined {
    const r = this.get('SELECT * FROM schedules WHERE id = ? AND deleted_at IS NULL', id)
    return r && this.toSchedule(r)
  }

  createSchedule(input: ScheduleInput & { nextRunAt: number | null }): ScheduleRow {
    const id = newId()
    const t = this.now()
    this.run(
      `INSERT INTO schedules (id, name, project_id, prompt, cron, model_id, next_run_at,
         created_at, updated_at, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.name,
      input.projectId,
      input.prompt,
      input.cron,
      input.modelId,
      input.nextRunAt,
      t,
      t,
      this.deviceId,
    )
    return this.getSchedule(id)!
  }

  updateSchedule(
    id: string,
    patch: Partial<
      ScheduleInput &
        Pick<
          ScheduleRow,
          'enabled' | 'nextRunAt' | 'lastRunAt' | 'lastConversationId' | 'lastError'
        >
    >,
  ): ScheduleRow {
    const cur = this.getSchedule(id)
    if (!cur) throw new Error(`schedule ${id} not found`)
    const n = { ...cur, ...patch }
    this.run(
      `UPDATE schedules SET name = ?, project_id = ?, prompt = ?, cron = ?, model_id = ?, enabled = ?,
         next_run_at = ?, last_run_at = ?, last_conversation_id = ?, last_error = ?,
         updated_at = ?, device_id = ? WHERE id = ?`,
      n.name,
      n.projectId,
      n.prompt,
      n.cron,
      n.modelId,
      n.enabled ? 1 : 0,
      n.nextRunAt,
      n.lastRunAt,
      n.lastConversationId,
      n.lastError,
      this.now(),
      this.deviceId,
      id,
    )
    return this.getSchedule(id)!
  }

  deleteSchedule(id: string): void {
    const t = this.now()
    this.run(
      'UPDATE schedules SET deleted_at = ?, updated_at = ?, device_id = ? WHERE id = ?',
      t,
      t,
      this.deviceId,
      id,
    )
  }

  // ── conversations ──────────────────────────────────────────

  private toConversation = (r: Row): ConversationRow => ({
    id: r.id as string,
    projectId: (r.project_id as string | null) ?? null,
    title: (r.title as string | null) ?? null,
    modelId: (r.model_id as string | null) ?? null,
    systemPrompt: (r.system_prompt as string | null) ?? null,
    params: parse<ConversationParams>(r.params_json, {}),
    thinking: (r.thinking as ThinkingLevel) ?? 'off',
    activeLeafId: (r.active_leaf_id as string | null) ?? null,
    pinned: r.pinned === 1,
    worktreePath: (r.worktree_path as string | null) ?? null,
    worktreeBranch: (r.worktree_branch as string | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  })

  listConversations(opts: { search?: string; projectId?: string | null; limit?: number } = {}) {
    const where = ['c.deleted_at IS NULL']
    const params: SQLInputValue[] = []
    if (opts.projectId !== undefined) {
      if (opts.projectId === null) where.push('c.project_id IS NULL')
      else {
        where.push('c.project_id = ?')
        params.push(opts.projectId)
      }
    }
    const q = opts.search?.trim()
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
      where.push(
        `(c.title LIKE ? ESCAPE '\\' OR EXISTS (
           SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
           AND m.parts_json LIKE ? ESCAPE '\\'))`,
      )
      params.push(like, like)
    }
    params.push(opts.limit ?? 500)
    return this.all(
      `SELECT c.* FROM conversations c WHERE ${where.join(' AND ')}
       ORDER BY c.pinned DESC, c.updated_at DESC LIMIT ?`,
      ...params,
    ).map(this.toConversation)
  }

  getConversation(id: string): ConversationRow | undefined {
    const r = this.get('SELECT * FROM conversations WHERE id = ? AND deleted_at IS NULL', id)
    return r && this.toConversation(r)
  }

  createConversation(
    input: Partial<
      Pick<
        ConversationRow,
        'projectId' | 'title' | 'modelId' | 'systemPrompt' | 'params' | 'thinking'
      >
    > = {},
  ): ConversationRow {
    const id = newId()
    const t = this.now()
    this.run(
      `INSERT INTO conversations (id, project_id, title, model_id, system_prompt, params_json, thinking,
         created_at, updated_at, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.projectId ?? null,
      input.title ?? null,
      input.modelId ?? null,
      input.systemPrompt ?? null,
      JSON.stringify(input.params ?? {}),
      input.thinking ?? 'off',
      t,
      t,
      this.deviceId,
    )
    return this.getConversation(id)!
  }

  updateConversation(
    id: string,
    patch: Partial<
      Pick<
        ConversationRow,
        | 'title'
        | 'modelId'
        | 'systemPrompt'
        | 'params'
        | 'thinking'
        | 'activeLeafId'
        | 'pinned'
        | 'projectId'
        | 'worktreePath'
        | 'worktreeBranch'
      >
    >,
  ): ConversationRow {
    const cur = this.getConversation(id)
    if (!cur) throw new Error(`conversation ${id} not found`)
    const next = { ...cur, ...patch }
    this.run(
      `UPDATE conversations SET title = ?, model_id = ?, system_prompt = ?, params_json = ?, thinking = ?,
         active_leaf_id = ?, pinned = ?, project_id = ?, worktree_path = ?, worktree_branch = ?,
         updated_at = ?, device_id = ?
       WHERE id = ?`,
      next.title,
      next.modelId,
      next.systemPrompt,
      JSON.stringify(next.params),
      next.thinking,
      next.activeLeafId,
      next.pinned ? 1 : 0,
      next.projectId,
      next.worktreePath,
      next.worktreeBranch,
      this.now(),
      this.deviceId,
      id,
    )
    return this.getConversation(id)!
  }

  deleteConversation(id: string): void {
    const t = this.now()
    this.transaction(() => {
      this.run(
        'UPDATE conversations SET deleted_at = ?, updated_at = ?, device_id = ? WHERE id = ?',
        t,
        t,
        this.deviceId,
        id,
      )
      this.run(
        'UPDATE messages SET deleted_at = ?, updated_at = ?, device_id = ? WHERE conversation_id = ? AND deleted_at IS NULL',
        t,
        t,
        this.deviceId,
        id,
      )
    })
  }

  // ── messages ───────────────────────────────────────────────

  private toMessage = (r: Row): MessageRow => ({
    id: r.id as string,
    conversationId: r.conversation_id as string,
    parentId: (r.parent_id as string | null) ?? null,
    role: r.role as Role,
    parts: parse<MessagePart[]>(r.parts_json, []),
    modelId: (r.model_id as string | null) ?? null,
    usage: parse<Usage | null>(r.usage_json, null),
    status: r.status as MessageStatus,
    error: (r.error as string | null) ?? null,
    createdAt: r.created_at as number,
  })

  getMessage(id: string): MessageRow | undefined {
    const r = this.get('SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL', id)
    return r && this.toMessage(r)
  }

  /** All messages of a conversation, every branch, in creation order. */
  listMessages(conversationId: string): MessageRow[] {
    return this.all(
      'SELECT * FROM messages WHERE conversation_id = ? AND deleted_at IS NULL ORDER BY id',
      conversationId,
    ).map(this.toMessage)
  }

  /**
   * Insert a message and make it the conversation's active leaf. The
   * conversation's updated_at moves too so it floats to the top of the list.
   */
  addMessage(input: {
    conversationId: string
    parentId: string | null
    role: Role
    parts: MessagePart[]
    modelId?: string | null
    status?: MessageStatus
  }): MessageRow {
    const id = newId()
    const t = this.now()
    this.transaction(() => {
      this.run(
        `INSERT INTO messages (id, conversation_id, parent_id, role, parts_json, model_id, status,
           created_at, updated_at, device_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.conversationId,
        input.parentId,
        input.role,
        JSON.stringify(input.parts),
        input.modelId ?? null,
        input.status ?? 'complete',
        t,
        t,
        this.deviceId,
      )
      this.run(
        'UPDATE conversations SET active_leaf_id = ?, updated_at = ?, device_id = ? WHERE id = ?',
        id,
        t,
        this.deviceId,
        input.conversationId,
      )
    })
    return this.getMessage(id)!
  }

  /**
   * Finalise a message that was streaming. Messages are otherwise immutable:
   * edits and regenerations create siblings via parentId.
   */
  finishMessage(
    id: string,
    patch: {
      parts: MessagePart[]
      status: MessageStatus
      usage?: Usage | null
      error?: string | null
    },
  ): MessageRow {
    this.run(
      `UPDATE messages SET parts_json = ?, status = ?, usage_json = ?, error = ?, updated_at = ?, device_id = ?
       WHERE id = ?`,
      JSON.stringify(patch.parts),
      patch.status,
      patch.usage ? JSON.stringify(patch.usage) : null,
      patch.error ?? null,
      this.now(),
      this.deviceId,
      id,
    )
    return this.getMessage(id)!
  }

  /** Mark messages left in 'streaming' by a crash as aborted. */
  recoverStreaming(): number {
    return Number(
      this.run(
        "UPDATE messages SET status = 'aborted', updated_at = ? WHERE status = 'streaming'",
        this.now(),
      ).changes,
    )
  }

  // ── blobs ──────────────────────────────────────────────────

  addBlob(sha256: string, mime: string, size: number): void {
    this.run(
      'INSERT OR IGNORE INTO blobs (sha256, mime, size, created_at) VALUES (?, ?, ?, ?)',
      sha256,
      mime,
      size,
      this.now(),
    )
  }

  getBlob(sha256: string): { sha256: string; mime: string; size: number } | undefined {
    const r = this.get('SELECT sha256, mime, size FROM blobs WHERE sha256 = ?', sha256)
    return r && { sha256: r.sha256 as string, mime: r.mime as string, size: r.size as number }
  }

  // ── image jobs ─────────────────────────────────────────────

  private toImageJob = (r: Row): ImageJobRow => ({
    id: r.id as string,
    prompt: r.prompt as string,
    params: parse<ImageJobParams>(r.params_json, {}),
    modelId: (r.model_id as string | null) ?? null,
    sourceBlobIds: parse<string[]>(r.source_blob_ids, []),
    resultBlobIds: parse<string[]>(r.result_blob_ids, []),
    status: r.status as ImageJobStatus,
    error: (r.error as string | null) ?? null,
    usage: parse<Usage | null>(r.usage_json, null),
    createdAt: r.created_at as number,
  })

  listImageJobs(limit = 200): ImageJobRow[] {
    return this.all(
      'SELECT * FROM image_jobs WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ?',
      limit,
    ).map(this.toImageJob)
  }

  getImageJob(id: string): ImageJobRow | undefined {
    const r = this.get('SELECT * FROM image_jobs WHERE id = ? AND deleted_at IS NULL', id)
    return r && this.toImageJob(r)
  }

  createImageJob(input: {
    prompt: string
    params: ImageJobParams
    modelId: string
    sourceBlobIds: string[]
  }): ImageJobRow {
    const id = newId()
    const t = this.now()
    this.run(
      `INSERT INTO image_jobs (id, prompt, params_json, model_id, source_blob_ids, status, created_at, updated_at, device_id)
       VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
      id,
      input.prompt,
      JSON.stringify(input.params),
      input.modelId,
      JSON.stringify(input.sourceBlobIds),
      t,
      t,
      this.deviceId,
    )
    return this.getImageJob(id)!
  }

  finishImageJob(
    id: string,
    patch: { status: ImageJobStatus; resultBlobIds?: string[]; error?: string; usage?: Usage },
  ): ImageJobRow {
    this.run(
      `UPDATE image_jobs SET status = ?, result_blob_ids = ?, error = ?, usage_json = ?, updated_at = ?, device_id = ?
       WHERE id = ?`,
      patch.status,
      JSON.stringify(patch.resultBlobIds ?? []),
      patch.error ?? null,
      patch.usage ? JSON.stringify(patch.usage) : null,
      this.now(),
      this.deviceId,
      id,
    )
    return this.getImageJob(id)!
  }

  /** Merge into a job's params (video progress, remote id). */
  updateImageJobParams(id: string, patch: Partial<ImageJobParams>): ImageJobRow {
    const job = this.getImageJob(id)
    if (!job) throw new Error(`job ${id} not found`)
    this.run(
      'UPDATE image_jobs SET params_json = ?, updated_at = ?, device_id = ? WHERE id = ?',
      JSON.stringify({ ...job.params, ...patch }),
      this.now(),
      this.deviceId,
      id,
    )
    return this.getImageJob(id)!
  }

  /** Video jobs that were still generating when the app quit, with a remote id to resume. */
  resumableVideoJobs(): ImageJobRow[] {
    return this.all(
      "SELECT * FROM image_jobs WHERE deleted_at IS NULL AND status IN ('pending', 'running')",
    )
      .map(this.toImageJob)
      .filter((j) => j.params.kind === 'video' && !!j.params.remoteId)
  }

  deleteImageJob(id: string): void {
    const t = this.now()
    this.run(
      'UPDATE image_jobs SET deleted_at = ?, updated_at = ?, device_id = ? WHERE id = ?',
      t,
      t,
      this.deviceId,
      id,
    )
  }

  /** Fail jobs interrupted by a quit, except video jobs that can resume polling. */
  recoverImageJobs(): number {
    let n = 0
    for (const r of this.all("SELECT * FROM image_jobs WHERE status IN ('pending', 'running')").map(
      this.toImageJob,
    )) {
      if (r.params.kind === 'video' && r.params.remoteId) continue
      this.run(
        "UPDATE image_jobs SET status = 'error', error = '应用在生成过程中退出', updated_at = ? WHERE id = ?",
        this.now(),
        r.id,
      )
      n++
    }
    return n
  }

  // ── trusted devices ────────────────────────────────────────
  // Local trust only: these rows are never exported or synced.

  private toDevice = (r: Row): TrustedDeviceRow => ({
    deviceId: r.device_id as string,
    name: r.name as string,
    platform: (r.platform as string | null) ?? null,
    publicKey: r.public_key as string,
    pairedAt: r.paired_at as number,
    lastSeen: (r.last_seen as number | null) ?? null,
  })

  listTrustedDevices(): TrustedDeviceRow[] {
    return this.all(
      'SELECT * FROM trusted_devices WHERE revoked_at IS NULL ORDER BY paired_at',
    ).map(this.toDevice)
  }

  getTrustedDevice(deviceId: string): TrustedDeviceRow | undefined {
    const r = this.get(
      'SELECT * FROM trusted_devices WHERE device_id = ? AND revoked_at IS NULL',
      deviceId,
    )
    return r && this.toDevice(r)
  }

  trustDevice(input: {
    deviceId: string
    name: string
    platform: string | null
    publicKey: string
  }): TrustedDeviceRow {
    this.run(
      `INSERT INTO trusted_devices (device_id, name, platform, public_key, paired_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET name = excluded.name, platform = excluded.platform,
         public_key = excluded.public_key, paired_at = excluded.paired_at, revoked_at = NULL`,
      input.deviceId,
      input.name,
      input.platform,
      input.publicKey,
      this.now(),
    )
    return this.getTrustedDevice(input.deviceId)!
  }

  revokeDevice(deviceId: string): void {
    this.run('UPDATE trusted_devices SET revoked_at = ? WHERE device_id = ?', this.now(), deviceId)
  }

  touchDevice(deviceId: string): void {
    this.run('UPDATE trusted_devices SET last_seen = ? WHERE device_id = ?', this.now(), deviceId)
  }

  // ── settings ───────────────────────────────────────────────

  getSetting<T>(key: string, fallback: T): T {
    const r = this.get('SELECT value_json FROM settings WHERE key = ?', key)
    return r ? parse<T>(r.value_json, fallback) : fallback
  }

  setSetting(key: string, value: unknown): void {
    this.run(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      key,
      JSON.stringify(value),
      this.now(),
    )
  }
}

/** Walk parent links from a leaf up to the root, returned root-first. */
export function pathToLeaf<T extends { id: string; parentId: string | null }>(
  messages: T[],
  leafId: string | null,
): T[] {
  if (!leafId) return []
  const byId = new Map(messages.map((m) => [m.id, m]))
  const path: T[] = []
  const seen = new Set<string>()
  let cur = byId.get(leafId)
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    path.push(cur)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return path.reverse()
}

/** Follow the newest child at each step, to land on a leaf after switching branches. */
export function newestLeafFrom<T extends { id: string; parentId: string | null }>(
  messages: T[],
  startId: string,
): string {
  const children = new Map<string, T[]>()
  for (const m of messages) {
    if (!m.parentId) continue
    const list = children.get(m.parentId) ?? []
    list.push(m)
    children.set(m.parentId, list)
  }
  let id = startId
  for (;;) {
    const kids = children.get(id)
    if (!kids?.length) return id
    id = kids.reduce((a, b) => (a.id > b.id ? a : b)).id
  }
}
