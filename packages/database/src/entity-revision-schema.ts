import type { DatabaseSync } from "node:sqlite";
import {
  maximumEntityRevision,
  readRevisionClock,
  revisionStoreFailure,
} from "./entity-revision-state.ts";

const entities = [
  { table: "products", kind: "product" },
  { table: "inventory_items", kind: "inventory_item" },
] as const;

/**
 * Installs and backfills revision metadata once, then verifies it on every reopen.
 *
 * @param database - Open connection after all preserving business migrations.
 * @returns Nothing after atomic installation; partial existing metadata is rejected.
 */
export function applyEntityRevisionSchema(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    if (!hasInstalledMetadata(database)) {
      createMetadata(database);
      backfillMetadata(database);
    }
    validateMetadata(database);
    installTriggers(database);
    database.exec("COMMIT");
  } catch {
    database.exec("ROLLBACK");
    throw revisionStoreFailure();
  }
}

/**
 * Rejects damaged installed metadata before any older migration can run its triggers.
 *
 * @param database - Newly opened connection before schema migration begins.
 * @returns Nothing for intact metadata or a pre-revision database; never repairs state.
 */
export function validateExistingEntityRevisionSchema(database: DatabaseSync): void {
  database.exec("BEGIN");
  try {
    if (hasInstalledMetadata(database)) {
      validateMetadata(database);
    }
    database.exec("COMMIT");
  } catch {
    database.exec("ROLLBACK");
    throw revisionStoreFailure();
  }
}

function hasInstalledMetadata(database: DatabaseSync): boolean {
  const tables = database.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('revision_clock', 'entity_revisions')",
  ).all();
  const triggers = database.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND (name LIKE 'entity_revision_%' OR name = 'revision_clock_monotonic')",
  ).all();
  if (tables.length === 0 && triggers.length === 0) {
    return false;
  }
  if (
    tables.length !== 2 || triggers.length !== 7 ||
    !triggers.some((trigger) => trigger.name === "revision_clock_monotonic") ||
    !entities.every((entity) => ["insert", "update", "delete"].every((event) =>
      triggers.some((trigger) => trigger.name === `entity_revision_${entity.kind}_${event}`),
    ))
  ) {
    throw revisionStoreFailure();
  }
  return true;
}

function createMetadata(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE revision_clock (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      high_water INTEGER NOT NULL CHECK (high_water >= 0 AND high_water <= ${maximumEntityRevision})
    ) STRICT;
    CREATE TABLE entity_revisions (
      entity_kind TEXT NOT NULL CHECK (entity_kind IN ('product', 'inventory_item')),
      entity_id TEXT NOT NULL,
      revision INTEGER NOT NULL UNIQUE CHECK (revision >= 1 AND revision <= ${maximumEntityRevision}),
      PRIMARY KEY (entity_kind, entity_id)
    ) STRICT;
    INSERT INTO revision_clock (singleton, high_water) VALUES (1, 0);
  `);
}

function backfillMetadata(database: DatabaseSync): void {
  for (const entity of entities) {
    database.exec(`
      INSERT INTO entity_revisions (entity_kind, entity_id, revision)
      SELECT '${entity.kind}', id,
        (SELECT high_water FROM revision_clock WHERE singleton = 1) + ROW_NUMBER() OVER (ORDER BY id)
      FROM ${entity.table};
      UPDATE revision_clock SET high_water = (
        SELECT COALESCE(MAX(revision), 0) FROM entity_revisions
      ) WHERE singleton = 1;
    `);
  }
}

function validateMetadata(database: DatabaseSync): void {
  const highWater = readRevisionClock(database, true);
  const invalid = database.prepare(`
    SELECT 1 FROM entity_revisions
    WHERE typeof(revision) != 'integer' OR revision < 1 OR revision > ?
      OR entity_kind NOT IN ('product', 'inventory_item') OR entity_id IS NULL
    UNION ALL
    SELECT 1 FROM entity_revisions GROUP BY revision HAVING COUNT(*) > 1
    UNION ALL
    SELECT 1 FROM entity_revisions GROUP BY entity_kind, entity_id HAVING COUNT(*) > 1
    LIMIT 1
  `).get(highWater);
  if (invalid !== undefined) {
    throw revisionStoreFailure();
  }
  for (const entity of entities) {
    const mismatch = database.prepare(`
      SELECT 1 FROM ${entity.table} AS entity
      LEFT JOIN entity_revisions AS metadata
        ON metadata.entity_kind = '${entity.kind}' AND metadata.entity_id = entity.id
      WHERE metadata.revision IS NULL
      UNION ALL
      SELECT 1 FROM entity_revisions AS metadata
      LEFT JOIN ${entity.table} AS entity ON metadata.entity_id = entity.id
      WHERE metadata.entity_kind = '${entity.kind}' AND entity.id IS NULL
      LIMIT 1
    `).get();
    if (mismatch !== undefined) {
      throw revisionStoreFailure();
    }
  }
}

function installTriggers(database: DatabaseSync): void {
  database.exec(`
    DROP TRIGGER IF EXISTS revision_clock_monotonic;
    CREATE TRIGGER revision_clock_monotonic BEFORE UPDATE ON revision_clock
    WHEN NEW.singleton IS NOT OLD.singleton OR NEW.high_water < OLD.high_water
    BEGIN SELECT RAISE(ABORT, 'REVISION_STORE_FAILURE'); END;
  `);
  for (const entity of entities) {
    // Introspection includes legacy SQL-visible columns and any preserving additions.
    const columns = database.prepare(`PRAGMA table_info(${entity.table})`).all();
    const changes = columns.map((column) => {
      if (typeof column.name !== "string") {
        throw revisionStoreFailure();
      }
      const name = `"${column.name.replaceAll('"', '""')}"`;
      return `OLD.${name} IS NOT NEW.${name}`;
    }).join(" OR ");
    const prefix = `entity_revision_${entity.kind}`;
    database.exec(`
      DROP TRIGGER IF EXISTS ${prefix}_insert;
      DROP TRIGGER IF EXISTS ${prefix}_update;
      DROP TRIGGER IF EXISTS ${prefix}_delete;
      CREATE TRIGGER ${prefix}_insert AFTER INSERT ON ${entity.table}
      BEGIN
        ${clockGuard()}
        ${advanceRevision(entity.kind)}
      END;
      CREATE TRIGGER ${prefix}_update AFTER UPDATE ON ${entity.table}
      WHEN ${changes}
      BEGIN
        ${clockGuard()}
        ${existingRevisionGuard(entity.kind)}
        DELETE FROM entity_revisions
          WHERE entity_kind = '${entity.kind}' AND entity_id = OLD.id AND OLD.id IS NOT NEW.id;
        ${advanceRevision(entity.kind)}
      END;
      CREATE TRIGGER ${prefix}_delete AFTER DELETE ON ${entity.table}
      BEGIN
        ${clockGuard()}
        ${existingRevisionGuard(entity.kind)}
        DELETE FROM entity_revisions WHERE entity_kind = '${entity.kind}' AND entity_id = OLD.id;
      END;
    `);
  }
}

function clockGuard(): string {
  return `SELECT CASE WHEN
    (SELECT COUNT(*) FROM revision_clock) != 1 OR
    NOT EXISTS (SELECT 1 FROM revision_clock WHERE singleton = 1
      AND typeof(high_water) = 'integer' AND high_water >= 0 AND high_water < ${maximumEntityRevision}
      AND high_water >= (SELECT COALESCE(MAX(revision), 0) FROM entity_revisions))
    THEN RAISE(ABORT, 'REVISION_STORE_FAILURE') END;`;
}

function existingRevisionGuard(kind: string): string {
  return `SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM entity_revisions WHERE entity_kind = '${kind}' AND entity_id = OLD.id
      AND typeof(revision) = 'integer' AND revision >= 1
      AND revision <= (SELECT high_water FROM revision_clock WHERE singleton = 1)
  ) THEN RAISE(ABORT, 'REVISION_STORE_FAILURE') END;`;
}

function advanceRevision(kind: string): string {
  return `UPDATE revision_clock SET high_water = high_water + 1 WHERE singleton = 1;
    INSERT INTO entity_revisions (entity_kind, entity_id, revision)
    VALUES ('${kind}', NEW.id, (SELECT high_water FROM revision_clock WHERE singleton = 1))
    ON CONFLICT (entity_kind, entity_id) DO UPDATE SET revision = excluded.revision;`;
}
