import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { config, log, readJson, writeJson } from './config.js'

const SAMPLE_RATE = 22050

// Speaks lines one at a time. ElevenLabs first; falls back to Piper (free, offline) when the
// monthly credits run out, or to text-only if neither is set up.
export class Voice {
  constructor () {
    this.queue = []
    this.playing = false
    this.muted = false
    this.usage = this.loadUsage()
  }

  loadUsage () {
    const month = new Date().toISOString().slice(0, 7)
    const u = readJson('tts-usage.json', { month, elevenChars: 0 })
    return u.month === month ? u : { month, elevenChars: 0 }
  }

  // The local character count is only an estimate (flash voices cost less than 1 credit/char),
  // so keep using ElevenLabs until ElevenLabs itself says the credits are gone.
  provider () {
    const p = config.tts.provider
    const piperOk = config.tts.piperExe && fs.existsSync(config.tts.piperExe) && config.tts.piperModel
    if (p === 'elevenlabs' && config.tts.elevenKey && config.tts.elevenVoice && !this.elevenOut) return 'elevenlabs'
    if ((p === 'elevenlabs' || p === 'piper') && piperOk) return 'piper'
    return 'none'
  }

  say (text) {
    if (!text || this.muted) return
    if (this.queue.length >= 2) this.queue.shift() // don't build up a backlog of stale quips
    this.queue.push(text)
    if (!this.playing) this.drain()
  }

  async drain () {
    this.playing = true
    while (this.queue.length) {
      const text = this.queue.shift()
      try {
        const which = this.provider()
        if (which === 'elevenlabs') await playPcm(await this.eleven(text))
        else if (which === 'piper') await playWavFile(await piper(text))
      } catch (err) {
        log('tts', err.message)
        if (this.elevenOut && this.provider() === 'piper') {
          try { await playWavFile(await piper(text)) } catch (e) { log('tts', e.message) }
        }
      }
    }
    this.playing = false
  }

  async eleven (text) {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${config.tts.elevenVoice}?output_format=pcm_${SAMPLE_RATE}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': config.tts.elevenKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        model_id: 'eleven_flash_v2_5', // cheapest + lowest latency; flash costs fewer credits per char
        voice_settings: { stability: 0.35, similarity_boost: 0.8, style: 0.6 }
      }),
      signal: AbortSignal.timeout(15000)
    })
    if (!res.ok) {
      const body = await res.text()
      // Out of credits for the month -> stop trying until restart (falls back to Piper or text)
      if (res.status === 402 || /quota_exceeded|insufficient|credits/i.test(body)) {
        this.elevenOut = true
        log('tts', 'ElevenLabs is out of credits for this month; switching to backup voice / text')
      }
      throw new Error(`ElevenLabs HTTP ${res.status}: ${body.slice(0, 200)}`)
    }
    this.usage.elevenChars += text.length
    writeJson('tts-usage.json', this.usage)
    return Buffer.from(await res.arrayBuffer())
  }

  stats () {
    return `voice: ${this.muted ? 'muted' : this.provider()}${this.elevenOut ? ' (ElevenLabs out of credits)' : ''}, ` +
      `~${this.usage.elevenChars} ElevenLabs chars sent this month (estimate; real balance is on elevenlabs.io)`
  }
}

function wavHeader (dataLen, rate, channels = 1, bits = 16) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataLen, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22)
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * bits / 8, 28)
  h.writeUInt16LE(channels * bits / 8, 32); h.writeUInt16LE(bits, 34)
  h.write('data', 36); h.writeUInt32LE(dataLen, 40)
  return h
}

async function playPcm (pcm) {
  const file = path.join(os.tmpdir(), `buddy-${Date.now()}.wav`)
  fs.writeFileSync(file, Buffer.concat([wavHeader(pcm.length, SAMPLE_RATE), pcm]))
  await playWavFile(file)
}

// Windows' built-in player: no extra installs. (macOS: afplay, Linux: aplay)
function playWavFile (file) {
  return new Promise((resolve) => {
    let cmd, args
    if (process.platform === 'win32') {
      cmd = 'powershell.exe'
      args = ['-NoProfile', '-Command', `(New-Object System.Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`]
    } else if (process.platform === 'darwin') { cmd = 'afplay'; args = [file] } else { cmd = 'aplay'; args = ['-q', file] }
    const p = spawn(cmd, args, { stdio: 'ignore', windowsHide: true })
    p.on('exit', () => { fs.rm(file, () => {}); resolve() })
    p.on('error', (e) => { log('tts', 'player failed:', e.message); resolve() })
  })
}

function piper (text) {
  return new Promise((resolve, reject) => {
    const out = path.join(os.tmpdir(), `buddy-piper-${Date.now()}.wav`)
    const p = spawn(config.tts.piperExe, ['--model', config.tts.piperModel, '--output_file', out], { windowsHide: true })
    p.on('error', reject)
    p.on('exit', (code) => code === 0 ? resolve(out) : reject(new Error(`piper exited ${code}`)))
    p.stdin.end(text)
  })
}
