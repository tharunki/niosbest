import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const identifierPattern = /^[a-z_][a-z0-9_]*$/i;
const rowIdPattern = /^[A-Za-z0-9_-]{1,80}$/;

export class StateStoreError extends Error {
  constructor(message, { status = 500, code = 'STATE_STORE_ERROR', retryable = false } = {}) {
    super(message);
    this.name = 'StateStoreError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

function validIdentifier(value, label) {
  const source = String(value || '').trim();
  if (!identifierPattern.test(source)) throw new StateStoreError(`${label} must contain only letters, numbers, and underscores.`, { code: 'STATE_STORE_CONFIG' });
  return source;
}

function validUrl(value, isProduction) {
  const source = String(value || '').trim().replace(/\/$/, '');
  if (!source) throw new StateStoreError('SUPABASE_URL is required when PORTAL_STATE_DRIVER=supabase.', { code: 'STATE_STORE_CONFIG' });
  let url;
  try { url = new URL(source); }
  catch { throw new StateStoreError('SUPABASE_URL must be a valid URL.', { code: 'STATE_STORE_CONFIG' }); }
  if (!['https:', 'http:'].includes(url.protocol) || (isProduction && url.protocol !== 'https:')) throw new StateStoreError('SUPABASE_URL must use HTTPS in production.', { code: 'STATE_STORE_CONFIG' });
  return source;
}

export function resolveStateStoreConfig({ env = process.env, isProduction = false, localFilePath = '' } = {}) {
  const driver = String(env.PORTAL_STATE_DRIVER || 'local').trim().toLowerCase();
  if (!['local', 'supabase'].includes(driver)) throw new StateStoreError('PORTAL_STATE_DRIVER must be "local" or "supabase".', { code: 'STATE_STORE_CONFIG' });

  if (driver === 'local') {
    if (!localFilePath) throw new StateStoreError('A local state file path is required for PORTAL_STATE_DRIVER=local.', { code: 'STATE_STORE_CONFIG' });
    return { driver, durable: false, localFilePath, isProduction };
  }

  const serviceRoleKey = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!serviceRoleKey) throw new StateStoreError('SUPABASE_SERVICE_ROLE_KEY is required when PORTAL_STATE_DRIVER=supabase.', { code: 'STATE_STORE_CONFIG' });
  const rowId = String(env.SUPABASE_STATE_ROW_ID || 'primary').trim();
  if (!rowIdPattern.test(rowId)) throw new StateStoreError('SUPABASE_STATE_ROW_ID may contain only letters, numbers, hyphens, and underscores.', { code: 'STATE_STORE_CONFIG' });
  return {
    driver,
    durable: true,
    baseUrl: validUrl(env.SUPABASE_URL, isProduction),
    serviceRoleKey,
    schema: validIdentifier(env.SUPABASE_STATE_SCHEMA || 'public', 'SUPABASE_STATE_SCHEMA'),
    table: validIdentifier(env.SUPABASE_STATE_TABLE || 'portal_state', 'SUPABASE_STATE_TABLE'),
    rowId,
    isProduction
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function responseError(operation, response, body = '') {
  const summary = String(body || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return new StateStoreError(`Supabase state ${operation} failed (${response.status})${summary ? `: ${summary}` : ''}`, {
    status: response.status >= 400 && response.status < 500 ? 503 : 502,
    code: 'SUPABASE_STATE_UNAVAILABLE',
    retryable: response.status >= 500 || response.status === 429
  });
}

function isConflictResponse(response) {
  // A conditional PATCH returns an empty representation when a different
  // instance has already replaced the snapshot. It is not an error: retry
  // against the newer revision instead of overwriting that work.
  return response.ok && response.status === 200;
}

export async function createStateStore(config, { fetchImpl = globalThis.fetch } = {}) {
  if (!config || !config.driver) throw new StateStoreError('State store configuration is required.', { code: 'STATE_STORE_CONFIG' });
  if (config.driver === 'local') {
    const stateFile = config.localFilePath;
    let queue = Promise.resolve();
    async function read() { return JSON.parse(await readFile(stateFile, 'utf8')); }
    async function write(data) {
      await mkdir(dirname(stateFile), { recursive: true });
      const temporary = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, JSON.stringify(data, null, 2), 'utf8');
      await rename(temporary, stateFile);
    }
    return {
      driver: 'local',
      durable: false,
      async ensure(initialState) {
        try { await read(); }
        catch (error) {
          if (error?.code !== 'ENOENT') throw error;
          await write(clone(initialState));
        }
      },
      read,
      write,
      async update(mutator) {
        const operation = queue.then(async () => {
          const state = await read();
          const result = await mutator(state);
          await write(state);
          return result;
        });
        queue = operation.catch(() => undefined);
        return operation;
      },
      publicStatus() { return { driver: 'local', durable: false, writeReady: !config.isProduction }; }
    };
  }

  if (config.driver !== 'supabase' || typeof fetchImpl !== 'function') throw new StateStoreError('A fetch implementation is required for the Supabase state store.', { code: 'STATE_STORE_CONFIG' });
  const tablePath = `/rest/v1/${encodeURIComponent(config.table)}`;
  // Modern `sb_secret_` keys are API keys, not JWTs. Passing one as a Bearer
  // token produces Supabase's "Invalid Compact JWS" response. Legacy
  // service-role JWTs still need the Authorization header for PostgREST.
  const legacyJwt = String(config.serviceRoleKey).startsWith('eyJ');
  const headers = (write = false, extra = {}) => ({
    apikey: config.serviceRoleKey,
    ...(legacyJwt ? { authorization: `Bearer ${config.serviceRoleKey}` } : {}),
    accept: 'application/json',
    'accept-profile': config.schema,
    ...(write ? { 'content-profile': config.schema, 'content-type': 'application/json' } : {}),
    ...extra
  });
  const request = async (path, options = {}) => {
    let response;
    try { response = await fetchImpl(`${config.baseUrl}${path}`, { ...options, signal: options.signal || AbortSignal.timeout(15_000) }); }
    catch (error) { throw new StateStoreError(`Supabase state request failed: ${error?.message || 'network error'}`, { status: 503, code: 'SUPABASE_STATE_UNAVAILABLE', retryable: true }); }
    return response;
  };
  const getRow = async () => {
    const response = await request(`${tablePath}?id=eq.${encodeURIComponent(config.rowId)}&select=revision,state`, { headers: headers(false) });
    if (!response.ok) throw responseError('read', response, await response.text());
    const rows = await response.json();
    if (!Array.isArray(rows) || !rows.length) return null;
    const row = rows[0];
    if (!Number.isSafeInteger(Number(row.revision)) || !row.state || typeof row.state !== 'object' || Array.isArray(row.state)) throw new StateStoreError('Supabase state row is malformed. Restore it from a backup before accepting student data.', { status: 503, code: 'SUPABASE_STATE_CORRUPT' });
    return { revision: Number(row.revision), state: row.state };
  };
  const insertInitial = async (initialState) => {
    const response = await request(`${tablePath}?on_conflict=id`, {
      method: 'POST',
      headers: headers(true, { prefer: 'resolution=ignore-duplicates,return=representation' }),
      body: JSON.stringify({ id: config.rowId, revision: 0, state: initialState })
    });
    if (!response.ok) throw responseError('initialization', response, await response.text());
  };
  const replace = async (revision, nextState) => {
    const response = await request(`${tablePath}?id=eq.${encodeURIComponent(config.rowId)}&revision=eq.${encodeURIComponent(revision)}`, {
      method: 'PATCH',
      headers: headers(true, { prefer: 'return=representation' }),
      body: JSON.stringify({ state: nextState, revision: revision + 1 })
    });
    if (!isConflictResponse(response)) throw responseError('write', response, await response.text());
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length !== 1) return false;
    return true;
  };

  let queue = Promise.resolve();
  return {
    driver: 'supabase',
    durable: true,
    async ensure(initialState) {
      const row = await getRow();
      if (row) return;
      await insertInitial(clone(initialState));
      if (!await getRow()) throw new StateStoreError('Supabase state initialization did not create a state row.', { status: 503, code: 'SUPABASE_STATE_UNAVAILABLE' });
    },
    async read() {
      const row = await getRow();
      if (!row) throw new StateStoreError('Supabase state has not been initialized. Apply the portal-state migration before accepting student data.', { status: 503, code: 'SUPABASE_STATE_NOT_INITIALIZED' });
      return clone(row.state);
    },
    async write(nextState) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const row = await getRow();
        if (!row) throw new StateStoreError('Supabase state has not been initialized. Apply the portal-state migration before accepting student data.', { status: 503, code: 'SUPABASE_STATE_NOT_INITIALIZED' });
        if (await replace(row.revision, clone(nextState))) return;
      }
      throw new StateStoreError('Supabase state was updated concurrently too many times. Please retry.', { status: 503, code: 'SUPABASE_STATE_CONFLICT', retryable: true });
    },
    async update(mutator) {
      const operation = queue.then(async () => {
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const row = await getRow();
          if (!row) throw new StateStoreError('Supabase state has not been initialized. Apply the portal-state migration before accepting student data.', { status: 503, code: 'SUPABASE_STATE_NOT_INITIALIZED' });
          const state = clone(row.state);
          const result = await mutator(state);
          if (await replace(row.revision, state)) return result;
        }
        throw new StateStoreError('Supabase state was updated concurrently too many times. Please retry.', { status: 503, code: 'SUPABASE_STATE_CONFLICT', retryable: true });
      });
      queue = operation.catch(() => undefined);
      return operation;
    },
    publicStatus() { return { driver: 'supabase', durable: true, writeReady: true }; }
  };
}
