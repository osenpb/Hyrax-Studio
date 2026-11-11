// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { markRecent, recentIds, sortByRecent } from "./recent";

describe("conexiones recientes", () => {
  beforeEach(() => localStorage.clear());

  it("guarda la más reciente primero, sin repetir y con tope", () => {
    for (const id of ["a", "b", "c", "a"]) markRecent(id);
    expect(recentIds()).toEqual(["a", "c", "b"]);
    for (let i = 0; i < 20; i++) markRecent(`x${i}`);
    expect(recentIds()).toHaveLength(8);
    expect(recentIds()[0]).toBe("x19");
  });

  it("tolera datos dañados", () => {
    localStorage.setItem("hyrax-recent", "no es json");
    expect(recentIds()).toEqual([]);
    localStorage.setItem("hyrax-recent", JSON.stringify([1, "ok", null]));
    expect(recentIds()).toEqual(["ok"]);
  });

  it("ordena las recientes primero y conserva el orden del resto", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    expect(sortByRecent(items, ["c", "a"]).map((i) => i.id)).toEqual(["c", "a", "b", "d"]);
    expect(sortByRecent(items, []).map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
  });
});
