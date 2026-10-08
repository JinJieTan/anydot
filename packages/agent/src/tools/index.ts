import { bashTool } from './bash'
import { editFileTool, grepTool, listFilesTool, readFileTool, writeFileTool } from './fs'
import { generateImageTool } from './image'
import { todoTool } from './todo'
import type { AgentTool } from './types'
import { webFetchTool } from './web'

export const ALL_TOOLS: AgentTool<never>[] = [
  readFileTool,
  listFilesTool,
  grepTool,
  editFileTool,
  writeFileTool,
  bashTool,
  webFetchTool,
  generateImageTool,
  todoTool,
] as AgentTool<never>[]

export {
  bashTool,
  editFileTool,
  generateImageTool,
  grepTool,
  listFilesTool,
  readFileTool,
  todoTool,
  webFetchTool,
  writeFileTool,
}
export type { Todo } from './todo'
export * from './types'
