import { describe, expect, it } from "vitest";
import { accountTileKind, merchantBrand } from "@/components/tiles";

describe("merchant recognition", () => {
  it("shares Amazon branding with Amazon Prime", () => {
    expect(merchantBrand("Amazon Prime")).toEqual(merchantBrand("Amazon"));
    expect(merchantBrand("Amazon")?.letter).toBe("a");
  });
  it("recognises sample merchant aliases", () => {
    expect(merchantBrand("Spotify Family")?.token).toBe("spotify");
    expect(merchantBrand("Jet2 Holidays · Tenerife Feb")?.token).toBe("jet2");
    expect(merchantBrand("Airbnb · Lisbon half-term")?.token).toBe("airbnb");
    expect(merchantBrand("iCloud+ 2TB")?.cloud).toBe(true);
    expect(merchantBrand("Microsoft 365 Family")?.token).toBe("microsoft");
  });
  it("keeps Bao Borough generated rather than assigning a brand", () => {
    expect(merchantBrand("Bao Borough")).toBeUndefined();
  });
});
describe("account recognition", () => {
  it("uses bank recognition for current accounts", () => {
    expect(accountTileKind("Monzo Current · Nikhila")).toBe("bank");
  });
  it("uses savings recognition for savings", () => {
    expect(accountTileKind("Revolut Savings")).toBe("savings");
  });
  it("uses shared-account recognition for joint accounts", () => {
    expect(accountTileKind("Joint Bills · Revolut")).toBe("joint");
  });
  it("uses card recognition for Amex and physical cards", () => {
    expect(accountTileKind("Amex Gold · Nikhila")).toBe("card");
    expect(accountTileKind("Physical")).toBe("card");
  });
  it("uses phone recognition for virtual cards", () => {
    expect(accountTileKind("Virtual ending 4412")).toBe("virtual");
  });
});
