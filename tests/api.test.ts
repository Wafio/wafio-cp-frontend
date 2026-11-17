import { afterEach, expect, test } from 'bun:test';
import { api } from '../src/lib/api';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
test('network rejection returns a typed error', async () => {
  globalThis.fetch = (() => Promise.reject(new TypeError('offline'))) as unknown as typeof fetch;
  expect((await api('/test')).error?.kind).toBe('network');
});
test('HTML success is a protocol failure', async () => {
  globalThis.fetch = (() => Promise.resolve(new Response('<html>login</html>'))) as unknown as typeof fetch;
  expect((await api('/test')).error?.kind).toBe('protocol');
});
test('HTTP failures preserve status and server error', async () => {
  globalThis.fetch = (() => Promise.resolve(Response.json({ error: 'Forbidden' }, { status: 403 }))) as unknown as typeof fetch;
  expect((await api('/test')).error).toMatchObject({ kind: 'http', status: 403, error: 'Forbidden' });
});

test('project selectors follow every page including project 101', async () => {
 const { listAllProjects } = await import('../src/lib/api');
 const offsets: number[] = [];
 globalThis.fetch = (async (input: string | URL | Request) => {
   const offset = Number(new URL(String(input)).searchParams.get('offset'));
   offsets.push(offset);
   return Response.json({ projects: Array.from({ length: offset ? 1 : 100 }, (_, i) => ({ id: String(offset+i) })), total: 101 });
 }) as unknown as typeof fetch;
 const result = await listAllProjects();
 expect(result.data?.projects).toHaveLength(101);
 expect(offsets).toEqual([0, 100]);
});

test('empty mutation body is not a confirmation', async () => {
 globalThis.fetch = (() => Promise.resolve(Response.json({}))) as unknown as typeof fetch;
 expect((await api('/test', { method: 'POST' })).error?.kind).toBe('protocol');
});
test('null is a valid absent telemetry response', async () => {
 globalThis.fetch = (() => Promise.resolve(Response.json(null))) as unknown as typeof fetch;
 expect(await api('/test')).toEqual({data:null});
});
test('critical create response requires an identity',async()=>{
 const { createProject }=await import('../src/lib/api');
 globalThis.fetch=(()=>Promise.resolve(Response.json({message:'wrong endpoint'}))) as unknown as typeof fetch;
 expect((await createProject('example','')).error?.kind).toBe('protocol');
});
test('explicit no-content deletion confirms success', async()=>{
 globalThis.fetch=(()=>Promise.resolve(new Response(null,{status:204}))) as unknown as typeof fetch;
 expect((await api('/test',{method:'DELETE'})).error).toBeUndefined();
});
test('null HTTP error remains a typed failure',async()=>{
 globalThis.fetch=(()=>Promise.resolve(Response.json(null,{status:403}))) as unknown as typeof fetch;
 expect((await api('/test')).error).toMatchObject({kind:'http',status:403});
});

test('authentication rejects incomplete success payloads', async () => {
 const { login, login2fa, registerWithInvite } = await import('../src/lib/api');
 const operations = [() => login('a@example.test', 'password'), () => login2fa('temporary', '123456'), () => registerWithInvite({token:'invite',email:'a@example.test',name:'A',password:'password'})];
 for (const body of [{ok:true}, {token:'session',user:{}}, {requires_2fa:true}, {token:'session',user:{id:'a',email:'a@example.test',name:'A',role:7}}]) {
  globalThis.fetch = (() => Promise.resolve(Response.json(body))) as unknown as typeof fetch;
  for (const operation of operations) expect((await operation()).error?.kind).toBe('protocol');
 }
});

test('authentication accepts complete sessions and password-only MFA challenges', async () => {
 const { login, login2fa, registerWithInvite } = await import('../src/lib/api');
 const session = {token:'session',user:{id:'a',email:'a@example.test',name:'',role:'user'}};
 globalThis.fetch = (() => Promise.resolve(Response.json(session))) as unknown as typeof fetch;
 expect((await login('a@example.test','password')).data).toEqual(session);
 expect((await login2fa('temporary','123456')).data).toEqual(session);
 expect((await registerWithInvite({token:'invite',email:'a@example.test',name:'A',password:'password'})).data).toEqual(session);
 const challenge={requires_2fa:true,temp_token:'temporary'};
 globalThis.fetch = (() => Promise.resolve(Response.json(challenge))) as unknown as typeof fetch;
 expect((await login('a@example.test','password')).data).toEqual(challenge);
 expect((await login2fa('temporary','123456')).error?.kind).toBe('protocol');
});

test('paged list helpers send limit/offset only when given', async () => {
  const { listHosts, listFleetAgents, listDetectionRules, getEBPFBlocklist } = await import('../src/lib/api');
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return Response.json({ hosts: [], agents: [], rules: [], entries: [], count: 0, total: 0, limit: 100, offset: 0 });
  }) as unknown as typeof fetch;
  await listHosts('p1');
  await listHosts('p1', { limit: 20, offset: 40 });
  await listFleetAgents({ kind: 'waf', projectId: 'p1', limit: 10 });
  await listDetectionRules('p1', 'h 1', { offset: 100 });
  await getEBPFBlocklist('p1', 50, undefined, 'h1', 100);
  const paths = urls.map((u) => { const x = new URL(u); return x.pathname + x.search; });
  expect(paths).toEqual([
    '/api/projects/p1/hosts',
    '/api/projects/p1/hosts?limit=20&offset=40',
    '/api/fleet/agents?kind=waf&project=p1&limit=10',
    '/api/projects/p1/host/trace/rules?host_id=h%201&offset=100',
    '/api/projects/p1/host/blocklist?limit=50&offset=100&host_id=h1',
  ]);
});

test('deleteProjectAgent targets the project route and passes force', async () => {
  const { deleteProjectAgent } = await import('../src/lib/api');
  const seen: { url: string; method?: string }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), method: init?.method });
    return Response.json(seen.length === 1
      ? { error: 'agent is online', code: 'AGENT_ONLINE', hint: 'Stop the agent first or retry with force=1.' }
      : { status: 'ok', ok: true }, { status: seen.length === 1 ? 409 : 200 });
  }) as unknown as typeof fetch;
  const first = await deleteProjectAgent('p1', 'a1');
  expect(first.error).toMatchObject({ status: 409, code: 'AGENT_ONLINE', hint: 'Stop the agent first or retry with force=1.' });
  const second = await deleteProjectAgent('p1', 'a1', { force: true });
  expect(second.data).toEqual({ status: 'ok', ok: true });
  expect(seen.map((s) => [new URL(s.url).pathname + new URL(s.url).search, s.method])).toEqual([
    ['/api/projects/p1/agents/a1', 'DELETE'],
    ['/api/projects/p1/agents/a1?force=1', 'DELETE'],
  ]);
});
