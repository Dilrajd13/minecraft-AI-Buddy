import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DATA_DIR = path.join(ROOT, 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })

const env = (k, d = '') => (process.env[k] ?? '').trim() || d
const num = (k, d) => {
  const n = Number(env(k, ''))
  return Number.isFinite(n) && env(k, '') !== '' ? n : d
}

export const config = {
  mc: {
    host: env('MC_HOST', 'localhost'),
    port: num('MC_PORT', 25565),
    version: env('MC_VERSION') || false,
    botName: env('BOT_NAME', 'Buddy'),
    owner: env('OWNER_NAME', '')
  },
  openrouterKey: env('OPENROUTER_API_KEY'),
  fast: {
    brain: env('FAST_BRAIN', 'jev'),
    jevModel: env('JEV_MODEL', 'typesafe/jev-1.14'),
    hz: Math.min(10, Math.max(0.5, num('JEV_HZ', 3))),
    maxSpend: num('JEV_MAX_SPEND_PER_SESSION', 1)
  },
  talk: {
    provider: env('TALK_PROVIDER', 'openrouter'),
    model: env('TALK_MODEL', 'google/gemma-4-31b-it'),
    ollamaUrl: env('OLLAMA_URL', 'http://localhost:11434')
  },
  tts: {
    provider: env('TTS_PROVIDER', 'elevenlabs'),
    elevenKey: env('ELEVENLABS_API_KEY'),
    elevenVoice: env('ELEVENLABS_VOICE_ID'),
    elevenMonthlyChars: num('ELEVENLABS_MONTHLY_CHARS', 10000),
    piperExe: env('PIPER_EXE'),
    piperModel: env('PIPER_MODEL')
  },
  // Model that writes code for free-form tasks (defaults to the talk model)
  codeModel: env('CODE_MODEL') || env('TALK_MODEL', 'google/gemma-4-31b-it'),
  // Self-directed play: when idle he picks his own activities every N seconds
  autonomy: { on: env('AUTONOMY', 'on') !== 'off', seconds: Math.max(5, num('AUTONOMY_SECONDS', 20)) },
  earsPort: num('EARS_PORT', 3077)
}

export function loadPersona () {
  const raw = fs.readFileSync(path.join(ROOT, 'config', 'persona.md'), 'utf8')
  return raw.replaceAll('{BOT_NAME}', config.mc.botName).replaceAll('{OWNER_NAME}', config.mc.owner || 'the player')
}

// Tiny JSON file store for things that should survive restarts (TTS monthly budget, notes)
export function readJson (name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')) } catch { return fallback }
}
export function writeJson (name, value) {
  fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(value, null, 2))
}

// Everything also goes to data/buddy.log so problems can be looked at after the window is closed
const LOG_FILE = path.join(DATA_DIR, 'buddy.log')
try { if (fs.statSync(LOG_FILE).size > 5e6) fs.renameSync(LOG_FILE, LOG_FILE + '.old') } catch {}
const RECENT = [] // last log lines, for the watch page
export const recentLogs = () => RECENT.slice()
export const log = (tag, ...args) => {
  const line = `[${new Date().toLocaleTimeString()}] [${tag}]`
  console.log(line, ...args)
  const text = args.map(a => typeof a === 'string' ? a : (a instanceof Error ? a.stack : JSON.stringify(a))).join(' ')
  fs.appendFile(LOG_FILE, `${new Date().toISOString().slice(0, 10)} ${line} ${text}\n`, () => {})
  RECENT.push({ t: new Date().toLocaleTimeString(), tag, text: text.slice(0, 600) })
  if (RECENT.length > 150) RECENT.shift()
}
