// A tiny fake Minecraft for tests: real recipes and block drops for the version, a few resources lying around,
// and just enough of mineflayer's API (inventory, crafting, collecting, furnaces, chests, mobs) for the planner.
import { EventEmitter } from 'node:events'
import mcData from 'minecraft-data'
import prismarineRecipe from 'prismarine-recipe'
import { Vec3 } from 'vec3'

const SMELTS = {
  raw_iron: 'iron_ingot', raw_gold: 'gold_ingot', raw_copper: 'copper_ingot', sand: 'glass', cobblestone: 'stone',
  beef: 'cooked_beef', porkchop: 'cooked_porkchop', chicken: 'cooked_chicken', mutton: 'cooked_mutton', oak_log: 'charcoal'
}
const MOB_LOOT = { cow: ['beef', 'beef', 'leather'], pig: ['porkchop', 'porkchop'], sheep: ['mutton', 'white_wool'], chicken: ['chicken', 'feather'] }

/**
 * world: [{ name, at: [x, y, z] }] resources; mobs: [{ name, at }]; inventory: { item: count }
 * Ground: y < 63 is stone (not findable, so it doesn't count as a resource), y = 63 grass, above is air.
 */
export function makeSimBot ({ version = '26.1', inventory = {}, world = [], mobs = [], slots = 36 } = {}) {
  const registry = mcData(version)
  const { Recipe } = prismarineRecipe(registry)
  const bot = new EventEmitter()
  const blocks = new Map() // "x,y,z" -> name
  const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
  for (const w of world) blocks.set(key(new Vec3(...w.at)), w.name)
  const stats = { crafted: {}, mined: {}, placed: {}, smelted: 0, killed: [], explored: 0 }

  // ---------- inventory ----------
  let inv = [] // [{ name, count, type }]
  const stackSize = (name) => registry.itemsByName[name]?.stackSize ?? 64
  const add = (name, n) => {
    if (!registry.itemsByName[name]) throw new Error(`sim: unknown item ${name}`)
    for (const s of inv) if (s.name === name && s.count < stackSize(name) && n > 0) { const m = Math.min(n, stackSize(name) - s.count); s.count += m; n -= m }
    while (n > 0) {
      if (inv.length >= slots) return false // full: the rest stays on the ground
      const m = Math.min(n, stackSize(name)); inv.push({ name, count: m, type: registry.itemsByName[name].id }); n -= m
    }
    return true
  }
  const remove = (name, n) => {
    for (const s of inv) if (s.name === name && n > 0) { const m = Math.min(n, s.count); s.count -= m; n -= m }
    inv = inv.filter(s => s.count > 0)
    if (n > 0) throw new Error(`sim: tried to use ${n} more ${name} than carried`)
  }
  const have = (name) => inv.filter(s => s.name === name).reduce((a, s) => a + s.count, 0)
  for (const [n, c] of Object.entries(inventory)) add(n, c)

  bot.registry = registry
  bot.version = version
  bot.game = { dimension: 'overworld' }
  bot.time = { timeOfDay: 1000 }
  bot.entity = { position: new Vec3(0.5, 64, 0.5), yaw: 0, height: 1.8, id: 1 }
  bot.health = 20; bot.food = 20; bot.oxygenLevel = 20
  bot.inventory = {
    items: () => inv.map(s => ({ ...s })),
    emptySlotCount: () => slots - inv.length,
    count: (id) => inv.filter(s => s.type === id).reduce((a, s) => a + s.count, 0),
    slots: []
  }
  bot.sim = { blocks, stats, have, add, inv: () => inv }

  // ---------- world ----------
  const nameAt = (p) => blocks.get(key(p)) ?? (p.y < 63 ? 'stone' : p.y < 64 ? 'grass_block' : 'air')
  bot.blockAt = (p) => {
    if (!p) return null
    const name = nameAt(p)
    const def = registry.blocksByName[name] ?? {}
    return { name, type: def.id, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: def.boundingBox ?? (name === 'air' ? 'empty' : 'block'), harvestTools: def.harvestTools, drops: def.drops }
  }
  const matches = (matching, name) => {
    const id = registry.blocksByName[name]?.id
    if (typeof matching === 'function') return !!matching({ name, type: id })
    return Array.isArray(matching) ? matching.includes(id) : matching === id
  }
  bot.findBlocks = ({ matching, maxDistance = 64, count = 1 }) => {
    const me = bot.entity.position
    return [...blocks.entries()]
      .filter(([, name]) => matches(matching, name))
      .map(([k]) => new Vec3(...k.split(',').map(Number)))
      .filter(p => p.distanceTo(me) <= maxDistance)
      .sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
      .slice(0, count)
  }
  bot.findBlock = (opts) => { const p = bot.findBlocks({ ...opts, count: 1 })[0]; return p ? bot.blockAt(p) : null }
  const dropsOf = (name) => {
    const def = registry.blocksByName[name]
    if (!def) return []
    if (def.harvestTools && !Object.keys(def.harvestTools).some(id => inv.some(s => String(s.type) === String(id)))) return [] // wrong tool: nothing drops
    return (def.drops ?? []).map(d => registry.items[typeof d === 'number' ? d : (d?.drop?.id ?? d?.drop ?? d?.id)]?.name).filter(Boolean)
  }
  const breakBlock = (b) => {
    const name = nameAt(b.position)
    blocks.delete(key(b.position))
    stats.mined[name] = (stats.mined[name] ?? 0) + 1
    for (const d of dropsOf(name)) add(d, 1)
  }
  bot.dig = async (b) => breakBlock(b)
  // he walks up to it and ends up standing on the ground next to it (logs higher up are reached from below)
  bot.collectBlock = { collect: async (b) => { bot.entity.position = new Vec3(b.position.x + 1.5, Math.min(b.position.y, 64), b.position.z + 0.5); breakBlock(b) }, cancelTask: () => {} }
  bot.pathfinder = {
    goto: async (goal) => {
      if (goal && Number.isFinite(goal.x) && Number.isFinite(goal.z)) {
        if (goal.y === undefined) stats.explored++
        bot.entity.position = new Vec3(goal.x + 0.5, Number.isFinite(goal.y) ? goal.y : bot.entity.position.y, goal.z + 0.5)
      }
    },
    setGoal: () => {}, stop: () => {}, isMoving: () => false, setMovements: () => {}
  }
  bot.tool = { equipForBlock: async () => {} }
  let held = null
  bot.equip = async (item) => { held = item?.name ?? item }
  bot.placeBlock = async (ref, face) => {
    const at = ref.position.plus(face)
    if (nameAt(at) !== 'air') throw new Error('sim: spot taken')
    remove(held, 1)
    blocks.set(key(at), held)
    stats.placed[held] = (stats.placed[held] ?? 0) + 1
  }
  bot.toss = async (type, meta, count) => { remove(registry.items[type].name, count) }
  bot.lookAt = async () => {}

  // ---------- crafting (real recipes) ----------
  const canCraft = (r) => r.delta.every(d => d.count >= 0 || have(registry.items[d.id].name) >= -d.count)
  bot.recipesAll = (id, meta, table) => Recipe.find(id, meta ?? null).filter(r => table || !r.requiresTable)
  bot.recipesFor = (id, meta, min, table) => bot.recipesAll(id, meta, table).filter(canCraft)
  bot.craft = async (recipe, times = 1, table) => {
    if (recipe.requiresTable && (!table || nameAt(table.position) !== 'crafting_table')) throw new Error('sim: needs a crafting table')
    for (let i = 0; i < times; i++) {
      if (!canCraft(recipe)) throw new Error('sim: missing ingredients')
      for (const d of recipe.delta) {
        const n = registry.items[d.id].name
        if (d.count < 0) remove(n, -d.count); else add(n, d.count)
      }
      const out = registry.items[recipe.result.id].name
      stats.crafted[out] = (stats.crafted[out] ?? 0) + recipe.result.count
    }
  }

  // ---------- furnace (instant) ----------
  bot.openFurnace = async (b) => {
    if (!/furnace|smoker/.test(nameAt(b.position))) throw new Error('sim: not a furnace')
    let input = null; let fuel = null; let output = null; let burn = 0
    const run = () => {
      while (input && input.count > 0 && (burn > 0 || (fuel && fuel.count > 0))) {
        if (burn <= 0) { burn = fuel.name === 'coal' || fuel.name === 'charcoal' ? 8 : 1.5; fuel.count--; if (!fuel.count) fuel = null }
        burn--; input.count--
        const out = SMELTS[input.name]
        output = { name: out, count: (output?.count ?? 0) + 1, type: registry.itemsByName[out].id }
        stats.smelted++
        if (!input.count) input = null
      }
    }
    return {
      get fuel () { return burn },
      fuelItem: () => fuel, inputItem: () => input, outputItem: () => output,
      putFuel: async (type, m, n) => { const name = registry.items[type].name; remove(name, n); fuel = { name, count: (fuel?.count ?? 0) + n, type }; run() },
      putInput: async (type, m, n) => { const name = registry.items[type].name; remove(name, n); input = { name, count: (input?.count ?? 0) + n, type }; run() },
      takeOutput: async () => { const o = output; output = null; if (o) add(o.name, o.count); return o },
      close: () => {}
    }
  }

  // ---------- chests (27 slots each) ----------
  const chestStore = new Map()
  bot.openContainer = async (b) => {
    const k = key(b.position)
    if (!/chest|barrel/.test(nameAt(b.position))) throw new Error('sim: not a chest')
    if (!chestStore.has(k)) chestStore.set(k, [])
    const items = chestStore.get(k)
    return {
      containerItems: () => items.map(s => ({ ...s })),
      deposit: async (type, m, n) => {
        const name = registry.items[type].name
        if (items.length >= 27) throw new Error('destination full')
        remove(name, n); items.push({ name, count: n, type })
      },
      withdraw: async (type, m, n) => { const s = items.find(i => i.type === type); s.count -= n; add(s.name, n) },
      close: () => {}
    }
  }
  bot.sim.chests = chestStore

  // ---------- mobs ----------
  bot.entities = {}
  let nextId = 100
  for (const m of mobs) { const id = nextId++; bot.entities[id] = { id, name: m.name, type: 'animal', position: new Vec3(...m.at), height: 1.4 } }
  bot.nearestEntity = (fn) => Object.values(bot.entities).filter(fn)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] ?? null
  bot.pvp = {
    attack: (target) => {
      setTimeout(() => {
        if (!bot.entities[target.id]) return
        delete bot.entities[target.id]
        stats.killed.push(target.name)
        for (const loot of MOB_LOOT[target.name] ?? []) add(loot, 1) // (real drops land on the ground; walking over picks them up)
        bot.emit('entityDead', target)
      }, 5)
    },
    stop: () => {}
  }
  bot.chat = () => {}
  return bot
}
