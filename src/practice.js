import { readJson, writeJson, log } from './config.js'
import { talkSummary } from './bot.js'

const FILE = 'practice.json'

// The skill ladder: the normal survival progression, easiest first.
// Steps with `get` are done by the planner (it works out tools/materials and the result is easy to check);
// the rest go through task mode.
export const STEPS = [
  { task: 'mine 4 wood logs', get: ['logs', 4] },
  { task: 'craft a crafting table', get: ['crafting_table', 1] },
  { task: 'craft a wooden pickaxe', get: ['wooden_pickaxe', 1] },
  { task: 'mine 8 cobblestone', get: ['cobblestone', 8] },
  { task: 'craft a stone pickaxe', get: ['stone_pickaxe', 1] },
  { task: 'craft a stone sword', get: ['stone_sword', 1] },
  { task: 'craft a stone axe', get: ['stone_axe', 1] },
  { task: 'craft a furnace', get: ['furnace', 1] },
  { task: 'mine 4 coal', get: ['coal', 4] },
  { task: 'craft 8 torches', get: ['torch', 8] },
  { task: 'get 4 pieces of food', get: ['food', 4] },
  { task: 'cook 4 pieces of meat', get: ['cooked_food', 4] },
  { task: 'mine 3 iron ore', get: ['raw_iron', 3] },
  { task: 'smelt 3 iron ingots', get: ['iron_ingot', 3] },
  { task: 'craft an iron pickaxe', get: ['iron_pickaxe', 1] },
  { task: 'craft an iron sword', get: ['iron_sword', 1] },
  { task: 'craft a chest', get: ['chest', 1] },
  { task: 'craft a shield', get: ['shield', 1] },
  { task: 'craft a bucket', get: ['bucket', 1] },
  { task: 'build a hut' },
  { task: 'craft an iron helmet', get: ['iron_helmet', 1] },
  { task: 'craft an iron chestplate', get: ['iron_chestplate', 1] },
  { task: 'craft iron leggings', get: ['iron_leggings', 1] },
  { task: 'craft iron boots', get: ['iron_boots', 1] },
  { task: 'equip all my iron armor' },
  { task: 'mine 3 diamonds', get: ['diamond', 3] },
  { task: 'craft a diamond pickaxe', get: ['diamond_pickaxe', 1] }
]
export const LADDER = STEPS.map(s => s.task)
const MAX_TRIES = 3

// Practice mode (Voyager-style automatic curriculum): work up the ladder on his own, one task at a time.
// Every task goes through task mode, so it reuses skills, writes new ones, learns lessons, and Jev checks
// that it really got done. When the ladder runs out, the AI proposes the next challenge from what he has.
export class Practice {
  constructor ({ coder, request, obtain }) {
    this.coder = coder
    this.obtain = obtain // (bot, item, count, cancelled) -> planner
    this.request = request // (messages) -> text, for proposing new tasks
    const s = readJson(FILE, {})
    this.completed = s.completed ?? []
    this.failed = s.failed ?? {}
    this.history = s.history ?? []
    this.on = false
    this.current = null
  }

  save () { writeJson(FILE, { completed: this.completed, failed: this.failed, history: this.history.slice(-100) }) }

  reset () { this.completed = []; this.failed = {}; this.history = []; this.save() }

  async nextTask (bot) {
    const ladderNext = LADDER.find(t => !this.completed.includes(t) && (this.failed[t] ?? 0) < MAX_TRIES)
    if (ladderNext) return ladderNext
    // Ladder done: let the AI propose something new, just beyond what he can already do
    const reply = await this.request([
      {
        role: 'system',
        content: 'You are the curriculum for a Minecraft bot that is teaching itself survival skills. Propose ONE next task that is ' +
          'useful, a little harder than what it has done, and doable with what it has or can gather nearby. ' +
          'Be specific and checkable (e.g. "craft a golden apple", "build a 5 block tall cobblestone tower", "mine 10 redstone"). ' +
          'Do not repeat completed tasks; avoid ones that failed many times. Reply with only the task.'
      },
      {
        role: 'user',
        content: `World now:\n${talkSummary(bot, null)}\n\nCompleted (${this.completed.length}): ${this.completed.slice(-30).join('; ')}\n\n` +
          `Failed: ${Object.entries(this.failed).filter(([, n]) => n >= MAX_TRIES).map(([t]) => t).join('; ') || 'none'}`
      }
    ])
    const task = String(reply || '').split('\n')[0].replace(/^["'\-\d.\s]+|["'.\s]+$/g, '').trim()
    return task || null
  }

  // One practice round: pick a task, try it, record how it went
  async runOne (bot, cancelled) {
    const task = await this.nextTask(bot)
    if (!task) throw new Error('nothing left to practice')
    this.current = task
    log('practice', `practicing: ${task}`)
    const started = Date.now()
    try {
      const step = STEPS.find(s => s.task === task)
      let result
      if (step?.get && this.obtain) {
        // planner: works out every step itself, and the result is easy to check (do I have it now?)
        const [item, count] = step.get
        await this.obtain(bot, item, count, cancelled)
        if (cancelled()) return null
        result = `have ${count} ${item.replace(/_/g, ' ')}`
      } else {
        result = await this.coder.run(bot, task, cancelled)
      }
      if (result === null) return null // interrupted; try again later
      if (!this.completed.includes(task)) this.completed.push(task)
      this.history.push({ task, ok: true, result, secs: Math.round((Date.now() - started) / 1000), at: Date.now() })
      log('practice', `learned: ${task} (${result})`)
      return { task, ok: true, result }
    } catch (err) {
      if (cancelled()) return null
      this.failed[task] = (this.failed[task] ?? 0) + 1
      this.history.push({ task, ok: false, error: err.message, at: Date.now() })
      log('practice', `failed: ${task} (try ${this.failed[task]}/${MAX_TRIES}): ${err.message}`)
      return { task, ok: false, error: err.message }
    } finally {
      this.current = null
      this.save()
    }
  }

  status () {
    const next = LADDER.find(t => !this.completed.includes(t) && (this.failed[t] ?? 0) < MAX_TRIES)
    return {
      on: this.on,
      current: this.current,
      completed: this.completed,
      ladderDone: LADDER.filter(t => this.completed.includes(t)).length,
      ladderTotal: LADDER.length,
      next: next ?? '(AI picks new challenges)',
      gaveUp: Object.entries(this.failed).filter(([, n]) => n >= MAX_TRIES).map(([t]) => t),
      recent: this.history.slice(-12).reverse()
    }
  }
}
