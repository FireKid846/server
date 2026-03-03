const SUPA_URL = () => process.env.SUPABASE_URL
const SUPA_KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY

const supa = async (path, opts = {}) => {
  const r = await fetch(`${SUPA_URL()}/rest/v1${path}`, {
    ...opts,
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPA_KEY(),
      'Authorization': `Bearer ${SUPA_KEY()}`,
      'Prefer':        'return=minimal',
      ...opts.headers,
    },
  })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`Supabase ${path} → ${r.status}: ${body}`)
  }
  return r
}

export const setPairingCode = async (sessionId, pairingCode) => {
  await supa(`/bot_sessions?id=eq.${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    body:   JSON.stringify({ pairing_code: pairingCode }),
  })
}

export const activateSession = async (sessionId, phoneNumber) => {
  await supa(`/bot_sessions?id=eq.${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    body:   JSON.stringify({
      status:       'active',
      phone_number: phoneNumber,
      pairing_code: null,
    }),
  })
}

export const deactivateSession = async (sessionId) => {
  await supa(`/bot_sessions?id=eq.${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    body:   JSON.stringify({
      status:           'inactive',
      disconnected_at:  new Date().toISOString(),
    }),
  })
}
