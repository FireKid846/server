import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  delay,
  BufferJSON,
} from '@whiskeysockets/baileys'

import pino    from 'pino'
import express from 'express'

import { pushSessionToGithub }                       from './lib/github.js'
import { setPairingCode, activateSession, deactivateSession } from './lib/supabase.js'

const PORT   = process.env.PORT   || 3000
const SECRET = process.env.RENDER_SECRET

const app = express()
app.use(express.json())

const pairingSessions = new Map()
const phoneToSession  = new Map()

const auth = (req, res, next) => {
  if (req.headers['x-render-secret'] !== SECRET)
    return res.status(401).json({ ok: false, error: 'Unauthorized' })
  next()
}

app.get('/health', (_, res) => {
  res.json({ ok: true, activePairings: pairingSessions.size })
})

app.post('/internal/pair', auth, async (req, res) => {
  const { phone, sessionId } = req.body

  if (!phone || !sessionId)
    return res.status(400).json({ ok: false, error: 'phone and sessionId required' })

  const cleanPhone = phone.replace(/\D/g, '')

  const existingId = phoneToSession.get(cleanPhone)
  if (existingId && pairingSessions.has(existingId)) {
    const stale = pairingSessions.get(existingId)
    if (stale?.killSocket) stale.killSocket()
    pairingSessions.delete(existingId)
    phoneToSession.delete(cleanPhone)
  }

  res.json({ ok: true, message: 'Pairing started' })

  startPairing(cleanPhone, sessionId).catch(e => {
    console.error('[Pair] Error:', e.message)
    pairingSessions.delete(sessionId)
    phoneToSession.delete(cleanPhone)
  })
})

app.post('/internal/disconnect', auth, async (req, res) => {
  const { sessionId } = req.body

  if (!sessionId)
    return res.status(400).json({ ok: false, error: 'sessionId required' })

  const entry = pairingSessions.get(sessionId)
  if (entry?.killSocket) entry.killSocket()
  pairingSessions.delete(sessionId)
  if (entry?.phone) phoneToSession.delete(entry.phone)

  await deactivateSession(sessionId).catch(e =>
    console.error('[Disconnect] Supabase update failed:', e.message)
  )

  res.json({ ok: true })
})

const startPairing = async (phone, sessionId, codeAlreadySent = false) => {
  console.log(`[Pair] Starting for ${phone} (sessionId: ${sessionId})`)
  phoneToSession.set(phone, sessionId)
  pairingSessions.set(sessionId, { phone, status: 'starting', killSocket: null })

  const { version } = await fetchLatestBaileysVersion()
  const tempAuth    = await useMultiFileAuthState(`/tmp/pair_${sessionId}`)

  const sock = makeWASocket({
    version,
    auth:                tempAuth.state,
    logger:              pino({ level: 'silent' }),
    printQRInTerminal:   false,
    markOnlineOnConnect: false,
    browser:             Browsers.macOS('Safari'),
    syncFullHistory:     false,
    connectTimeoutMs:    60_000,
    getMessage:          async () => ({ conversation: '' }),
  })

  const entry = pairingSessions.get(sessionId)
  if (entry) entry.killSocket = () => { try { sock.end() } catch {} }

  sock.ev.on('creds.update', tempAuth.saveCreds)

  let codeRequested    = codeAlreadySent
  let sessionFinalized = false

  const cleanup = () => {
    pairingSessions.delete(sessionId)
    phoneToSession.delete(phone)
    try { sock.end() } catch {}
  }

  const timeout = setTimeout(() => {
    console.log(`[Pair] Timeout for sessionId: ${sessionId}`)
    cleanup()
  }, 3 * 60 * 1000)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    console.log(`[Pair] connection.update → ${connection || 'n/a'} (sessionId: ${sessionId})`)

    if (connection === 'connecting' && !codeRequested && !sock.authState.creds.registered) {
      codeRequested = true
      await delay(1500)
      try {
        const code = await sock.requestPairingCode(phone)
        console.log(`[Pair] Code for ${phone}: ${code}`)
        await setPairingCode(sessionId, code)
      } catch (e) {
        console.error(`[Pair] requestPairingCode failed: ${e.message}`)
      }
    }

    if (connection === 'open') {
      clearTimeout(timeout)
      console.log(`[Pair] Connected for ${phone}`)

      const userPhone = sock.user?.id?.split(':')[0] || phone

      const credsJson = JSON.stringify(tempAuth.state.creds, BufferJSON.replacer)

      try {
        await pushSessionToGithub(userPhone, credsJson)
        console.log(`[Pair] Creds pushed to GitHub for ${userPhone}`)
      } catch (e) {
        console.error(`[Pair] GitHub push failed: ${e.message}`)
      }

      try {
        await activateSession(sessionId, userPhone)
        console.log(`[Pair] Supabase session activated`)
      } catch (e) {
        console.error(`[Pair] Supabase activate failed: ${e.message}`)
      }

      sessionFinalized = true
      cleanup()
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      console.log(`[Pair] Connection closed, code: ${code} (sessionId: ${sessionId})`)

      if (sessionFinalized) {
        clearTimeout(timeout)
        return
      }

      if (code === 515) {
        console.log(`[Pair] 515 restart — reconnecting...`)
        try { sock.end() } catch {}
        await delay(2000)
        startPairing(phone, sessionId, true).catch(e => {
          console.error('[Pair] Reconnect after 515 failed:', e.message)
          pairingSessions.delete(sessionId)
        })
        return
      }

      clearTimeout(timeout)
      cleanup()
    }
  })
}

const selfPing = async () => {
  const url = process.env.RENDER_EXTERNAL_URL
  if (!url) return
  try {
    const r = await fetch(`${url}/health`)
    const d = await r.json().catch(() => ({}))
    console.log(`[Ping] OK — activePairings: ${d.activePairings ?? '?'}`)
  } catch (e) {
    console.error(`[Ping] Failed: ${e.message}`)
  }
}

app.listen(PORT, () => {
  console.log(`[Backend] Running on :${PORT}`)
  selfPing()
  setInterval(selfPing, 10 * 60 * 1000)
})
