import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { expandCommand, loadSkills, parseFrontmatter, readSkill } from './skills'

async function put(path: string, text: string) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, text)
}

describe('skills', () => {
  it('parses frontmatter', () => {
    const { meta, body } = parseFrontmatter('---\nname: x\ndescription: "Does y"\n---\nBody')
    expect(meta).toEqual({ name: 'x', description: 'Does y' })
    expect(body).toBe('Body')
    expect(parseFrontmatter('no fm').body).toBe('no fm')
  })

  it('loads project and user skills and commands; project shadows user', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aitech-skills-'))
    const project = join(root, 'proj')
    const home = join(root, 'home')
    await put(
      join(project, '.claude/skills/deploy/SKILL.md'),
      '---\nname: deploy\ndescription: Project deploy\n---\nRun the deploy.',
    )
    await put(
      join(home, '.claude/skills/deploy/SKILL.md'),
      '---\ndescription: User deploy\n---\nOther.',
    )
    await put(join(home, '.aitech/skills/pdf/SKILL.md'), '# Work with PDFs\nSteps…')
    await put(
      join(home, '.claude/commands/review.md'),
      '---\ndescription: Review code\nargument-hint: <file>\n---\nReview $ARGUMENTS carefully.',
    )
    await put(join(project, '.aitech/commands/hello.md'), 'Say hello.')

    const all = await loadSkills(project, home)
    expect(all.map((s) => `${s.kind}:${s.name}:${s.scope}`)).toEqual([
      'skill:deploy:project',
      'command:hello:project',
      'skill:pdf:user',
      'command:review:user',
    ])
    expect(all.find((s) => s.name === 'pdf')!.description).toBe('Work with PDFs')
    expect(all.find((s) => s.name === 'review')!.argumentHint).toBe('<file>')

    // Plain chats only see the user's own.
    expect((await loadSkills(null, home)).map((s) => s.name)).toEqual(['deploy', 'pdf', 'review'])

    const review = all.find((s) => s.name === 'review')!
    expect(await expandCommand(review, ' src/a.ts ')).toBe('Review src/a.ts carefully.')
    const hello = all.find((s) => s.name === 'hello')!
    expect(await expandCommand(hello, 'world')).toBe('Say hello.\n\nARGUMENTS: world')
    const deploy = all.find((s) => s.name === 'deploy')!
    expect(await readSkill(deploy)).toContain('Run the deploy.')
    expect(await readSkill(deploy)).toContain(join(project, '.claude/skills/deploy'))
    expect(await expandCommand(deploy, 'prod')).toMatch(/Run the deploy\.\n\nARGUMENTS: prod$/)
  })
})
