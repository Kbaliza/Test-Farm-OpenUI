// Which Customers tab to open when something links to ONE customer.
//
// The Customers page splits customers across three tabs by status: active, on
// call, and lost. So a link that just says "/customers" lands on the active tab,
// and a customer who is on call or has been marked lost is nowhere to be seen —
// which is exactly how a sample that HAD been converted looked as though the
// conversion never happened.
//
// Given a customer id, this finds which tab actually holds them and returns that
// tab plus their code to narrow the list with. It reads the lists the page has
// already loaded, so it costs no extra query, and it keeps working if the
// customer's status changes later — nothing here hard-codes a status.
//
// Pure on purpose: the rule is testable without a database or a rendered page.

export type CustomerTab = "all" | "oncall" | "lost";

type Listed = { id: string; customerCode: string };

export type CustomerFocus = {
  /** The tab to open. Falls back to the caller's tab when there is nothing to find. */
  tab: CustomerTab;
  /** Pre-fill for the tab's search box — empty when not focusing anyone. */
  search: string;
};

export function resolveCustomerFocus(
  findId: string | undefined | null,
  lists: { all: Listed[]; onCall: Listed[]; lost: Listed[] },
  fallbackTab: CustomerTab
): CustomerFocus {
  if (!findId) return { tab: fallbackTab, search: "" };

  const inAll = lists.all.find((c) => c.id === findId);
  if (inAll) return { tab: "all", search: inAll.customerCode };

  const inOnCall = lists.onCall.find((c) => c.id === findId);
  if (inOnCall) return { tab: "oncall", search: inOnCall.customerCode };

  const inLost = lists.lost.find((c) => c.id === findId);
  if (inLost) return { tab: "lost", search: inLost.customerCode };

  // A customer who has since been deleted, or an id someone typed. Show the
  // ordinary list rather than an empty one filtered by a code that matches nothing.
  return { tab: fallbackTab, search: "" };
}
