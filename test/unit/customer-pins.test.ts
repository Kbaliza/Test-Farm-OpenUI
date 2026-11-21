import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
import { parsePin } from "@/lib/customer-pins";

// The link shapes the office has actually saved on customers (live, 26 Oct).
describe("parsePin", () => {
  it("reads ?q=lat%2Clng links", () => {
    expect(parsePin("https://maps.google.com/maps?q=33.6387697%2C72.9729199&z=17&hl=en")).toEqual({ lat: 33.6387697, lng: 72.9729199 });
    expect(parsePin("https://maps.google.com/?q=33.5508295,73.1348767")).toEqual({ lat: 33.5508295, lng: 73.1348767 });
  });

  it("prefers the pin (!3d!4d) over the map centre (@)", () => {
    const u = "https://www.google.com/maps/place/House+12/@33.5580000,73.1420000,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d33.5585669!4d73.1429286";
    expect(parsePin(u)).toEqual({ lat: 33.5585669, lng: 73.1429286 });
  });

  it("falls back to the @lat,lng centre", () => {
    expect(parsePin("https://www.google.com/maps/@33.5585669,73.1429286,18z")).toEqual({ lat: 33.5585669, lng: 73.1429286 });
  });

  it("reads degrees-minutes-seconds and bare coordinates", () => {
    const p = parsePin(`33°28'57.0"N 73°08'10.1"E`)!;
    expect(p.lat).toBeCloseTo(33.4825, 4);
    expect(p.lng).toBeCloseTo(73.13614, 4);
    expect(parsePin(" 33.6, 73.05 ")).toEqual({ lat: 33.6, lng: 73.05 });
  });

  it("refuses short links, text and coordinates outside Pakistan", () => {
    expect(parsePin("https://maps.app.goo.gl/AbCdEf123")).toBeNull();
    expect(parsePin("Street 4, house 12")).toBeNull();
    expect(parsePin("https://maps.google.com/?q=73.1,33.5")).toBeNull();
    expect(parsePin("")).toBeNull();
    expect(parsePin(null)).toBeNull();
  });
});
