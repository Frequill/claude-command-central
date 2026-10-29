import { describe, expect, test } from 'claude-code/testing'

import { createInbox, promptFor, readMessage, waiting } from '../hooks/inbox'
import type { InboxIo } from '../hooks/inbox'

const file = (name: string) => ({ name, kind: 'file' })

function fakeInbox(files: Record<string, string>) {
  const sent: string[] = []
  const written: string[] = []
  const steps: string[] = []
  const io: InboxIo = {
    dir: '/h/.claude/ccc/inbox/s1',
    exists: async () => true,
    list: async () => Object.keys(files).map(file),
    read: async path => {
      const name = path.split('/').pop() as string
      if (!(name in files)) throw new Error('missing')
      return files[name] as string
    },
    write: async (path, text) => {
      written.push(path.split('/').pop() as string)
      files[path.split('/').pop() as string] = text
    },
    submit: async text => {
      sent.push(text)
      steps.push(`submit ${text}`)
    },
    interrupt: async at => void steps.push(at === 42 ? 'interrupt' : `interrupt at ${at}`),
    now: async () => 42,
  }
  return { io, sent, written, steps }
}

describe('messages from the chat window', () => {
  test('only messages not yet taken wait, oldest first', async () => {
    const entries = [file('2000-bb.json'), file('1000-aa.json'), file('1000-aa.taken'), file('3000-cc.json'), file('notes.txt'), file('../x.json'), { name: '4000-dd.json', kind: 'dir' }]
    expect(waiting(entries)).toEqual(['2000-bb', '3000-cc'])
  })

  test('a stored message is read with care', async () => {
    expect(readMessage('{"text": " hi ", "images": ["/u/a.png", 5, "relative.png"]}')).toEqual({ text: 'hi', images: ['/u/a.png'], mode: 'queue' })
    expect(readMessage('{"text": "now", "mode": "now"}')?.mode).toBe('now')
    expect(readMessage('{"text": "later", "mode": "whenever"}')?.mode).toBe('queue')
    expect(readMessage('{"text": "", "images": []}')).toBeUndefined()
    expect(readMessage('not json')).toBeUndefined()
    expect(readMessage('[]')).toBeUndefined()
  })

  test('Stop on the agent map ends that run and goes in as no message', async () => {
    expect(readMessage('{"stopRun": "toolu_01AB", "at": 7}')).toEqual({ text: '', images: [], mode: 'now', stopRun: 'toolu_01AB', at: 7 })
    expect(readMessage('{"stopRun": "../x"}')).toBeUndefined()
    const { io, sent, steps } = fakeInbox({ '1000-aa.json': '{"stopRun": "toolu_01AB"}', '2000-bb.json': '{"text": "next"}' })
    const stopped: string[] = []
    const inbox = createInbox({ ...io, stopRun: async id => void stopped.push(id) })
    await inbox.check()
    expect(stopped).toEqual(['toolu_01AB'])
    // the turn is not stopped for it, and the next message goes in as usual
    expect(steps.filter(step => step.startsWith('interrupt'))).toEqual([])
    await Promise.resolve()
    expect(sent).toEqual(['next'])
  })

  test('images are named in the prompt so Claude can open them', async () => {
    expect(promptFor({ text: 'What do you see?', images: [], mode: 'queue' })).toBe('What do you see?')
    expect(promptFor({ text: 'What do you see?', images: ['/u/a.png', '/u/b.jpg'], mode: 'queue' })).toBe('What do you see?\n\nImages I added (open them with the Read tool):\n- /u/a.png\n- /u/b.jpg')
    expect(promptFor({ text: '', images: ['/u/a.png'], mode: 'now' })).toBe('Images I added (open them with the Read tool):\n- /u/a.png')
  })

  test('any other dropped file is named before the images', async () => {
    expect(readMessage('{"text": "", "files": ["/u/notes.txt", "rel.txt"]}')).toEqual({ text: '', images: [], files: ['/u/notes.txt'], mode: 'queue' })
    expect(promptFor({ text: 'Read', images: ['/u/a.png'], files: ['/u/notes.txt'], mode: 'queue' })).toBe(
      'Read\n\nFiles I added (open them with the Read tool):\n- /u/notes.txt\n\nImages I added (open them with the Read tool):\n- /u/a.png',
    )
  })

  test('a queued message waits in the inbox while Claude works; Send now (mode now) goes in at once', async () => {
    const fake = fakeInbox({ '1000-aa.json': '{"text": "later", "mode": "queue"}', '2000-bb.json': '{"text": "now", "mode": "now"}' })
    let busy = true
    fake.io.isBusy = async () => busy
    const inbox = createInbox(fake.io)
    expect(await inbox.check()).toBe(1)
    expect(fake.steps).toEqual(['interrupt', 'submit now'])
    expect(fake.written).toEqual(['2000-bb.taken'])
    expect(await inbox.check()).toBe(0)
    busy = false
    expect(await inbox.check()).toBe(1)
    expect(fake.sent).toEqual(['now', 'later'])
  })

  test('once a queued message goes in, the next waits for the turn it starts', async () => {
    const fake = fakeInbox({ '1000-aa.json': '{"text": "one"}', '2000-bb.json': '{"text": "two"}' })
    fake.io.isBusy = async () => false
    const inbox = createInbox(fake.io)
    expect(await inbox.check()).toBe(1)
    expect(fake.sent).toEqual(['one'])
  })

  test('each message is sent once, in order, and marked taken before it is sent', async () => {
    const fake = fakeInbox({ '2000-bb.json': '{"text": "second"}', '1000-aa.json': '{"text": "first"}' })
    const inbox = createInbox(fake.io)
    expect(await inbox.check()).toBe(2)
    expect(fake.sent).toEqual(['first', 'second'])
    expect(fake.written).toEqual(['1000-aa.taken', '2000-bb.taken'])
    expect(await inbox.check()).toBe(0)
    expect(fake.sent).toHaveLength(2)
  })

  test('a broken message is set aside, and a missing inbox is no error', async () => {
    const fake = fakeInbox({ '1000-aa.json': '{broken' })
    expect(await createInbox(fake.io).check()).toBe(0)
    expect(fake.written).toEqual(['1000-aa.taken'])
    const nothing = createInbox({ ...fake.io, list: async () => { throw new Error('no folder') } })
    expect(await nothing.check()).toBe(0)
    let listed = false
    const empty = createInbox({ ...fake.io, exists: async () => false, list: async () => { listed = true; return [] } })
    expect(await empty.check()).toBe(0)
    expect(listed).toBe(false)
  })

  test('a message that has not gone in yet holds up none after it', async () => {
    const handed: string[] = []
    const files: Record<string, string> = { '1000-aa.json': '{"text": "first"}' }
    const fake = fakeInbox(files)
    const waiting = createInbox({ ...fake.io, submit: text => { handed.push(text); return new Promise(() => {}) } })
    expect(await waiting.check()).toBe(1)
    files['2000-bb.json'] = '{"text": "second"}'
    expect(await waiting.check()).toBe(1)
    expect(handed).toEqual(['first', 'second'])
  })

  test('a message to go in at once stops Claude first; one to queue leaves Claude working', async () => {
    const fake = fakeInbox({ '1000-aa.json': '{"text": "later", "mode": "queue"}', '2000-bb.json': '{"text": "now", "mode": "now"}' })
    expect(await createInbox(fake.io).check()).toBe(2)
    expect(fake.steps).toEqual(['submit later', 'interrupt', 'submit now'])
  })

  test('a stop ends the running turn and sends nothing', async () => {
    const fake = fakeInbox({ '1000-aa.json': '{"text": "later", "mode": "queue"}', '2000-bb.json': '{"id": "2000-bb", "stop": true}', '3000-cc.json': '{"stop": true, "at": 900}' })
    expect(readMessage('{"stop": true}')).toEqual({ text: '', images: [], mode: 'now', isStop: true })
    expect(await createInbox(fake.io).check()).toBe(1)
    // a stop says when it was asked, so the mod ends only a turn that ran then
    expect(fake.steps).toEqual(['submit later', 'interrupt', 'interrupt at 900'])
    expect(fake.written).toEqual(['1000-aa.taken', '2000-bb.taken', '3000-cc.taken'])
  })

  test('a stop that fails still lets the message go in', async () => {
    const fake = fakeInbox({ '1000-aa.json': '{"text": "now", "mode": "now"}' })
    const stubborn = createInbox({ ...fake.io, interrupt: () => Promise.reject(new Error('not running')) })
    expect(await stubborn.check()).toBe(1)
    expect(fake.sent).toEqual(['now'])
  })

  test('a failed hand-over is no error for the inbox', async () => {
    const fake = fakeInbox({ '1000-aa.json': '{"text": "hi"}' })
    const failing = createInbox({ ...fake.io, submit: () => Promise.reject(new Error('busy')) })
    expect(await failing.check()).toBe(1)
  })
})
