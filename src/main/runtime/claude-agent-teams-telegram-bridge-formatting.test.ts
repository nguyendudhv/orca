import { describe, expect, it } from 'vitest'
import {
  chunkTelegramMessage,
  diffNewTailLines,
  stripAnsiEscapeCodes
} from './claude-agent-teams-telegram-bridge-formatting'

describe('stripAnsiEscapeCodes', () => {
  it('removes CSI color/cursor sequences', () => {
    expect(stripAnsiEscapeCodes('\x1B[32mhello\x1B[0m world')).toBe('hello world')
  })

  it('removes OSC title sequences terminated by BEL or ST', () => {
    expect(stripAnsiEscapeCodes('\x1B]0;window title\x07prompt$ ')).toBe('prompt$ ')
    expect(stripAnsiEscapeCodes('\x1B]0;window title\x1B\\prompt$ ')).toBe('prompt$ ')
  })

  it('removes charset designation and bare Fe escapes', () => {
    expect(stripAnsiEscapeCodes('\x1B(Bsome text')).toBe('some text')
  })

  it('leaves plain text untouched', () => {
    expect(stripAnsiEscapeCodes('no escapes here')).toBe('no escapes here')
  })
})

describe('diffNewTailLines', () => {
  it('returns the whole tail when there is no previous baseline', () => {
    expect(diffNewTailLines([], ['a', 'b'])).toEqual(['a', 'b'])
  })

  it('returns only lines appended past the previous scrollback overlap', () => {
    const previous = ['one', 'two', 'three']
    const next = ['two', 'three', 'four', 'five']
    expect(diffNewTailLines(previous, next)).toEqual(['four', 'five'])
  })

  it('returns an empty array when nothing changed', () => {
    const previous = ['one', 'two', 'three']
    expect(diffNewTailLines(previous, previous)).toEqual([])
  })

  it('returns the full next tail when scrollback has no overlap at all', () => {
    expect(diffNewTailLines(['old line'], ['unrelated', 'content'])).toEqual([
      'unrelated',
      'content'
    ])
  })
})

describe('chunkTelegramMessage', () => {
  it('returns a single chunk for short text', () => {
    expect(chunkTelegramMessage('hello')).toEqual(['hello'])
  })

  it('splits long text into bounded chunks that reassemble losslessly', () => {
    const text = 'x'.repeat(9000)
    const chunks = chunkTelegramMessage(text)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(3500)
    }
    expect(chunks.join('')).toBe(text)
  })
})
