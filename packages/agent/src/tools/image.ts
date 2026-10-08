import { mkdir, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { generateImages } from '@aitech/core'
import { resolvePath } from '../paths'
import { str, type AgentTool } from './types'

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

function slug(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32)
  return s || 'image'
}

export const generateImageTool: AgentTool<{
  prompt: string
  size?: string
  quality?: string
  n?: number
  output_dir?: string
}> = {
  kind: 'image',
  definition: {
    name: 'generate_image',
    description:
      'Generate images with the configured image model (e.g. gpt-image-2) and save them as files in the ' +
      'project. Returns the saved paths. Costs money; only use when the user wants images.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed description of the image' },
        size: { type: 'string', enum: ['1024x1024', '1536x1024', '1024x1536', 'auto'] },
        quality: { type: 'string', enum: ['low', 'medium', 'high', 'auto'] },
        n: { type: 'number', description: 'Number of images, 1-4' },
        output_dir: { type: 'string', description: 'Directory to save into (default: generated)' },
      },
      required: ['prompt'],
    },
  },
  describe: (i) => `生成图片：${i.prompt.slice(0, 40)}`,
  paths: (i) => [i.output_dir ?? 'generated'],
  async run(input, ctx) {
    if (!ctx.imageModel) {
      return {
        output:
          'No image model is configured. Ask the user to set a default image model in settings.',
        isError: true,
      }
    }
    const prompt = str(input.prompt, 'prompt')
    const n = Math.min(4, Math.max(1, Math.floor(input.n ?? 1)))
    const res = await generateImages({
      baseUrl: ctx.imageModel.provider.baseUrl,
      apiKey: ctx.imageModel.provider.apiKey,
      model: ctx.imageModel.modelId,
      prompt,
      size: input.size && input.size !== 'auto' ? input.size : undefined,
      quality: input.quality && input.quality !== 'auto' ? input.quality : undefined,
      n,
      signal: ctx.signal,
    })
    const { abs: dir } = resolvePath(ctx.cwd, input.output_dir ?? 'generated')
    await mkdir(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const saved: string[] = []
    for (const [i, img] of res.images.entries()) {
      const file = join(
        dir,
        `${slug(prompt)}-${stamp}${res.images.length > 1 ? `-${i + 1}` : ''}.${EXT[img.mime] ?? 'png'}`,
      )
      await writeFile(file, img.data)
      saved.push(relative(ctx.cwd, file).split('\\').join('/'))
    }
    return { output: `Saved ${saved.length} image(s):\n${saved.join('\n')}` }
  },
}
