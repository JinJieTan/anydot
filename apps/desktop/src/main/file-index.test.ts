import { describe, expect, it } from 'vitest'
import { rank } from './file-index'

describe('rank', () => {
  const files = [
    'src/',
    'src/main/',
    'src/main/index.ts',
    'src/app.tsx',
    'docs/index.md',
    'README.md',
  ]

  it('orders name prefix, name substring, path substring, then fuzzy', () => {
    expect(rank(files, 'index', 10)).toEqual(['docs/index.md', 'src/main/index.ts'])
    expect(rank(files, 'main', 10)).toEqual(['src/main/', 'src/main/index.ts'])
    expect(rank(files, 'smi', 10)).toEqual(['src/main/', 'src/main/index.ts'])
  })

  it('lists top-level entries for an empty query', () => {
    expect(rank(files, '', 10)).toEqual(['src/', 'README.md'])
  })
})
