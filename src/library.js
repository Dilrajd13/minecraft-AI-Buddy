import { readJson, writeJson, log } from './config.js'

const FILE = 'skills.json'
const LESSONS_FILE = 'lessons.json'
const STOP = new Set(['a', 'an', 'the', 'me', 'my', 'some', 'of', 'to', 'for', 'and', 'here', 'there', 'please', 'go', 'get', 'make', 'it', 'this', 'that', 'with', 'in', 'on', 'at', 'up', 'out', 'little', 'small', 'big'])

const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w))
  .map(w => w.replace(/(ies)$/, 'y').replace(/([^s])s$/, '$1')) // crude singular: pickaxes -> pickaxe (glass stays glass)

const overlap = (a, b) => {
  const want = new Set(words(a))
  const have = new Set(words(b))
  if (!want.size || !have.size) return 0
  return [...want].filter(w => have.has(w)).length / Math.max(want.size, have.size)
}

// Skill library (the Voyager trick): every task that works gets saved with its code,
// so next time he reuses proven code instead of writing it from scratch.
// Plus lessons: short notes on what went wrong and what fixed it, fed into every future attempt.
export class SkillLibrary {
  constructor () {
    this.skills = readJson(FILE, [])
    this.lessons = readJson(LESSONS_FILE, [])
  }

  save () { writeJson(FILE, this.skills) }
  saveLessons () { writeJson(LESSONS_FILE, this.lessons) }

  static nameFor (task) {
    return words(task).slice(0, 6).join('_') || 'task'
  }

  add (task, code) {
    const name = SkillLibrary.nameFor(task)
    const existing = this.skills.find(s => s.name === name)
    if (existing) Object.assign(existing, { task, code, updated: Date.now(), fails: 0 })
    else this.skills.push({ name, task, code, uses: 0, fails: 0, created: Date.now(), updated: Date.now() })
    this.save()
    return name
  }

  used (name) {
    const s = this.get(name)
    if (s) { s.uses++; s.fails = 0; s.lastUsed = Date.now(); this.save() }
  }

  // A saved skill that failed this time. Ones that keep failing sink in the rankings.
  failed (name) {
    const s = this.get(name)
    if (s) { s.fails = (s.fails ?? 0) + 1; this.save() }
  }

  get (name) { return this.skills.find(s => s.name === name) }

  remove (name) {
    const before = this.skills.length
    this.skills = this.skills.filter(s => s.name !== name)
    this.save()
    return this.skills.length < before
  }

  // reliability: proven skills rank up, flaky ones down
  static trust (s) { return (s.uses ?? 0) - 2 * (s.fails ?? 0) }

  // Best matches for a new task, scored by shared keywords. score 1 = same words.
  search (task, limit = 3) {
    return this.skills
      .map(s => ({ skill: s, score: overlap(task, s.task) * ((s.fails ?? 0) >= 3 ? 0.5 : 1) }))
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score || SkillLibrary.trust(b.skill) - SkillLibrary.trust(a.skill))
      .slice(0, limit)
  }

  // Ask Jev which saved skill (if any) does what the owner wants. Understands meaning, not just shared words
  // ("open the furnace" ~ "take glass out of the furnace"). Returns { skill, confidence } or null.
  async pick (task, jev, ctx = { emit: () => {} }) {
    if (!jev?.enabled || !this.skills.length) return null
    // shortlist: keyword matches first, then the most trusted skills; keeps the request small
    const shortlist = [...new Set([
      ...this.search(task, 8).map(r => r.skill),
      ...this.skills.slice().sort((a, b) => SkillLibrary.trust(b) - SkillLibrary.trust(a)).slice(0, 8)
    ])].filter(s => (s.fails ?? 0) < 3).slice(0, 12)
    if (!shortlist.length) return null
    const criteria = Object.fromEntries(shortlist.map((s, i) => [`s${i}`, s.task]))
    criteria.none = 'none of these would accomplish the request'
    const answers = await jev.ask(`A Minecraft bot was asked: "${task}"\nIt has saved programs for these past requests.`, {
      match: {
        type: 'choice',
        instructions: 'Which saved program would accomplish the new request as-is (same goal, maybe different wording)? Pick none if it would need changes.',
        criteria
      }
    }, ctx)
    const a = answers?.match
    if (!a?.choice || a.choice === 'none' || !criteria[a.choice]) return null
    const skill = shortlist[Number(a.choice.slice(1))]
    log('task', `Jev matched "${task}" to saved skill "${skill.name}" (conf ${Number(a.confidence ?? 0).toFixed(2)})`)
    return { skill, confidence: Number(a.confidence ?? 0) }
  }

  addLesson (task, lesson) {
    const text = String(lesson || '').trim().replace(/\s+/g, ' ').slice(0, 240)
    if (!text) return
    this.lessons = this.lessons.filter(l => l.lesson !== text)
    this.lessons.push({ task, lesson: text, at: Date.now() })
    if (this.lessons.length > 60) this.lessons.shift()
    this.saveLessons()
    log('task', `learned: ${text}`)
  }

  // Lessons that look related to this task, plus the most recent ones (general know-how)
  relevantLessons (task, n = 8) {
    const scored = this.lessons.map((l, i) => ({ l, s: overlap(task, `${l.task} ${l.lesson}`) + i / 1000 }))
    const related = scored.filter(x => x.s >= 0.15).sort((a, b) => b.s - a.s).slice(0, n).map(x => x.l)
    const recent = this.lessons.slice(-4)
    return [...new Set([...related, ...recent])].slice(0, n)
  }

  list () {
    return this.skills.map(s => `${s.name} (worked ${s.uses}x${s.fails ? `, failed ${s.fails}x` : ''}): ${s.task}`)
  }
}
