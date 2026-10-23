import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({}))
const { isValidAccelerator } = await import('./shell-integration')

describe('isValidAccelerator', () => {
  it.each(['Alt+Space', 'Control+Alt+Space', 'CommandOrControl+Shift+K', 'F12', 'Command+/'])(
    'accepts %s',
    (a) => expect(isValidAccelerator(a)).toBe(true),
  )
  it.each(['Nope+Q', 'Q', 'Alt+', 'Alt+Alt+K', 'Control+Banana', ''])('rejects %s', (a) =>
    expect(isValidAccelerator(a)).toBe(false),
  )
})
