import pathfinderPkg from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { log } from './config.js'
import { findItem, craftItem, resolveItemName } from './actions.js'

const { GoalNear } = pathfinderPkg.goals

const CHESTS = ['chest', 'trapped_chest', 'barrel']
const FURNACES = ['furnace', 'blast_furnace', 'smoker']
// best first; value = items smelted per piece
const FUELS = [['coal', 8], ['charcoal', 8], ['coal_block', 80], ['lava_bucket', 100], ['blaze_rod', 12],
  ['oak_planks', 1.5], ['spruce_planks', 1.5], ['birch_planks', 1.5], ['jungle_planks', 1.5], ['acacia_planks', 1.5],
  ['dark_oak_planks', 1.5], ['mangrove_planks', 1.5], ['cherry_planks', 1.5], ['oak_log', 1.5], ['spruce_log', 1.5],
  ['birch_log', 1.5], ['stick', 0.5]]
// Stuff he keeps when you say "put everything in the chest"
const KEEP = /sword|_axe|pickaxe|shovel|hoe|helmet|chestplate|leggings|boots|shield|bow|crossbow|trident|torch/

const blockIds = (bot, names) => names.map(n => bot.registry.blocksByName[n]?.id).filter(id => id !== undefined)

async function walkTo (bot, pos, range = 2) {
  if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > range + 1) {
    await bot.pathfinder.goto(new GoalNear(pos.x, pos.y, pos.z, range))
  }
}

const OPEN = /^(air|cave_air|short_grass|grass|fern|tall_grass|snow)$/

// A spot within reach where something can be set down: open space with a solid block under it,
// not where he's standing. Checks his own level first, then one up/down, out to 2 blocks.
export function findPlaceSpot (bot) {
  const me = bot.entity.position.floored()
  const rings = []
  for (let r = 1; r <= 2; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if (Math.max(Math.abs(dx), Math.abs(dz)) === r) rings.push([dx, dz])
  for (const dy of [0, -1, 1]) {
    for (const [dx, dz] of rings) {
      const spot = me.offset(dx, dy, dz)
      const here = bot.blockAt(spot)
      const ground = bot.blockAt(spot.offset(0, -1, 0))
      if (here && OPEN.test(here.name) && ground?.boundingBox === 'block') return { spot, ground }
    }
  }
  return null
}

// Place a block from inventory near him (on the ground, or in a nook in a tunnel); returns the placed block
export async function placeNextToMe (bot, itemName) {
  const item = findItem(bot, itemName)
  if (!item) throw new Error(`I don't have a ${itemName}`)
  let found = findPlaceSpot(bot)
  if (!found) {
    // boxed in (tunnel / staircase): clear the block in front of him at foot level and use that
    const me = bot.entity.position.floored()
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const spot = me.offset(dx, 0, dz)
      const b = bot.blockAt(spot)
      const ground = bot.blockAt(spot.offset(0, -1, 0))
      if (!b || b.boundingBox !== 'block' || ground?.boundingBox !== 'block') continue
      try { await bot.dig(b) } catch { continue }
      found = { spot, ground: bot.blockAt(spot.offset(0, -1, 0)) }
      break
    }
  }
  if (!found) throw new Error(`no room to place the ${itemName}`)
  await bot.equip(item, 'hand')
  await bot.placeBlock(found.ground, new Vec3(0, 1, 0))
  return bot.blockAt(found.spot)
}

export function nearestChest (bot, maxDistance = 32) {
  return bot.findBlock({ matching: blockIds(bot, CHESTS), maxDistance })
}

const summarize = (items) => {
  const out = {}
  for (const i of items) out[i.name] = (out[i.name] ?? 0) + i.count
  return out
}

// Open a chest, let fn work with it, record what's inside, close it
async function withChest (bot, memory, chestBlock, fn) {
  const chest = chestBlock ?? nearestChest(bot)
  if (!chest) throw new Error('there is no chest nearby')
  await walkTo(bot, chest.position, 2)
  const win = await bot.openContainer(chest)
  try {
    const result = await fn(win)
    memory?.rememberChest(chest.position, summarize(win.containerItems()), bot.game?.dimension)
    return result
  } finally {
    win.close()
  }
}

export async function chestContents (bot, memory, chestBlock) {
  return withChest(bot, memory, chestBlock, async (win) => summarize(win.containerItems()))
}

// item = name, or 'all' / blank = everything except tools, weapons, armor and torches
export async function storeItems (bot, memory, item, count) {
  const all = !item || /^(all|everything|stuff|items|junk)$/i.test(item)
  const chest = memory?.chestWith?.(null, bot) ?? nearestChest(bot)
  return withChest(bot, memory, chest, async (win) => {
    const stored = {}
    const items = all
      ? bot.inventory.items().filter(i => !KEEP.test(i.name))
      : bot.inventory.items().filter(i => i.name === item || i.name.includes(String(item).toLowerCase().replace(/\s+/g, '_')))
    if (!items.length) throw new Error(all ? 'I have nothing to store' : `I don't have any ${item}`)
    let left = count ?? Infinity
    for (const it of items) {
      if (left <= 0) break
      const n = Math.min(it.count, left)
      try {
        await win.deposit(it.type, null, n)
        stored[it.name] = (stored[it.name] ?? 0) + n
        left -= n
      } catch (err) {
        if (/full|space/i.test(err.message)) throw new Error('the chest is full')
        throw err
      }
    }
    return 'stored ' + Object.entries(stored).map(([k, v]) => `${v} ${k}`).join(', ')
  })
}

export async function takeItems (bot, memory, item, count = 64) {
  const term = String(item || '').toLowerCase().replace(/\s+/g, '_')
  if (!term) throw new Error('say what to take out of the chest')
  // A chest we remember having it beats the nearest one
  const remembered = memory?.chestWith?.(term, bot)
  return withChest(bot, memory, remembered ?? nearestChest(bot), async (win) => {
    const matches = win.containerItems().filter(i => i.name === term || i.name.includes(term))
    if (!matches.length) throw new Error(`no ${item} in that chest`)
    let left = count
    let took = 0
    for (const it of matches) {
      if (left <= 0) break
      const n = Math.min(it.count, left)
      await win.withdraw(it.type, null, n)
      took += n
      left -= n
    }
    return `took ${took} ${matches[0].name}`
  })
}

async function getFurnace (bot) {
  let block = bot.findBlock({ matching: blockIds(bot, FURNACES), maxDistance: 32 })
  if (block) return block
  if (!findItem(bot, 'furnace')) {
    log('task', 'no furnace around, making one')
    await craftItem(bot, 'furnace', 1) // needs 8 cobblestone; craftItem handles the crafting table
  }
  block = await placeNextToMe(bot, 'furnace')
  return block
}

// Smelt `count` of an item (raw_iron, sand, beef...), adding fuel as needed, and collect the results
export async function smelt (bot, item, count = 1) {
  const inputName = resolveItemName(bot, item)
  const input = inputName && findItem(bot, inputName)
  if (!input) throw new Error(`I don't have any ${item} to smelt`)
  const n = Math.min(count, input.count)
  const block = await getFurnace(bot)
  await walkTo(bot, block.position, 2)
  const furnace = await bot.openFurnace(block)
  let collected = 0
  try {
    // take out anything already finished so it doesn't block the slot
    if (furnace.outputItem()) collected += (await furnace.takeOutput())?.count ?? 0

    // fuel: enough for n items
    let fuelNeeded = n - (furnace.fuel > 0 ? 1 : 0)
    if (furnace.fuelItem()) fuelNeeded -= furnace.fuelItem().count * 1.5
    for (const [name, per] of FUELS) {
      if (fuelNeeded <= 0) break
      if (name === input.name) continue
      const f = bot.inventory.items().find(i => i.name === name)
      if (!f) continue
      const pieces = Math.min(f.count, Math.ceil(fuelNeeded / per))
      await furnace.putFuel(f.type, null, pieces)
      fuelNeeded -= pieces * per
    }
    if (!furnace.fuelItem() && !(furnace.fuel > 0)) throw new Error('I have no fuel (coal, planks or logs)')

    await furnace.putInput(input.type, null, n)
    log('task', `smelting ${n} ${input.name}`)
    // ~10s per item; take output as it comes
    const deadline = Date.now() + n * 11000 + 5000
    while (collected < n && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      if (furnace.outputItem()) collected += (await furnace.takeOutput())?.count ?? 0
      if (!furnace.inputItem() && !furnace.outputItem()) break
      if (!furnace.fuelItem() && furnace.fuel <= 0 && furnace.inputItem()) throw new Error(`ran out of fuel after ${collected}`)
    }
  } finally {
    furnace.close()
  }
  return `smelted ${collected} ${input.name}`
}
