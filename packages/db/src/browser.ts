/**
 * Entry for the web app: everything here runs in a browser (no Node imports).
 * `openDatabase` and pre-migration backups stay in index.ts, which needs node:sqlite.
 */
export { migrations } from './migrations'
export { migrate, schemaVersion } from './schema'
export type { SqlDatabase, SqlStatement, SqlValue } from './sql'
export { Store, newestLeafFrom, pathToLeaf } from './store'
export type {
  ConversationParams,
  ConversationRow,
  ImageJobParams,
  ImageJobRow,
  ImageJobStatus,
  MessageRow,
  ModelRow,
  PermissionMode,
  ProjectRow,
  ProviderRow,
  ScheduleInput,
  ScheduleRow,
  TrustedDeviceRow,
} from './store'
