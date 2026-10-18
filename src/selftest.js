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
    blockAt: () => null, // open air everywhere unless a test says otherwise
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

// Memory records what he did (no "(does it)" placeholder for the model to copy)
tb.request = async () => ({ content: '', tool_calls: [{ function: { name: 'set_goal', arguments: '{"goal":"hunt","mob":"cow","count":2}' } }] })
await tb.complete('get food')
assert.deepEqual(goals[2], { goal: 'hunt', mob: 'cow', count: 2 })
assert.equal(tb.history.at(-1).content, '[goal: hunt mob=cow count=2]')
assert.ok(!tb.history.some(h => h.content.includes('(does it)')))

// Free-form task via text tag keeps the whole sentence
tb.request = async () => ({ content: 'Ugh fine. [goal: task task=build a 3x3 dirt hut right here]' })
await tb.complete('build me a hut')
assert.deepEqual(goals[3], { goal: 'task', task: 'build a 3x3 dirt hut right here' })

// Coder runs AI-written code with the skills API and returns its summary
const { Coder } = await import('./coder.js')
const coder = new Coder(() => ({}))
const cbot = { ...fakeBot({ items: [{ name: 'dirt', count: 5 }] }), entities: {} }
const out = await coder.execute(cbot, "const p = skills.position(); return 'at ' + p.x + ' with ' + skills.count('dirt') + ' dirt'", () => false)
assert.equal(out, 'at 0 with 5 dirt')
await assert.rejects(coder.execute(cbot, "throw new Error('no wood')", () => false), /no wood/)

// Garbled task text and doubled quotes get cleaned up
const { cleanTask } = await import('./talkbrain.js')
assert.equal(cleanTask('", task: place the crafting table on the ground"'), 'place the crafting table on the ground')
assert.equal(cleanTask(' task=build_a_hut'), 'build a hut')
const { repairCode } = await import('./coder.js')
assert.equal(repairCode("return ''successfully placed it'"), "return 'successfully placed it'")
assert.equal(await coder.execute(cbot, repairCode("return ''done''"), () => false), 'done')

// Skill library: saves working code, finds it again for similar wording (in-memory only, never touches data/)
const { SkillLibrary } = await import('./library.js')
const lib = new SkillLibrary(); lib.skills = []; lib.save = () => {}
lib.add('build a small dirt hut here', 'return "hut"')
lib.add('make a stone pickaxe from scratch', 'return "pick"')
assert.equal(lib.search('build me a dirt hut')[0].skill.name, 'build_dirt_hut')
assert.ok(lib.search('build me a dirt hut')[0].score >= 0.8)
assert.equal(lib.search('craft a stone pickaxe')[0].skill.task, 'make a stone pickaxe from scratch')
assert.equal(lib.search('dance').length, 0)

// Coder reuses a saved skill without asking the AI, and library.run works inside task code
const coder2 = new Coder(() => ({}), lib, null)
coder2.request = async () => { throw new Error('should not call the AI for a known task') }
assert.equal(await coder2.run(cbot, 'build a dirt hut', () => false), 'hut')
assert.equal(await coder2.execute(cbot, 'return await library.run("make_stone_pickaxe_from_scratch")', () => false), 'pick')

// An interrupted task resumes with the same code instead of asking the AI again
const coder3 = new Coder(() => ({}), null, null)
let aiCalls = 0
let interrupted = false
coder3.request = async () => { aiCalls++; interrupted = true; return '```js\nif (skills.count("dirt") < 99) await skills.wait(5)\nreturn "dug"\n```' }
assert.equal(await coder3.run(cbot, 'dig a hole', () => interrupted), null) // a fight interrupts it mid-task
assert.equal(await coder3.run(cbot, 'dig a hole', () => false), 'dug')
assert.equal(aiCalls, 1, 'resume should reuse the code, not call the AI again')

// Autonomy: 'self' lines are tagged, and get dropped (not queued over the owner) while he's busy
const heard = []
const tbs = new TalkBrain({ getWorld: () => 'w', onGoal: () => {}, onReply: () => {} })
tbs.complete = async (line) => { heard.push(line); return null }
await tbs.hear('self', 'pick something')
assert.match(heard[0], /^\[your own initiative\]/)
tbs.busy = true
await tbs.hear('owner', 'come here')
await tbs.hear('self', 'pick again')
assert.equal(tbs.pending.line, 'come here', 'owner request must not be replaced by autonomy')

// Never target things the server kicks you for hitting (the "invalid_entity_attacked" bug)
const { isAttackable } = await import('./bot.js')
const { findPrey } = await import('./actions.js')
const ent = (id, name, type, x) => ({ id, name, type, position: new Vec3(x, 64, 0) })
const item = ent(10, 'item', 'object', 1)
const orb = ent(11, 'experience_orb', 'orb', 1.5)
const arrow = ent(12, 'arrow', 'projectile', 2)
const cow = ent(13, 'cow', 'animal', 6)
const zombie = ent(14, 'zombie', 'hostile', 8)
const hb = fakeBot()
hb.entities = Object.fromEntries([item, orb, arrow, cow, zombie].map(e => [e.id, e]))
hb.nearestEntity = (fn) => Object.values(hb.entities).filter(fn).sort((a, b) => a.position.x - b.position.x)[0] ?? null
assert.equal(isAttackable(hb, item), false)
assert.equal(isAttackable(hb, orb), false)
assert.equal(isAttackable(hb, arrow), false)
assert.equal(isAttackable(hb, hb.entity), false)
assert.equal(isAttackable(hb, cow), true)
assert.equal(findPrey(hb, '')?.name, 'cow', 'blank hunt = nearest food animal, NOT the dropped item')
assert.equal(findPrey(hb, 'zombies')?.name, 'zombie')
assert.equal(findPrey(hb, 'item'), null)
assert.equal(findPrey(hb, 'dragon'), null)

// Mobs behind solid blocks (in a cave below) are ignored; visible ones aren't
const { nearbyHostiles, touchesLiquid } = await import('./bot.js')
const cave = fakeBot({ mobs: [mob(20, 'zombie', 6)] })
cave.entities[20].position = new Vec3(0, 58, 0) // 6 blocks straight down
cave.blockAt = (p) => (p.y < 63 && p.y >= 59 ? { name: 'stone', boundingBox: 'block' } : null)
assert.equal(nearbyHostiles(cave).length, 0, 'zombie in a cave below should be ignored')
cave.blockAt = () => null
assert.equal(nearbyHostiles(cave).length, 1, 'visible zombie should count')

// Water next to a block = don't dig it
const wet = fakeBot()
wet.blockAt = (p) => (p.x === 6 && p.y === 64 && p.z === 0 ? { name: 'water' } : { name: 'stone' })
assert.equal(touchesLiquid(wet, new Vec3(5, 64, 0)), true)
assert.equal(touchesLiquid(wet, new Vec3(0, 64, 0)), false)

// Chests: store keeps tools, take uses a remembered chest; memory lists chest contents
const { storeItems, takeItems } = await import('./containers.js')
const { Memory: Mem2 } = await import('./memory.js')
const cmem = new Mem2(); cmem.places = {}; cmem.notes = []; cmem.recentChat = []; cmem.chests = {}; cmem.save = () => {}
const inv = [{ name: 'cobblestone', count: 30, type: 1 }, { name: 'stone_pickaxe', count: 1, type: 2 }, { name: 'dirt', count: 10, type: 3 }]
const chestItems = [{ name: 'iron_ingot', count: 12, type: 9 }]
const chestBlock = { name: 'chest', position: new Vec3(3, 64, 0) }
const cb = fakeBot({ items: inv })
cb.registry = { blocksByName: { chest: { id: 50 }, trapped_chest: { id: 51 }, barrel: { id: 52 } } }
cb.findBlock = () => chestBlock
cb.blockAt = (p) => (p.x === 3 && p.y === 64 && p.z === 0 ? chestBlock : null)
cb.game = { dimension: 'overworld' }
cb.pathfinder = { goto: async () => {} }
cb.openContainer = async () => ({
  containerItems: () => chestItems,
  deposit: async (type, meta, n) => { const it = inv.find(i => i.type === type); chestItems.push({ name: it.name, count: n, type }); it.count -= n },
  withdraw: async (type, meta, n) => { chestItems.find(i => i.type === type).count -= n },
  close: () => {}
})
assert.equal(await storeItems(cb, cmem, 'all'), 'stored 30 cobblestone, 10 dirt', 'store all keeps the pickaxe')
assert.match(cmem.describe(), /chest at 3 64 0: 30 cobblestone, 12 iron_ingot, 10 dirt/)
assert.equal(cmem.chestWith('iron', cb), chestBlock)
assert.equal(await takeItems(cb, cmem, 'iron ingot', 5), 'took 5 iron_ingot')

// Building: a tiny simulated world where blocks really get placed
const { buildStructure, planMaterials, familyOf, loadBlueprint } = await import('./builder.js')
assert.equal(familyOf('spruce_planks'), 'planks')
assert.equal(familyOf('oak_stairs'), 'planks')
assert.equal(familyOf('stone_brick_stairs'), 'stone')
function simWorld (inventory) {
  const world = new Map()
  const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
  const nameAt = (p) => world.get(key(p)) ?? (p.y < 63 ? 'dirt' : p.y < 64 ? 'grass_block' : 'air')
  const inv = inventory.map((i, n) => ({ ...i, type: n + 1 }))
  let held = null
  const names = ['cobblestone', 'oak_planks', 'birch_planks', 'spruce_planks', 'glass_pane', 'torch', 'ladder', 'oak_log', 'dirt', 'stone_bricks', 'oak_door']
  const b = {
    entity: { position: new Vec3(0, 64, 0), yaw: 0 },
    version: '26.1',
    game: { dimension: 'overworld' },
    registry: { blocksByName: Object.fromEntries(names.map((n, i) => [n, { id: i + 1, name: n }])), itemsByName: Object.fromEntries(names.map((n, i) => [n, { id: i + 1 }])) },
    inventory: { items: () => inv.filter(i => i.count > 0) },
    blockAt: (p) => { const name = nameAt(p); return { name, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: /air|torch|ladder/.test(name) ? 'empty' : 'block' } },
    dig: async (blk) => { world.set(key(blk.position), 'air') },
    equip: async (item) => { held = item },
    placeBlock: async (ref, face) => { world.set(key(ref.position.plus(face)), held.name); held.count-- },
    tool: { equipForBlock: async () => {} },
    pathfinder: { goto: async () => {} }
  }
  return { bot: b, world, nameAt }
}
{
  const { bot: wb, world } = simWorld([{ name: 'cobblestone', count: 40 }])
  const res = await buildStructure(wb, 'wall', { cancelled: () => false })
  assert.match(res, /built the wall: 32 blocks placed/)
  assert.equal([...world.values()].filter(v => v === 'cobblestone').length, 32)
}
{
  // no oak, no glass, no door, no torch: uses birch for walls, leaves window/door openings
  const { bot: hb2, world, nameAt } = simWorld([{ name: 'birch_planks', count: 80 }, { name: 'cobblestone', count: 30 }])
  const plan = planMaterials(hb2, (await loadBlueprint('hut')).cells)
  assert.equal(plan.assign.oak_planks, 'birch_planks')
  assert.equal(plan.assign.glass, 'air')
  const res = await buildStructure(hb2, 'small hut', { cancelled: () => false })
  assert.match(res, /built the hut/)
  assert.ok([...world.values()].filter(v => v === 'birch_planks').length >= 40, 'walls + roof in birch')
  // doorway (front middle) left open: origin is 1 block back from the bot (yaw 0 faces -z), floor at y 63
  const d = 5; const oz = 0 - 1 - d; const ox = 0 - 2
  assert.equal(nameAt(new Vec3(ox + 2, 64, oz + 4)), 'air', 'door gap at ground level')
  assert.equal(nameAt(new Vec3(ox + 2, 63, oz + 2)), 'cobblestone', 'stone floor')
}
{
  // "out of cobblestone" overrides the planks walls
  const { bot: pb } = simWorld([{ name: 'cobblestone', count: 120 }])
  const plan = planMaterials(pb, (await loadBlueprint('hut')).cells, 'cobblestone')
  assert.equal(plan.assign.oak_planks, 'cobblestone')
}

// Session summaries turn conversation into long-term notes (no duplicates)
{
  const smem = new Mem2(); smem.places = {}; smem.notes = ['owner hates spiders']; smem.recentChat = []; smem.chests = {}; smem.save = () => {}
  const stb = new TalkBrain({ getWorld: () => 'w', onGoal: () => {}, onReply: () => {}, memory: smem })
  stb.history = [{ role: 'user', content: 'lets build a castle by the lake tomorrow' }, { role: 'assistant', content: 'ugh fine' }]
  stb.request = async (msgs, opts) => { assert.equal(opts.tools, false); return { content: '["owner wants a castle by the lake", "owner hates spiders"]' } }
  await stb.summarize()
  assert.deepEqual(smem.notes, ['owner hates spiders', 'owner wants a castle by the lake'].sort((a, b) => smem.notes.indexOf(a) - smem.notes.indexOf(b)))
  assert.equal(smem.notes.length, 2)
}

// Learning across runs: Jev matches reworded requests to saved skills, lessons get written and reused
{
  const L = new SkillLibrary(); L.skills = []; L.lessons = []; L.save = () => {}; L.saveLessons = () => {}
  L.add('take the glass out of the furnace', 'return "got glass"')
  L.add('dig a staircase down', 'return "stairs"')
  // fake Jev that picks the furnace skill
  const fakeJev = { enabled: true, ask: async (state, q) => ({ match: { choice: Object.entries(q.match.criteria).find(([, v]) => v.includes('furnace'))[0], confidence: 0.86 } }) }
  const picked = await L.pick('open the furnace and grab what is inside', fakeJev)
  assert.equal(picked.skill.name, 'take_glass_furnace')
  // Coder uses Jev's pick and reruns the proven code with no AI call
  const lc = new Coder(() => ({ fast: { jev: fakeJev } }), L, null)
  lc.request = async () => { throw new Error('should reuse the saved skill, not ask the AI') }
  assert.equal(await lc.run(cbot, 'open the furnace and grab what is inside', () => false), 'got glass')
  assert.equal(L.get('take_glass_furnace').uses, 1)

  // a task that fails once then works -> a lesson is written, and shows up next time
  const lc2 = new Coder(() => ({}), L, null)
  let call = 0
  lc2.request = async (msgs) => {
    call++
    if (msgs[0].content.startsWith('You write short lessons')) return 'Use skills.smelt() instead of bot.openFurnace.'
    return call === 1 ? '```js\nthrow new Error("openFurnace is not a function")\n```' : '```js\nreturn "smelted"\n```'
  }
  assert.equal(await lc2.run(cbot, 'light up the base with torches', () => false), 'smelted')
  await new Promise(resolve => setTimeout(resolve, 20)) // lesson is written in the background
  assert.equal(L.lessons.at(-1).lesson, 'Use skills.smelt() instead of bot.openFurnace.')
  let seenPrompt = ''
  lc2.request = async (msgs) => { seenPrompt = msgs[1]?.content ?? ''; return '```js\nreturn "ok"\n```' }
  await lc2.run(cbot, 'light up the farm with torches', () => false)
  assert.match(seenPrompt, /Lessons you learned.*\n- Use skills\.smelt\(\)/)

  // a skill that keeps failing ranks below a reliable one
  L.add('mine iron the old way', 'x'); L.add('mine iron the good way', 'y')
  for (let i = 0; i < 3; i++) L.failed('mine_iron_old_way')
  L.used('mine_iron_good_way')
  assert.equal(L.search('mine iron')[0].skill.name, 'mine_iron_good_way')
}

// Food hunting: "food" / a food animal counts as a food hunt; a missing cow falls back to whatever food animal is near
{
  const { isFoodHunt, collectDrops } = await import('./actions.js')
  assert.equal(isFoodHunt(''), true)
  assert.equal(isFoodHunt('food'), true)
  assert.equal(isFoodHunt('cows'), true)
  assert.equal(isFoodHunt('zombie'), false)
  const fb = fakeBot()
  const pig = ent(30, 'pig', 'animal', 5)
  fb.entities = { 30: pig }
  fb.nearestEntity = (fn) => Object.values(fb.entities).find(fn) ?? null
  assert.equal(findPrey(fb, 'cow'), null)
  assert.equal(findPrey(fb, 'food')?.name, 'pig', 'no cows -> the pig')

  // after a kill he walks over the drops so they end up in his inventory
  const drop = ent(31, 'item', 'object', 6)
  const db = fakeBot()
  db.entities = { 31: drop }
  db.nearestEntity = (fn) => Object.values(db.entities).find(fn) ?? null
  db.pathfinder = { goto: async () => { delete db.entities[31] } } // walking onto it picks it up
  await collectDrops(db, new Vec3(5, 64, 0))
  assert.equal(db.entities[31], undefined)
}

// A program that runs but doesn't do the job is NOT saved as a skill; Gemma is told and tries again
{
  const V = new SkillLibrary(); V.skills = []; V.lessons = []; V.save = () => {}; V.saveLessons = () => {}
  let jevCalls = 0
  const judge = { enabled: true, ask: async (state, q) => { jevCalls++; return q.done ? { done: { noul: /\+1 iron_ore/.test(state) ? 0.9 : 0.1 } } : null } }
  const vinv = [{ name: 'stone_pickaxe', count: 1 }]
  const vb = { ...fakeBot(), inventory: { items: () => vinv, slots: [] } }
  const vc = new Coder(() => ({ fast: { jev: judge } }), V, null)
  let n = 0
  vc.request = async (msgs) => {
    if (msgs[0].content.startsWith('You write short lessons')) return 'NONE'
    n++
    // 1st try "succeeds" but gets nothing; 2nd actually gets the ore
    return n === 1 ? '```js\nreturn "found and mined iron ore nearby"\n```' : '```js\nreturn "mined it"\n```'
  }
  const realExec = vc.execute.bind(vc)
  vc.execute = async (bot, code, c) => { if (n === 2) vinv.push({ name: 'iron_ore', count: 1 }); return realExec(bot, code, c) }
  assert.equal(await vc.run(vb, 'get some iron', () => false), 'mined it')
  assert.equal(n, 2, 'first fake success was rejected')
  assert.equal(V.skills.length, 1)
  assert.equal(V.skills[0].code, 'return "mined it"')
}

// Hunger: eats when hungry even at full health
{
  const hungry = fakeBot({ health: 20, food: 12, items: [{ name: 'cooked_beef', count: 5 }] })
  assert.equal(decide(hungry).action, 'eat')
  const full = fakeBot({ health: 20, food: 19, items: [{ name: 'cooked_beef', count: 5 }] })
  assert.equal(decide(full).action, 'pursue_goal')
}

// Voyager: skills load, primitives map onto ours, and a Voyager skill runs inside the sandbox
{
  const { voyagerSkills, searchVoyager, pickVoyager } = await import('./voyager.js')
  assert.ok(Object.keys(voyagerSkills()).length >= 100)
  assert.equal(searchVoyager('make an iron pickaxe', 1)[0].name, 'craftIronPickaxe')
  const jevV = { enabled: true, ask: async (s, q) => ({ match: { choice: Object.entries(q.match.criteria).find(([, v]) => v.startsWith('craftIronPickaxe:'))[0], confidence: 0.9 } }) }
  assert.equal((await pickVoyager('make an iron pickaxe', jevV)).name, 'craftIronPickaxe')
  // Voyager-style code calling a primitive works inside our sandbox (and bot.chat goes to the log, not game chat)
  let chatted = false
  const vbot = { ...fakeBot(), chat: () => { chatted = true } }
  const vc2 = new Coder(() => ({}), null, null)
  const out = await vc2.execute(vbot, 'bot.chat("Crafted sticks."); return typeof mineBlock + " " + typeof craftIronPickaxe', () => false)
  assert.equal(out, 'function function')
  assert.equal(chatted, false, 'Voyager chatter must not hit game chat')
}

// Practice: walks the ladder in order, records wins, gives up after 3 failures
{
  const { Practice, LADDER } = await import('./practice.js')
  const ran = []
  const fakeCoder = { run: async (b, task) => { ran.push(task); if (task === LADDER[1]) throw new Error('no wood'); return 'ok' } }
  const P = new Practice({ coder: fakeCoder, request: async () => 'craft a golden apple' })
  P.completed = []; P.failed = {}; P.history = []; P.save = () => {}
  assert.deepEqual(await P.runOne(cbot, () => false), { task: LADDER[0], ok: true, result: 'ok' })
  for (let i = 0; i < 3; i++) await P.runOne(cbot, () => false) // ladder[1] fails 3x
  assert.equal(P.failed[LADDER[1]], 3)
  await P.runOne(cbot, () => false)
  assert.equal(ran.at(-1), LADDER[2], 'gave up on the failing step and moved on')
  P.completed = [...LADDER]
  assert.equal(await P.nextTask(cbot), 'craft a golden apple', 'ladder done -> AI proposes the next challenge')
}

// Mining target choice: never anything in his own column below him, and skipped spots stay skipped
{
  const { findSafeBlock } = await import('./actions.js')
  const mb = fakeBot()
  const ores = [new Vec3(0, 60, 0), new Vec3(3, 63, 1), new Vec3(6, 64, 0)] // straight below, nearby, further
  mb.findBlocks = () => ores
  mb.blockAt = (p) => ({ name: ores.some(o => o.equals(p.floored ? p.floored() : p)) ? 'iron_ore' : 'stone', position: p })
  assert.equal(findSafeBlock(mb, [1]).position.toString(), new Vec3(3, 63, 1).toString(), 'skips the ore straight below')
  assert.equal(findSafeBlock(mb, [1], new Set([new Vec3(3, 63, 1).toString()])).position.toString(), new Vec3(6, 64, 0).toString())
}

// Memory: places + notes, fuzzy place lookup, shows up in the talk prompt
const { Memory } = await import('./memory.js')
const mem = new Memory(); mem.places = {}; mem.notes = []; mem.recentChat = []; mem.save = () => {}
mem.remember('place', 'Base', null, { x: 10, y: 64, z: -5 })
mem.remember('note', null, 'owner hates spiders')
assert.deepEqual(mem.place('the base'), { x: 10, y: 64, z: -5 })
const tbm = new TalkBrain({ getWorld: () => 'w', onGoal: () => {}, onReply: () => {}, memory: mem })
assert.match(tbm.systemPrompt(), /base: 10 64 -5/)
assert.match(tbm.systemPrompt(), /owner hates spiders/)
tbm.request = async () => ({ content: 'Noted, nerd.', tool_calls: [{ function: { name: 'remember', arguments: '{"kind":"note","text":"owner builds ugly towers"}' } }] })
await tbm.complete('remember i love towers')
assert.ok(mem.notes.includes('owner builds ugly towers'))
assert.equal(mem.recentChat.at(-1).content, 'Noted, nerd.')

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
