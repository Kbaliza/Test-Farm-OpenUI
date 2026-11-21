import { PrismaClient, Prisma } from "@prisma/client";
import { AsyncLocalStorage } from "node:async_hooks";
import { PRISMA_TRANSACTION_OPTIONS } from "./prisma-options";
import { currentAuditActor } from "./audit-actor-resolve";

declare global {
   
  var __prisma: PrismaClient | undefined;
}

/**
 * Whether we are already inside a transaction. Without it, a write issued on a
 * `tx` client would come back through the hook below and try to open a second
 * transaction inside the first, which Postgres refuses.
 */
const inTransaction = new AsyncLocalStorage<true>();

/** Every operation that changes something. Reads are left alone entirely. */
const WRITES = new Set([
  "create", "createMany", "createManyAndReturn",
  "update", "updateMany", "upsert",
  "delete", "deleteMany",
]);

/**
 * The client, with the audit actor attached to every write.
 *
 * The database records WHAT changed (see supabase/audit-log.sql); this puts WHO
 * on the wire so the trigger can read it. It must be set transaction-locally:
 * the runtime talks through the transaction pooler, where a connection is handed
 * to another request the moment a transaction ends, so a session-level setting
 * would sign Sana's edit with Ali's name.
 *
 * Exported as a factory because the test harness builds its own client — if it
 * built a bare one, every test would run unaudited and the suite would prove
 * nothing about the thing it is testing.
 */
export function makePrismaClient() {
  const base = new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
    transactionOptions: PRISMA_TRANSACTION_OPTIONS,
  });

  // Who is acting is resolved BEFORE this is called — see audit-actor-resolve for
  // why reading the request-scoped holder alone lost the name on every Save. Kept
  // synchronous on purpose: it must hand back the lazy statement, not run it. An
  // async function would await the PrismaPromise it returns and execute it on its
  // own, outside the transaction it is meant to open.
  const actorSql = (a: Awaited<ReturnType<typeof currentAuditActor>>) => {
    return base.$executeRaw`select
      set_config('app.actor_id', ${a?.id ?? ""}, true),
      set_config('app.actor_name', ${a?.name ?? ""}, true),
      set_config('app.actor_role', ${a?.role ?? ""}, true)`;
  };

  return base.$extends({
    client: {
      $transaction(...args: unknown[]) {
        // The batched form cannot work on this client, so it is refused rather
        // than left to hang.
        //
        // `db.model.create(...)` on a client carrying a `query` extension does
        // not return a lazy PrismaPromise — the hook below runs immediately and
        // hands back an ordinary promise, so by the time an array of them
        // reaches here every statement has ALREADY been sent, each in a
        // one-statement transaction of its own. Prisma's batch API is then
        // given plain promises it cannot orchestrate and never settles.
        //
        // The damage that caused was quiet: the rows committed, so the data was
        // there on the next page load, while `await db.$transaction([...])`
        // never returned and the save button sat on "Saving..." for ever. It
        // also meant the statements were NOT atomic, which for the money paths
        // (expenses, recovery) matters more than the stuck button did.
        //
        // The interactive form below is the supported one: it sets the actor on
        // the real transaction client and runs every statement inside it.
        //
        // Rejected rather than thrown synchronously: $transaction returns a
        // promise, so a caller that only attaches .catch() would otherwise take
        // the error as an uncaught throw at the call site.
        if (Array.isArray(args[0])) {
          return Promise.reject(
            new Error(
              "db.$transaction([...]) is not supported on this client — the audit actor " +
                "extension makes each operation run immediately and on its own, so the batch " +
                "is neither atomic nor able to settle. Use db.$transaction(async (tx) => …) " +
                "and issue the writes on `tx`.",
            ),
          );
        }
        // The interactive form: one extra round trip per transaction, which is
        // the price of a pooled connection that cannot hold the setting itself.
        const fn = args[0] as (tx: Prisma.TransactionClient) => Promise<unknown>;
        return (base.$transaction as (f: typeof fn, o?: unknown) => Promise<unknown>)(
          async (tx) => {
            const a = await currentAuditActor();
            await tx.$executeRaw`select
              set_config('app.actor_id', ${a?.id ?? ""}, true),
              set_config('app.actor_name', ${a?.name ?? ""}, true),
              set_config('app.actor_role', ${a?.role ?? ""}, true)`;
            return inTransaction.run(true, () => fn(tx));
          },
          args[1],
        );
      },
    },
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (inTransaction.getStore() || !WRITES.has(operation)) return query(args);
          // A write on its own becomes a one-statement transaction carrying the
          // actor. Batched, so it is still a single round trip.
          //
          // The operation is re-issued on the UNEXTENDED client: re-issuing it
          // on the extended one would arrive back here for ever.
          const model_ = (base as unknown as Record<string, Record<string, (a: unknown) => Prisma.PrismaPromise<unknown>>>)[
            model.charAt(0).toLowerCase() + model.slice(1)
          ];
          const op = model_[operation](args);
          const actor = await currentAuditActor();
          const [, result] = await base.$transaction([actorSql(actor), op]);
          return result;
        },
      },
    },
  });
}

/**
 * Typed as a plain PrismaClient on purpose.
 *
 * The extension adds no methods and changes no signature — it only puts the
 * actor on the wire — but `$extends` rewrites the client's type, and every
 * helper in the codebase that takes a `Prisma.TransactionClient` would stop
 * type-checking against it. Keeping the public type still is what makes this
 * change invisible to the other 300 write sites.
 */
export const db: PrismaClient =
  globalThis.__prisma ?? (makePrismaClient() as unknown as PrismaClient);

if (process.env.NODE_ENV !== "production") {
  globalThis.__prisma = db;
}
