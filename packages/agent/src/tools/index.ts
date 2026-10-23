import { askUserTool } from './ask'
import { bashTool } from './bash'
import { editFileTool, grepTool, listFilesTool, readFileTool, writeFileTool } from './fs'
import { generateImageTool } from './image'
import { bashOutputTool, killJobTool } from './jobs'
import { webSearchTool } from './search'
import { skillTool } from './skill'
import { taskTool } from './task'
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
  bashOutputTool,
  killJobTool,
  webSearchTool,
  webFetchTool,
  generateImageTool,
  todoTool,
  askUserTool,
  skillTool,
  taskTool,
] as AgentTool<never>[]

export {
  askUserTool,
  bashOutputTool,
  bashTool,
  killJobTool,
  editFileTool,
  generateImageTool,
  grepTool,
  listFilesTool,
  readFileTool,
  skillTool,
  taskTool,
  todoTool,
  webFetchTool,
  webSearchTool,
  writeFileTool,
}
export { BROWSER_TOOLS } from './browser'
export type { BrowserCommand, BrowserReply } from './browser'
export { computerDisplayTool, computerTool } from './computer'
export type { ComputerInput } from './computer'
export type { Todo } from './todo'
export * from './types'
