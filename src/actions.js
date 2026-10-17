import pathfinderPkg from 'mineflayer-pathfinder'
import { bestFood, ownerEntity, nearbyHostiles } from './bot.js'
import { config, log } from './config.js'

const { goals } = pathfinderPkg
const { GoalFollow, GoalNear, GoalInvert } = goals

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
    if (!g) return `unknown goal ${kind}`
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

function resolveBlockIds (bot, name) {
  const term = String(name || '').toLowerCase().trim().replace(/\s+/g, '_').replace(/s$/, '')
  const key = BLOCK_ALIASES[term] ?? BLOCK_ALIASES[term + 's'] ?? term
  const all = Object.values(bot.registry.blocksByName)
  let matches = all.filter(b => b.name === key)
  if (!matches.length) matches = all.filter(b => b.name.includes(key))
  // ores also come in deepslate variants
  if (key.endsWith('_ore')) matches = all.filter(b => b.name === key || b.name === `deepslate_${key}`)
  return matches.map(b => b.id)
}

function makeGoal (kind, args) {
  switch (kind) {
    case 'follow':
      return {
        describe: () => `following ${config.mc.owner}`,
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
    case 'collect': {
      const count = Math.max(1, Math.min(64, Number(args.count) || 8))
      let got = 0
      return {
        describe: () => `collecting ${args.block} (${got}/${count})`,
        start: async (body, cancelled) => {
          const bot = body.bot
          const ids = resolveBlockIds(bot, args.block)
          if (!ids.length) throw new Error(`no block called "${args.block}"`)
          while (got < count && !cancelled()) {
            const block = bot.findBlock({ matching: ids, maxDistance: 64 })
            if (!block) throw new Error(`can't find any ${args.block} nearby`)
            await bot.collectBlock.collect(block)
            got++
          }
          return cancelled() ? null : `collected ${got} ${args.block}`
        }
      }
    }
    case 'give':
      return {
        describe: () => `bringing ${args.item} to ${config.mc.owner}`,
        start: async (body, cancelled) => {
          const bot = body.bot
          const term = String(args.item || '').toLowerCase().replace(/\s+/g, '_')
          const item = bot.inventory.items().find(i => i.name === term) ??
            bot.inventory.items().find(i => i.name.includes(term))
          if (!item) throw new Error(`I don't have any ${args.item}`)
          const owner = ownerEntity(bot)
          if (!owner) throw new Error("can't see the owner")
          await bot.pathfinder.goto(new GoalNear(owner.position.x, owner.position.y, owner.position.z, 2))
          if (cancelled()) return null
          await bot.lookAt(owner.position.offset(0, 1.6, 0))
          const count = Math.min(item.count, Number(args.count) || item.count)
          await bot.toss(item.type, null, count)
          return `gave ${count} ${item.name}`
        }
      }
    case 'stop':
    case 'idle':
      return { describe: () => 'standing still', start: () => {} }
    default:
      return null
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
