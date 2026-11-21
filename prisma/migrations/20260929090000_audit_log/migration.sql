-- The audit log: every add, edit and delete, with who did it and what changed.
--
-- Deliberately WITHOUT a foreign key to "User". A user who owns no records is
-- hard-deleted by the Users page, and an audit trail that loses its actor when
-- the actor is removed is not a trail. actorName/actorRole are snapshots for the
-- same reason. Do not "fix" this by adding a relation.
--
-- The trigger that fills this table, the one that makes it append-only, and the
-- prune function all live in supabase/audit-log.sql — trigger DDL is outside the
-- migration chain in this project (see DEPLOY.md).
CREATE TABLE "AuditLog" (
    "id"            TEXT NOT NULL,
    "tableName"     TEXT NOT NULL,
    "rowId"         TEXT,
    "operation"     TEXT NOT NULL,
    "before"        JSONB,
    "after"         JSONB,
    "changedFields" TEXT[] NOT NULL DEFAULT '{}',
    "actorId"       TEXT,
    "actorName"     TEXT,
    "actorRole"     TEXT,
    "actorSource"   TEXT NOT NULL DEFAULT 'unknown',
    "at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- The page reads newest-first, filtered by table, by actor, or by one row's history.
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at" DESC);
CREATE INDEX "AuditLog_tableName_at_idx" ON "AuditLog"("tableName", "at" DESC);
CREATE INDEX "AuditLog_actorId_at_idx" ON "AuditLog"("actorId", "at" DESC);
CREATE INDEX "AuditLog_tableName_rowId_at_idx" ON "AuditLog"("tableName", "rowId", "at" DESC);
