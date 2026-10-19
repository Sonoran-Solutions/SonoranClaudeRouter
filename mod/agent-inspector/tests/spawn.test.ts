import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// The test's own `on('agent.spawn')` sits beneath the plugin: it stands for
// the engine starting the subagent, and counts how often it is reached.

const NOW = Date.UTC(2026, 9, 19, 17, 20, 0)

/** Records the plugin's `$.state` writes (the test's hook sits beneath it). */
function watchState(on: On): Map<string, unknown> {
  const values = new Map<string, unknown>()
  on('state.set', ($, e, next) => {
    const ref = e as unknown as { key: string; id?: string; value: unknown }
    values.set(ref.id === undefined ? ref.key : `${ref.key}:${ref.id}`, ref.value)
    return next(e)
  })
  return values
}

const SPAWN = {
  tool_use_id: 'toolu_1',
  prompt: 'Look around the repo.',
  description: 'look around',
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' as const },
  parentModel: 'claude-parent',
  background: true,
  fork: false,
}

test('normal path: forwarded exactly once, result unchanged, agent recorded', async ($, on) => {
  mock.clock(on, { now: NOW })
  const state = watchState(on)
  let calls = 0
  on('agent.spawn', () => {
    calls += 1
    return { model: 'claude-x', agentId: 'agent-1' }
  })
  const result = await $.agent.spawn(SPAWN)
  expect(calls).toBe(1)
  expect(result).toEqual({ model: 'claude-x', agentId: 'agent-1' })
  const value = state.get('claude') as { id: string }[] | undefined
  expect(value?.[0]).toMatchObject({
    id: 'agent-1', type: 'Explore', model: 'claude-x', description: 'look around', status: 'spawned', spawnedAt: NOW,
  })
})

test('the launch rejects: forwarded exactly once, the rejection reaches the caller unchanged', async ($, on) => {
  mock.clock(on, { now: NOW })
  const state = watchState(on)
  let calls = 0
  // A throwing hook is skipped by the kit, so the launch beneath ends in the
  // kit's own rejection ("no implementation"): that is the error the caller
  // must see, and a second dispatch would run this hook a second time.
  on('agent.spawn', () => {
    calls += 1
    throw new Error('launch failed after commit')
  })
  await expect($.agent.spawn(SPAWN)).rejects.toThrow(/no implementation for agent\.spawn/)
  expect(calls).toBe(1)
  expect(state.get('claude')).toBeUndefined()
})

test('the launch is denied: forwarded exactly once, the denial reaches the caller unchanged', async ($, on) => {
  mock.clock(on, { now: NOW })
  const state = watchState(on)
  let calls = 0
  on('agent.spawn', () => {
    calls += 1
    return { deny: 'no capacity' }
  })
  expect(await $.agent.spawn(SPAWN)).toEqual({ deny: 'no capacity' })
  expect(calls).toBe(1)
  expect(state.get('claude')).toBeUndefined()
})

test('bookkeeping fails: forwarded exactly once, result unchanged', async ($, on) => {
  // No mock clock: the plugin's `$.clock.now()` in its bookkeeping rejects.
  const state = watchState(on)
  let calls = 0
  on('agent.spawn', () => {
    calls += 1
    return { model: 'claude-x', agentId: 'agent-2' }
  })
  const result = await $.agent.spawn(SPAWN)
  expect(calls).toBe(1)
  expect(result).toEqual({ model: 'claude-x', agentId: 'agent-2' })
  expect(state.get('claude')).toBeUndefined()
})
