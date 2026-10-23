import { readSkill, type Skill } from '../skills'
import { str, type AgentTool } from './types'

export const skillTool: AgentTool<{ name: string }> = {
  kind: 'meta',
  definition: {
    name: 'skill',
    description:
      'Load a skill: specialised instructions (and bundled files) for a kind of task. ' +
      'The available skills are listed in the system prompt; load the matching one before starting such a task.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Skill name from the list' } },
      required: ['name'],
    },
  },
  describe: (input) => `加载技能 ${input.name}`,
  async run(input, ctx) {
    const name = str(input.name, 'name')
    const skill = ctx.skills?.find((s: Skill) => s.kind === 'skill' && s.name === name)
    if (!skill) return { output: `No skill named "${name}".`, isError: true }
    return { output: await readSkill(skill) }
  },
}
