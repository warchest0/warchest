import { describe, expect, it } from "vitest";
import {
  cmpDecimals,
  decimalToUsd6,
  divDecimals,
  formatDecimal,
  mulBps,
  roundDecimals,
  roundPrice,
  roundSize,
  truncateDecimals,
  usd6ToDecimal,
} from "../src/hyperliquid/rounding.js";

describe("decimal helpers", () => {
  it("formats mantissa/exponent without trailing zeros", () => {
    expect(formatDecimal(123400n, -4)).toBe("12.34");
    expect(formatDecimal(5n, -3)).toBe("0.005");
    expect(formatDecimal(0n, -3)).toBe("0");
    expect(formatDecimal(12n, 2)).toBe("1200");
  });
  it("truncates and rounds", () => {
    expect(truncateDecimals("1.23456", 2)).toBe("1.23");
    expect(roundDecimals("1.23456", 2, "up")).toBe("1.24");
    expect(roundDecimals("1.23", 4, "up")).toBe("1.23");
    expect(roundDecimals("1.2300", 2, "up")).toBe("1.23");
  });
  it("multiplies by bps and divides exactly", () => {
    expect(mulBps("100", 10_050)).toBe("100.5");
    expect(mulBps("2692.85", 9_500)).toBe("2558.2075");
    expect(divDecimals("300", "2692.85", 6)).toBe("0.111406");
    expect(cmpDecimals("1.5", "1.50")).toBe(0);
    expect(cmpDecimals("0.9", "1")).toBe(-1);
    expect(cmpDecimals("10", "9.999")).toBe(1);
  });
  it("converts USDC 6-decimals", () => {
    expect(usd6ToDecimal(123_456_789n)).toBe("123.456789");
    expect(decimalToUsd6("99.5")).toBe(99_500_000n);
    expect(decimalToUsd6("-3.1234567")).toBe(3_123_456n);
    expect(decimalToUsd6("0")).toBe(0n);
  });
});

describe("Hyperliquid tick/lot rules", () => {
  it("keeps at most 5 significant figures unless the price is an integer", () => {
    expect(roundPrice("84295.5", 5, "up")).toBe("84296");
    expect(roundPrice("84295.5", 5, "down")).toBe("84295");
    expect(roundPrice("2692.85", 4, "down")).toBe("2692.8");
    expect(roundPrice("2692.85", 4, "up")).toBe("2692.9");
    expect(roundPrice("123456.7", 5, "down")).toBe("123456");
    expect(roundPrice("0.0123456", 0, "down")).toBe("0.012345");
  });
  it("caps decimals at 6 − szDecimals", () => {
    expect(roundPrice("0.123456789", 0, "down")).toBe("0.12345");
    expect(roundPrice("1.23456789", 2, "down")).toBe("1.2345");
    expect(roundPrice("120.145", 2, "up")).toBe("120.15");
  });
  it("truncates sizes to szDecimals", () => {
    expect(roundSize("0.1114049", 4)).toBe("0.1114");
    expect(roundSize("1.999999", 2)).toBe("1.99");
    expect(roundSize("3", 5)).toBe("3");
  });
});
