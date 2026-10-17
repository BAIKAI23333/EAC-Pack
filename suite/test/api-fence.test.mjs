/**
 * Regression lock for the /api prefix-shadowing auth-fence defect.
 *
 * The kernel's authentication gate is itself a route on the `/api` prefix, and
 * `webServer` matches the LONGEST prefix first. Once this suite mounts
 * `/api/eac-plugin-suite` it therefore shadows that gate completely, and
 * `register()` adds no fence of its own — so every handler has to ask the
 * kernel's `connection` service for a verdict.
 *
 * These tests pin the contract:
 *   - a rejected request is answered with the kernel's own status code,
 *   - an unreachable/failing fence answers 503 and NEVER lets the request through,
 *   - a rejected request has NO side effects (no body read, no job enqueued).
 */
process.env.DSH_SUITE_NO_RESOURCES = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

function makeRes() {
  const res = {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    end(payload) {
      if (payload) this.body += payload
    },
    write() {},
  }
  return res
}

/** A request that records whether its body was ever consumed. */
function makeReq(url, method = 'GET', body) {
  const req = {
    url,
    method,
    bodyRead: false,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    on(event, cb) {
      if (event === 'data' && body !== undefined) {
        req.bodyRead = true
        cb(Buffer.from(body))
      }
      if (event === 'end') cb()
    },
  }
  return req
}

/**
 * Mount the API with a controllable fence.
 * `fence` receives the request; return a status code to reject, undefined to pass.
 */
function mount({ fence, pluginManager } = {}) {
  const registered = []
  const calls = { installed: 0, removed: 0, enabled: 0 }
  const pm = pluginManager ?? {
    async installBundle() { calls.installed++; return { pendingBuilds: [] } },
    async removeBundle() { calls.removed++; return { ok: true } },
    async setBundleEnabled() { calls.enabled++; return { ok: true } },
    async listBundles() { return [] },
  }
  const webServer = {
    register(def) {
      registered.push(def)
      return () => registered.splice(registered.indexOf(def), 1)
    },
  }
  const connection = fence === null ? undefined : { requestRejection: fence ?? (() => undefined) }
  const ctx = {
    pluginManager: pm,
    ...(connection ? { connection } : {}),
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) { return fn() },
    inject(deps, cb) {
      cb({ webServer, pluginManager: pm, ...(connection ? { connection } : {}) })
    },
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-fence-'))
  process.env.DSH_HOME = home
  apply(ctx, {})
  assert.equal(registered.length, 1, 'API route is mounted even without a working fence')
  return { handler: registered[0].handler, calls, home }
}

test('a rejected request is answered with the kernel status and runs no business logic', async () => {
  for (const code of [401, 403]) {
    const { handler, calls } = mount({ fence: () => code })
    const req = makeReq('http://localhost/api/eac-plugin-suite/install', 'POST', JSON.stringify({ pack: 'eac' }))
    const res = makeRes()
    await handler(req, res)
    assert.equal(res.statusCode, code, `kernel verdict ${code} is forwarded verbatim`)
    assert.equal(res.body, '', 'no payload leaks on rejection')
    assert.equal(req.bodyRead, false, 'the request body is never read for a rejected request')
    assert.equal(calls.installed, 0, 'no install job was enqueued')
  }
})

test('an unreachable or throwing fence fails CLOSED with 503', async () => {
  const cases = [
    ['service missing entirely', null],
    ['service without requestRejection', { requestRejection: undefined }],
    ['requestRejection throws', () => { throw new Error('fence exploded') }],
  ]
  for (const [label, fence] of cases) {
    const { handler, calls } = mount({ fence })
    const req = makeReq('http://localhost/api/eac-plugin-suite/catalog')
    const res = makeRes()
    await handler(req, res)
    assert.equal(res.statusCode, 503, `${label}: answers 503 instead of allowing the request`)
    assert.equal(res.body, '', `${label}: empty body (no internals leak)`)
    assert.equal(calls.installed, 0, `${label}: no side effects`)
  }
})

test('a rejected GET never serves catalog or status data', async () => {
  for (const route of ['/catalog', '/status', '/snapshots', '/events-ring']) {
    const { handler } = mount({ fence: () => 401 })
    const res = makeRes()
    await handler(makeReq(`http://localhost/api/eac-plugin-suite${route}`), res)
    assert.equal(res.statusCode, 401, `${route} is fenced`)
    assert.ok(!res.body.includes('packs'), `${route} exposes no catalog data`)
  }
})

test('rejected writes never reach the plugin manager', async () => {
  const posts = [
    ['/install', { pack: 'eac' }],
    ['/uninstall', { ids: ['x'] }],
    ['/enable', { id: 'x', enabled: true }],
    ['/resources/retry', {}],
  ]
  for (const [route, body] of posts) {
    const { handler, calls } = mount({ fence: () => 403 })
    const req = makeReq(`http://localhost/api/eac-plugin-suite${route}`, 'POST', JSON.stringify(body))
    const res = makeRes()
    await handler(req, res)
    assert.equal(res.statusCode, 403)
    assert.equal(req.bodyRead, false, `${route}: business body untouched`)
    assert.deepEqual(calls, { installed: 0, removed: 0, enabled: 0 }, `${route}: no manager call`)
  }
})

test('an allowed request still reaches the original handler', async () => {
  const { handler } = mount({ fence: () => undefined })
  const res = makeRes()
  await handler(makeReq('http://localhost/api/eac-plugin-suite/catalog'), res)
  assert.equal(res.statusCode, 200, 'passing the fence preserves normal behaviour')
  assert.ok(JSON.parse(res.body).packs, 'catalog payload is unchanged')
})

test('the fence is consulted on every request, not cached at apply time', async () => {
  let verdict = 401
  const { handler } = mount({ fence: () => verdict })
  const first = makeRes()
  await handler(makeReq('http://localhost/api/eac-plugin-suite/catalog'), first)
  assert.equal(first.statusCode, 401)
  verdict = undefined
  const second = makeRes()
  await handler(makeReq('http://localhost/api/eac-plugin-suite/catalog'), second)
  assert.equal(second.statusCode, 200, 'a late/unblocked verdict is picked up without re-mounting')
})
