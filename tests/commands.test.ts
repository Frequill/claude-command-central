import { describe, expect, test } from 'claude-code/testing'

import { commandSheet, slashOf } from '../hooks/commands'

describe('slash commands written in CCC', () => {
  test('a slash command is its name and what follows it', () => {
    expect(slashOf('/caveman')).toEqual({ command: 'caveman', args: '' })
    expect(slashOf('  /model opus  ')).toEqual({ command: 'model', args: 'opus' })
    expect(slashOf('/anthropic-skills:pdf merge these\nplease')).toEqual({ command: 'anthropic-skills:pdf', args: 'merge these\nplease' })
  })

  test('plain words, or a path, are no command', () => {
    expect(slashOf('hello /model')).toBeUndefined()
    expect(slashOf('/')).toBeUndefined()
    expect(slashOf('/Users/me/file.txt is broken')).toBeUndefined()
  })

  test('the board gets each command plainly, and the models /model takes', () => {
    const sheet = commandSheet([{ name: 'caveman', description: 'Talk less', source: 'plugin', plugin: 'caveman' } as never], ['default', 'opus'])
    expect(sheet).toEqual({ commands: [{ name: 'caveman', description: 'Talk less', source: 'plugin' }], models: ['default', 'opus'] })
    expect(commandSheet([], undefined).models).toEqual([])
  })
})
