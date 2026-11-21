import { Skeleton } from "@/components/ui/skeleton";

export default function PageLoader() {
  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-4 sm:px-6 sm:py-5">
        <div className="space-y-2">
          <Skeleton className="h-6 w-44" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-8 w-28 rounded-full" />
      </div>

      {/* Content */}
      <div className="space-y-4 p-4 sm:p-6">
        {/* Stat tiles row */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="hidden h-24 rounded-xl sm:block" />
        </div>

        {/* Main content block */}
        <Skeleton className="h-56 rounded-xl" />

        {/* Secondary block */}
        <Skeleton className="h-40 rounded-xl" />
      </div>
    </div>
  );
}
