import pathfinderPkg from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { bestFood, ownerEntity, nearbyHostiles, isAttackable, isMobNamed, FOOD_ANIMALS, FOODS, touchesLiquid } from './bot.js'
import { config, log } from './config.js'
import { storeItems, takeItems, smelt, placeNextToMe } from './containers.js'
import { mineOre, ORES } from './mining.js'
import { obtain, makeCtx, parseGoal, countOf, storeExcess, SMELT, normalizeItem } from './planner.js'

const { goals } = pathfinderPkg
const { GoalFollow, GoalNear, GoalInvert } = goals

// His own gear: kept when giving/storing "everything"
const KEEP_GEAR = /sword|_axe|pickaxe|shovel|hoe|helmet|chestplate|leggings|boots|shield|bow|crossbow|trident/

const WEAPONS = ['netherite_sword', 'diamond_sword', 'netherite_axe', 'diamond_axe', 'iron_sword', 'iron_axe',
  'stone_sword', 'stone_axe', 'golden_sword', 'wooden_sword', 'golden_axe', 'wooden_axe']

const BLOCK_ALIASES = {
  wood: '_log', log: '_log', logs: '_log', tree: '_log', trees: '_log',
  stone: 'stone', cobble: 'stone', cobblestone: 'stone',
  iron: 'iron_ore', coal: 'coal_ore', diamond: 'diamond_ore', diamonds: 'diamond_ore',
  gold: 'gold_ore', copper: 'copper_ore', redstone: 'redstone_ore', lapis: 'lapis_ore',
  dirt: 'dirt', sand: 'sand', gravel: 'gravel', wool: '_wool', leaves: '_leaves'
}

export const COMBAT_ACTIONS = {
  attack: 'hit the chosen target with my best weapon',
  retreat: 'back away from the chosen target to a safe distance',
  strafe_left: 'sidestep left while fighting (dodge arrows/creeper blasts)',
  strafe_right: 'sidestep right while fighting',
  shield: 'raise shield to block (only if I have one in offhand)',
  eat: 'eat food to heal (only if I have food and am not full)',
  regroup: 'sprint back next to the owner to fight together (when outnumbered, hurt, or far from the owner)',
  pursue_goal: 'no threat worth reacting to, keep doing my current goal'
}

// "Body" = everything that actually moves the bot. Brains only pick goals/actions; this executes them.
export class Body {
  constructor (bot, emit) {
    this.bot = bot
    this.emit = emit // (eventName, details) -> used for "goal finished / failed" commentary
    this.goal = makeGoal('follow', {})
    this.mode = 'goal' // 'goal' | 'combat'
    this.busyUntil = 0
    this.goalRunId = 0
  }

  setGoal (kind, args = {}) {
    const g = makeGoal(kind, args)
    if (!g) {
      // Tell the brain so it can fix it (e.g. "craft" with no item name) instead of silently doing nothing
      const why = ['craft', 'give', 'equip', 'collect', 'take', 'smelt', 'get'].includes(kind) ? `you have to say WHICH item/block to ${kind}` : `unknown goal ${kind}`
      log('goal', `couldn't start ${kind}: ${why}`)
      this.emit('goal_failed', `couldn't start ${kind}: ${why}`)
      return why
    }
    this.stopEverything()
    this.goal = g
    this.mode = 'goal'
    this.startGoal()
    log('goal', g.describe())
    return g.describe()
  }

  startGoal () {
    const runId = ++this.goalRunId
    Promise.resolve(this.goal.start(this, () => runId !== this.goalRunId))
      .then((result) => {
        if (runId !== this.goalRunId || !result) return
        // Goal finished on its own (e.g. collected enough wood) -> report and go back to following
        this.emit('goal_done', result)
        this.goal = makeGoal('follow', {})
        this.startGoal()
      })
      .catch((err) => {
        if (runId !== this.goalRunId) return
        log('goal', 'failed:', err.message)
        this.emit('goal_failed', `${this.goal.describe()} failed: ${err.message}`)
        this.goal = makeGoal('follow', {})
        this.startGoal()
      })
  }

  stopEverything () {
    const bot = this.bot
    this.goalRunId++
    try { bot.pvp.stop() } catch {}
    try { bot.collectBlock.cancelTask() } catch {}
    try { bot.pathfinder.setGoal(null) } catch {}
    if (bot.buddyMoves) bot.pathfinder.setMovements(bot.buddyMoves.normal)
    bot.clearControlStates()
  }

  // Called by the fast brain several times a second
  async act (action, target) {
    const bot = this.bot
    if (!bot.entity || Date.now() < this.busyUntil) return
    if (action === 'pursue_goal' || !COMBAT_ACTIONS[action]) {
      if (this.mode === 'combat') {
        this.mode = 'goal'
        try { bot.pvp.stop() } catch {}
        if (bot.buddyMoves) bot.pathfinder.setMovements(bot.buddyMoves.normal)
        bot.clearControlStates()
        this.startGoal() // resume what we were doing before the fight
      }
      return
    }

    if (this.mode === 'goal') {
      // Fight interrupts the goal; it gets restarted on pursue_goal
      this.goalRunId++
      try { bot.collectBlock.cancelTask() } catch {}
      this.mode = 'combat'
      if (bot.buddyMoves) bot.pathfinder.setMovements(bot.buddyMoves.combat) // chase on foot, never dig toward mobs
    }

    switch (action) {
      case 'attack':
        if (!target) return
        await this.equipWeapon()
        if (bot.pvp.target !== target) bot.pvp.attack(target)
        break
      case 'retreat':
        if (!target) return
        try { bot.pvp.stop() } catch {}
        bot.pathfinder.setGoal(new GoalInvert(new GoalFollow(target, 10)), true)
        bot.setControlState('sprint', true)
        break
      case 'strafe_left':
      case 'strafe_right': {
        const dir = action === 'strafe_left' ? 'left' : 'right'
        bot.setControlState(dir, true)
        setTimeout(() => bot.setControlState(dir, false), 350)
        break
      }
      case 'regroup': {
        const owner = ownerEntity(bot)
        if (!owner) return
        try { bot.pvp.stop() } catch {}
        bot.pathfinder.setGoal(new GoalFollow(owner, 1), true)
        bot.setControlState('sprint', true)
        break
      }
      case 'shield':
        if (bot.inventory.slots[45]?.name !== 'shield') return
        bot.activateItem(true)
        this.busyUntil = Date.now() + 600
        setTimeout(() => bot.deactivateItem(), 600)
        break
      case 'eat': {
        const food = bestFood(bot)
        if (!food || bot.food >= 20) return
        try { bot.pvp.stop() } catch {}
        this.busyUntil = Date.now() + 2000
        try {
          await bot.equip(food, 'hand')
          await bot.consume()
        } catch (err) { log('act', 'eat failed:', err.message) }
        this.busyUntil = 0
        break
      }
    }
  }

  // Emergency: running out of air underwater. Drop everything, swim up, get to land, then carry on.
  async surface () {
    const bot = this.bot
    if (this.surfacing) return
    this.surfacing = true
    const runId = ++this.goalRunId
    log('bot', `low on air (${bot.oxygenLevel}/20), swimming up`)
    try { bot.pvp.stop() } catch {}
    try { bot.collectBlock.cancelTask() } catch {}
    bot.setControlState('jump', true)
    bot.setControlState('sprint', false)
    // aim for the nearest dry spot: solid block with two air blocks above it
    const me = bot.entity.position
    const land = bot.findBlock({
      matching: (b) => b.boundingBox === 'block',
      useExtraInfo: (b) => {
        const a1 = bot.blockAt(b.position.offset(0, 1, 0)); const a2 = bot.blockAt(b.position.offset(0, 2, 0))
        return a1?.name === 'air' && a2?.name === 'air' && b.position.y >= Math.floor(me.y) - 1
      },
      maxDistance: 16
    })
    if (land) bot.pathfinder.setGoal(new GoalNear(land.position.x, land.position.y + 1, land.position.z, 1))
    const started = Date.now()
    while (Date.now() - started < 20000) {
      await new Promise(resolve => setTimeout(resolve, 250))
      const headWet = /water/.test(bot.blockAt(bot.entity.position.offset(0, 1.62, 0))?.name ?? '')
      if (!headWet && bot.oxygenLevel >= 18) break
    }
    bot.setControlState('jump', false)
    this.surfacing = false
    this.emit('goal_failed', 'You almost drowned and had to swim up for air.')
    if (runId === this.goalRunId) this.startGoal()
  }

  // Idle chore picked by Jev: grab dropped items nearby, then go back to the current goal
  async pickUpItems () {
    const bot = this.bot
    if (this.mode !== 'goal' || this.pickingUp) return
    const drop = bot.nearestEntity(e => e.name === 'item' && e.position.distanceTo(bot.entity.position) < 12)
    if (!drop) return
    this.pickingUp = true
    const runId = ++this.goalRunId
    try {
      await bot.pathfinder.goto(new GoalNear(drop.position.x, drop.position.y, drop.position.z, 0))
    } catch {}
    this.pickingUp = false
    if (runId === this.goalRunId && this.mode === 'goal') this.startGoal()
  }

  async equipWeapon () {
    const bot = this.bot
    if (WEAPONS.includes(bot.heldItem?.name)) return
    const items = bot.inventory.items()
    for (const name of WEAPONS) {
      const w = items.find(i => i.name === name)
      if (w) { try { await bot.equip(w, 'hand') } catch {} return }
    }
  }
}

export function resolveBlockIds (bot, name) {
  const term = String(name || '').toLowerCase().trim().replace(/\s+/g, '_').replace(/s$/, '')
  if (!term) return []
  const key = BLOCK_ALIASES[term] ?? BLOCK_ALIASES[term + 's'] ?? term
  const all = Object.values(bot.registry.blocksByName)
  let matches = all.filter(b => b.name === key)
  if (!matches.length) matches = all.filter(b => b.name.includes(key))
  // ores also come in deepslate variants
  if (key.endsWith('_ore')) matches = all.filter(b => b.name === key || b.name === `deepslate_${key}`)
  return matches.map(b => b.id)
}

function makeGoal (kind, args) {
  // Models put names in the wrong field (name/target/item/block); accept any of them
  const anyName = args.item ?? args.block ?? args.name ?? args.target ?? args.what
  if (['craft', 'give', 'equip', 'take', 'smelt', 'store', 'get'].includes(kind) && !args.item) args = { ...args, item: anyName }
  if (kind === 'collect' && !args.block) args = { ...args, block: anyName }
  if (['craft', 'give', 'equip', 'collect', 'take', 'smelt', 'get'].includes(kind) && !(args.item || args.block)) return null
  switch (kind) {
    case 'follow':
      return {
        describe: () => `following ${config.mc.owner}`,
        isIdle: true,
        start: (body) => {
          const owner = ownerEntity(body.bot)
          if (owner) body.bot.pathfinder.setGoal(new GoalFollow(owner, 2), true)
          else waitForOwner(body)
        }
      }
    case 'come':
      return {
        describe: () => `walking over to ${config.mc.owner}`,
        start: async (body, cancelled) => {
          const owner = ownerEntity(body.bot)
          if (!owner) throw new Error("can't see the owner")
          await body.bot.pathfinder.goto(new GoalNear(owner.position.x, owner.position.y, owner.position.z, 2))
          return cancelled() ? null : `got to ${config.mc.owner}`
        }
      }
    case 'guard': {
      let spot = null
      return {
        describe: () => 'guarding this spot',
        isGuard: true,
        isIdle: true,
        start: (body) => {
          spot = spot ?? body.bot.entity.position.clone()
          body.bot.pathfinder.setGoal(new GoalNear(spot.x, spot.y, spot.z, 2), true)
        }
      }
    }
    case 'goto': {
      const { x, y, z } = args
      if (![x, y, z].every(Number.isFinite)) return null
      return {
        describe: () => `walking to ${x} ${y} ${z}`,
        start: async (body, cancelled) => {
          await body.bot.pathfinder.goto(new GoalNear(x, y, z, 1))
          return cancelled() ? null : `arrived at ${x} ${y} ${z}`
        }
      }
    }
    case 'get':
      // "get X": the planner works out every step (tools, materials, crafting table, furnace, fuel...)
      return planGoal(args.item, args.count, 'atLeast')
    case 'tidy':
      return {
        describe: () => 'putting extra stuff in a chest',
        start: async (body, cancelled) => {
          await storeExcess(body.bot, planCtx(body, cancelled))
          return 'put my extra stuff away'
        }
      }
    case 'collect': {
      // wood / stone / iron / coal... are items the planner knows how to get (with the right tool, safely).
      // Anything it doesn't recognise as an item (leaves, glowstone blocks...) is just dug up directly.
      const count = Math.max(1, Math.min(64, Number(args.count) || 8))
      return planGoal(args.block, args.count, 'more', 'collecting', async (body, cancelled) => {
        const bot = body.bot
        const ids = resolveBlockIds(bot, args.block)
        if (!ids.length) throw new Error(`no block called "${args.block}"`)
        let got = 0
        while (got < count && !cancelled()) {
          const block = findSafeBlock(bot, ids)
          if (!block) throw new Error(`can't find any ${args.block} nearby`)
          await bot.collectBlock.collect(block)
          got++
        }
        return cancelled() ? null : `collected ${got} ${args.block}`
      })
    }
    case 'give':
      return {
        describe: () => `bringing ${args.item} to ${config.mc.owner}`,
        start: async (body, cancelled) => {
          const bot = body.bot
          const term = String(args.item || '').toLowerCase().replace(/\s+/g, '_')
          // "all" = everything but his own tools/armor; "food" = all food
          const group = /^(all|everything|stuff|items|inventory)$/.test(term) ? 'all' : /^(food|meat|foods)$/.test(term) ? 'food' : null
          const items = group === 'all' ? bot.inventory.items().filter(i => !KEEP_GEAR.test(i.name))
            : group === 'food' ? bot.inventory.items().filter(i => FOODS.includes(i.name))
              : [bot.inventory.items().find(i => i.name === term) ?? bot.inventory.items().find(i => i.name.includes(term))].filter(Boolean)
          if (!items.length) {
            const carrying = bot.inventory.items().map(i => `${i.count} ${i.name}`).join(', ') || 'nothing'
            throw new Error(`I don't have any ${args.item} (I'm carrying: ${carrying})`)
          }
          const owner = ownerEntity(bot)
          if (!owner) throw new Error("can't see the owner")
          await bot.pathfinder.goto(new GoalNear(owner.position.x, owner.position.y, owner.position.z, 2))
          if (cancelled()) return null
          await bot.lookAt(owner.position.offset(0, 1.6, 0))
          const given = []
          for (const item of items) {
            const count = group ? item.count : Math.min(item.count, Number(args.count) || item.count)
            await bot.toss(item.type, null, count)
            given.push(`${count} ${item.name}`)
          }
          return `gave ${given.join(', ')}`
        }
      }
    case 'hunt': {
      // Models sometimes put the mob in the wrong field, or leave it out ("go hunt") -> food animals
      const term = String(args.mob || args.target || args.item || '').toLowerCase().trim().replace(/\s+/g, '_')
      const forFood = isFoodHunt(term)
      // "get food" means a few animals, not one
      const count = Math.max(1, Math.min(10, Number(args.count) || (forFood ? 4 : 1)))
      const killedNames = []
      return {
        describe: () => `hunting ${forFood ? 'for food' : term} (${killedNames.length}/${count})`,
        start: async (body, cancelled) => {
          const bot = body.bot
          while (killedNames.length < count && !cancelled()) {
            // asked for cows but there are none? any food animal will do
            const target = findPrey(bot, term) ?? (forFood ? findPrey(bot, 'food') : null)
            if (!target) {
              if (killedNames.length) break
              throw new Error(`can't find any ${forFood ? 'animals to eat' : term} nearby`)
            }
            await body.equipWeapon()
            await killEntity(bot, target, cancelled)
            if (!cancelled()) killedNames.push(target.name)
          }
          if (cancelled()) return null
          const food = bot.inventory.items().filter(i => FOODS.includes(i.name)).map(i => `${i.count} ${i.name}`).join(', ')
          return `killed ${killedNames.join(', ')}${food ? `; now carrying ${food}` : ''}`
        }
      }
    }
    case 'craft':
      // crafting = get N more, gathering whatever's missing along the way
      return planGoal(args.item, args.count || 1, 'more', 'crafting')
    case 'equip':
      return {
        describe: () => `equipping ${args.item}`,
        start: async (body) => {
          const bot = body.bot
          const item = findItem(bot, args.item)
          if (!item) throw new Error(`I don't have any ${args.item}`)
          const n = item.name
          const slot = /helmet|_cap$|turtle_shell/.test(n) ? 'head' : /chestplate|elytra/.test(n) ? 'torso'
            : /leggings/.test(n) ? 'legs' : /boots/.test(n) ? 'feet' : n === 'shield' ? 'off-hand' : 'hand'
          await bot.equip(item, slot)
          return `equipped ${n}`
        }
      }
    case 'eat':
      return {
        describe: () => 'eating',
        start: async (body) => {
          const bot = body.bot
          const food = bestFood(bot)
          if (!food) throw new Error('I have no food')
          if (bot.food >= 20) throw new Error("I'm not hungry")
          await bot.equip(food, 'hand')
          await bot.consume()
          return `ate ${food.name}`
        }
      }
    case 'sleep':
      return {
        describe: () => 'going to bed',
        start: async (body, cancelled) => {
          const bot = body.bot
          // You can only sleep at night (or in a thunderstorm)
          const t = bot.time?.timeOfDay ?? 0
          if (t > 0 && t < 12542 && !bot.thunderState) throw new Error("it's daytime, you can only sleep at night")
          // pick a bed nobody (like the owner) is lying in
          const beds = bot.findBlocks({ matching: b => bot.isABed(b), maxDistance: 48, count: 12 }).map(p => bot.blockAt(p))
          const free = beds.filter(b => { try { return !bot.parseBedMetadata(b).occupied } catch { return true } })
          if (!beds.length) throw new Error('no bed nearby')
          if (!free.length) throw new Error('every bed nearby is taken (the owner is in it?) - need another bed')
          const bed = free[0]
          await bot.pathfinder.goto(new GoalNear(bed.position.x, bed.position.y, bed.position.z, 2))
          if (cancelled()) return null
          try {
            await bot.sleep(bed)
          } catch (err) {
            // the usual reasons, in plain words
            if (/monster|unsafe|mob/i.test(err.message)) throw new Error('monsters are too close to sleep')
            if (/not night|day/i.test(err.message)) throw new Error("it's not night yet")
            throw err
          }
          await new Promise(resolve => bot.once('wake', resolve))
          return 'slept through the night'
        }
      }
    case 'store':
      return {
        describe: () => `putting ${args.item || 'stuff'} in a chest`,
        start: async (body) => storeItems(body.bot, body.memory, args.item, args.count ? Number(args.count) : undefined)
      }
    case 'take':
      return {
        describe: () => `getting ${args.item} from a chest`,
        start: async (body) => takeItems(body.bot, body.memory, args.item, Number(args.count) || 64)
      }
    case 'smelt': {
      // "smelt raw iron" -> get iron ingots (the planner gets ore, furnace and fuel if needed)
      const input = String(args.item || '').toLowerCase().replace(/\s+/g, '_')
      const product = Object.keys(SMELT).find(k => SMELT[k] === input || k === input || (SMELT[k] === 'logs' && /_log$/.test(input))) ??
        Object.keys(SMELT).find(k => SMELT[k] === `raw_${input}` || SMELT[k].endsWith(input))
      if (product) return planGoal(product, args.count, 'more', 'smelting')
      return {
        describe: () => `smelting ${args.item}`,
        start: async (body) => smelt(body.bot, args.item, Number(args.count) || 64)
      }
    }
    case 'build': {
      const what = args.structure || args.item || args.task || args.name || 'hut'
      return {
        describe: () => `building a ${what}${args.material ? ` out of ${args.material}` : ''}`,
        start: async (body, cancelled) => {
          if (!body.runBuild) throw new Error('building is not available')
          return body.runBuild(String(what), args.material, cancelled)
        }
      }
    }
    case 'practice':
      // Practice mode: keep working up the skill ladder until told otherwise
      return {
        describe: () => `practicing${args.current?.() ? `: ${args.current()}` : ''}`,
        start: async (body, cancelled) => {
          if (!body.runPractice) throw new Error('practice mode is not available')
          while (!cancelled()) {
            let r
            try { r = await body.runPractice(cancelled) } catch (err) {
              if (/nothing left/.test(err.message)) return 'finished everything on the practice list'
              throw err
            }
            if (r === null || cancelled()) return null
            body.emit('practice', r.ok ? `You just learned to: ${r.task}` : `You failed at practicing "${r.task}": ${r.error}`)
            await new Promise(resolve => setTimeout(resolve, 1500))
          }
          return null
        }
      }
    case 'task':
      // Anything the fixed goals can't do: the coder writes and runs a small program for it
      return {
        describe: () => `working on: ${args.task}`,
        start: async (body, cancelled) => {
          if (!body.runTask) throw new Error('task mode is not available')
          return body.runTask(String(args.task || ''), cancelled)
        }
      }
    case 'stop':
    case 'idle':
      return { describe: () => 'standing still', isIdle: true, stay: true, start: () => {} }
    default:
      return null
  }
}

// Hunting for food (blank, "food", or naming a food animal) rather than a specific monster
export function isFoodHunt (term) {
  const t = String(term || '').toLowerCase().replace(/s$/, '')
  return !t || /^(food|meat|animal|mob|something|anything|dinner|lunch)$/.test(t) || FOOD_ANIMALS.includes(t)
}

// Nearest living mob matching the name; blank / "food" / "animal" means the nearest food animal
export function findPrey (bot, term) {
  const t = String(term || '').toLowerCase().trim().replace(/\s+/g, '_')
  const generic = !t || /^(food|animals?|meat|mobs?|something|anything)$/.test(t)
  return bot.nearestEntity(e => isAttackable(bot, e) && e.type !== 'player' &&
    e.position.distanceTo(bot.entity.position) < 48 &&
    (generic ? FOOD_ANIMALS.includes(e.name) : isMobNamed(e, t)))
}

// Nearest block of these types that's safe to mine: no water/lava behind it, not the floor under his feet
export function findSafeBlock (bot, ids, skip = null) {
  const feet = bot.entity.position.floored()
  for (const p of bot.findBlocks({ matching: ids, maxDistance: 64, count: 40 })) {
    if (p.x === feet.x && p.z === feet.z && p.y < feet.y) continue // anywhere straight below him
    if (skip?.has(p.toString())) continue
    if (touchesLiquid(bot, p)) continue
    return bot.blockAt(p)
  }
  return null
}

export function findItem (bot, name) {
  const term = String(name || '').toLowerCase().trim().replace(/\s+/g, '_')
  if (!term) return undefined
  const items = bot.inventory.items()
  return items.find(i => i.name === term) ?? items.find(i => i.name.includes(term))
}

// Kill a mob, then pick up what it dropped (meat, wool, bones...) - otherwise the loot just sits on the ground
export async function killEntity (bot, target, cancelled) {
  if (!isAttackable(bot, target)) return
  let lastPos = target.position.clone()
  await new Promise((resolve) => {
    const done = () => {
      clearInterval(check)
      bot.removeListener('entityDead', onDead)
      bot.removeListener('entityGone', onDead)
      try { bot.pvp.stop() } catch {}
      resolve()
    }
    const onDead = (e) => { if (e.id === target.id) done() }
    const started = Date.now()
    const check = setInterval(() => {
      if (bot.entities[target.id]) lastPos = bot.entities[target.id].position.clone()
      if (cancelled() || !bot.entities[target.id] || Date.now() - started > 40000) done()
    }, 250)
    bot.on('entityDead', onDead)
    bot.on('entityGone', onDead)
    bot.pvp.attack(target)
  })
  if (!cancelled()) await collectDrops(bot, lastPos, cancelled)
}

// Walk over the dropped items around a spot so they get picked up
export async function collectDrops (bot, pos, cancelled = () => false) {
  await new Promise(resolve => setTimeout(resolve, 500)) // drops spawn a moment after death
  const until = Date.now() + 8000
  while (Date.now() < until && !cancelled()) {
    const drop = bot.nearestEntity(e => e.name === 'item' && e.position.distanceTo(pos) < 6)
    if (!drop) break
    try {
      await bot.pathfinder.goto(new GoalNear(drop.position.x, drop.position.y, drop.position.z, 0))
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250))
    if (bot.entities[drop.id] && drop.position.distanceTo(bot.entity.position) < 1.5) break // can't pick it up (full?)
  }
}

// Resolve "pickaxe", "wooden pickaxe", "table" etc. to a real item name
export function resolveItemName (bot, name) {
  const term = String(name || '').toLowerCase().trim().replace(/\s+/g, '_')
  if (!term) return null
  const aliases = { table: 'crafting_table', workbench: 'crafting_table', planks: 'oak_planks', sticks: 'stick', pick: 'wooden_pickaxe', pickaxe: 'wooden_pickaxe', sword: 'wooden_sword', axe: 'wooden_axe', shovel: 'wooden_shovel', torches: 'torch' }
  const key = aliases[term] ?? term
  const byName = bot.registry.itemsByName
  if (byName[key]) return key
  if (byName[key.replace(/s$/, '')]) return key.replace(/s$/, '')
  return Object.keys(byName).find(n => n.includes(key)) ?? null
}

export async function ensureCraftingTable (bot) {
  const near = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 32 })
  if (near) {
    await bot.pathfinder.goto(new GoalNear(near.position.x, near.position.y, near.position.z, 2))
    return near
  }
  if (!findItem(bot, 'crafting_table')) {
    await craftOnce(bot, 'crafting_table', 1, null)
  }
  // Put it down anywhere close (finds room even in a tunnel)
  return placeNextToMe(bot, 'crafting_table')
}

async function craftOnce (bot, itemName, count, table) {
  const id = bot.registry.itemsByName[itemName].id
  const recipe = bot.recipesFor(id, null, 1, table)[0]
  if (!recipe) return false
  const per = recipe.result.count || 1
  for (let i = 0; i < Math.ceil(count / per); i++) {
    const r = bot.recipesFor(id, null, 1, table)[0]
    if (!r) return i > 0
    await bot.craft(r, 1, table ?? undefined)
  }
  return true
}

// Craft N more of an item. Goes through the planner, so missing materials, sticks, planks, logs, the crafting table
// and the right tools all get sorted out on the way.
export async function craftItem (bot, name, count = 1, opts = {}) {
  const item = normalizeItem(bot, name) ?? resolveItemName(bot, name)
  if (!item) throw new Error(`there's no item called "${name}"`)
  await obtain(bot, makeCtx(opts), item, countOf(bot, item) + count)
  return ` ${item}`
}

// Plan context tied to the body: shares the "these chests are full" list, and shows the current plan on the watch page
export function planCtx (body, cancelled) {
  body.fullChests ??= new Set()
  return makeCtx({
    memory: body.memory,
    cancelled,
    fullChests: body.fullChests,
    onStep: (stack, text) => { body.plan = { stack, text, at: Date.now() } }
  })
}

// A goal that the planner carries out. mode 'atLeast' = have N in total, 'more' = N more than now.
// fallback runs if the name isn't an item the planner knows.
function planGoal (rawName, rawCount, mode, verb = 'getting', fallback = null) {
  let label = `${verb} ${rawName}`
  return {
    describe: () => label,
    start: async (body, cancelled) => {
      const bot = body.bot
      const parsed = parseGoal(bot, String(rawName ?? ''), Number(rawCount) || 0)
      if (!parsed) {
        if (fallback) return fallback(body, cancelled)
        throw new Error(`I don't know what "${rawName}" is`)
      }
      const amount = Number(rawCount) || parsed.count
      const target = mode === 'more' ? countOf(bot, parsed.item) + amount : amount
      label = `${verb} ${amount} ${parsed.item.replace(/_/g, ' ')}`
      log('goal', label)
      try {
        await obtain(bot, planCtx(body, cancelled), parsed.item, target)
      } finally {
        body.plan = null
      }
      return `got ${parsed.item.replace(/_/g, ' ')} - now carrying ${countOf(bot, parsed.item)}`
    }
  }
}

function waitForOwner (body) {
  const runId = body.goalRunId
  const t = setInterval(() => {
    if (runId !== body.goalRunId) return clearInterval(t)
    const owner = ownerEntity(body.bot)
    if (owner) {
      clearInterval(t)
      body.bot.pathfinder.setGoal(new GoalFollow(owner, 2), true)
    }
  }, 1000)
}

// Used by the reflex brain and to decide when Jev is worth calling
export function threatLevel (bot, body) {
  const hostiles = nearbyHostiles(bot, 16)
  const near = hostiles[0]
  const dist = near ? near.position.distanceTo(bot.entity.position) : Infinity
  return { hostiles, near, dist, guarding: !!body.goal.isGuard }
}
