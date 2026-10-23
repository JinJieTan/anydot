import { describe, expect, it } from 'vitest'
import { artifactKind, artifactPage } from './artifact'

describe('artifacts', () => {
  it('maps languages and extensions', () => {
    expect(artifactKind('HTML')).toBe('html')
    expect(artifactKind('.mmd')).toBe('mermaid')
    expect(artifactKind('md')).toBe('markdown')
    expect(artifactKind('ts')).toBeNull()
  })

  it('wraps mermaid source safely', () => {
    const page = artifactPage({ title: 'x', kind: 'mermaid', content: 'A-->B</pre><script>' }, true)
    expect(page).toContain('A-->B&lt;/pre>&lt;script>')
    expect(page).toContain("theme: 'dark'")
  })

  it('serves html as is', () => {
    expect(artifactPage({ title: 'x', kind: 'html', content: '<p>hi</p>' }, false)).toBe(
      '<p>hi</p>',
    )
  })
})
