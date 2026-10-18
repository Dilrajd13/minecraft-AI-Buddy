// The planner: "get X" by working out every step, using Minecraft's real recipe and block-drop data.
//   get iron -> need a stone pickaxe? -> need cobblestone + sticks -> sticks need planks -> planks need logs
//   -> chop a tree -> craft planks -> sticks -> crafting table -> pickaxe -> stairs down -> mine iron.
// It works things out fresh every step (so it adapts if something changes), never guesses, and says exactly
// what's missing when it can't finish.
import pathfinderPkg from 'mineflayer-pathfinder'
import { log } from './config.js'
import { FOODS } from './bot.js'
import { findSafeBlock, findPrey, killEntity, ensureCraftingTable } from './actions.js'
import { mineOre, ORES } from './mining.js'
import { smelt, placeNextToMe } from './containers.js'

const { GoalXZ } = pathfinderPkg.goals

// furnace recipes (output: input). 'logs' = any log
export const SMELT = {
  iron_ingot: 'raw_iron', gold_ingot: 'raw_gold', copper_ingot: 'raw_copper', glass: 'sand', stone: 'cobblestone',
  smooth_stone: 'stone', charcoal: 'logs', cooked_beef: 'beef', cooked_porkchop: 'porkchop', cooked_chicken: 'chicken',
  cooked_mutton: 'mutton', cooked_rabbit: 'rabbit', cooked_cod: 'cod', cooked_salmon: 'salmon', baked_potato: 'potato',
  brick: 'clay_ball', green_dye: 'cactus', dried_kelp: 'kelp', terracotta: 'clay', netherite_scrap: 'ancient_debris'
}
// things you get by killing mobs (output: mobs that drop it)
export const MOB_DROPS = {
  beef: ['cow', 'mooshroom'], porkchop: ['pig'], mutton: ['sheep'], chicken: ['chicken'], rabbit: ['rabbit'],
  leather: ['cow', 'mooshroom'], feather: ['chicken'], white_wool: ['sheep'], string: ['spider', 'cave_spider'],
  bone: ['skeleton', 'stray'], rotten_flesh: ['zombie', 'husk', 'drowned'], slime_ball: ['slime'], ink_sac: ['squid']
}
const RAW_MEAT = ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon']
const COOKED = /^cooked_|^baked_potato$|^bread$|^golden_carrot$/
const LOGS = /^(?!stripped_).+_(log|stem)$/
const PLANKS = /_planks$/
// Always get these by mining, even though a recipe exists (coal from a coal block, etc.)
const MINE_FIRST = /^(raw_(iron|gold|copper)|coal|diamond|emerald|redstone|lapis_lazuli|cobblestone|cobbled_deepslate|flint|clay_ball|dirt|sand|red_sand|gravel|sugar_cane|cactus|bamboo|wheat_seeds|snowball|amethyst_shard|quartz|glowstone_dust|apple)$/
// Blocks that drop themselves but come from nature (fine to harvest); anything else self-dropping is probably built
const NATURAL_SELF = /_log$|_stem$|^(dirt|sand|red_sand|gravel|clay|cactus|sugar_cane|bamboo|pumpkin|melon|netherrack|soul_sand|end_stone|obsidian|blackstone|basalt|tuff|calcite|andesite|diorite|granite)$/
// cheapest useful tool first (golden tools break fast; copper needs smelting, so plain stone comes before it)
const TOOL_ORDER = ['wooden', 'stone', 'copper', 'iron', 'diamond', 'netherite', 'golden']
// stuff he keeps when putting things away
const KEEP = /sword|_axe$|pickaxe|shovel|_hoe$|helmet|chestplate|leggings|boots|shield|^bow$|crossbow|trident|^torch$|^bucket$|water_bucket|^shears$|flint_and_steel/
const JUNK = /^(dirt|gravel|granite|diorite|andesite|tuff|netherrack|rotten_flesh|poisonous_potato|wheat_seeds|beetroot_seeds|spider_eye)$/
const SPARE = /^(cobblestone|cobbled_deepslate|sand|red_sand|calcite|stone|deepslate|cobbled_deepslate)$/ // easy to get again

// ---------- names ----------
const ALIAS = {
  wood: 'logs', log: 'logs', logs: 'logs', tree: 'logs', trunk: 'logs', wood_log: 'logs', plank: 'planks', planks: 'planks', wooden_plank: 'planks',
  stone: 'cobblestone', cobble: 'cobblestone', rock: 'cobblestone', iron: 'raw_iron', iron_ore: 'raw_iron', gold: 'raw_gold', gold_ore: 'raw_gold',
  copper: 'raw_copper', copper_ore: 'raw_copper', coal_ore: 'coal', diamond_ore: 'diamond', redstone_ore: 'redstone', lapis: 'lapis_lazuli',
  lapis_ore: 'lapis_lazuli', emerald_ore: 'emerald', table: 'crafting_table', workbench: 'crafting_table', crafting: 'crafting_table',
  meat: 'food', food: 'food', foods: 'food', cooked_meat: 'cooked_food', cooked_food: 'cooked_food', steak: 'cooked_beef', pork: 'porkchop',
  wool: 'white_wool', ingot: 'iron_ingot', pickaxe: 'stone_pickaxe', pick: 'stone_pickaxe', sword: 'stone_sword', axe: 'stone_axe', shovel: 'stone_shovel'
}
const NUMBERS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, sixteen: 16, twenty: 20, some: 0, few: 3, couple: 2, stack: 64 }

const STOPWORDS = /^(the|of|me|my|more|please|get|make|craft|mine|collect|gather|find|obtain|smelt|cook|go|and|until|have|i|for|us|you|us|bring|grab|fetch|some)$/

// "3 iron ingots", "a stone pickaxe", "wood", "smelt 3 raw iron into iron ingots" -> { item, count }
// (item may be the groups logs / planks / food / cooked_food). null if it isn't an item.
export function parseGoal (bot, text, fallbackCount = 0) {
  const all = String(text || '').toLowerCase().replace(/[^a-z0-9_ ]/g, ' ').replace(/\s+/g, ' ').trim()
  // the amount can be anywhere ("smelt 3 raw iron into iron ingots")
  let count = fallbackCount
  for (const w of all.split(' ')) {
    if (/^\d+$/.test(w)) { count = Number(w); break }
    if (NUMBERS[w]) { count = NUMBERS[w]; break }
  }
  // the item: whatever comes after "into", otherwise the whole thing minus filler words
  const target = (all.match(/\binto (.+)$/)?.[1] ?? all).split(' ')
    .filter(w => !STOPWORDS.test(w) && !/^\d+$/.test(w) && NUMBERS[w] === undefined)
  const name = normalizeItem(bot, target.join('_'))
  return name ? { item: name, count: Math.max(1, count || defaultCount(name)) } : null
}

// sensible amount when nobody says how many ("get iron" -> a few, "get a pickaxe" -> one)
export function defaultCount (item) {
  if (item === 'logs') return 6
  if (item === 'planks') return 8
  if (item === 'food' || item === 'cooked_food') return 4
  if (/^(cobblestone|cobbled_deepslate|dirt|sand|gravel)$/.test(item)) return 16
  if (/^(raw_|coal$|redstone$|lapis_lazuli$|copper)/.test(item)) return 5
  if (/^(diamond|emerald)$/.test(item)) return 3
  if (/^(torch|stick|arrow)$/.test(item)) return 8
  return 1
}

export function normalizeItem (bot, raw) {
  const byName = bot.registry.itemsByName
  const s = String(raw || '').toLowerCase().trim().replace(/[\s-]+/g, '_').replace(/^_+|_+$/g, '')
  if (!s) return null
  // singular forms of the last word: torches -> torch, axes -> axe, ingots -> ingot, berries -> berry
  const last = (fn) => s.replace(/[^_]+$/, (w) => fn(w))
  const forms = [...new Set([s, last(w => w.replace(/ies$/, 'y')), last(w => w.replace(/es$/, '')), last(w => w.replace(/(?<!s)s$/, ''))])]
  for (const c of forms) {
    if (ALIAS[c]) return ALIAS[c]
    if (byName[c]) return c
    if (byName[`raw_${c}`]) return `raw_${c}`
  }
  for (const c of forms) if (byName[c + 's']) return c + 's' // "oak plank" -> oak_planks
  return null
}

const pretty = (n) => String(n).replace(/_/g, ' ')

// ---------- inventory ----------
export function countOf (bot, name) {
  const items = bot.inventory.items()
  const sum = (f) => items.filter(f).reduce((a, i) => a + i.count, 0)
  if (name === 'logs' || LOGS.test(name)) return sum(i => LOGS.test(i.name))
  if (name === 'planks' || PLANKS.test(name)) return sum(i => PLANKS.test(i.name))
  if (name === 'food') return sum(i => FOODS.includes(i.name))
  if (name === 'cooked_food') return sum(i => COOKED.test(i.name))
  return sum(i => i.name === name)
}
const familyOf = (name) => LOGS.test(name) ? 'logs' : PLANKS.test(name) ? 'planks' : name

// ---------- world data ----------
const dropId = (d) => typeof d === 'number' ? d : (d?.drop?.id ?? d?.drop ?? d?.id)

function dropSources (bot, item) {
  const id = bot.registry.itemsByName[item]?.id
  if (id === undefined) return []
  return Object.values(bot.registry.blocksByName).filter(b =>
    (b.drops ?? []).some(d => dropId(d) === id) &&
    (b.name !== item || NATURAL_SELF.test(item)) && // don't take apart things people built
    !/^infested_|_slab$|_stairs$|_wall$|^potted_|_bed$|^chest$|^barrel$/.test(b.name))
}

function craftRecipes (bot, item) {
  const id = bot.registry.itemsByName[item]?.id
  if (id === undefined) return []
  try { return bot.recipesAll(id, null, true) } catch { return [] }
}

function ingredientsOf (bot, recipe) {
  const need = {}
  for (const d of recipe.delta ?? []) {
    if (d.count >= 0) continue
    const name = familyOf(bot.registry.items[d.id]?.name ?? String(d.id))
    need[name] = (need[name] ?? 0) - d.count
  }
  return need
}

// Ingredients that are easy to come by near the surface vs. ones that mean a long trip
const COMMON = /^(planks|logs|stick|cobblestone|coal|iron_ingot|string|leather|sand|glass|white_wool|torch|redstone)$/
const RARE = /deepslate|blackstone|crimson|warped|bamboo|cherry|mangrove|pale_oak|basalt|nether|quartz|copper|amethyst|prismarine|purpur|end_stone/

// the recipe variant whose ingredients he's closest to having; with nothing on hand, the one with common materials
// (a stone pickaxe can be made from cobbled deepslate or blackstone too, but that means digging deep / the Nether)
function bestRecipe (bot, recipes) {
  let best = recipes[0]; let bestScore = -Infinity
  for (const r of recipes) {
    const parts = Object.entries(ingredientsOf(bot, r))
    const have = parts.reduce((a, [n, c]) => a + Math.min(1, countOf(bot, n) / c), 0) / Math.max(1, parts.length)
    const ease = parts.reduce((a, [n]) => a + (COMMON.test(n) ? 1 : 0) - (RARE.test(n) ? 2 : 0), 0) / Math.max(1, parts.length)
    const score = have * 10 + ease
    if (score > bestScore) { best = r; bestScore = score }
  }
  return best
}

// Tools that can harvest a block (null = bare hands fine), cheapest first
function harvestTools (bot, block) {
  if (!block?.harvestTools) return null
  const names = Object.keys(block.harvestTools).map(id => bot.registry.items[id]?.name).filter(Boolean)
  const rank = (n) => { const i = TOOL_ORDER.indexOf(n.split('_')[0]); return i < 0 ? 99 : i }
  return names.sort((a, b) => rank(a) - rank(b))
}

// ---------- context ----------
// ctx: { memory, cancelled, stack, reserve, fullChests, onStep }
export function makeCtx (opts = {}) {
  return {
    memory: opts.memory ?? null,
    cancelled: opts.cancelled ?? (() => false),
    stack: [],
    reserve: new Set(),
    fullChests: opts.fullChests ?? new Set(),
    onStep: opts.onStep ?? (() => {}),
    storing: false
  }
}
const check = (ctx) => { if (ctx.cancelled()) throw new Error('cancelled') }
function step (ctx, text) {
  log('plan', `${'  '.repeat(Math.max(0, ctx.stack.length - 1))}${text}`)
  ctx.onStep(ctx.stack.map(pretty), text)
}

// ---------- the main thing ----------
// Make sure he has at least `count` of `name`, doing whatever it takes.
export async function obtain (bot, ctx, name, count = 1, depth = 0) {
  check(ctx)
  const have = countOf(bot, name)
  if (have >= count) return have
  if (depth > 12) throw new Error(`too many steps to get ${pretty(name)}`)
  if (ctx.stack.includes(name)) throw new Error(`going in circles trying to get ${pretty(name)}`)
  ctx.stack.push(name)
  ctx.reserve.add(familyOf(name))
  step(ctx, `need ${count - have} more ${pretty(name)} (have ${have})`)
  try {
    await ensureSpace(bot, ctx)
    if (name === 'food') await getFood(bot, ctx, count)
    else if (name === 'cooked_food') await getCookedFood(bot, ctx, count, depth)
    else if (name === 'logs' || LOGS.test(name)) await mineBlocks(bot, ctx, logBlockIds(bot), 'logs', count)
    else if (name === 'planks' || PLANKS.test(name)) await makePlanks(bot, ctx, count, depth)
    else if (SMELT[name]) await doSmelt(bot, ctx, name, count, depth)
    else {
      const sources = dropSources(bot, name)
      const recipes = craftRecipes(bot, name)
      if (sources.length && (!recipes.length || MINE_FIRST.test(name))) await doMine(bot, ctx, name, count, sources, depth)
      else if (recipes.length) await doCraft(bot, ctx, name, count, recipes, depth)
      else if (MOB_DROPS[name]) await doHunt(bot, ctx, name, count)
      else if (sources.length) await doMine(bot, ctx, name, count, sources, depth)
      else throw new Error(`I don't know how to get ${pretty(name)}`)
    }
    const now = countOf(bot, name)
    if (now < count) throw new Error(`only got ${now} of ${count} ${pretty(name)}`)
    step(ctx, `got ${pretty(name)} (${now})`)
    return now
  } finally {
    ctx.stack.pop()
  }
}

async function doCraft (bot, ctx, name, count, recipes, depth) {
  for (let pass = 0; pass < 4 && countOf(bot, name) < count; pass++) {
    const recipe = bestRecipe(bot, recipes)
    const per = recipe.result?.count || 1
    const times = Math.ceil((count - countOf(bot, name)) / per)
    const need = Object.entries(ingredientsOf(bot, recipe)).map(([n, c]) => [n, c * times])
    const show = need.map(([n, c]) => `${c} ${pretty(n)}`).join(' + ')
    step(ctx, `craft ${pretty(name)}: needs ${show}${recipe.requiresTable ? ' + crafting table' : ''}`)
    for (const [n] of need) ctx.reserve.add(n)
    // The crafting table first: making one uses 4 planks, which would eat the ingredients gathered below
    let table = null
    if (recipe.requiresTable) {
      const near = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 32 })
      if (!near && countOf(bot, 'crafting_table') < 1) await obtain(bot, ctx, 'crafting_table', 1, depth + 1)
    }
    // things that are themselves crafted (sticks) first, raw stuff (planks) last: making sticks uses planks up
    need.sort((a, b) => (craftRecipes(bot, b[0]).length ? 1 : 0) - (craftRecipes(bot, a[0]).length ? 1 : 0))
    const gather = async () => {
      for (let k = 0; k < 4; k++) {
        const missing = need.filter(([n, c]) => countOf(bot, n) < c)
        if (!missing.length) return
        for (const [n, c] of missing) await obtain(bot, ctx, n, c, depth + 1)
      }
    }
    await gather()
    if (recipe.requiresTable) table = await ensureCraftingTable(bot)
    await gather() // one last check right before crafting
    await craftTimes(bot, name, times, table)
  }
}

// Craft one batch at a time (asking mineflayer for more than the materials allow just hangs)
async function craftTimes (bot, name, times, table) {
  const id = bot.registry.itemsByName[name].id
  for (let i = 0; i < times; i++) {
    const recipe = bot.recipesFor(id, null, 1, table)[0]
    if (!recipe) {
      if (i > 0) return
      throw new Error(`missing ingredients for ${pretty(name)}: ${missingText(bot, name)}`)
    }
    await bot.craft(recipe, 1, table ?? undefined)
  }
}

// "need 1 more stick" - what's missing for one craft of this item
export function missingText (bot, name) {
  const recipes = craftRecipes(bot, name)
  if (!recipes.length) return `${pretty(name)} can't be crafted`
  const need = ingredientsOf(bot, bestRecipe(bot, recipes))
  const parts = Object.entries(need).filter(([n, c]) => countOf(bot, n) < c).map(([n, c]) => `${c - countOf(bot, n)} more ${pretty(n)}`)
  return parts.join(', ') || 'a crafting table'
}

async function makePlanks (bot, ctx, count, depth) {
  for (let pass = 0; pass < 6 && countOf(bot, 'planks') < count; pass++) {
    const logsNeeded = Math.ceil((count - countOf(bot, 'planks')) / 4)
    if (countOf(bot, 'logs') < logsNeeded) await obtain(bot, ctx, 'logs', logsNeeded, depth + 1)
    const logItem = bot.inventory.items().find(i => LOGS.test(i.name))
    if (!logItem) throw new Error('no logs to make planks from')
    const plankName = logItem.name.replace(/_(log|stem)$/, '_planks')
    if (!bot.registry.itemsByName[plankName]) throw new Error(`can't make planks from ${pretty(logItem.name)}`)
    step(ctx, `craft ${pretty(plankName)} from ${pretty(logItem.name)}`)
    await craftTimes(bot, plankName, Math.min(logItem.count, logsNeeded), null)
  }
}

async function doMine (bot, ctx, item, count, sources, depth) {
  // the right tool first (stone needs a pickaxe, iron needs a stone pickaxe...)
  const tools = harvestTools(bot, sources[0])
  if (tools && !tools.some(t => countOf(bot, t) > 0)) {
    const tool = tools.find(t => !/^(golden|copper)_/.test(t)) ?? tools[0]
    step(ctx, `${pretty(item)} needs a ${pretty(tool)} first`)
    await obtain(bot, ctx, tool, 1, depth + 1)
  }
  const ore = sources.map(s => s.name.replace(/^deepslate_/, '').replace(/_ore$/, '')).find(o => ORES.includes(o))
  for (let round = 0; round < 4 && countOf(bot, item) < count; round++) {
    check(ctx)
    await ensureSpace(bot, ctx)
    const left = count - countOf(bot, item)
    if (ore) {
      step(ctx, `mine ${left} ${pretty(ore)} ore`)
      await mineOre(bot, ctx.memory, ore, left, ctx.cancelled)
    } else {
      await mineBlocks(bot, ctx, sources.map(s => s.id), item, count)
    }
  }
}

const logBlockIds = (bot) => Object.values(bot.registry.blocksByName).filter(b => LOGS.test(b.name)).map(b => b.id)

// Don't dig up the base or things he built
function isProtected (ctx, pos) {
  const places = ctx.memory?.places ?? {}
  return Object.entries(places).some(([name, p]) =>
    !/^(mine|where i last died)$|spot$/.test(name) &&
    Math.abs(p.x - pos.x) <= 6 && Math.abs(p.z - pos.z) <= 6 && Math.abs(p.y - pos.y) <= 6)
}

// Chop/dig blocks until he has `count` of `item`, wandering a bit to find more if needed
async function mineBlocks (bot, ctx, ids, item, count) {
  const skip = new Set()
  let explored = 0; let errors = 0
  while (countOf(bot, item) < count) {
    check(ctx)
    await ensureSpace(bot, ctx)
    let block = null
    for (let tries = 0; tries < 20; tries++) {
      const b = findSafeBlock(bot, ids, skip)
      if (!b) break
      if (isProtected(ctx, b.position)) { skip.add(b.position.toString()); continue }
      block = b; break
    }
    if (!block) {
      if (explored >= 4) throw new Error(`couldn't find any ${pretty(item)} around here`)
      explored++
      step(ctx, `no ${pretty(item)} nearby, exploring`)
      await explore(bot, ctx)
      continue
    }
    try {
      await bot.collectBlock.collect(block)
    } catch (err) {
      if (/cancelled/.test(err.message)) throw err
      skip.add(block.position.toString())
      if (++errors > 8) throw new Error(`kept failing to get ${pretty(item)}: ${err.message}`)
    }
  }
}

let exploreTurn = 0
async function explore (bot, ctx) {
  const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]]
  const [dx, dz] = dirs[exploreTurn++ % dirs.length]
  const p = bot.entity.position
  await Promise.race([
    bot.pathfinder.goto(new GoalXZ(Math.floor(p.x + dx * 28), Math.floor(p.z + dz * 28))).catch(() => {}),
    new Promise(resolve => setTimeout(resolve, 25000))
  ])
  check(ctx)
}

async function doSmelt (bot, ctx, name, count, depth) {
  const input = SMELT[name]
  for (let pass = 0; pass < 3 && countOf(bot, name) < count; pass++) {
    const need = count - countOf(bot, name)
    step(ctx, `smelt ${need} ${pretty(name)} from ${pretty(input)}`)
    ctx.reserve.add(input)
    await obtain(bot, ctx, input, need, depth + 1)
    const furnaceNear = bot.findBlock({ matching: ['furnace', 'blast_furnace', 'smoker'].map(n => bot.registry.blocksByName[n]?.id).filter(x => x !== undefined), maxDistance: 32 })
    if (!furnaceNear && countOf(bot, 'furnace') < 1) await obtain(bot, ctx, 'furnace', 1, depth + 1)
    await ensureFuel(bot, ctx, need, input, depth)
    const inputItem = input === 'logs' ? bot.inventory.items().find(i => LOGS.test(i.name))?.name : input
    await smelt(bot, inputItem, need)
  }
}

async function ensureFuel (bot, ctx, items, input, depth) {
  const value = () => (countOf(bot, 'coal') + countOf(bot, 'charcoal')) * 8 + countOf(bot, 'planks') * 1.5 +
    (input === 'logs' ? 0 : countOf(bot, 'logs') * 1.5)
  if (value() >= items) return
  step(ctx, `need fuel for ${items} items`)
  try {
    await obtain(bot, ctx, 'coal', countOf(bot, 'coal') + Math.ceil((items - value()) / 8), depth + 1)
  } catch (err) {
    if (/cancelled/.test(err.message)) throw err
    step(ctx, `no coal (${err.message}), using planks as fuel`)
    await obtain(bot, ctx, 'planks', countOf(bot, 'planks') + Math.ceil((items - value()) / 1.5), depth + 1)
  }
}

async function huntUntil (bot, ctx, done, mobFilter, label) {
  let explored = 0
  while (!done()) {
    check(ctx)
    await ensureSpace(bot, ctx)
    const target = mobFilter()
    if (!target) {
      if (explored >= 3) throw new Error(`couldn't find any ${label} around here`)
      explored++
      step(ctx, `no ${label} nearby, exploring`)
      await explore(bot, ctx)
      continue
    }
    step(ctx, `kill ${target.name}`)
    await killEntity(bot, target, ctx.cancelled)
  }
}

async function getFood (bot, ctx, count) {
  await huntUntil(bot, ctx, () => countOf(bot, 'food') >= count, () => findPrey(bot, 'food'), 'animals')
}

async function getCookedFood (bot, ctx, count, depth) {
  const rawCount = () => RAW_MEAT.reduce((a, m) => a + countOf(bot, m), 0)
  const need = count - countOf(bot, 'cooked_food')
  if (rawCount() < need) {
    await huntUntil(bot, ctx, () => rawCount() >= need, () => findPrey(bot, 'food'), 'animals')
  }
  for (const m of RAW_MEAT) {
    const n = Math.min(countOf(bot, m), count - countOf(bot, 'cooked_food'))
    if (n > 0) await obtain(bot, ctx, `cooked_${m}`, countOf(bot, `cooked_${m}`) + n, depth + 1)
  }
}

async function doHunt (bot, ctx, item, count) {
  const mobs = MOB_DROPS[item]
  await huntUntil(bot, ctx, () => countOf(bot, item) >= count, () => {
    for (const m of mobs) { const t = findPrey(bot, m); if (t) return t }
    return null
  }, mobs.join('/'))
}

// ---------- full inventory -> chests ----------
const emptySlots = (bot) => typeof bot.inventory.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : 36

export async function ensureSpace (bot, ctx, minFree = 2) {
  if (ctx.storing || emptySlots(bot) >= minFree) return
  await storeExcess(bot, ctx)
}

function usableChest (bot, ctx) {
  const ids = ['chest', 'trapped_chest', 'barrel'].map(n => bot.registry.blocksByName[n]?.id).filter(x => x !== undefined)
  for (const p of bot.findBlocks({ matching: ids, maxDistance: 24, count: 10 })) {
    if (!ctx.fullChests.has(p.toString())) return bot.blockAt(p)
  }
  return null
}

// Put everything he doesn't need right now into a chest; make a chest (or another one) when needed
export async function storeExcess (bot, ctx) {
  ctx.storing = true
  try {
    const keep = (i) => KEEP.test(i.name) || FOODS.includes(i.name) || ctx.reserve.has(familyOf(i.name))
    for (let round = 0; round < 4; round++) {
      check(ctx)
      const toStore = bot.inventory.items().filter(i => !keep(i))
      if (!toStore.length) { step(ctx, 'inventory is full of stuff I need right now'); return }
      let chest = usableChest(bot, ctx)
      if (!chest) {
        step(ctx, 'inventory full and no chest nearby: making one')
        // crafting the chest needs a few free slots (planks, the table, the chest): drop junk first, then spare cobble
        for (const re of [JUNK, SPARE]) {
          for (const j of bot.inventory.items().filter(i => re.test(i.name) && !ctx.reserve.has(familyOf(i.name)))) {
            if (emptySlots(bot) >= 3) break
            step(ctx, `dropping ${j.count} ${pretty(j.name)} to make room`)
            await bot.toss(j.type, null, j.count)
          }
        }
        const saved = ctx.stack
        ctx.stack = []
        try { await obtain(bot, ctx, 'chest', 1) } finally { ctx.stack = saved }
        chest = await placeNextToMe(bot, 'chest')
        const p = chest.position
        ctx.memory?.remember('place', 'storage', null, { x: p.x, y: p.y, z: p.z, dimension: bot.game?.dimension })
      }
      const win = await bot.openContainer(chest)
      let full = false
      const stored = []
      try {
        for (const it of bot.inventory.items().filter(i => !keep(i))) {
          try {
            await win.deposit(it.type, null, it.count)
            stored.push(`${it.count} ${it.name}`)
          } catch (err) {
            if (/full|space|destination/i.test(err.message)) { full = true; break }
            throw err
          }
        }
        const contents = {}
        for (const i of win.containerItems()) contents[i.name] = (contents[i.name] ?? 0) + i.count
        ctx.memory?.rememberChest?.(chest.position, contents, bot.game?.dimension)
      } finally {
        win.close()
      }
      if (stored.length) step(ctx, `stored ${stored.join(', ')}`)
      if (!full) return
      ctx.fullChests.add(chest.position.toString())
      step(ctx, 'that chest is full, getting another one')
    }
  } finally {
    ctx.storing = false
  }
}

// One-call helper for other modules: get N of something with a fresh plan
export async function obtainItem (bot, name, count, opts = {}) {
  const item = normalizeItem(bot, name) ?? name
  return obtain(bot, makeCtx(opts), item, count)
}
