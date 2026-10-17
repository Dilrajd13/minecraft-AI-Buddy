// Offline sanity checks (no Minecraft, no API keys needed): `npm run check`
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { reflexDecide } from './fastbrain/reflex.js'
import { TalkBrain, cleanForSpeech } from './talkbrain.js'
import { runCommand } from './commands.js'
import { worldState } from './bot.js'

const mob = (id, name, x) => ({ id, name, type: 'hostile', position: new Vec3(x, 64, 0) })
function fakeBot ({ health = 20, food = 20, items = [], mobs = [] } = {}) {
  const entities = Object.fromEntries(mobs.map(m => [m.id, m]))
  return {
    health, food, entities,
    entity: { position: new Vec3(0, 64, 0), yaw: 0, isInWater: false },
    players: {}, time: { timeOfDay: 1000 }, heldItem: null,
    inventory: { items: () => items, slots: [] }
  }
}
const decide = (bot, guarding = false) => reflexDecide(bot, worldState(bot, null), { guarding })

assert.equal(decide(fakeBot()).action, 'pursue_goal', 'calm -> keep doing goal')
assert.equal(decide(fakeBot({ mobs: [mob(1, 'zombie', 3)] })).action, 'attack', 'close zombie -> attack')
assert.equal(decide(fakeBot({ mobs: [mob(1, 'creeper', 3)] })).action, 'retreat', 'close creeper -> retreat')
assert.equal(decide(fakeBot({ mobs: [mob(1, 'zombie', 8)] })).action, 'pursue_goal', 'far zombie -> ignore')
assert.equal(decide(fakeBot({ mobs: [mob(1, 'zombie', 8)] }), true).action, 'attack', 'guarding -> attack at range')
assert.equal(decide(fakeBot({ health: 5, mobs: [mob(1, 'zombie', 3)] })).action, 'retreat', 'low hp -> retreat')
assert.equal(decide(fakeBot({ health: 9, food: 15, items: [{ name: 'bread', count: 3 }] })).action, 'eat', 'hurt + safe -> eat')

const ws = worldState(fakeBot({ mobs: [mob(1, 'zombie', 3), mob(2, 'skeleton', 10)] }), null)
assert.match(ws.text, /t0: zombie 3\.0 blocks/)
assert.equal(ws.hostiles.length, 2)

assert.equal(cleanForSpeech('*laughs* Holy crap 😂 a **creeper**'), 'Holy crap a creeper')

// Text-goal fallback parsing (for providers without tool calling)
const goals = []
const tb = new TalkBrain({ getWorld: () => 'test', onGoal: g => goals.push(g), onReply: () => {} })
tb.request = async () => ({ content: 'Fine, I\'ll chop your stupid trees. [goal: collect block=oak_log count=5]' })
const reply = await tb.complete('get wood')
assert.equal(reply, "Fine, I'll chop your stupid trees.")
assert.deepEqual(goals[0], { goal: 'collect', block: 'oak_log', count: 5 })

// Tool-call path
tb.request = async () => ({ content: 'On it.', tool_calls: [{ function: { name: 'set_goal', arguments: '{"goal":"guard"}' } }] })
await tb.complete('guard here')
assert.deepEqual(goals[1], { goal: 'guard' })

// Override commands
const app = { talk: tb, voice: { muted: false, stats: () => '' }, body: { setGoal: k => k }, fast: { mode: 'reflex', jev: { enabled: false, disabledReason: 'x', stats: () => '' } }, speak: () => {} }
runCommand('!add talk like a pirate', app)
assert.match(tb.systemPrompt(), /talk like a pirate/)
runCommand('!clear', app)
assert.doesNotMatch(tb.systemPrompt(), /pirate/)
runCommand('!mute', app)
assert.equal(app.voice.muted, true)
assert.equal(runCommand('hello', app), null)

console.log('selftest: all good')
