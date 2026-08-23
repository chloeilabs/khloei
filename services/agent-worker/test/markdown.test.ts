import { describe, expect, test } from 'bun:test'

import { normalizeComputerMarkdown } from '../../../shared/markdown'

describe('computer response Markdown', () => {
  test('repairs an invalid inline language fence and its stray closer', () => {
    const malformed = [
      '- **Visible heading:** "Example Domain" (an ````html',
      '<h1>`)',
      '',
      'The page is intended for documentation examples.',
      '```',
    ].join('\n')

    expect(normalizeComputerMarkdown(malformed)).toBe(
      [
        '- **Visible heading:** "Example Domain" (an `<h1>`)',
        '',
        'The page is intended for documentation examples.',
      ].join('\n'),
    )
  })

  test('leaves valid triple- and four-backtick code fences unchanged', () => {
    const valid = [
      '```html',
      '<h1>Example</h1>',
      '```',
      '',
      '````markdown',
      '```ts',
      'const title = "Example"',
      '```',
      '````',
    ].join('\n')

    expect(normalizeComputerMarkdown(valid)).toBe(valid)
  })
})
