const GITHUB_TOKEN = () => process.env.GITHUB_TOKEN
const GITHUB_REPO  = () => process.env.GITHUB_REPO

const ghHeaders = () => ({
  'Authorization': `Bearer ${GITHUB_TOKEN()}`,
  'Content-Type':  'application/json',
  'Accept':        'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
})

const getFileSha = async (path) => {
  const r = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO()}/contents/${path}`,
    { headers: ghHeaders() }
  )
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`GitHub GET ${path} → ${r.status}`)
  const d = await r.json()
  return d.sha || null
}

export const pushSessionToGithub = async (phone, credsJson) => {
  const path    = `nexstore/sessions/${phone}/creds.json`
  const content = Buffer.from(credsJson).toString('base64')
  const sha     = await getFileSha(path)

  const body = {
    message: `session: update ${phone}`,
    content,
    ...(sha ? { sha } : {}),
  }

  const r = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO()}/contents/${path}`,
    { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) }
  )

  if (!r.ok) {
    const err = await r.json().catch(() => ({}))
    throw new Error(`GitHub push failed: ${err.message || r.status}`)
  }
}
