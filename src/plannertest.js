// Planner tests in a simulated world with Minecraft 26.1's real recipes and block drops: `npm run check`
import assert from 'node:assert/strict'
import { makeSimBot } from './sim.js'
import { obtain, makeCtx, parseGoal, countOf, ensureSpace } from './planner.js'

const quiet = process.argv.includes('--quiet')
const ctx = () => makeCtx({ onStep: quiet ? () => {} : undefined })

// a patch of world: a few trees, an exposed stone boulder, coal and iron in a cliff, all on the surface
function world () {
  const w = []
  for (const [x, z] of [[6, 0], [7, 4], [-5, 3], [3, -6]]) for (let y = 64; y < 69; y++) w.push({ name: 'oak_log', at: [x, y, z] })
  for (let i = 0; i < 30; i++) w.push({ name: 'stone', at: [10 + (i % 6), 64 + Math.floor(i / 18), -3 + Math.floor((i % 18) / 6)] })
  for (let i = 0; i < 6; i++) w.push({ name: 'coal_ore', at: [-10, 64 + (i % 2), i] })
  for (let i = 0; i < 6; i++) w.push({ name: 'iron_ore', at: [-12, 64 + (i % 2), i - 6] })
  return w
}

// --- reading requests ---
{
  const bot = makeSimBot()
  const p = (t) => parseGoal(bot, t)
  assert.deepEqual(p('get iron'), { item: 'raw_iron', count: 5 })
  assert.deepEqual(p('craft an iron pickaxe'), { item: 'iron_pickaxe', count: 1 })
  assert.deepEqual(p('craft 8 torches'), { item: 'torch', count: 8 })
  assert.deepEqual(p('smelt 3 raw iron into iron ingots'), { item: 'iron_ingot', count: 3 })
  assert.deepEqual(p('collect 20 iron ore'), { item: 'raw_iron', count: 20 })
  assert.deepEqual(p('mine 4 wood logs'), { item: 'logs', count: 4 })
  assert.deepEqual(p('get some cobblestone'), { item: 'cobblestone', count: 16 })
  assert.deepEqual(p('make sticks'), { item: 'stick', count: 8 })
  assert.equal(p('build a hut'), null)
  console.log('planner: reading requests ok')
}

// --- "get a stone pickaxe" with empty pockets: wood -> planks -> sticks -> table -> wooden pickaxe -> cobblestone -> stone pickaxe
{
  const bot = makeSimBot({ world: world() })
  await obtain(bot, ctx(), 'stone_pickaxe', 1)
  const s = bot.sim.stats
  assert.equal(countOf(bot, 'stone_pickaxe'), 1)
  assert.ok(s.crafted.wooden_pickaxe >= 1, 'made a wooden pickaxe on the way')
  assert.ok(s.mined.oak_log >= 2, 'chopped trees')
  assert.ok(s.mined.stone >= 3, 'mined real stone (cobblestone), not deepslate')
  assert.ok(s.placed.crafting_table >= 1, 'placed a crafting table')
  console.log('planner: stone pickaxe from nothing ok', JSON.stringify(s.crafted))
}

// --- "get iron" from nothing: needs a stone pickaxe first (never tries copper), then mines iron
{
  const bot = makeSimBot({ world: world() })
  await obtain(bot, ctx(), 'raw_iron', 3)
  assert.ok(countOf(bot, 'raw_iron') >= 3)
  assert.equal(bot.sim.stats.crafted.copper_pickaxe, undefined, 'did not go for a copper pickaxe')
  assert.ok(countOf(bot, 'stone_pickaxe') >= 1)
  console.log('planner: get iron from nothing ok')
}

// --- iron ingots: ore + furnace (8 cobblestone) + fuel (coal), smelted
{
  const bot = makeSimBot({ world: world() })
  await obtain(bot, ctx(), 'iron_ingot', 3)
  assert.ok(countOf(bot, 'iron_ingot') >= 3)
  assert.ok(bot.sim.stats.placed.furnace >= 1, 'made and placed a furnace')
  assert.ok(bot.sim.stats.mined.coal_ore >= 1 || bot.sim.stats.crafted.oak_planks, 'got fuel')
  console.log('planner: iron ingots ok (smelted', bot.sim.stats.smelted, ')')
}

// --- an iron pickaxe from nothing: the whole chain, 3 levels of tools
{
  const bot = makeSimBot({ world: world() })
  await obtain(bot, ctx(), 'iron_pickaxe', 1)
  assert.equal(countOf(bot, 'iron_pickaxe'), 1)
  console.log('planner: iron pickaxe from nothing ok')
}

// --- has a pickaxe already: doesn't make another
{
  const bot = makeSimBot({ world: world(), inventory: { stone_pickaxe: 1 } })
  await obtain(bot, ctx(), 'raw_iron', 2)
  assert.equal(bot.sim.stats.crafted.wooden_pickaxe, undefined)
  assert.equal(bot.sim.stats.crafted.stone_pickaxe, undefined)
  console.log('planner: reuses the pickaxe he has ok')
}

// --- has 64 cobblestone but 1 stick (the case that confused him): makes sticks, doesn't go mining stone
{
  const bot = makeSimBot({ world: world(), inventory: { cobblestone: 64, stick: 1, oak_log: 2 } })
  await obtain(bot, ctx(), 'stone_pickaxe', 1)
  assert.equal(countOf(bot, 'stone_pickaxe'), 1)
  assert.equal(bot.sim.stats.mined.stone ?? 0, 0, 'did not mine stone he already had')
  console.log('planner: missing sticks case ok')
}

// --- food: hunts any food animal nearby
{
  const bot = makeSimBot({ world: world(), mobs: [{ name: 'pig', at: [8, 64, 8] }, { name: 'sheep', at: [-8, 64, 8] }, { name: 'chicken', at: [4, 64, -9] }] })
  await obtain(bot, ctx(), 'food', 4)
  assert.ok(countOf(bot, 'food') >= 4)
  console.log('planner: food ok, killed', bot.sim.stats.killed.join(', '))
}

// --- full inventory: makes a chest, stores the extras, keeps tools; makes a second chest when the first is full
{
  const junkKinds = ['granite', 'diorite', 'andesite', 'gravel', 'sand', 'cobblestone', 'dirt', 'tuff', 'calcite', 'clay_ball', 'flint', 'bone']
  const inventory = { stone_pickaxe: 1, oak_log: 4 }
  const bot = makeSimBot({ world: world(), inventory, slots: 36 })
  for (let i = 0; bot.inventory.emptySlotCount() > 1; i++) bot.sim.add(junkKinds[i % junkKinds.length], 64)
  assert.ok(bot.inventory.emptySlotCount() <= 1)
  await ensureSpace(bot, ctx())
  assert.ok(bot.inventory.emptySlotCount() >= 20, `freed space (${bot.inventory.emptySlotCount()} free)`)
  assert.equal(countOf(bot, 'stone_pickaxe'), 1, 'kept his pickaxe')
  assert.ok(bot.sim.chests.size >= 2, `filled one chest and made another (${bot.sim.chests.size} chests)`)
  console.log('planner: full inventory -> chests ok', bot.sim.chests.size, 'chests,', bot.inventory.emptySlotCount(), 'free slots')
}

// --- impossible: clear message about what's missing
{
  const bot = makeSimBot({ world: [] }) // nothing around at all
  await assert.rejects(obtain(bot, ctx(), 'stone_pickaxe', 1), /couldn't find any logs/)
  console.log('planner: explains when it can\'t ok')
}

console.log('plannertest: all good')
