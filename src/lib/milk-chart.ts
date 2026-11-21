// Shapes and constants for the dashboard's Milk Inventory & Sales card. Kept out
// of the "use server" actions file, which may only export async functions.

/** Milk bought in over the counter — its own stack, not a real product id. */
export const OUTSOURCED_KEY = "__outsourced__";

export type MilkChartDay = {
  /** "YYYY-MM-DD" */
  date: string;
  inventory: Record<string, number>;
  sales: Record<string, number>;
  inventoryTotal: number;
  salesTotal: number;
};

export type MilkChartData = {
  from: string;
  to: string;
  days: MilkChartDay[];
  types: { id: string; name: string; totalL: number }[];
  totals: {
    arrived: number;
    outsourced: number;
    inventory: number; // arrived + outsourced
    sales: number;     // delivered, net of customer returns
    wastage: number;
    net: number;       // inventory − sales − wastage
  };
};
