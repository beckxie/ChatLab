import assert from 'node:assert/strict'
import { test } from 'node:test'

const { AgentSessionLog, getAgentSessionLog, buildAgentSessionLogKey } = await import('./sessionLog.ts')

test('bootstrap history and append nodes', () => {
  const log = new AgentSessionLog('session-a')
  log.bootstrapFromHistoryIfEmpty([
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'system', content: 'ignored' },
  ])

  const snapshot = log.getSnapshot()
  assert.equal(snapshot.nodeCount, 2)
  assert.equal(snapshot.headNodeId !== null, true)

  const promptHistory = log.getPromptHistory(10)
  assert.deepEqual(
    promptHistory.map((item) => `${item.role}:${item.content}`),
    ['user:u1', 'assistant:a1']
  )
})

test('context_tag marks current head when target is omitted', () => {
  const log = new AgentSessionLog('session-b')
  log.append('user', 'step1')
  const head = log.append('assistant', 'step2')
  assert.ok(head)

  const tagResult = log.tag('milestone')
  assert.equal(tagResult.success, true)
  assert.equal(tagResult.nodeId, head.id)

  const snapshot = log.getSnapshot()
  assert.equal(snapshot.tagCount, 1)
  assert.equal(snapshot.segmentSize, 0)
})

test('context_checkout applies anchor for next-turn prompt history', () => {
  const log = new AgentSessionLog('session-c')
  const n1 = log.append('user', 'phase-1')
  const n2 = log.append('assistant', 'phase-1 done')
  log.append('user', 'phase-2 question')
  log.append('assistant', 'phase-2 answer')

  assert.ok(n1)
  assert.ok(n2)
  const tagResult = log.tag('phase1', n2.id)
  assert.equal(tagResult.success, true)

  const checkout = log.checkout('phase1', 'keep only phase1 branch')
  assert.equal(checkout.success, true)
  assert.equal(checkout.toNodeId, n2.id)

  const notes = log.consumePendingSystemNotes()
  assert.equal(notes.length, 1)
  assert.match(notes[0], /phase1 branch/i)
  assert.equal(log.consumePendingSystemNotes().length, 0)

  const promptHistory = log.getPromptHistory(10)
  assert.equal(promptHistory.length, 3)
  assert.equal(promptHistory[0].content, 'phase-1 done')
})

test('context_log payload includes usage and snapshot metrics', () => {
  const log = new AgentSessionLog('session-d')
  log.append('user', 'hello')
  log.append('assistant', 'world')

  const payload = log.buildContextLogPayload(
    {
      contextTokens: 256,
      contextWindow: 1024,
      contextUsage: 0.25,
      totalUsage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    },
    6
  )

  assert.equal(payload.snapshot.nodeCount, 2)
  assert.match(payload.dashboard, /context_key=session-d/)
  assert.match(payload.dashboard, /usage=256\/1024 \(25%\), total=30/)
})

test('overflow pruning keeps size bound and clears removed tags', () => {
  const log = new AgentSessionLog('session-e', 3, 8)
  const n1 = log.append('user', 'n1')
  log.append('assistant', 'n2')
  log.append('user', 'n3')
  assert.ok(n1)
  assert.equal(log.tag('old_tag', n1.id).success, true)

  log.append('assistant', 'n4')
  const snapshot = log.getSnapshot()

  assert.equal(snapshot.nodeCount, 3)
  assert.equal(snapshot.tagCount, 0)
})

test('overflow pruning clears stale checkouts and rehomes anchor', () => {
  const log = new AgentSessionLog('session-f', 3, 8)
  const n1 = log.append('user', 'n1')
  const n2 = log.append('assistant', 'n2')
  log.append('user', 'n3')

  assert.ok(n1)
  assert.ok(n2)
  assert.equal(log.checkout(n1.id, 'focus on first branch').success, true)

  log.append('assistant', 'n4')
  const snapshot = log.getSnapshot()
  const promptHistory = log.getPromptHistory(10)

  assert.equal(snapshot.nodeCount, 3)
  assert.equal(snapshot.checkoutCount, 0)
  assert.notEqual(snapshot.activeAnchorNodeId, n1.id)
  assert.equal(promptHistory[0].content, 'n3')
})

test('session log registry is isolated by session+conversation key', () => {
  const keyA = buildAgentSessionLogKey('s1', 'c1')
  const keyB = buildAgentSessionLogKey('s1', 'c2')
  assert.notEqual(keyA, keyB)

  const a1 = getAgentSessionLog('s1', 'c1')
  const a2 = getAgentSessionLog('s1', 'c1')
  const b1 = getAgentSessionLog('s1', 'c2')

  assert.equal(a1, a2)
  assert.notEqual(a1, b1)
})
