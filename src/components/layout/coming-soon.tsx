import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Hammer } from "lucide-react";

export function ComingSoon({
  title,
  description,
  hint,
}: {
  title: string;
  description?: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col">
      <PageHeader title={title} description={description} />
      <div className="p-6">
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <div className="rounded-full bg-muted p-3 text-muted-foreground">
              <Hammer className="size-6" />
            </div>
            <h3 className="text-base font-semibold">Coming in a later phase</h3>
            <p className="max-w-md text-sm text-muted-foreground">
              {hint ?? "This screen is on the roadmap and will be built in an upcoming phase."}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
