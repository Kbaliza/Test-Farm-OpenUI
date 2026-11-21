import { describe, it, expect } from "vitest";
import { resolveCustomerFocus } from "@/lib/customer-focus";

// The Customers page splits customers across three tabs by status. A link to one
// customer has to open the tab that actually holds them — a link that assumed the
// active tab is how a converted sample's customer looked as though it had never
// been created.

const lists = {
  all:    [{ id: "a1", customerCode: "C-0001" }, { id: "a2", customerCode: "C-0002" }],
  onCall: [{ id: "o1", customerCode: "C-0100" }],
  lost:   [{ id: "l1", customerCode: "C-0532" }],
};

describe("opening the tab that actually holds the customer", () => {
  it("finds an active customer", () => {
    expect(resolveCustomerFocus("a2", lists, "all")).toEqual({ tab: "all", search: "C-0002" });
  });

  it("switches to On Call for an on-call customer", () => {
    expect(resolveCustomerFocus("o1", lists, "all")).toEqual({ tab: "oncall", search: "C-0100" });
  });

  it("switches to Lost for a deactivated customer — the case that was broken", () => {
    expect(resolveCustomerFocus("l1", lists, "all")).toEqual({ tab: "lost", search: "C-0532" });
  });

  it("overrides an explicitly requested tab, so the link always lands on them", () => {
    // ?tab=all&find=<a lost customer> must still show the customer.
    expect(resolveCustomerFocus("l1", lists, "all").tab).toBe("lost");
    expect(resolveCustomerFocus("a1", lists, "lost").tab).toBe("all");
  });
});

describe("when there is nobody to focus", () => {
  it("leaves the requested tab alone with no search", () => {
    expect(resolveCustomerFocus(undefined, lists, "lost")).toEqual({ tab: "lost", search: "" });
    expect(resolveCustomerFocus("", lists, "oncall")).toEqual({ tab: "oncall", search: "" });
    expect(resolveCustomerFocus(null, lists, "all")).toEqual({ tab: "all", search: "" });
  });

  it("an unknown id shows the ordinary list, not an empty filtered one", () => {
    // A deleted customer, or an id someone typed. Filtering by a code that matches
    // nothing would look like the page was broken.
    expect(resolveCustomerFocus("gone", lists, "all")).toEqual({ tab: "all", search: "" });
  });

  it("copes with empty tabs", () => {
    const empty = { all: [], onCall: [], lost: [] };
    expect(resolveCustomerFocus("a1", empty, "all")).toEqual({ tab: "all", search: "" });
  });
});
