import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CountUpMoney } from "@/components/motion";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("First-view money counts", () => {
  it("finishes the £12,100 household income count in 600ms and does not restart for a person change", () => {
    let callback: FrameRequestCallback | undefined;
    const request = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb) => {
        callback = cb;
        return 1;
      });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const { container, rerender } = render(<CountUpMoney value={12100} />);
    act(() => callback?.(0));
    expect(container.querySelector(".motion-number")?.textContent).toBe("£0");
    act(() => callback?.(600));
    expect(container.querySelector(".motion-number")?.textContent).toBe(
      "£12,100",
    );
    const calls = request.mock.calls.length;
    rerender(<CountUpMoney value={7240} />);
    expect(container.querySelector(".motion-number")?.textContent).toBe(
      "£7,240",
    );
    expect(request).toHaveBeenCalledTimes(calls);
  });

  it("skips count animation entirely under reduced motion", () => {
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    const request = vi.spyOn(window, "requestAnimationFrame");
    const { container } = render(<CountUpMoney value={12100} />);
    expect(container.querySelector(".motion-number")?.textContent).toBe(
      "£12,100",
    );
    expect(request).not.toHaveBeenCalled();
  });
});
