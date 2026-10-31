import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { HubError } from './store.mjs';

const scrypt = promisify(scryptCallback);
const SCRYPT = { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 };
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const USERNAME = /^[a-z0-9][a-z0-9_.-]{2,39}$/;
const stamp = now => new Date(now()).toISOString();
const digest = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const authError = () => new HubError('Invalid username or password', 401, 'INVALID_CREDENTIALS');

class CryptoGate {
  active = 0;
  waiting = [];
  async run(fn) {
    if (this.active >= 2) {
      if (this.waiting.length >= 8) throw new HubError('Authentication busy', 503, 'AUTH_BUSY');
      await new Promise(resolve => this.waiting.push(resolve));
    } else this.active++;
    try { return await fn(); }
    finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

function usernameValue(value) {
  if (typeof value !== 'string' || !USERNAME.test(value.trim().toLowerCase()) || value.length > 40) {
    throw new HubError('Username must be 3–40 letters, numbers, dots, dashes or underscores', 400, 'INVALID_USERNAME');
  }
  return value.trim().toLowerCase();
}

function passwordValue(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128 || Buffer.byteLength(value, 'utf8') > 512) {
    throw new HubError('Password must be 12–128 characters', 400, 'INVALID_PASSWORD');
  }
  return value;
}

function sessionValue(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32,100}$/.test(value)) {
    throw new HubError('Authentication required', 401, 'UNAUTHORIZED');
  }
  return value;
}

function publicUser(row, owner) {
  return { id: row.id, username: row.username, tenantId: owner.tenant_id, createdAt: row.created_at };
}

export class AccountService {
  constructor(store, { now = Date.now, registrationEnabled = true } = {}) {
    this.store = store;
    this.now = now;
    this.registrationEnabled = registrationEnabled;
    this.gate = new CryptoGate();
    this.buckets = new Map();
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS account_users(
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        owner_subject_id TEXT NOT NULL UNIQUE REFERENCES subjects(id),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_sessions(
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES account_users(id),
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS account_sessions_user ON account_sessions(user_id);
    `);
  }

  limit(key, max, windowMs) {
    const now = this.now();
    if (this.buckets.size >= 10000) {
      for (const [name, bucket] of this.buckets) if (bucket.until <= now) this.buckets.delete(name);
      if (this.buckets.size >= 10000 && !this.buckets.has(key)) throw new HubError('Authentication busy', 503, 'AUTH_BUSY');
    }
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.until <= now) {
      this.buckets.set(key, { count: 1, until: now + windowMs });
      return;
    }
    if (++bucket.count > max) throw new HubError('Too many authentication attempts', 429, 'RATE_LIMIT');
  }

  async hashPassword(password, salt = randomBytes(16).toString('hex')) {
    const result = await this.gate.run(() => scrypt(password, Buffer.from(salt, 'hex'), 64, SCRYPT));
    return { salt, hash: result.toString('hex') };
  }

  async verifyPassword(password, row) {
    const computed = await this.hashPassword(password, row?.password_salt || '00000000000000000000000000000000');
    const expected = Buffer.from(row?.password_hash || '00'.repeat(64), 'hex');
    return Boolean(row && timingSafeEqual(Buffer.from(computed.hash, 'hex'), expected));
  }

  ownerFor(row) {
    const owner = this.store.db.prepare('SELECT * FROM subjects WHERE id=? AND role=? AND revoked_at IS NULL').get(row.owner_subject_id, 'owner');
    if (!owner) throw new HubError('Account owner unavailable', 401, 'UNAUTHORIZED');
    return owner;
  }

  issueSession(row) {
    const current = this.store.db.prepare('SELECT password_hash FROM account_users WHERE id=?').get(row.id);
    if (!current || current.password_hash !== row.password_hash) throw authError();
    const sessionToken = secret();
    const expires = this.now() + SESSION_MS;
    this.store.tx(() => {
      this.store.db.prepare('DELETE FROM account_sessions WHERE expires_at<=? OR revoked_at IS NOT NULL').run(this.now());
      this.store.db.prepare('INSERT INTO account_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
        .run(digest(sessionToken), row.id, expires, this.now());
      this.store.db.prepare(`
        DELETE FROM account_sessions WHERE user_id=? AND token_hash IN (
          SELECT token_hash FROM account_sessions WHERE user_id=?
          ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET 20
        )
      `).run(row.id, row.id);
    });
    return { user: publicUser(row, this.ownerFor(row)), sessionToken, expiresAt: new Date(expires).toISOString() };
  }

  async register({ username, password, source = 'unknown' }) {
    if (!this.registrationEnabled) throw new HubError('Registration is disabled', 403, 'REGISTRATION_DISABLED');
    this.limit(`register:${source}`, 5, 15 * 60_000);
    const name = usernameValue(username);
    passwordValue(password);
    if (this.store.db.prepare('SELECT 1 FROM account_users WHERE username=?').get(name)) {
      throw new HubError('Username unavailable', 409, 'USERNAME_UNAVAILABLE');
    }
    const encoded = await this.hashPassword(password);
    const userId = randomUUID();
    const ownerId = randomUUID();
    const tenantId = `account-${userId}`;
    let row;
    try {
      row = this.store.tx(() => {
        if (this.store.db.prepare('SELECT 1 FROM account_users WHERE username=?').get(name)) {
          throw new HubError('Username unavailable', 409, 'USERNAME_UNAVAILABLE');
        }
        this.store.db.prepare('INSERT INTO tenants(id,created_at) VALUES(?,?)').run(tenantId, stamp(this.now));
        // This owner is exclusively reached through account sessions. No bearer secret is written to disk.
        this.store.db.prepare('INSERT INTO subjects(id,tenant_id,role,token_hash,epoch,created_at) VALUES(?,?,?,?,?,?)')
          .run(ownerId, tenantId, 'owner', digest(secret()), 1, stamp(this.now));
        this.store.db.prepare('INSERT INTO account_users(id,username,password_salt,password_hash,owner_subject_id,created_at) VALUES(?,?,?,?,?,?)')
          .run(userId, name, encoded.salt, encoded.hash, ownerId, stamp(this.now));
        return this.store.db.prepare('SELECT * FROM account_users WHERE id=?').get(userId);
      });
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new HubError('Username unavailable', 409, 'USERNAME_UNAVAILABLE');
      throw error;
    }
    return this.issueSession(row);
  }

  async credentials(username, password, source = 'unknown') {
    this.limit(`login:source:${source}`, 30, 60_000);
    let name;
    try { name = usernameValue(username); } catch { throw authError(); }
    // Validate size before spending CPU. Invalid credentials have one public error.
    if (typeof password !== 'string' || password.length > 128 || Buffer.byteLength(password, 'utf8') > 512) throw authError();
    const failureKey=`login:user:${name}:source:${source}`;
    this.limit(failureKey, 12, 5 * 60_000);
    const row = this.store.db.prepare('SELECT * FROM account_users WHERE username=?').get(name);
    if (!(await this.verifyPassword(password, row))) throw authError();
    this.buckets.delete(failureKey);
    this.ownerFor(row);
    return row;
  }

  async login({ username, password, source = 'unknown' }) {
    return this.issueSession(await this.credentials(username, password, source));
  }

  authenticateSession(token) {
    const value = sessionValue(token);
    const row = this.store.db.prepare(`
      SELECT u.*,s.expires_at,s.revoked_at
      FROM account_sessions s JOIN account_users u ON u.id=s.user_id
      WHERE s.token_hash=?
    `).get(digest(value));
    if (!row || row.revoked_at != null || row.expires_at <= this.now()) {
      throw new HubError('Authentication required', 401, 'UNAUTHORIZED');
    }
    const subject = this.ownerFor(row);
    return { user: publicUser(row, subject), subject };
  }

  logout(token) {
    const value = sessionValue(token);
    this.store.db.prepare('UPDATE account_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL')
      .run(this.now(), digest(value));
  }

  async changePassword(userId, { currentPassword, newPassword }) {
    this.limit(`password:${userId}`, 5, 15 * 60_000);
    const row = this.store.db.prepare('SELECT * FROM account_users WHERE id=?').get(userId);
    if (!row || typeof currentPassword !== 'string' || currentPassword.length > 128 ||
      !(await this.verifyPassword(currentPassword, row))) throw authError();
    passwordValue(newPassword);
    const encoded = await this.hashPassword(newPassword);
    this.store.tx(() => {
      const updated = this.store.db.prepare('UPDATE account_users SET password_salt=?,password_hash=? WHERE id=? AND password_hash=?')
        .run(encoded.salt, encoded.hash, userId, row.password_hash);
      if (!updated.changes) throw authError();
      this.store.db.prepare('UPDATE account_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL')
        .run(this.now(), userId);
    });
    return { changed: true };
  }

  async claim(legacyOwner, { username, password, source = 'unknown' }) {
    if (!legacyOwner || legacyOwner.role !== 'owner' || legacyOwner.revoked_at) {
      throw new HubError('Owner role required', 403, 'FORBIDDEN');
    }
    this.limit(`claim:${source}`, 5, 15 * 60_000);
    const name = usernameValue(username);
    passwordValue(password);
    if (this.store.db.prepare('SELECT 1 FROM account_users WHERE username=?').get(name)) {
      throw new HubError('Username unavailable', 409, 'USERNAME_UNAVAILABLE');
    }
    const encoded = await this.hashPassword(password);
    const userId = randomUUID();
    const row = this.store.tx(() => {
      if (this.store.db.prepare(`
        SELECT 1 FROM account_users u JOIN subjects s ON s.id=u.owner_subject_id
        WHERE s.tenant_id=?
      `).get(legacyOwner.tenant_id)) {
        throw new HubError('Owner already linked to an account', 409, 'OWNER_LINKED');
      }
      if (this.store.db.prepare('SELECT 1 FROM account_users WHERE username=?').get(name)) {
        throw new HubError('Username unavailable', 409, 'USERNAME_UNAVAILABLE');
      }
      this.store.db.prepare('INSERT INTO account_users(id,username,password_salt,password_hash,owner_subject_id,created_at) VALUES(?,?,?,?,?,?)')
        .run(userId, name, encoded.salt, encoded.hash, legacyOwner.id, stamp(this.now));
      return this.store.db.prepare('SELECT * FROM account_users WHERE id=?').get(userId);
    });
    return this.issueSession(row);
  }

  async nodePairing({ username, password, projectIds, source = 'unknown' }) {
    const row = await this.credentials(username, password, source);
    const current = this.store.db.prepare('SELECT password_hash FROM account_users WHERE id=?').get(row.id);
    if (!current || current.password_hash !== row.password_hash) throw authError();
    // Existing node credentials are deliberately independent and remain valid after password rotation.
    return this.store.createPairing(this.ownerFor(row), { role: 'node', projectIds, ttlSeconds: 600 });
  }
}
