const { Pool } = require('pg');

const pools = new Map();
const schemaInitPromises = new Map();
let isClosing = false;

function convertParams(sql, params = []) {
  let idx = 0;
  const text = String(sql || '').replace(/\?/g, () => `$${++idx}`);
  return { text, values: params };
}

function getBootstrapConfig() {
  const host = process.env.DB_HOST || process.env.DATABASE_HOST;
  const port = process.env.DB_PORT || process.env.DATABASE_PORT || '5432';
  const name = process.env.DB_NAME || process.env.DATABASE_NAME;
  const user = process.env.DB_USER || process.env.DATABASE_USER;
  const password = process.env.DB_PASSWORD || process.env.DATABASE_PASSWORD;
  const ssl = String(process.env.DB_SSL || process.env.DATABASE_SSL || '').toLowerCase() === 'true';

  if (!host || !name || !user || !password) {
    throw new Error('Banco remoto nao configurado no .env. Verifique DB_HOST, DB_PORT, DB_NAME, DB_USER e DB_PASSWORD.');
  }

  return { host, port: Number(port), database: name, user, password, ssl };
}

async function createPoolIfNeeded() {
  const cfg = getBootstrapConfig();
  return createPoolForConfig(cfg, true);
}

async function createPoolForConfig(cfg, ensureSchema = false) {
  const key = JSON.stringify({ host: cfg.host, port: cfg.port, database: cfg.database, user: cfg.user, ssl: cfg.ssl });

  if (isClosing) {
    throw new Error('Database pool is closing');
  }

  const existingPool = pools.get(key);
  if (existingPool) return existingPool;

  const pool = new Pool({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : false,
    max: 30,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });
  pool.__poolKey = key;
  pools.set(key, pool);

  // Handle pool errors
  pool.on('error', (err) => {
    console.error('Unexpected error on idle client in pool:', err);
  });

  if (ensureSchema) {
    await initSchema(pool, key);
  }
  return pool;
}

async function initSchema(activePool, key) {
  const existingInitPromise = schemaInitPromises.get(key);
  if (existingInitPromise) return existingInitPromise;

  const initPromise = (async () => {
    await activePool.query(`
      CREATE TABLE IF NOT EXISTS roles (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) UNIQUE NOT NULL,
        description TEXT,
        permissions TEXT,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await activePool.query(`
      INSERT INTO roles (name, description, permissions) VALUES
        ('admin', 'Administrador com acesso total', '["read","write","delete","manage_users"]'),
        ('supervisor', 'Supervisor com acesso a relatórios e atendentes', '["read","write","manage_attendants"]'),
        ('atendente', 'Atendente com acesso básico', '["read","write"]'),
        ('guest', 'Login via SSO sem cadastro/perfil em Pessoas — só vê a Dashboard', '["read_dashboard"]')
      ON CONFLICT (name) DO NOTHING
    `);
    await activePool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        vertical VARCHAR(120),
        password_hash TEXT,
        role_id INTEGER NOT NULL REFERENCES roles(id),
        is_active BOOLEAN DEFAULT TRUE,
        first_access BOOLEAN DEFAULT TRUE,
        failed_login_attempts INTEGER DEFAULT 0,
        locked_until TIMESTAMP NULL,
        last_login TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await activePool.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS vertical VARCHAR(120)
    `).catch(() => {});
    await activePool.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER DEFAULT 0
    `).catch(() => {});
    await activePool.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS locked_until TIMESTAMP NULL
    `).catch(() => {});
    await activePool.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS last_login TIMESTAMP NULL
    `).catch(() => {});
    await activePool.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    `).catch(() => {});
    await activePool.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    `).catch(() => {});
    await activePool.query(`
      CREATE TABLE IF NOT EXISTS config (
        id SERIAL PRIMARY KEY,
        key VARCHAR(120) UNIQUE NOT NULL,
        value TEXT NOT NULL,
        encryptedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await activePool.query(`
      CREATE TABLE IF NOT EXISTS mfa_settings (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        mfa_type TEXT DEFAULT 'totp',
        totp_secret TEXT,
        backup_codes TEXT,
        is_enabled BOOLEAN DEFAULT FALSE,
        verified_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await activePool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token TEXT UNIQUE NOT NULL,
        ip_address TEXT,
        user_agent TEXT,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await activePool.query(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token TEXT UNIQUE NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await activePool.query(`
      CREATE TABLE IF NOT EXISTS access_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        resource TEXT,
        ip_address TEXT,
        success BOOLEAN DEFAULT TRUE,
        details TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await activePool.query(`
      CREATE TABLE IF NOT EXISTS tickets (
        id BIGINT PRIMARY KEY,
        subject TEXT NOT NULL,
        status TEXT,
        baseStatus TEXT,
        createdDate TEXT,
        lastActionDate TEXT,
        lastUpdate TEXT,
        serviceFirstLevelId INTEGER,
        serviceFirstLevel TEXT,
        serviceSecondLevel TEXT,
        slaAgreement TEXT,
        slaAgreementRule TEXT,
        slaSolutionTime INTEGER,
        slaResponseTime INTEGER,
        slaSolutionDate TEXT,
        slaSolutionDateIsPaused BOOLEAN,
        slaResponseDate TEXT,
        slaRealResponseDate TEXT,
        ownerEmail TEXT,
        ownerName TEXT,
        owner_team TEXT,
        clientName TEXT,
        clientEmail TEXT,
        clientOrganization TEXT,
        justification TEXT,
        customFields TEXT,
        actionsJson TEXT,
        clientsJson TEXT,
        statusHistoriesJson TEXT,
        actionsCount INTEGER DEFAULT 0,
        lastActionCreatedByBusinessName TEXT,
        lastActionOrigin TEXT,
        syncedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await activePool.query(`
      ALTER TABLE tickets
      ALTER COLUMN justification TYPE TEXT USING justification::text
    `).catch(() => {});
    await activePool.query(`
      ALTER TABLE tickets
      ADD COLUMN IF NOT EXISTS owner_team TEXT
    `).catch(() => {});

    await activePool.query(`
      CREATE TABLE IF NOT EXISTS ai_usage_log (
        id SERIAL PRIMARY KEY,
        source VARCHAR(64) NOT NULL,
        model VARCHAR(64),
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        estimated_cost_usd NUMERIC(10,6) DEFAULT 0,
        user_email TEXT,
        meta TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `).catch(() => {});

    await activePool.query(`
      CREATE TABLE IF NOT EXISTS performance_score_history (
        id SERIAL PRIMARY KEY,
        owner_name TEXT NOT NULL,
        score INTEGER NOT NULL,
        seniority_label VARCHAR(64),
        seniority_reason TEXT,
        total_tickets INTEGER DEFAULT 0,
        avg_satisfaction NUMERIC(5,2),
        first_contact_rate NUMERIC(5,2),
        open_tickets_count INTEGER DEFAULT 0,
        avg_open_tickets_ref NUMERIC(6,2),
        sat_score NUMERIC(6,2),
        vol_score NUMERIC(6,2),
        pos_score NUMERIC(6,2),
        comp_score NUMERIC(6,2),
        gaps_count INTEGER DEFAULT 0,
        breakdown TEXT,
        period_start DATE,
        period_end DATE,
        created_by TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `).catch(() => {});

    await activePool.query(`
      CREATE INDEX IF NOT EXISTS idx_perf_score_owner ON performance_score_history(owner_name, created_at DESC)
    `).catch(() => {});
  })();

  schemaInitPromises.set(key, initPromise);
  return initPromise;
}

function isRetryableConnectionError(err) {
  const msg = String(err?.message || '').toLowerCase();
  return (
    msg.includes('connection terminated') ||
    msg.includes('econnrefused') ||
    msg.includes('timeout') ||
    msg.includes('cannot use a pool after calling end on the pool')
  );
}

async function invalidatePoolByKey(key) {
  if (!key) return;
  const targetPool = pools.get(key);
  if (!targetPool) return;

  pools.delete(key);
  schemaInitPromises.delete(key);

  try {
    await targetPool.end();
  } catch (_) {
    // noop
  }
}

async function query(sql, params = []) {
  const { text, values } = convertParams(sql, params);

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const activePool = await createPoolIfNeeded();
    try {
      return await activePool.query(text, values);
    } catch (err) {
      lastError = err;

      if (attempt < 3 && !isClosing && isRetryableConnectionError(err)) {
        await invalidatePoolByKey(activePool.__poolKey);
        console.warn(`Query attempt ${attempt} failed, retrying in ${attempt * 1000}ms...`, err.message);
        await new Promise(resolve => setTimeout(resolve, attempt * 1000));
      } else {
        throw err;
      }
    }
  }
  throw lastError;
}

async function queryDatabase(databaseName, sql, params = []) {
  const base = getBootstrapConfig();
  // Bancos secundários (ex: movidesk_curadoria) podem não estar registrados no
  // PgBouncer. Nesses casos, usa DB_DIRECT_PORT (padrão 5432) para conexão direta
  // ao PostgreSQL, contornando o pooler sem afetar as conexões principais.
  const directPort = process.env.DB_DIRECT_PORT ? Number(process.env.DB_DIRECT_PORT) : 5432;
  const isMainDb = databaseName === base.database;
  const cfg = {
    ...base,
    database: databaseName,
    port: isMainDb ? base.port : directPort
  };
  const { text, values } = convertParams(sql, params);

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const activePool = await createPoolForConfig(cfg, false);
    try {
      return await activePool.query(text, values);
    } catch (err) {
      lastError = err;

      if (attempt < 3 && !isClosing && isRetryableConnectionError(err)) {
        await invalidatePoolByKey(activePool.__poolKey);
        await new Promise(resolve => setTimeout(resolve, attempt * 1000));
        continue;
      }

      throw err;
    }
  }

  throw lastError;
}

function get(sql, params, callback) {
  query(sql, params)
    .then((result) => {
      if (typeof callback === 'function') callback(null, result.rows[0] || undefined);
    })
    .catch((err) => {
      if (typeof callback === 'function') callback(err);
    });
}

function all(sql, params, callback) {
  query(sql, params)
    .then((result) => {
      if (typeof callback === 'function') callback(null, result.rows || []);
    })
    .catch((err) => {
      if (typeof callback === 'function') callback(err);
    });
}

function run(sql, params, callback) {
  query(sql, params)
    .then((result) => {
      if (typeof callback === 'function') {
        callback.call({ lastID: result.rows?.[0]?.id, changes: result.rowCount || 0 }, null);
      }
    })
    .catch((err) => {
      if (typeof callback === 'function') callback(err);
    });
}

async function close() {
  isClosing = true;
  const allPools = Array.from(pools.values());
  pools.clear();
  schemaInitPromises.clear();

  for (const pool of allPools) {
    try {
      await pool.end();
    } catch (_) {
      // noop
    }
  }
}

module.exports = { query, queryDatabase, get, all, run, close };
