import fs from 'node:fs'
import path from 'node:path'
import pathfinderPkg from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { ROOT, DATA_DIR, log } from './config.js'
import { findItem, craftItem, resolveBlockIds, findSafeBlock } from './actions.js'

const { GoalNear } = pathfinderPkg.goals

export const BUILDS_DIR = path.join(ROOT, 'builds') // built-in blueprints + .schem files you download
export const DESIGNS_DIR = path.join(DATA_DIR, 'builds') // builds Gemma designed (kept local)
fs.mkdirSync(DESIGNS_DIR, { recursive: true })

const MAX_CELLS = 3000

// ---------- materials ----------
// Families of interchangeable building blocks. Order inside doesn't matter; he picks what he has most of.
const FAMILIES = [
  ['planks', /_planks$/],
  ['logs', /(_log|_wood|_stem|_hyphae)$/],
  ['stone', /^(cobblestone|stone|stone_bricks|mossy_cobblestone|mossy_stone_bricks|andesite|diorite|granite|polished_(andesite|diorite|granite|deepslate|blackstone|tuff)|cobbled_deepslate|deepslate|deepslate_bricks|deepslate_tiles|bricks|sandstone|smooth_sandstone|red_sandstone|smooth_stone|tuff|tuff_bricks|blackstone|blackstone_bricks|mud_bricks|calcite|end_stone|nether_bricks|prismarine|quartz_block)$/],
  ['dirt', /^(dirt|coarse_dirt|rooted_dirt|mud|packed_mud)$/],
  ['wool', /_wool$/],
  ['concrete', /_concrete$/],
  ['terracotta', /terracotta$/]
]
// If a family is missing entirely, use these instead (most common stuff first)
const FALLBACK_ORDER = ['planks', 'stone', 'logs', 'dirt']
// Things worth skipping when copying someone else's build (decor he can't easily get or place)
const DECOR = /flower|tulip|poppy|dandelion|orchid|allium|bluet|daisy|cornflower|lily|rose|peony|lilac|carpet|button|pressure_plate|sign|banner|item_frame|painting|pot$|candle|rail|lever|tripwire|^grass$|short_grass|tall_grass|fern|vine|bush|sapling|mushroom|dead_|coral|kelp|seagrass|chain|bed$|head|skull|cake|cobweb|snow$|moss_carpet|lantern|campfire|anvil|bell|brewing|cauldron|lectern|loom|grindstone|stonecutter|composter|barrel|chest|furnace|smoker|crafting_table|enchanting|beacon|redstone|repeater|comparator|hopper|dropper|dispenser|observer|piston|note_block|jukebox|spawner|water|lava|bubble|fire|portal|barrier|structure|command|jigsaw|light$/

function baseName (name) {
  // stairs/slabs/walls -> the full block they're made of
  const b = name.replace(/_(stairs|slab|wall)$/, '')
  if (b === name) return name
  if (b === 'oak' || /^(spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped)$/.test(b)) return `${b}_planks`
  if (/brick$/.test(b)) return b + 's'
  return b
}

export function familyOf (name) {
  const b = baseName(name)
  for (const [fam, re] of FAMILIES) if (re.test(b)) return fam
  if (/bookshelf/.test(name)) return 'planks'
  return null
}

// What a blueprint cell means: air, skip, a special thing, or a building block
export function cellKind (name) {
  if (!name || name === 'air' || name === 'cave_air' || name === 'void_air') return 'air'
  if (name === 'skip') return 'skip'
  if (name === 'door' || /_door$/.test(name)) return 'door'
  if (name === 'torch' || /wall_torch$|^torch$/.test(name)) return 'torch'
  if (name === 'ladder') return 'ladder'
  if (/glass/.test(name)) return 'glass'
  if (/_fence$|_fence_gate$/.test(name)) return 'fence'
  if (DECOR.test(name)) return 'skip'
  return 'block'
}

const invCounts = (bot) => {
  const c = {}
  for (const i of bot.inventory.items()) c[i.name] = (c[i.name] ?? 0) + i.count
  return c
}
const isPlaceableBlockItem = (bot, name) => !!bot.registry.blocksByName[name]

// Decide the real material for every kind of block in the blueprint, using what's in the inventory.
// prefer = material the owner asked for ("out of cobblestone"), applied to the main structure.
export function planMaterials (bot, cells, prefer) {
  const need = {} // original block -> count
  for (const c of cells) if (cellKind(c.block) === 'block' || cellKind(c.block) === 'fence') need[baseName(c.block)] = (need[baseName(c.block)] ?? 0) + 1
  const have = invCounts(bot)
  const left = { ...have }
  const assign = {}
  const shortages = {}
  const groups = Object.entries(need).sort((a, b) => b[1] - a[1])
  const mainFamily = groups.length ? familyOf(groups[0][0]) : null
  const preferName = prefer ? String(prefer).toLowerCase().trim().replace(/\s+/g, '_').replace(/s$/, '') : null

  const pickFrom = (fam, n) => {
    // most-plentiful item of that family that covers n (or the most-plentiful at all)
    const options = Object.keys(left).filter(k => familyOf(k) === fam && isPlaceableBlockItem(bot, k)).sort((a, b) => left[b] - left[a])
    return options.find(k => left[k] >= n) ?? options[0] ?? null
  }

  for (const [orig, n] of groups) {
    const fam = familyOf(orig)
    let choice = null
    if (preferName && (fam === mainFamily || !fam)) {
      choice = Object.keys(bot.registry.blocksByName).includes(preferName) ? preferName
        : Object.keys(bot.registry.blocksByName).find(k => k === preferName + 's' || k === preferName + '_planks' || k.startsWith(preferName)) ?? null
    }
    if (!choice && (left[orig] ?? 0) >= n) choice = orig
    if (!choice && fam) choice = pickFrom(fam, n)
    if (!choice) choice = orig // nothing similar on hand; try to gather it, else substitute later
    assign[orig] = choice
    const got = left[choice] ?? 0
    left[choice] = Math.max(0, got - n)
    if (got < n) shortages[choice] = (shortages[choice] ?? 0) + (n - got)
  }
  // special pieces: use them if we have them, otherwise leave the gap / skip
  const firstWith = (re) => Object.keys(have).find(k => re.test(k))
  assign.glass = firstWith(/glass/) ?? 'air'
  assign.door = firstWith(/_door$/) ?? 'air'
  assign.torch = have.torch ? 'torch' : 'skip'
  assign.ladder = have.ladder ? 'ladder' : 'skip'
  return { assign, shortages, need }
}

export function materialFor (plan, cell) {
  const k = cellKind(cell.block)
  if (k === 'air' || k === 'skip') return k
  if (k === 'block' || k === 'fence') return plan.assign[baseName(cell.block)]
  return plan.assign[k]
}

// ---------- gathering ----------
async function collectN (bot, blockName, n, cancelled) {
  const ids = resolveBlockIds(bot, blockName)
  for (let i = 0; i < n; i++) {
    if (cancelled()) throw new Error('cancelled')
    const b = findSafeBlock(bot, ids)
    if (!b) throw new Error(`can't find enough ${blockName} nearby (got ${i} of ${n})`)
    await bot.collectBlock.collect(b)
  }
}

async function ensurePickaxe (bot) {
  if (bot.inventory.items().some(i => i.name.endsWith('_pickaxe'))) return
  await craftItem(bot, 'wooden_pickaxe', 1)
}

// Try to get missing materials: planks from logs, cobble from stone, dirt, logs.
async function gather (bot, shortages, cancelled) {
  for (const [mat, n] of Object.entries(shortages)) {
    if (cancelled()) throw new Error('cancelled')
    const fam = familyOf(mat)
    log('build', `gathering ${n} ${mat}`)
    if (fam === 'planks') {
      const logsNeeded = Math.ceil(n / 4)
      const logs = bot.inventory.items().filter(i => /_log$|_stem$/.test(i.name)).reduce((a, i) => a + i.count, 0)
      if (logs < logsNeeded) await collectN(bot, 'wood', logsNeeded - logs, cancelled)
      const log0 = bot.inventory.items().find(i => /_log$|_stem$/.test(i.name))
      const planks = log0 ? log0.name.replace(/_(log|stem)$/, '_planks') : mat
      await craftItem(bot, planks, n)
    } else if (fam === 'logs') {
      await collectN(bot, 'wood', n, cancelled)
    } else if (mat === 'cobblestone' || mat === 'stone' || fam === 'stone') {
      await ensurePickaxe(bot)
      await collectN(bot, 'stone', n, cancelled)
    } else if (fam === 'dirt') {
      await collectN(bot, 'dirt', n, cancelled)
    } else {
      throw new Error(`I can't gather ${mat}`)
    }
  }
}

// ---------- blueprints ----------
function fromLayers (bp) {
  const cells = []
  bp.layers.forEach((layer, y) => {
    layer.forEach((row, z) => {
      ;[...row].forEach((ch, x) => {
        if (ch === ' ') return
        const block = bp.palette[ch]
        if (!block || block === 'skip') return
        cells.push({ x, y, z, block })
      })
    })
  })
  return cells
}

async function fromSchem (file, version) {
  const { Schematic } = await import('prismarine-schematic')
  const schem = await Schematic.read(fs.readFileSync(file), version)
  const start = schem.start()
  const cells = []
  await schem.forEach((block, pos) => {
    if (cells.length > MAX_CELLS * 3) return
    cells.push({ x: pos.x - start.x, y: pos.y - start.y, z: pos.z - start.z, block: block.name })
  })
  return cells
}

export function listBuilds () {
  const names = new Set()
  for (const dir of [BUILDS_DIR, DESIGNS_DIR]) {
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) if (/\.(json|schem|schematic)$/.test(f)) names.add(f.replace(/\.(json|schem|schematic)$/, ''))
  }
  return [...names]
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'build'

function findBuildFile (name) {
  const s = slug(name)
  const all = []
  for (const dir of [DESIGNS_DIR, BUILDS_DIR]) {
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) all.push(path.join(dir, f))
  }
  const base = (f) => path.basename(f).replace(/\.(json|schem|schematic)$/, '')
  return all.find(f => base(f) === s) ??
    all.find(f => s.includes(base(f)) || base(f).includes(s)) ?? // "small hut" -> hut
    null
}

// strict = every layer has the same rows and every row the same width (used to make the AI fix its designs)
export function validateBlueprint (bp, { strict = false } = {}) {
  if (!bp || typeof bp.palette !== 'object' || !Array.isArray(bp.layers) || !bp.layers.length) throw new Error('blueprint needs palette and layers')
  if (bp.layers.length > 16) throw new Error('blueprint too tall (max 16 layers)')
  const D = bp.layers[0]?.length
  const W = bp.layers[0]?.[0]?.length
  bp.layers.forEach((layer, i) => {
    if (!Array.isArray(layer) || layer.length > 17) throw new Error('each layer must be a list of at most 17 rows')
    if (strict && layer.length !== D) throw new Error(`layer ${i} has ${layer.length} rows but layer 0 has ${D}; every layer needs exactly ${D} rows`)
    layer.forEach((row, j) => {
      if (typeof row !== 'string' || row.length > 17) throw new Error('rows must be strings of at most 17 characters')
      if (strict && row.length !== W) throw new Error(`layer ${i} row ${j} ("${row}") is ${row.length} characters but must be exactly ${W}; pad with spaces`)
      if (strict) for (const ch of row) if (ch !== ' ' && !(ch in bp.palette)) throw new Error(`character "${ch}" in layer ${i} is not in the palette`)
    })
  })
  return bp
}

// Last resort for a sloppy design: pad/trim rows and layers to the same size
export function normalizeBlueprint (bp) {
  const D = Math.max(...bp.layers.map(l => l.length))
  const W = Math.max(...bp.layers.flat().map(r => r.length))
  bp.layers = bp.layers.map(l => Array.from({ length: D }, (_, j) => (l[j] ?? '').padEnd(W, ' ').slice(0, W)))
  return bp
}

export function saveDesign (name, bp) {
  const file = path.join(DESIGNS_DIR, `${slug(name)}.json`)
  fs.writeFileSync(file, JSON.stringify({ ...bp, name: slug(name) }, null, 2))
  return slug(name)
}

// Returns { name, cells } for a built-in/saved blueprint or a .schem file; null if unknown
export async function loadBlueprint (name, version) {
  const file = findBuildFile(name)
  if (!file) return null
  if (file.endsWith('.json')) {
    const bp = validateBlueprint(JSON.parse(fs.readFileSync(file, 'utf8')))
    return { name: path.basename(file, '.json'), cells: fromLayers(bp), description: bp.description }
  }
  return { name: path.basename(file).replace(/\.\w+$/, ''), cells: await fromSchem(file, version) }
}

export function blueprintCells (bp) { return fromLayers(validateBlueprint(bp)) }

// ---------- building ----------
const SOLID = (b) => b && b.boundingBox === 'block'
const FACES = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]
const SIDES_FIRST = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, 1, 0]]

async function placeAt (bot, itemName, pos, kind, cancelled) {
  if (cancelled()) throw new Error('cancelled')
  const cur = bot.blockAt(pos)
  if (cur && cur.name !== 'air' && cur.name !== 'cave_air' && !/short_grass|^grass$|fern|snow$|water/.test(cur.name)) return 'filled'
  const item = findItem(bot, itemName)
  if (!item) return 'no-item'
  const faces = kind === 'ladder' ? SIDES_FIRST.slice(0, 4) : kind === 'torch' ? [[0, -1, 0], ...SIDES_FIRST.slice(0, 4)] : FACES
  for (const [dx, dy, dz] of faces) {
    const ref = bot.blockAt(pos.offset(dx, dy, dz))
    if (!SOLID(ref)) continue
    const eye = bot.entity.position.offset(0, 1.62, 0)
    if (eye.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4.3) await bot.pathfinder.goto(new GoalNear(pos.x, pos.y, pos.z, 3))
    const feet = bot.entity.position.floored()
    if (kind !== 'torch' && kind !== 'ladder' && kind !== 'door' && (feet.equals(pos) || feet.offset(0, 1, 0).equals(pos))) {
      await bot.pathfinder.goto(new GoalNear(pos.x + 2, pos.y, pos.z + 2, 1)).catch(() => {})
    }
    await bot.equip(item, 'hand')
    await bot.placeBlock(ref, new Vec3(-dx, -dy, -dz))
    return 'placed'
  }
  return 'no-support'
}

// Where the build goes: a couple of blocks in front of him, floor replacing the ground layer
function pickOrigin (bot, cells) {
  const w = Math.max(...cells.map(c => c.x)) + 1
  const d = Math.max(...cells.map(c => c.z)) + 1
  const feet = bot.entity.position.floored()
  const yaw = bot.entity.yaw
  const fx = Math.round(-Math.sin(yaw)); const fz = fx === 0 ? (Math.round(-Math.cos(yaw)) || 1) : 0
  let ox, oz
  if (fx === 1) { ox = feet.x + 2; oz = feet.z - Math.floor(d / 2) } else if (fx === -1) { ox = feet.x - 1 - w; oz = feet.z - Math.floor(d / 2) } else if (fz === 1) { oz = feet.z + 2; ox = feet.x - Math.floor(w / 2) } else { oz = feet.z - 1 - d; ox = feet.x - Math.floor(w / 2) }
  return new Vec3(ox, feet.y - 1, oz)
}

/**
 * Build a structure.
 * structure: name of a blueprint/.schem, OR a description (Gemma designs it via designFn)
 * opts: { material, memory, design: async (description) => blueprint, cancelled, version }
 */
export async function buildStructure (bot, structure, opts = {}) {
  const cancelled = opts.cancelled ?? (() => false)
  let bp = await loadBlueprint(structure, opts.version ?? bot.version)
  if (!bp) {
    if (!opts.design) throw new Error(`I don't know how to build "${structure}"`)
    log('build', `no blueprint for "${structure}", designing one`)
    const designed = await opts.design(structure)
    const name = saveDesign(structure, designed)
    bp = { name, cells: blueprintCells(designed), description: designed.description }
    log('build', `designed and saved as "${name}"`)
  }
  let cells = bp.cells
  const solidCells = cells.filter(c => cellKind(c.block) !== 'air' && cellKind(c.block) !== 'skip')
  if (!solidCells.length) throw new Error('that blueprint is empty')
  if (solidCells.length > MAX_CELLS) throw new Error(`that build is too big (${solidCells.length} blocks, max ${MAX_CELLS})`)
  // drop air cells far outside the solid part (schematics carry lots of empty space)
  cells = cells.filter(c => cellKind(c.block) !== 'skip')

  // 1) materials: plan, gather what's missing, re-plan, then fall back to anything he has
  let plan = planMaterials(bot, cells, opts.material)
  if (Object.keys(plan.shortages).length) {
    try { await gather(bot, plan.shortages, cancelled) } catch (err) {
      if (/cancelled/.test(err.message)) throw err
      log('build', `couldn't gather everything: ${err.message}`)
    }
    plan = planMaterials(bot, cells, opts.material)
  }
  if (Object.keys(plan.shortages).length) {
    // last resort: swap short materials for whatever full blocks he has spare
    const have = invCounts(bot)
    for (const [mat, missing] of Object.entries(plan.shortages)) {
      const spare = FALLBACK_ORDER.flatMap(f => Object.keys(have).filter(k => familyOf(k) === f && isPlaceableBlockItem(bot, k)))
        .sort((a, b) => have[b] - have[a])[0]
      if (!spare || have[spare] < missing) continue
      for (const k of Object.keys(plan.assign)) if (plan.assign[k] === mat) plan.assign[k] = spare
      log('build', `not enough ${mat}, using ${spare} instead`)
      have[spare] -= missing
      delete plan.shortages[mat]
    }
  }
  const short = Object.entries(plan.shortages).map(([k, v]) => `${v} ${k}`).join(', ')
  if (short) log('build', `still short on ${short}; building as much as I can`)

  const origin = opts.origin ?? pickOrigin(bot, cells)
  const at = (c) => origin.offset(c.x, c.y, c.z)
  log('build', `building ${bp.name} at ${origin.x} ${origin.y} ${origin.z} (${solidCells.length} blocks)`)

  // 2) clear the space: anything in the way that shouldn't be there, top-down
  const toClear = cells
    .filter(c => {
      const want = materialFor(plan, c)
      const cur = bot.blockAt(at(c))
      return cur && !/^(air|cave_air|void_air|bedrock)$/.test(cur.name) && cur.name !== want && !/water|lava/.test(cur.name)
    })
    .sort((a, b) => b.y - a.y)
  for (const c of toClear) {
    if (cancelled()) throw new Error('cancelled')
    const cur = bot.blockAt(at(c))
    if (!cur || cur.name === 'air') continue
    if (cur.boundingBox !== 'block' && cellKind(materialFor(plan, c)) === 'air') { try { await bot.dig(cur) } catch {} ; continue }
    try {
      if (bot.entity.position.distanceTo(at(c)) > 4.3) await bot.pathfinder.goto(new GoalNear(at(c).x, at(c).y, at(c).z, 3))
      try { await bot.tool.equipForBlock(cur) } catch {}
      await bot.dig(cur)
    } catch (err) { log('build', `couldn't clear ${cur.name}: ${err.message}`) }
  }

  // 3) place bottom-up; within a layer, keep placing whatever already has something to attach to
  const todo = cells.filter(c => !['air', 'skip'].includes(materialFor(plan, c)))
  const doorTops = new Set()
  let placed = 0; let skipped = 0
  const layers = [...new Set(todo.map(c => c.y))].sort((a, b) => a - b)
  for (const y of layers) {
    let remaining = todo.filter(c => c.y === y && !doorTops.has(`${c.x},${c.y},${c.z}`))
    let progress = true
    while (remaining.length && progress) {
      progress = false
      const me = bot.entity.position
      remaining.sort((a, b) => at(a).distanceTo(me) - at(b).distanceTo(me))
      const next = []
      for (const c of remaining) {
        const mat = materialFor(plan, c)
        const kind = cellKind(c.block)
        let r
        try { r = await placeAt(bot, mat, at(c), kind, cancelled) } catch (err) {
          if (/cancelled/.test(err.message)) throw err
          r = 'error'
        }
        if (r === 'placed' || r === 'filled') {
          progress = true
          if (r === 'placed') placed++
          if (kind === 'door') doorTops.add(`${c.x},${c.y + 1},${c.z}`)
          if (placed % 20 === 0 && r === 'placed') log('build', `${placed}/${todo.length} placed`)
        } else if (r === 'no-support' && y === layers[0]) {
          // floor over a dip: put a support block under it, then try again next pass
          const below = at(c).offset(0, -1, 0)
          try { await placeAt(bot, mat, below, 'block', cancelled) } catch {}
          next.push(c)
        } else if (r === 'no-item') {
          skipped++
        } else {
          next.push(c)
        }
      }
      remaining = next
    }
    skipped += remaining.length
  }
  opts.memory?.remember('place', bp.name, null, { x: origin.x, y: origin.y + 1, z: origin.z, dimension: bot.game?.dimension })
  return `built the ${bp.name}: ${placed} blocks placed${skipped ? `, ${skipped} skipped` : ''}${short ? ` (ran short on ${short})` : ''}`
}
