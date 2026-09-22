import { afterEach, describe, expect, it, vi } from "vitest";
import { captureToken, createApi, tokenFromHash } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("local dashboard API boundary", () => {
  it("extracts encoded tokens from the fragment without accepting blank values", () => {
    expect(tokenFromHash("#token=a%2Bb%3Dc")).toBe("a+b=c");
    expect(tokenFromHash("#token=")).toBeNull();
    expect(tokenFromHash("#view=runs")).toBeNull();
  });

  it("moves a token into session storage and clears it from the address bar", () => {
    const replaceState = vi.fn();
    const setItem = vi.fn();
    vi.stubGlobal("window", {
      location: {
        hash: "#token=new-secret",
        href: "http://127.0.0.1:4317/?view=context#token=new-secret",
      },
      history: { replaceState },
    });
    vi.stubGlobal("sessionStorage", {
      setItem,
      getItem: vi.fn().mockReturnValue("previous-secret"),
    });
    expect(captureToken()).toBe("new-secret");
    expect(setItem).toHaveBeenCalledWith(
      "graph-engineering-token",
      "new-secret",
    );
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?view=context");
  });

  it("reuses a stored token on page refresh without rewriting browser history", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: { hash: "", href: "http://127.0.0.1:4317/" },
      history: { replaceState },
    });
    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn().mockReturnValue("stored-secret"),
    });
    expect(captureToken()).toBe("stored-secret");
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("sends authentication in headers and JSON bodies only to local API paths", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "plan-1" }), { status: 200 }),
      );
    const api = createApi("private-token", request);
    await expect(
      api("/api/plans", { objective: "Fix issue" }),
    ).resolves.toEqual({ id: "plan-1" });
    expect(request).toHaveBeenCalledWith(
      "/api/plans",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer private-token",
          "Content-Type": "application/json",
        },
        body: '{"objective":"Fix issue"}',
      }),
    );
    await expect(api("https://external.example/api/project")).rejects.toThrow(
      "Only local API",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("surfaces policy failures and non-JSON authentication failures", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: "Provider denied by project policy" }),
          { status: 403 },
        ),
      )
      .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));
    const api = createApi("expired-token", request);
    await expect(api("/api/runs", { planId: "plan" })).rejects.toMatchObject({
      status: 403,
      message: "Provider denied by project policy",
    });
    await expect(api("/api/project")).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining("expired"),
    });
  });
});
