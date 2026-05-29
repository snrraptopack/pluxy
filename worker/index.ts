import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { sha256 } from 'hono/utils/crypto'
import { encrypt, decrypt } from './crypto'

type Bindings = {
  USERS: KVNamespace
  RESULTS: KVNamespace
  SECRET: string
}

const app = new Hono<{ Bindings: Bindings }>()

// Enable CORS for API routes
app.use('/api/*', cors())

// API status check
app.get('/api/status', (c) => {
  return c.json({ status: 'online', service: 'Pluxy UMaT Portal Cache' })
})

/**
 * Public summary endpoint — returns total registered user count and their index numbers.
 * No passwords, tokens, or session data are exposed here.
 */
app.get('/yousers', async (c) => {
  try {
    const list = await c.env.USERS.list()

    // Filter out internal keys (session cookies and result hashes are stored with colons)
    const usernames = list.keys
      .map(k => k.name)
      .filter(name => !name.includes(':'))

    return c.json({
      total: usernames.length,
      users: usernames
    })
  } catch (err: any) {
    return c.json({ ok: false, error: err.message || 'Internal server error' }, 500)
  }
})

/**
 * Endpoint to register or update user credentials.
 * This will save the credentials encrypted using AES-GCM and c.env.SECRET.
 * It also triggers an initial sync in the background so results are ready sooner.
 */
app.post('/api/signup', async (c) => {
  try {
    const { username, password } = await c.req.json()
    if (!username || !password) {
      return c.json({ ok: false, error: 'Username and password are required' }, 400)
    }

    // Encrypt the password using c.env.SECRET before saving to KV
    const enc = await encrypt(password, c.env.SECRET)

    // Store user credentials. Set active to true to enable background polling.
    await c.env.USERS.put(
      username,
      JSON.stringify({ username, enc, active: true })
    )

    // Trigger an immediate sync in the background (using ctx.waitUntil) so the user doesn't have to wait for the cron
    c.executionCtx.waitUntil(processUser(username, c.env, true))

    return c.json({ ok: true, message: 'User registered/updated successfully. Initial result fetch started.' })
  } catch (err: any) {
    return c.json({ ok: false, error: err.message || 'Internal server error' }, 500)
  }
})

/**
 * Endpoint to retrieve cached UMaT results for a specific student.
 */
app.get('/api/my-results/:user', async (c) => {
  try {
    const username = c.req.param('user')
    const cached = await c.env.RESULTS.get(username, 'json')

    if (!cached) {
      // Check if user is registered at all
      const userRecord = await c.env.USERS.get(username, 'json') as { active: boolean; errorState?: string } | null
      if (!userRecord) {
        return c.json({ status: 'not_found', error: 'Student not registered on Pluxy' }, 404)
      }
      if (userRecord.errorState === 'invalid_credentials') {
        return c.json({ status: 'inactive', error: 'Sync failed. Incorrect UMaT Index Number or PIN. Disconnect and try again.' }, 400)
      }
      return c.json({ status: 'pending', message: 'Retrieval in progress. Please check back in a few seconds.' }, 202)
    }

    return c.json(cached)
  } catch (err: any) {
    return c.json({ ok: false, error: err.message || 'Internal server error' }, 500)
  }
})

/**
 * Endpoint to check background polling status of a user.
 */
app.get('/api/user-status/:user', async (c) => {
  try {
    const username = c.req.param('user')
    const userRecord = await c.env.USERS.get(username, 'json') as { 
      active: boolean; 
      manualSyncsToday?: number; 
      lastSyncReset?: number 
    } | null

    if (!userRecord) {
      return c.json({ registered: false })
    }

    const DAY_MS = 24 * 60 * 60 * 1000
    const now = Date.now()
    let syncsToday = userRecord.manualSyncsToday || 0
    if (userRecord.lastSyncReset && (now - userRecord.lastSyncReset > DAY_MS)) {
      syncsToday = 0
    }

    return c.json({ 
      registered: true, 
      active: userRecord.active,
      syncsRemaining: Math.max(0, 5 - syncsToday)
    })
  } catch (err: any) {
    return c.json({ ok: false, error: err.message || 'Internal server error' }, 500)
  }
})

/**
 * Force a manual trigger to fetch results from the UMaT portal immediately.
 */
app.post('/api/refresh/:user', async (c) => {
  try {
    const username = c.req.param('user')
    const userRecord = await c.env.USERS.get(username, 'json') as { 
      username: string; 
      enc: string; 
      active: boolean; 
      manualSyncsToday?: number; 
      lastSyncReset?: number 
    } | null

    if (!userRecord) {
      return c.json({ ok: false, error: 'User credentials not found. Please sign up first.' }, 404)
    }

    // 24-hour rate limit check (max 5 manual syncs per day)
    const DAY_MS = 24 * 60 * 60 * 1000
    const now = Date.now()
    
    let syncsToday = userRecord.manualSyncsToday || 0
    let syncReset = userRecord.lastSyncReset || now
    
    if (now - syncReset > DAY_MS) {
      syncsToday = 0
      syncReset = now
    }
    
    if (syncsToday >= 5) {
      return c.json({ 
        ok: false, 
        error: 'Daily manual sync limit reached (5/5). Pluxy will continue checking in the background.' 
      }, 429)
    }

    // Update count and reset timestamp
    userRecord.manualSyncsToday = syncsToday + 1
    userRecord.lastSyncReset = syncReset
    userRecord.active = true // Ensure active status is re-enabled

    await c.env.USERS.put(username, JSON.stringify(userRecord))

    // Run the sync process in-line to respond with results directly
    await processUser(username, c.env, true)
    
    const userRecordUpdated = await c.env.USERS.get(username, 'json') as { active: boolean; errorState?: string } | null
    if (userRecordUpdated && userRecordUpdated.errorState === 'invalid_credentials') {
      return c.json({ ok: false, error: 'Sync failed. Incorrect UMaT Index Number or PIN.' }, 400)
    }

    // Fetch newly cached data
    const cached = await c.env.RESULTS.get(username, 'json')
    if (cached) {
      return c.json({ ok: true, data: cached })
    }

    return c.json({ ok: false, error: 'Failed to retrieve results. Check portal credentials.' }, 400)
  } catch (err: any) {
    return c.json({ ok: false, error: err.message || 'Internal server error' }, 500)
  }
})

// Core business logic to check UMaT portal, update cache, and diff changes
async function processUser(username: string, env: Bindings, force = false): Promise<boolean> {
  const userData = await env.USERS.get(username, 'json') as { username: string; enc: string; active: boolean; lastPolled?: number; errorState?: string | null } | null
  if (!userData || !userData.active) return false

  // Rate limit protection: enforce 4-hour cooldown on automatic background cron ticks
  const COOLDOWN_MS = 4 * 60 * 60 * 1000
  if (!force && userData.lastPolled && (Date.now() - userData.lastPolled < COOLDOWN_MS)) {
    console.log(`Skipping background sync for user ${username} (within cooldown)`)
    return true
  }

  // Update lastPolled immediately to prevent race conditions
  userData.lastPolled = Date.now()
  if (force) {
    userData.errorState = null
  }
  await env.USERS.put(username, JSON.stringify(userData))

  let password
  try {
    password = await decrypt(userData.enc, env.SECRET)
  } catch (err) {
    console.error(`Failed to decrypt password for user ${username}:`, err)
    return false
  }

  // 1. Session Cache: fetch cookie or reuse valid one
  let cookie = await env.RESULTS.get(`sess:${username}`)
  let loginSuccessful = true

  if (!cookie) {
    try {
      console.log('Logging in to UMaT portal for', username)
      const login = await fetch('https://student.umat.edu.gh/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' },
        body: JSON.stringify({ username, password })
      })

      if (login.status === 400 || login.status === 401) {
        console.warn(`Invalid credentials detected for user ${username}. Deactivating account polling.`)
        userData.active = false
        userData.errorState = 'invalid_credentials'
        await env.USERS.put(username, JSON.stringify(userData))
        throw new Error('INVALID_CREDENTIALS')
      }

      if (!login.ok) {
        throw new Error(`Login failed with status ${login.status}`)
      }

      // Check the JSON response for isSuccessful: false
      const loginJson: any = await login.json().catch(() => ({}))
      if (loginJson && loginJson.isSuccessful === false) {
        console.warn(`Login failed for user ${username}: ${loginJson.message}`)
        userData.active = false
        userData.errorState = 'invalid_credentials'
        await env.USERS.put(username, JSON.stringify(userData))
        throw new Error(loginJson.message || 'INVALID_CREDENTIALS')
      }

      const setCookie = login.headers.get('set-cookie')
      cookie = setCookie?.split(';')[0] || ''
      
      if (!cookie) {
        throw new Error('No set-cookie header received from UMaT auth API')
      }

      // Cache the session cookie for 20 minutes (UMaT standard session is ~30 min)
      await env.RESULTS.put(`sess:${username}`, cookie, { expirationTtl: 1200 })

      // Clear errorState since login was successful
      if (userData.errorState) {
        userData.errorState = null
        await env.USERS.put(username, JSON.stringify(userData))
      }
    } catch (err) {
      console.error(`UMaT portal login error for user ${username}:`, err)
      loginSuccessful = false
    }
  }

  if (!loginSuccessful || !cookie) return false

  // 2. Fetch academic results
  try {
    let res = await fetch('https://student.umat.edu.gh/api/result', {
      headers: { cookie, 'user-agent': 'Mozilla/5.0' }
    })

    // Handle expired cookie (401) by clearing cache and retrying once
    if (res.status === 401) {
      console.log('Session expired. Retrying login for', username)
      await env.RESULTS.delete(`sess:${username}`)
      
      const login = await fetch('https://student.umat.edu.gh/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' },
        body: JSON.stringify({ username, password })
      })

      const setCookie = login.headers.get('set-cookie')
      cookie = setCookie?.split(';')[0] || ''
      
      if (cookie) {
        await env.RESULTS.put(`sess:${username}`, cookie, { expirationTtl: 1200 })
        res = await fetch('https://student.umat.edu.gh/api/result', {
          headers: { cookie, 'user-agent': 'Mozilla/5.0' }
        })
      }
    }

    const resJson: any = await res.json()
    if (!resJson.isSuccessful || !Array.isArray(resJson.data)) {
      console.error(`Unsuccessful result payload for user ${username}:`, resJson.message)
      
      // If the portal tells us the auth token is missing, deactivate polling
      if (resJson.message === 'No authentication token found' || resJson.message?.includes('auth') || resJson.message?.includes('login')) {
        console.warn(`Auth session validation failed for user ${username}. Deactivating account.`)
        userData.active = false
        userData.errorState = 'invalid_credentials'
        await env.USERS.put(username, JSON.stringify(userData))
      }
      return false
    }

    // 3. Diff and update cache
    const dataString = JSON.stringify(resJson)
    const newHash = await sha256(dataString)
    if (!newHash) return false
    const oldHash = await env.RESULTS.get(`${username}:hash`)

    if (newHash !== oldHash) {
      // Save full response with updated timestamp
      await env.RESULTS.put(
        username,
        JSON.stringify({
          updated: Date.now(),
          studentName: resJson.studentName,
          data: resJson.data
        })
      )
      
      // Store new hash to track changes
      await env.RESULTS.put(`${username}:hash`, newHash)
      
      // Deactivate automatic polling. User can reactivate by calling /refresh or logging in again.
      await env.USERS.put(
        username,
        JSON.stringify({ ...userData, active: false })
      )
      
      console.log('New academic results detected and saved for', username)
      return true
    } else {
      console.log('No changes in results for user', username)
      return true
    }
  } catch (err) {
    console.error(`Error fetching results for user ${username}:`, err)
    return false
  }
}

// Export the Worker exported handlers
export default {
  fetch: app.fetch,

  /**
   * Cron job handler: triggers periodically to scan and process active users.
   */
  async scheduled(_controller: any, env: Bindings, ctx: ExecutionContext) {
    console.log('Cron job checking for new results...')
    const users = await env.USERS.list()
    
    // Batch processing to respect execution limit of 30 seconds
    const activeBatch = users.keys.slice(0, 20)
    for (const { name } of activeBatch) {
      ctx.waitUntil(processUser(name, env))
    }
  }
} satisfies ExportedHandler<Bindings>
