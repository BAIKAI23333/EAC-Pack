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
 *   - a rejected request has NO side effects (no body read, no job enqueued),
 *   - and, at the bottom of this file, the same behaviour holds inside a REAL
 *     cordis context rather than a hand-written mock (see that section's note).
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
 * `connection: null` simulates a host with no connection service.
 *
 * The handler resolves the service through `ctx.get('connection')`, so the mock
 * MUST expose `get()`. A plain object carrying only a `connection` property is
 * NOT faithful: a real cordis Context is a Proxy with its own read rules, which
 * is exactly what the real-cordis test at the bottom of this file covers.
 */
function mount({ fence, pluginManager, connection: connectionOverride } = {}) {
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
  const connection = connectionOverride !== undefined
    ? connectionOverride
    : (fence === null ? undefined : { requestRejection: fence ?? (() => undefined) })
  const ctx = {
    pluginManager: pm,
    ...(connection ? { connection } : {}),
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      return name === 'connection' ? connection : undefined
    },
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

test('a host without ctx.get() fails CLOSED instead of crashing', async () => {
  // Defensive branch: an older host may not expose ctx.get at all.
  const registered = []
  const ctx = {
    pluginManager: {},
    logger: {},
    effect(fn) { return fn() },
    inject(deps, cb) { cb({ webServer: { register(def) { registered.push(def); return () => {} } }, pluginManager: {} }) },
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-fence-'))
  process.env.DSH_HOME = home
  apply(ctx, {})
  const res = makeRes()
  await registered[0].handler(makeReq('http://localhost/api/eac-plugin-suite/catalog'), res)
  assert.equal(res.statusCode, 503, 'no ctx.get -> cannot verify -> refuse')
  assert.equal(res.body, '', 'and say nothing about why')
})

// ---------------------------------------------------------------------------
// Real-cordis integration coverage.
//
// Everything above runs against a hand-written ctx object, and that is exactly
// how an earlier revision of this patch shipped broken: a real cordis Context is
// a Proxy, `Reflect.get(ctx, name)` THROWS for a service not declared in
// `inject`, and the resulting exception was swallowed into a blanket 503. Every
// mock-based test still passed while the plugin answered 503 for every request
// in a real host — protected, but completely unusable.
//
// This test therefore mounts the shipped `apply()` into a REAL cordis Context
// with real Services, so the service-resolution path is exercised for real.
// It skips (rather than fails) when cordis is not installed in this checkout.
// ---------------------------------------------------------------------------

/** Locate a real cordis in this checkout, or null when unavailable. */
async function loadCordis() {
  const candidates = [
    '@deepseek-ai/cordis',
    // Kernel used by the isolated test runtime.
    new URL(
      '../../../../DSH-Desktop-EAC/.test-runtime/p0-lab/development/runtimes/dsh-020rc2-node24/kernel/node_modules/@deepseek-ai/cordis/lib/index.js',
      import.meta.url,
    ).href,
  ]
  for (const spec of candidates) {
    try {
      const mod = await import(spec)
      if (mod?.Context && mod?.Service) return mod
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

test('real cordis: a present connection service must NOT be turned into 503', async (t) => {
  const cordis = await loadCordis()
  if (!cordis) return t.skip('cordis is not installed in this checkout')
  const { Context, Service } = cordis

  class FakeConnection extends Service {
    constructor(ctx) { super(ctx, 'connection') }
    requestRejection(req) {
      return req.headers?.host === 'evil.example' ? 403 : undefined
    }
  }
  class FakeWebServer extends Service {
    constructor(ctx) { super(ctx, 'webServer'); this.routes = [] }
    register(def) { this.routes.push(def); return () => {} }
  }
  class FakePluginManager extends Service {
    constructor(ctx) { super(ctx, 'pluginManager') }
    async installBundle() { throw new Error('must not be called for a rejected request') }
    async removeBundle() { throw new Error('must not be called for a rejected request') }
    async setBundleEnabled() { throw new Error('must not be called for a rejected request') }
    async listBundles() { return [] }
  }

  const app = new Context()
  app.plugin(FakeConnection)
  app.plugin(FakeWebServer)
  app.plugin(FakePluginManager)
  await new Promise((r) => setTimeout(r, 100))

  apply(app, {})
  await new Promise((r) => setTimeout(r, 200))

  const routes = app.get('webServer')?.routes ?? []
  assert.equal(routes.length, 1, 'route mounted inside a real cordis context')
  const handler = routes[0].handler

  // The benign case is the one the Reflect.get bug broke: it must be served,
  // not refused. 503 here means the fence could not see a service that exists.
  const ok = makeRes()
  const okReq = makeReq('http://localhost/api/eac-plugin-suite/catalog')
  okReq.headers = { host: '127.0.0.1:3000' }
  await handler(okReq, ok)
  assert.notEqual(ok.statusCode, 503, 'an existing service must never be reported as unavailable')
  assert.equal(ok.statusCode, 200, 'benign request served normally')

  // The forged-host case must forward the kernel's own verdict.
  const forged = makeRes()
  const forgedReq = makeReq('http://localhost/api/eac-plugin-suite/catalog')
  forgedReq.headers = { host: 'evil.example' }
  await handler(forgedReq, forged)
  assert.equal(forged.statusCode, 403, 'kernel 403 verdict is forwarded')
})
