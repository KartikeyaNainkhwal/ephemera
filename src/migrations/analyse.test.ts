import assert from 'node:assert/strict';
import { test } from 'node:test';

import { analyseSql, isMigrationPath, splitStatements } from './analyse.js';

const rulesOf = (sql: string) => analyseSql(sql).findings.map((f) => f.rule);

/* ── statement splitting ───────────────────────────────────────────────── */

test('splits on semicolons', () => {
  assert.equal(splitStatements('SELECT 1; SELECT 2;').length, 2);
});

test('a semicolon inside a string literal does not split', () => {
  const statements = splitStatements("INSERT INTO t VALUES ('a;b'); SELECT 1;");
  assert.equal(statements.length, 2);
  assert.ok(statements[0]!.includes("'a;b'"));
});

test('a dollar-quoted function body does not shatter', () => {
  const sql = `
    CREATE FUNCTION f() RETURNS void AS $$
    BEGIN
      PERFORM 1; PERFORM 2;
    END;
    $$ LANGUAGE plpgsql;
    SELECT 1;`;
  assert.equal(splitStatements(sql).length, 2);
});

test('comments are not treated as statements', () => {
  assert.equal(splitStatements('-- just a note\n/* and another */').length, 0);
});

test('a semicolon in a comment does not split', () => {
  assert.equal(splitStatements('SELECT 1 -- a; b\n;').length, 1);
});

/* ── the dangerous cases ───────────────────────────────────────────────── */

test('NOT NULL with no default is critical', () => {
  const result = analyseSql('ALTER TABLE users ADD COLUMN email text NOT NULL;');
  assert.ok(rulesOf('ALTER TABLE users ADD COLUMN email text NOT NULL;').includes('add-column-not-null-no-default'));
  assert.equal(result.findings[0]!.severity, 'critical');
  assert.equal(result.safe, false);
});

test('NOT NULL WITH a default is not flagged by that rule', () => {
  assert.ok(
    !rulesOf("ALTER TABLE users ADD COLUMN email text NOT NULL DEFAULT '';").includes(
      'add-column-not-null-no-default',
    ),
  );
});

test('CREATE INDEX without CONCURRENTLY is critical', () => {
  const findings = analyseSql('CREATE INDEX idx_users_email ON users (email);').findings;
  assert.equal(findings[0]!.rule, 'create-index-blocking');
  assert.equal(findings[0]!.lock, 'SHARE');
});

test('CREATE INDEX CONCURRENTLY is not flagged as blocking', () => {
  const rules = rulesOf('CREATE INDEX CONCURRENTLY idx ON users (email);');
  assert.ok(!rules.includes('create-index-blocking'));
  // ...but it is flagged for the transaction restriction.
  assert.ok(rules.includes('concurrently-in-transaction'));
});

test('a type change is critical', () => {
  assert.ok(rulesOf('ALTER TABLE users ALTER COLUMN id TYPE bigint;').includes('alter-column-type'));
});

test('a type change names the exceptions rather than guessing', () => {
  // The statement does not reveal the *old* type, so safety cannot be decided
  // from it. The rule must say that rather than claim either answer.
  const findings = analyseSql('ALTER TABLE users ALTER COLUMN name TYPE text;').findings;
  const typeFinding = findings.find((f) => f.rule === 'alter-column-type');
  assert.ok(typeFinding);
  assert.match(typeFinding!.detail, /metadata-only/i);
  assert.match(typeFinding!.detail, /does not state/i);
  assert.match(typeFinding!.summary, /text/);
});

test('SET NOT NULL warns about the full scan', () => {
  const findings = analyseSql('ALTER TABLE users ALTER COLUMN email SET NOT NULL;').findings;
  const f = findings.find((x) => x.rule === 'set-not-null');
  assert.ok(f);
  assert.equal(f!.lock, 'ACCESS EXCLUSIVE');
  assert.match(f!.remedy!, /NOT VALID/i);
});

test('a validating foreign key warns; NOT VALID does not', () => {
  assert.ok(
    rulesOf('ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users (id);')
      .includes('add-foreign-key-validating'),
  );
  assert.ok(
    !rulesOf(
      'ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users (id) NOT VALID;',
    ).includes('add-foreign-key-validating'),
  );
});

test('a volatile default rewrites the table', () => {
  assert.ok(
    rulesOf('ALTER TABLE users ADD COLUMN created_at timestamptz DEFAULT now();').includes(
      'add-column-volatile-default',
    ),
  );
});

test('a constant default is safe', () => {
  const rules = rulesOf("ALTER TABLE users ADD COLUMN status text DEFAULT 'active';");
  assert.ok(!rules.includes('add-column-volatile-default'));
  assert.ok(rules.includes('add-column-safe'));
});

/* ── breaking the running release ──────────────────────────────────────── */

test('dropping a column is flagged for the deployed release, not the lock', () => {
  const f = analyseSql('ALTER TABLE users DROP COLUMN legacy_email;').findings[0]!;
  assert.equal(f.rule, 'drop-column');
  assert.match(f.detail, /previous release/i);
});

test('renames are critical', () => {
  assert.ok(rulesOf('ALTER TABLE users RENAME COLUMN a TO b;').includes('rename'));
  assert.ok(rulesOf('ALTER TABLE users RENAME TO people;').includes('rename'));
});

/* ── data loss ─────────────────────────────────────────────────────────── */

test('destructive statements are critical', () => {
  assert.ok(rulesOf('DROP TABLE users;').includes('drop-table'));
  assert.ok(rulesOf('TRUNCATE users;').includes('truncate'));
  assert.ok(rulesOf('VACUUM FULL users;').includes('vacuum-full'));
});

test('an unbounded UPDATE warns; a bounded one does not', () => {
  assert.ok(rulesOf("UPDATE users SET status = 'x';").includes('unbounded-dml'));
  assert.ok(!rulesOf("UPDATE users SET status = 'x' WHERE id = 1;").includes('unbounded-dml'));
});

/* ── overall behaviour ─────────────────────────────────────────────────── */

test('a safe migration reports safe', () => {
  const result = analyseSql("ALTER TABLE users ADD COLUMN nickname text DEFAULT 'x';");
  assert.equal(result.safe, true);
  assert.ok(result.findings.every((f) => f.severity === 'info'));
});

test('findings carry the statement position and the sql', () => {
  const result = analyseSql('SELECT 1;\nDROP TABLE users;');
  const finding = result.findings.find((f) => f.rule === 'drop-table')!;
  assert.equal(finding.statement, 2);
  assert.match(finding.sql, /DROP TABLE users/i);
  assert.equal(result.statementCount, 2);
});

test('every finding is actionable — a severity above info carries a remedy', () => {
  const sql = `
    ALTER TABLE users ADD COLUMN a text NOT NULL;
    CREATE INDEX i ON users (a);
    ALTER TABLE users DROP COLUMN b;
    TRUNCATE logs;
    UPDATE users SET x = 1;`;
  const findings = analyseSql(sql).findings.filter((f) => f.severity !== 'info');
  assert.ok(findings.length >= 5);
  for (const finding of findings) {
    assert.ok(finding.remedy && finding.remedy.length > 0, `${finding.rule} has no remedy`);
    assert.ok(finding.detail.length > 0);
  }
});

test('an empty or comment-only file yields nothing', () => {
  assert.equal(analyseSql('').findings.length, 0);
  assert.equal(analyseSql('-- nothing here').statementCount, 0);
});

/* ── path detection ────────────────────────────────────────────────────── */

test('migration paths are recognised', () => {
  assert.equal(isMigrationPath('migrations/001_init.sql'), true);
  assert.equal(isMigrationPath('db/migrate/20260809_add.sql'), true);
  assert.equal(isMigrationPath('prisma/migrations/x/migration.sql'), true);
  assert.equal(isMigrationPath('src/index.ts'), false);
  assert.equal(isMigrationPath('README.md'), false);
  assert.equal(isMigrationPath('queries/report.sql'), false);
});

/* ── ADD CONSTRAINT is not ADD COLUMN ──────────────────────────────────── */

test('adding a constraint is never reported as adding a column', () => {
  // `COLUMN` is optional in the grammar, so a naive pattern matches any ADD.
  const cases = [
    'ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users (id);',
    'ALTER TABLE users ADD PRIMARY KEY (id);',
    'ALTER TABLE users ADD UNIQUE (email);',
    'ALTER TABLE users ADD CONSTRAINT c CHECK (email IS NOT NULL);',
  ];
  for (const sql of cases) {
    const rules = rulesOf(sql);
    assert.ok(!rules.includes('add-column-safe'), `${sql} → add-column-safe`);
    assert.ok(
      !rules.includes('add-column-not-null-no-default'),
      `${sql} → add-column-not-null-no-default`,
    );
  }
});

test('a genuine column addition is still detected, with or without COLUMN', () => {
  assert.ok(rulesOf('ALTER TABLE users ADD COLUMN nickname text;').includes('add-column-safe'));
  assert.ok(rulesOf('ALTER TABLE users ADD nickname text;').includes('add-column-safe'));
  assert.ok(
    rulesOf('ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname text;').includes('add-column-safe'),
  );
});
