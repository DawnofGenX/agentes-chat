import { sql } from "drizzle-orm";
import { bigint, boolean, check, integer, jsonb, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { MachineLoadRecord } from "./machines";

/**
 * The usage report's state for the whole installation (ADR 0060 §5): one row, made at the server's
 * first start. Not a tenant's, so no `org_id`.
 */
export const instanceTelemetry = pgTable(
  "instance_telemetry",
  {
    id: integer().primaryKey().default(1),
    /** Random, made once: the only id the report carries. */
    instanceId: uuid().notNull().defaultRandom(),
    /** The installation owner's switch in Settings; `TELEMETRY=off` wins over it. */
    enabled: boolean().notNull().default(true),
    /** When the server last started (the report's uptime). */
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** How busy the server's host got over the last day, as its last sample left it. */
    hostLoad: jsonb().$type<MachineLoadRecord>(),
    /** The last day's samples behind `hostLoad` (epoch ms), so a restarted server keeps its day. */
    hostSamples: jsonb().$type<{ at: number; load: number; memory: number }[]>(),
    /** When the next report is due; kept so a restart neither delays it nor sends it twice in a day. */
    nextReportAt: timestamp({ withTimezone: true }),
    /**
     * Who has the installation's own settings (this switch, the Jev key, ADR 0073): its first account, pinned so
     * the next oldest never inherits them. No foreign key: a deleted owner's id keeps matching nobody.
     */
    ownerUserId: text(),
    /**
     * Whether the router may pick who answers on a person's own Claude or ChatGPT plan (`router-plan.ts`): true only
     * on installations that already had a workspace when it became opt-in (migration 0304), false on new ones.
     */
    routerPlanFallback: boolean().notNull().default(false),
  },
  (t) => [check("instance_telemetry_one_row", sql`${t.id} = 1`)],
);

/**
 * Each server process's own vitals (the app's and every worker's), written by the process about once a minute and
 * read by the operator API (`GET /vitals`): one row per process start. Rows a process stopped writing a day ago go.
 * The installation's own, so no `org_id`.
 */
export const serverProcesses = pgTable("server_processes", {
  /** Made at the process's start. */
  id: uuid().primaryKey(),
  /** `SERVER_ROLE`: `all` or `worker`. */
  role: text().notNull(),
  version: text().notNull(),
  startedAt: timestamp({ withTimezone: true }).notNull(),
  seenAt: timestamp({ withTimezone: true }).notNull(),
  rssBytes: bigint({ mode: "number" }).notNull(),
  heapUsedBytes: bigint({ mode: "number" }).notNull(),
  heapTotalBytes: bigint({ mode: "number" }).notNull(),
  /** The event loop's delay over its last minute (`event-loop-lag.ts`); null before its first minute ended. */
  eventLoopP99Ms: real(),
  eventLoopMaxMs: real(),
  /** When it wrote its heap snapshot (`HEAP_SNAPSHOT_MB`), and the file's name; null: none. */
  heapSnapshotAt: timestamp({ withTimezone: true }),
  heapSnapshotFile: text(),
});
