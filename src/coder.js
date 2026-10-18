import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import pathfinderPkg from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { config, log } from './config.js'
import { bestFood, ownerEntity, talkSummary } from './bot.js'
import { resolveBlockIds, findItem, killEntity, craftItem, findPrey, findSafeBlock, isFoodHunt } from './actions.js'
import { storeItems, takeItems, chestContents, smelt } from './containers.js'
import { buildStructure, listBuilds, validateBlueprint, normalizeBlueprint, BUILDS_DIR } from './builder.js'
import { staircase, mineOre } from './mining.js'
import { obtain, makeCtx, parseGoal, normalizeItem, defaultCount, countOf } from './planner.js'

function obtainItemCtx (bot, memory, cancelled, item, count) {
  const name = normalizeItem(bot, item) ?? item
  return obtain(bot, makeCtx({ memory, cancelled }), name, count ?? defaultCount(name))
}
import { voyagerPrimitives, quietBot, voyagerScript, searchVoyager, pickVoyager } from './voyager.js'

// Voyager's 120 skills, compiled once and defined inside every task's sandbox
let voyagerCompiled
function voyagerDefs () {
  if (voyagerCompiled === undefined) {
    try { voyagerCompiled = new vm.Script(voyagerScript(), { filename: 'voyager-skills.js' }) } catch (err) {
      log('task', `couldn't load Voyager skills: ${err.message}`); voyagerCompiled = null
    }
  }
  return voyagerCompiled
}

const { GoalNear } = pathfinderPkg.goals

const API_DOCS = `You write JavaScript that controls a Minecraft bot (mineflayer). Your code is the BODY of an async function.
Use these helpers (all async ones must be awaited). Coordinates are numbers.

  await skills.get(item, count)             // GET ANY ITEM: works out every step (tools, sticks, planks, logs, table, furnace, fuel)
                                            // e.g. get('iron_pickaxe'), get('raw_iron', 10), get('torch', 16), get('cooked_food', 5)
  await skills.collect(block, count)        // mine/gather blocks, e.g. 'oak_log', 'stone', 'iron_ore', 'wood', 'dirt'
  await skills.craft(item, count)           // auto-makes planks/sticks + crafting table if needed
  await skills.hunt(mob, count)             // kill mobs and pick up their drops, e.g. 'cow', 'zombie'; 'food' = any food animal
  await skills.goto(x, y, z, range=1)       // walk somewhere
  await skills.goToOwner()                  // walk to the owner
  await skills.dig(x, y, z)                 // break one block
  await skills.mine(ore, count)             // mine iron/coal/diamond...: nearby, or takes safe stairs down to find it
  await skills.staircase(depth)             // SAFE way to go underground: continues your existing staircase ('mine')
                                            // if there is one, else starts one. Stops at lava/water/caves.
  await skills.place(item, x, y, z)         // place a block at that exact EMPTY spot (air), next to a solid block.
                                            // To put something on the ground where you stand, use y = position().y, not y-1.
  await skills.placeNear(item)              // place a block on the ground right next to you (easiest for tables/chests/torches)
  await skills.equip(item)                  // hold tool/weapon or wear armor
  await skills.eat()
  await skills.give(item, count)            // walk to owner and drop items for them
  await skills.toss(item, count)            // drop items here
  await skills.wait(ms)
  skills.findBlocks(name, count=1, maxDistance=64) -> [{x,y,z}, ...] nearest first
  skills.blockAt(x, y, z) -> block name string ('air' if empty)
  skills.position() -> {x,y,z} (your feet, rounded)
  skills.ownerPosition() -> {x,y,z} or null
  skills.inventory() -> [{name, count}]
  skills.count(item) -> how many you have
  skills.nearbyEntities(range=16) -> [{name, distance, x, y, z}]
  skills.say(text)                          // type in game chat (use rarely)
  await skills.store(item, count)           // put items in the nearest chest; item 'all' = everything but tools/armor
  await skills.take(item, count)            // take items from a chest (goes to a chest you remember having it)
  await skills.chestContents() -> {name: count}  // look in the nearest chest
  await skills.smelt(item, count)           // smelt in a furnace (raw_iron, sand, beef...); makes/places one + adds fuel
  await skills.build(name, material)        // build a blueprint ('hut', 'cabin', 'tower', 'wall', saved/downloaded ones)
                                            // or a description ('small stone house'); swaps in materials you have
  skills.listBuilds() -> [names]
  skills.places() -> {name: {x,y,z}}        // places you remember (e.g. 'base')
  await skills.gotoPlace(name)              // walk to a remembered place
  await library.run(name)                   // run a saved skill (proven code from earlier tasks)
Also available: bot (raw mineflayer bot), Vec3, console.log.
Voyager-style helpers also work: await mineBlock(bot, name, count), await craftItem(bot, name, count), await smeltItem(bot, item, fuel, count),
await killMob(bot, mob), await placeItem(bot, name, vec3), await exploreUntil(bot, new Vec3(1,0,1), seconds, () => bot.findBlock(...)),
plus 120 ready-made Voyager skills (listed below when relevant).

Rules:
- Reply with ONLY one \`\`\`js code block. No explanation.
- No require/import. Don't loop forever; every loop needs a limit.
- Check inventory before using items; gather/craft what's missing first.
- If the task is impossible, throw new Error("short reason").
- Use double quotes for strings. Optionally end with: return "short summary".
- To build, compute coordinates relative to skills.position(), place blocks bottom-up, and build a couple blocks away from yourself.
- NEVER dig the block under your own feet (you'll fall into lava or a cave). To go down use skills.staircase().
- To get or make ANY item use skills.get(item, count). It already handles missing tools and materials, so don't write those steps yourself.
- Wrap risky single steps (like placing one torch) in try/catch so one failure doesn't stop the whole job.`

// Worked examples of good task code. Small models copy patterns far better than they invent them.
const EXAMPLES = `Examples of good code:

Task: make a stone pickaxe and a stone sword, then hold the pickaxe
\`\`\`js
await skills.get("stone_pickaxe", 1)  // gets wood, planks, sticks, a wooden pickaxe and cobblestone if needed
await skills.get("stone_sword", 1)
await skills.equip("stone_pickaxe")
return "made a stone pickaxe and sword"
\`\`\`

Task: build a small 3x3 dirt hut next to me
\`\`\`js
const need = 16
if (skills.count("dirt") < need) await skills.collect("dirt", need - skills.count("dirt"))
const p = skills.position()
const ox = p.x + 2, oz = p.z + 2, y = p.y
for (let h = 0; h < 2; h++) {
  for (let dx = 0; dx < 3; dx++) {
    for (let dz = 0; dz < 3; dz++) {
      const wall = dx === 0 || dx === 2 || dz === 0 || dz === 2
      const door = dx === 1 && dz === 0
      if (!wall || door) continue
      if (skills.blockAt(ox + dx, y + h, oz + dz) !== "air") continue
      try { await skills.place("dirt", ox + dx, y + h, oz + dz) } catch (e) { console.log("skip", e.message) }
    }
  }
}
return "built a dirt hut"
\`\`\`

Task: light up the area with torches
\`\`\`js
await skills.get("torch", 4)
const p = skills.position()
let placed = 0
for (const [dx, dz] of [[4, 0], [-4, 0], [0, 4], [0, -4]]) {
  for (const dy of [0, 1, -1]) {
    try { await skills.place("torch", p.x + dx, p.y + dy, p.z + dz); placed++; break } catch (e) {}
  }
}
return "placed " + placed + " torches"
\`\`\`

Task: dig a staircase down and collect 20 iron ore
\`\`\`js
await skills.get("raw_iron", 20)  // makes a stone pickaxe if needed and takes safe stairs down to find iron
return "got " + skills.count("raw_iron") + " raw iron"
\`\`\`

Task: make full iron armor and put it on
\`\`\`js
for (const piece of ["iron_helmet", "iron_chestplate", "iron_leggings", "iron_boots"]) {
  await skills.get(piece, 1)  // mines + smelts the iron it needs (furnace and fuel included)
  await skills.equip(piece)
}
return "made and put on iron armor"
\`\`\`

Task: take my cobblestone back to base
\`\`\`js
if (!skills.places().base) throw new Error("I don't know where base is")
await skills.gotoPlace("base")
try { await skills.store("cobblestone") } catch (e) { await skills.toss("cobblestone", skills.count("cobblestone")) }
return "put the cobble away at base"
\`\`\``

// Lets the AI write a small program for any request the fixed goals can't handle.
// The program runs in a separate context with only the bot controls handed to it.
// NOTE: node:vm is not a security sandbox. Only the owner's own requests are allowed to reach this.
export class Coder {
  constructor (getApp, library, memory) {
    this.getApp = getApp
    this.library = library
    this.memory = memory
  }

  async run (bot, task, cancelled) {
    const goal = () => this.getApp().body?.goal
    const matches = this.library?.search(task) ?? []
    const failures = []

    // Interrupted (a fight, etc.) and now resuming the same job? Re-run the code we already have.
    // Good task code checks what's already done (counts, blocks), so re-running picks up where it left off.
    const act = this.active
    if (act && act.task === task && Date.now() - act.at < 10 * 60000) {
      log('task', 'resuming with the same code')
      try {
        const before = snapshot(bot)
        const result = await this.execute(bot, act.code, cancelled)
        this.active = null
        const check = await this.verify(bot, task, before, result)
        if (!check.ok) throw new Error(check.reason)
        this.library?.add(task, act.code)
        return typeof result === 'string' && result ? result : `finished: ${task}`
      } catch (err) {
        if (cancelled()) return null // interrupted again; keep the code for next time
        this.active = null
        failures.push(`Your previous code for this task failed with: ${describeError(err, act.code)}\n\`\`\`js\n${act.code}\n\`\`\``)
      }
    }

    // A plain "get / make / mine X" request: the planner does it step by step, no code needed.
    const simple = !/\b(and|then|build|place|put|store|give|equip|bring|wear|plant|farm|light|tunnel|staircase)\b/i.test(task)
    const verb = task.match(/\b(get|make|craft|mine|collect|gather|obtain|smelt|cook|find|fetch|grab|chop)\b.*$/i)
    const goalItem = simple && verb && bot.registry ? parseGoal(bot, verb[0]) : null
    if (goalItem) {
      log('task', `planner: get ${goalItem.count} ${goalItem.item}`)
      await obtain(bot, makeCtx({ memory: this.memory, cancelled }), goalItem.item, goalItem.count)
      return `got ${goalItem.item.replace(/_/g, ' ')} (now ${countOf(bot, goalItem.item)})`
    }

    // Same job as before? Re-run the proven code first, no AI call needed.
    // Exact-ish wording match, or Jev judging that a saved skill does the same thing in other words.
    let reuse = matches[0]?.score >= 0.8 ? matches[0].skill : null
    if (!reuse) {
      const jev = this.getApp().fast?.jev
      const picked = await this.library?.pick(task, jev).catch(() => null)
      if (picked && picked.confidence >= 0.7) reuse = picked.skill
    }
    if (reuse) {
      log('task', `reusing saved skill "${reuse.name}"`)
      try {
        const before = snapshot(bot)
        const result = await this.execute(bot, reuse.code, cancelled)
        const check = await this.verify(bot, task, before, result)
        if (!check.ok) throw new Error(check.reason)
        this.library.used(reuse.name)
        return typeof result === 'string' && result ? result : `finished: ${task}`
      } catch (err) {
        if (cancelled()) return null
        log('task', `saved skill failed this time: ${err.message}`)
        this.library.failed(reuse.name)
        failures.push(`The saved skill "${reuse.name}" failed this time with: ${describeError(err, reuse.code)}\n\`\`\`js\n${reuse.code}\n\`\`\``)
      }
    }
    // A ready-made Voyager skill that does exactly this? Run it (through our safe helpers) and keep it if it works.
    if (!reuse) {
      const vp = await pickVoyager(task, this.getApp().fast?.jev)
      if (vp && vp.confidence >= 0.8) {
        const code = `return await ${vp.name}(bot)`
        try {
          const before = snapshot(bot)
          const result = await this.execute(bot, code, cancelled)
          const check = await this.verify(bot, task, before, result ?? `ran Voyager skill ${vp.name}`)
          if (!check.ok) throw new Error(check.reason)
          const name = this.library?.add(task, code)
          if (name) log('task', `saved Voyager skill ${vp.name} as "${name}"`)
          return typeof result === 'string' && result ? result : `did ${vp.name}`
        } catch (err) {
          if (cancelled()) return null
          failures.push(`Voyager's ready-made ${vp.name}(bot) failed: ${err.message}`)
        }
      }
    }
    const lessons = this.library?.relevantLessons(task) ?? []
    const voyagerHints = searchVoyager(task, 10)
    const errors = [] // what went wrong this time, for the lesson afterwards

    const known = this.library?.skills.slice().sort((a, b) => b.uses - a.uses).slice(0, 25)
      .map(s => `- "${s.name}": ${s.task}`).join('\n')
    const similar = matches.map(m => `Saved skill "${m.skill.name}" (task: ${m.skill.task}):\n\`\`\`js\n${m.skill.code}\n\`\`\``).join('\n\n')
    const messages = [
      { role: 'system', content: `${API_DOCS}\n\n${EXAMPLES}` },
      {
        role: 'user',
        content: [
          `World right now:\n${talkSummary(bot, goal())}`,
          this.memory?.describe() ?? '',
          `Owner's name: ${config.mc.owner}`,
          known ? `Saved skills you can call with await library.run(name):\n${known}` : '',
          voyagerHints.length ? `Ready-made Voyager skills that may help (call like: await craftIronPickaxe(bot)):\n${voyagerHints.map(v => `- ${v.name}(bot): ${v.summary}`).join('\n')}` : '',
          lessons.length ? `Lessons you learned on earlier tasks (follow them):\n${lessons.map(l => `- ${l.lesson}`).join('\n')}` : '',
          similar ? `Code that worked for similar tasks before (reuse/adapt it):\n${similar}` : '',
          failures.join('\n'),
          `Task: ${task}`
        ].filter(Boolean).join('\n\n')
      }
    ]
    let lastErr
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (cancelled()) return null
      const reply = await this.request(messages)
      const code = repairCode((reply.match(/```(?:js|javascript)?\s*([\s\S]*?)```/) ?? [null, reply])[1].trim())
      log('task', `attempt ${attempt} code:\n${code}\n---`)
      this.active = { task, code, at: Date.now() }
      try {
        const before = snapshot(bot)
        const result = await this.execute(bot, code, cancelled)
        this.active = null
        // Ran without crashing isn't the same as worked: Jev checks it did the job before it becomes a skill
        const check = await this.verify(bot, task, before, result)
        if (!check.ok) throw new Error(check.reason)
        const name = this.library?.add(task, code)
        if (name) log('task', `saved as skill "${name}"`)
        // It took some failing to get here: write down what fixed it (in the background)
        if (errors.length || failures.length) this.learnLesson(task, [...failures, ...errors], code).catch(() => {})
        return typeof result === 'string' && result ? result : `finished: ${task}`
      } catch (err) {
        if (cancelled()) return null
        lastErr = err
        errors.push(describeError(err, code))
        log('task', `attempt ${attempt} failed: ${err.message}`)
        messages.push({ role: 'assistant', content: '```js\n' + code + '\n```' })
        messages.push({
          role: 'user',
          content: `That failed with: ${describeError(err, code)}\nWorld now:\n${talkSummary(bot, goal())}\nFix it and reply with the full corrected code.`
        })
      }
    }
    this.active = null
    // Never worked: remember what to avoid next time
    this.learnLesson(task, [...failures, ...errors], null).catch(() => {})
    throw new Error(`couldn't do "${task}": ${lastErr?.message}`)
  }

  // Did the program actually accomplish the task? Jev judges from what it reported + what changed.
  async verify (bot, task, before, result) {
    const jev = this.getApp().fast?.jev
    if (!jev?.enabled) return { ok: true }
    const changes = diffSnapshots(before, snapshot(bot))
    const answers = await jev.ask(
      `A Minecraft bot was asked: "${task}"\nIts program finished and reported: "${typeof result === 'string' ? result : 'nothing'}"\nWhat changed: ${changes}`,
      { done: { type: 'noul', instructions: 'Did the bot actually accomplish what it was asked? Getting items should show them gained; building or placing uses up blocks; going somewhere shows it moved. A report that admits failure or found nothing means no.' } },
      { emit: () => {} }
    ).catch(() => null)
    const p = answers?.done?.noul
    if (p == null) return { ok: true }
    log('task', `Jev check: ${p >= 0.4 ? 'looks done' : 'NOT done'} (${Number(p).toFixed(2)}) - ${changes}`)
    return p >= 0.4 ? { ok: true } : { ok: false, reason: `the code ran but didn't actually do the job (it reported "${result}"; what changed: ${changes})` }
  }

  // Turn this task's errors (and the code that finally worked, if any) into one reusable rule of thumb
  async learnLesson (task, errors, workingCode) {
    if (!this.library || !errors.length) return
    const reply = await this.request([
      {
        role: 'system',
        content: 'You write short lessons for a Minecraft bot that programs itself with the skills API. ' +
          'Given what went wrong (and the code that finally worked, if any), write ONE practical rule of thumb (max 25 words) ' +
          'that would have avoided the mistake, e.g. "Use skills.smelt() instead of opening furnaces with bot.openFurnace". ' +
          'Reply with only the lesson, or NONE if there is nothing general to learn.'
      },
      {
        role: 'user',
        content: `Task: ${task}\n\nWhat went wrong:\n${errors.map(e => `- ${e.slice(0, 400)}`).join('\n')}` +
          (workingCode ? `\n\nCode that finally worked:\n\`\`\`js\n${workingCode.slice(0, 2000)}\n\`\`\`` : '\n\n(It never worked.)')
      }
    ])
    const lesson = reply.replace(/^["'\s-]+|["'\s]+$/g, '').split('\n')[0]
    if (lesson && !/^none\b/i.test(lesson)) this.library.addLesson(task, lesson)
  }

  execute (bot, code, cancelled) {
    const skills = makeSkills(bot, cancelled, this.memory, (d) => this.designBlueprint(d))
    const lib = this.library
    const library = {
      async run (name) {
        const s = lib?.get(name) ?? lib?.search(name, 1)[0]?.skill
        if (!s) throw new Error(`no saved skill called "${name}"`)
        lib.used(s.name)
        return new vm.Script(`(async () => {\n${s.code}\n})()`, { filename: `skill-${s.name}.js` }).runInContext(ctx)
      }
    }
    const prims = voyagerPrimitives(bot, { memory: this.memory, cancelled, place: skills.place })
    const ctx = vm.createContext({
      ...prims, skills, library, bot: quietBot(bot), Vec3, console: { log: (...a) => log('task', ...a) }
    })
    voyagerDefs()?.runInContext(ctx)
    const script = new vm.Script(`(async () => {\n${code}\n})()`, { filename: 'task.js' })
    const run = script.runInContext(ctx, { timeout: 2000 })
    let timer
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('took longer than 5 minutes')), 5 * 60000) })
    return Promise.race([run, timeout]).finally(() => clearTimeout(timer))
  }

  // Design a build from a description ("small medieval house") as a layer blueprint
  async designBlueprint (description) {
    const example = fs.readFileSync(path.join(BUILDS_DIR, 'hut.json'), 'utf8')
    const messages = [
      {
        role: 'system',
        content: `You design Minecraft builds as JSON blueprints. Reply with ONLY the JSON, no explanation.
Format: {"description": "...", "palette": {char: block_name}, "layers": [layer0, layer1, ...]}
- layers[0] is the bottom (the floor). Each layer is a list of rows (strings); each character is one block.
- Use ' ' (space) for "leave as is" and map '.' to "air" for empty space inside rooms.
- Every layer must have the same number of rows and every row the same length. Max 15 wide, 15 deep, 12 tall.
- Use normal blocks: oak_planks, spruce_planks, oak_log, cobblestone, stone_bricks, glass_pane, bricks, dirt.
  Special values: "door" (doorway, 2 tall: put it in two stacked layers), "torch", "ladder", "air".
- Make it look good: walls, a door, windows, a roof that steps in or overhangs, some torches inside.
- The floor (layer 0) should be solid. A chimney is a single 1x1 column, not a whole row.
- Count carefully: write every row at full width, padding with spaces.
Example (a small hut):
${example}`
      },
      { role: 'user', content: `Design: ${description}` }
    ]
    let lastErr; let lastJson
    for (let attempt = 0; attempt < 3; attempt++) {
      const reply = await this.request(messages)
      try {
        lastJson = JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1))
        return validateBlueprint(lastJson, { strict: true })
      } catch (err) {
        lastErr = err
        log('build', `design attempt ${attempt + 1} not valid: ${err.message}`)
        messages.push({ role: 'assistant', content: reply }, { role: 'user', content: `That wasn't valid: ${err.message}. Reply with only the full corrected JSON.` })
      }
    }
    // Still sloppy after retries: pad it into shape rather than give up
    if (lastJson?.layers && lastJson?.palette) return validateBlueprint(normalizeBlueprint(lastJson))
    throw new Error(`couldn't design "${description}": ${lastErr?.message}`)
  }

  async request (messages) {
    const isOllama = config.talk.provider === 'ollama'
    const url = isOllama ? `${config.talk.ollamaUrl}/v1/chat/completions` : 'https://openrouter.ai/api/v1/chat/completions'
    const headers = { 'Content-Type': 'application/json' }
    if (!isOllama) {
      headers.Authorization = `Bearer ${config.openrouterKey}`
      headers['X-Title'] = 'minecraft-buddy'
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: config.codeModel, messages, max_tokens: 1500, temperature: 0.3 }),
      signal: AbortSignal.timeout(isOllama ? 120000 : 45000)
    })
    if (!res.ok) throw new Error(`coder HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const json = await res.json()
    return json.choices?.[0]?.message?.content ?? ''
  }
}

// Inventory + position, to see what a task actually changed
function snapshot (bot) {
  const inv = {}
  for (const i of bot.inventory?.items?.() ?? []) inv[i.name] = (inv[i.name] ?? 0) + i.count
  return { inv, pos: bot.entity?.position?.clone?.() ?? null }
}

function diffSnapshots (a, b) {
  const names = new Set([...Object.keys(a.inv), ...Object.keys(b.inv)])
  const parts = []
  for (const n of names) {
    const d = (b.inv[n] ?? 0) - (a.inv[n] ?? 0)
    if (d) parts.push(`${d > 0 ? '+' : ''}${d} ${n}`)
  }
  const moved = a.pos && b.pos ? a.pos.distanceTo(b.pos) : 0
  return `inventory ${parts.join(', ') || 'unchanged'}; moved ${moved.toFixed(0)} blocks`
}

// Fix the silly mistakes small models make over and over (doubled quotes like ''hello'')
export function repairCode (code) {
  const compiles = (c) => { try { new vm.Script(`(async () => {\n${c}\n})()`); return true } catch { return false } }
  if (compiles(code)) return code
  const fixed = code
    .replace(/(['"])\1(?=[A-Za-z])/g, '$1') // ''word -> 'word
    .replace(/(?<=[A-Za-z0-9.!?])(['"])\1/g, '$1') // word'' -> word'
  return compiles(fixed) ? fixed : code
}

// Tell the model exactly which line broke, so it doesn't repeat the same mistake
function describeError (err, code) {
  const lines = code.split('\n')
  const m = String(err.stack || '').match(/task\.js:(\d+)/)
  const lineNo = m ? Number(m[1]) - 1 : null // -1 for the wrapper line
  const where = lineNo && lines[lineNo - 1] ? ` (line ${lineNo}: ${lines[lineNo - 1].trim()})` : ''
  const kind = err instanceof SyntaxError || err?.name === 'SyntaxError' ? 'SyntaxError: ' : ''
  return `${kind}${err.message}${where}`
}

function makeSkills (bot, cancelled, memory, designer) {
  const check = () => { if (cancelled()) throw new Error('cancelled') }
  const pos = (v) => ({ x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) })
  const goNear = async (x, y, z, range) => { check(); await bot.pathfinder.goto(new GoalNear(x, y, z, range)) }

  const skills = {
    async collect (block, count = 1) {
      const ids = resolveBlockIds(bot, block)
      if (!ids.length) throw new Error(`no block called "${block}"`)
      for (let i = 0; i < count; i++) {
        check()
        const b = findSafeBlock(bot, ids)
        if (!b) throw new Error(`can't find any ${block} nearby (got ${i})`)
        await bot.collectBlock.collect(b)
      }
    },
    async craft (item, count = 1) { check(); return craftItem(bot, item, count) },
    async hunt (mob, count = 1) {
      for (let i = 0; i < count; i++) {
        check()
        const t = findPrey(bot, mob) ?? (isFoodHunt(mob) ? findPrey(bot, 'food') : null)
        if (!t) throw new Error(`can't find any ${mob || 'food animals'} nearby (killed ${i})`)
        await killEntity(bot, t, cancelled)
      }
    },
    goto: (x, y, z, range = 1) => goNear(x, y, z, range),
    async goToOwner () {
      const o = ownerEntity(bot)
      if (!o) throw new Error("can't see the owner")
      await goNear(o.position.x, o.position.y, o.position.z, 2)
    },
    async dig (x, y, z) {
      check()
      const b = bot.blockAt(new Vec3(x, y, z))
      if (!b || b.name === 'air') return
      if (b.position.distanceTo(bot.entity.position) > 4) await goNear(x, y, z, 3)
      try { await bot.tool.equipForBlock(b) } catch {}
      await bot.dig(b)
    },
    async place (item, x, y, z) {
      check()
      const target = new Vec3(x, y, z)
      const here = bot.blockAt(target)
      const replaceable = !here || ['air', 'cave_air', 'water', 'short_grass', 'tall_grass', 'grass', 'fern', 'snow'].includes(here.name)
      if (!replaceable) {
        throw new Error(`${x} ${y} ${z} is already filled with ${here.name}; pick an empty (air) spot, e.g. one block higher`)
      }
      const it = findItem(bot, item)
      if (!it) throw new Error(`I don't have any ${item}`)
      const faces = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
      for (const [dx, dy, dz] of faces) {
        const ref = bot.blockAt(target.offset(dx, dy, dz))
        if (!ref || ref.boundingBox !== 'block') continue
        if (target.distanceTo(bot.entity.position) > 4.5) await goNear(x, y, z, 3)
        // don't place a block inside ourselves
        const feet = bot.entity.position.floored()
        if (feet.equals(target) || feet.offset(0, 1, 0).equals(target)) await goNear(x + 2, y, z + 2, 1)
        await bot.equip(it, 'hand')
        await bot.placeBlock(ref, new Vec3(-dx, -dy, -dz))
        return
      }
      throw new Error(`nothing solid next to ${x} ${y} ${z} to place against`)
    },
    // Safe way down: one step forward + one down each time, with headroom, stopping at lava/water/caves
    // Safe stairs down (continues his 'mine' staircase); shared with the built-in mining goal
    get: (item, count) => { check(); return obtainItemCtx(bot, memory, cancelled, item, count) },
    staircase: (depth = 10, opts = {}) => { check(); return staircase(bot, memory, depth, opts, cancelled) },
    // Mine an ore: nearby if visible, otherwise takes the stairs down until it finds some
    mine: (ore, count = 3) => { check(); return mineOre(bot, memory, ore, count, cancelled) },
    async placeNear (item) {
      const me = bot.entity.position.floored()
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1], [2, 0], [0, 2]]) {
        const ground = bot.blockAt(me.offset(dx, -1, dz))
        const spot = bot.blockAt(me.offset(dx, 0, dz))
        if (ground?.boundingBox === 'block' && spot && ['air', 'cave_air', 'short_grass', 'grass'].includes(spot.name)) {
          await skills.place(item, me.x + dx, me.y, me.z + dz)
          return { x: me.x + dx, y: me.y, z: me.z + dz }
        }
      }
      throw new Error('no free spot next to me to place it')
    },
    async equip (item) {
      const it = findItem(bot, item)
      if (!it) throw new Error(`I don't have any ${item}`)
      const n = it.name
      const slot = /helmet/.test(n) ? 'head' : /chestplate|elytra/.test(n) ? 'torso' : /leggings/.test(n) ? 'legs'
        : /boots/.test(n) ? 'feet' : n === 'shield' ? 'off-hand' : 'hand'
      await bot.equip(it, slot)
    },
    async eat () {
      const f = bestFood(bot)
      if (!f) throw new Error('no food')
      await bot.equip(f, 'hand')
      await bot.consume()
    },
    async give (item, count) {
      const it = findItem(bot, item)
      if (!it) throw new Error(`I don't have any ${item}`)
      await skills.goToOwner()
      const o = ownerEntity(bot)
      if (o) await bot.lookAt(o.position.offset(0, 1.6, 0))
      await bot.toss(it.type, null, Math.min(it.count, count ?? it.count))
    },
    async toss (item, count) {
      const it = findItem(bot, item)
      if (!it) throw new Error(`I don't have any ${item}`)
      await bot.toss(it.type, null, Math.min(it.count, count ?? it.count))
    },
    async wait (ms) {
      const end = Date.now() + Math.min(ms, 60000)
      while (Date.now() < end) { check(); await new Promise(resolve => setTimeout(resolve, Math.min(100, end - Date.now()))) }
    },
    findBlocks (name, count = 1, maxDistance = 64) {
      const ids = resolveBlockIds(bot, name)
      if (!ids.length) return []
      return bot.findBlocks({ matching: ids, maxDistance, count }).map(pos)
    },
    blockAt: (x, y, z) => bot.blockAt(new Vec3(x, y, z))?.name ?? 'unknown',
    position: () => pos(bot.entity.position),
    ownerPosition: () => { const o = ownerEntity(bot); return o ? pos(o.position) : null },
    inventory: () => bot.inventory.items().map(i => ({ name: i.name, count: i.count })),
    count: (item) => bot.inventory.items().filter(i => i.name === item || i.name.includes(item)).reduce((a, i) => a + i.count, 0),
    nearbyEntities (range = 16) {
      return Object.values(bot.entities)
        .filter(e => e !== bot.entity && e.position.distanceTo(bot.entity.position) <= range)
        .map(e => ({ name: e.username ?? e.name, distance: +e.position.distanceTo(bot.entity.position).toFixed(1), ...pos(e.position) }))
        .sort((a, b) => a.distance - b.distance)
    },
    say: (text) => bot.chat(String(text).slice(0, 250)),
    store: (item, count) => { check(); return storeItems(bot, memory, item, count) },
    take: (item, count = 64) => { check(); return takeItems(bot, memory, item, count) },
    chestContents: () => { check(); return chestContents(bot, memory) },
    smelt: (item, count = 1) => { check(); return smelt(bot, item, count) },
    build: (name, material) => { check(); return buildStructure(bot, name, { material, memory, cancelled, design: designer }) },
    listBuilds: () => listBuilds(),
    places: () => ({ ...(memory?.places ?? {}) }),
    async gotoPlace (name) {
      const p = memory?.place(name)
      if (!p) throw new Error(`I don't remember a place called ${name}`)
      await goNear(p.x, p.y, p.z, 2)
    }
  }
  return skills
}
