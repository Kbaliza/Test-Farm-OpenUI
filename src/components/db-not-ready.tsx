import { Database } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

export function DbNotReady({ what = "this screen" }: { what?: string }) {
  return (
    <Card className="m-6 border-dashed">
      <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
        <div className="rounded-full bg-amber-100 p-3 text-amber-700">
          <Database className="size-6" />
        </div>
        <h3 className="text-base font-semibold">Database not connected</h3>
        <p className="max-w-md text-sm text-muted-foreground">
          {what} needs a working Postgres connection. Set{" "}
          <code className="rounded bg-muted px-1 py-0.5">DATABASE_URL</code> in{" "}
          <code className="rounded bg-muted px-1 py-0.5">.env</code>, then run{" "}
          <code className="rounded bg-muted px-1 py-0.5">npm run db:push</code>{" "}
          and{" "}
          <code className="rounded bg-muted px-1 py-0.5">npm run db:seed</code>.
        </p>
      </CardContent>
    </Card>
  );
}
