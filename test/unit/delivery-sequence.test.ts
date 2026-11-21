import { describe, it, expect } from "vitest";
import { resequence, sequenceChanges, type SequencedCustomer } from "@/lib/delivery-sequence";

const c = (id: string, seq: number | null, code = id.toUpperCase()): SequencedCustomer => ({
  id,
  deliverySequence: seq,
  customerCode: code,
});

const orderOf = (m: Map<string, number>) =>
  [...m.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);

describe("resequence — the saved order becomes the standing order", () => {
  it("numbers a full route exactly as it was left", () => {
    const all = [c("a", 1), c("b", 2), c("c", 3)];
    const out = resequence(["c", "a", "b"], all);
    expect(out.get("c")).toBe(1);
    expect(out.get("a")).toBe(2);
    expect(out.get("b")).toBe(3);
  });

  it("numbers a brand-new shift where nobody has a sequence yet", () => {
    const all = [c("a", null), c("b", null), c("c", null)];
    expect(orderOf(resequence(["b", "c", "a"], all))).toEqual(["b", "c", "a"]);
  });

  it("keeps an off-day customer in place instead of dumping them at the end", () => {
    // b is off today. The manager swaps a and c.
    const all = [c("a", 1), c("b", 2), c("c", 3)];
    const out = resequence(["c", "a"], all);
    // b sat between a(1) and c(3); one present customer (a, old 1) came before it.
    expect(orderOf(out)).toEqual(["c", "b", "a"]);
    expect(out.size).toBe(3);
  });

  it("keeps an absent first customer first", () => {
    const all = [c("z", 1), c("a", 2), c("b", 3)];
    const out = resequence(["b", "a"], all);
    expect(orderOf(out)).toEqual(["z", "b", "a"]);
  });

  it("sends never-sequenced absentees to the end, in code order", () => {
    const all = [c("a", 1), c("b", 2), c("x", null, "X1"), c("y", null, "Y1")];
    const out = resequence(["b", "a"], all);
    expect(orderOf(out)).toEqual(["b", "a", "x", "y"]);
  });

  it("ignores a stop belonging to another shift's customer", () => {
    // "guest" came in via a one-day order and is not in this shift.
    const all = [c("a", 1), c("b", 2)];
    const out = resequence(["guest", "b", "a"], all);
    expect(out.has("guest")).toBe(false);
    expect(orderOf(out)).toEqual(["b", "a"]);
  });

  it("gives every customer a distinct number, with no gaps", () => {
    const all = [c("a", 5), c("b", null), c("c", 2), c("d", 9)];
    const out = resequence(["d", "c"], all);
    const nums = [...out.values()].sort((x, y) => x - y);
    expect(nums).toEqual([1, 2, 3, 4]);
    expect(new Set(nums).size).toBe(4);
  });

  it("handles an empty route without touching anyone's order", () => {
    const all = [c("a", 1), c("b", 2)];
    expect(orderOf(resequence([], all))).toEqual(["a", "b"]);
  });

  it("handles an empty shift", () => {
    expect(resequence(["a"], []).size).toBe(0);
  });

  it("is stable — saving the same order twice changes nothing the second time", () => {
    const all = [c("a", 1), c("b", 2), c("c", 3)];
    const first = resequence(["c", "a", "b"], all);
    const after: SequencedCustomer[] = all.map((x) => ({ ...x, deliverySequence: first.get(x.id)! }));
    const second = resequence(["c", "a", "b"], after);
    expect(orderOf(second)).toEqual(orderOf(first));
    expect(sequenceChanges(second, after)).toEqual([]);
  });
});

describe("sequenceChanges — only what actually moved", () => {
  it("writes nothing when the order is unchanged", () => {
    const all = [c("a", 1), c("b", 2)];
    expect(sequenceChanges(resequence(["a", "b"], all), all)).toEqual([]);
  });

  it("returns just the rows that moved", () => {
    const all = [c("a", 1), c("b", 2), c("c", 3)];
    const changes = sequenceChanges(resequence(["a", "c", "b"], all), all);
    expect(changes.map((x) => x.id).sort()).toEqual(["b", "c"]);
  });

  it("fills in customers who never had a sequence", () => {
    const all = [c("a", null), c("b", null)];
    const changes = sequenceChanges(resequence(["a", "b"], all), all);
    expect(changes).toEqual([
      { id: "a", deliverySequence: 1 },
      { id: "b", deliverySequence: 2 },
    ]);
  });
});

describe("a shift where nobody has a sequence yet — the fresh-system case", () => {
  it("puts absent customers after the route, not in front of it", () => {
    const all = [c("a", null), c("b", null), c("off", null), c("d", null)];
    // 'off' is not on today's route; the manager moves d to the front.
    const out = resequence(["d", "a", "b"], all);
    expect(orderOf(out)).toEqual(["d", "a", "b", "off"]);
    expect(out.get("off")).toBe(4);
  });

  it("keeps an anchored absentee ahead of unsequenced present customers", () => {
    // 'first' has a real sequence; the rest have none.
    const all = [c("first", 1), c("a", null), c("b", null)];
    const out = resequence(["b", "a"], all);
    expect(orderOf(out)).toEqual(["first", "b", "a"]);
  });

  it("mixes anchored and unanchored absentees correctly", () => {
    const all = [c("a", 1), c("mid", 2), c("b", 3), c("new", null, "N1")];
    const out = resequence(["b", "a"], all);
    // mid keeps its place between the two present customers; new trails.
    expect(orderOf(out)).toEqual(["b", "mid", "a", "new"]);
  });
});

describe("an unsequenced shift still anchors absentees by their current order", () => {
  it("an off-day customer in the middle is not dumped at the end", () => {
    // Nobody has a sequence, so the current order is by code: A, B, C(off), D.
    const all = [c("a", null, "A"), c("b", null, "B"), c("off", null, "C"), c("d", null, "D")];
    const out = resequence(["d", "a", "b"], all); // 'off' is not on today's route
    // Two customers (a, b) used to come before 'off', so it drops back in after
    // the first two of the saved route — mid-round, not last.
    expect(orderOf(out)).toEqual(["d", "a", "off", "b"]);
    expect(out.get("off")).toBe(3);
  });

  it("an off-day customer that used to come first still comes first", () => {
    const all = [c("off", null, "A1"), c("a", null, "B1"), c("b", null, "C1")];
    const out = resequence(["b", "a"], all);
    expect(orderOf(out)).toEqual(["off", "b", "a"]);
  });
});
