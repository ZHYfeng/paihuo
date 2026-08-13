import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TaskGraph } from "./visualization";

describe("TaskGraph", () => {
  it("provides a table equivalent to the visual graph", () => {
    render(<TaskGraph title="Delivery" nodes={[{ id: "build", label: "实现" }, { id: "review", label: "复核" }]} edges={[{ from: "build", to: "review" }]} />);
    expect(screen.getByRole("table", { name: /Delivery/ })).toBeInTheDocument();
    expect(screen.getAllByRole("cell", { name: "build" })).toHaveLength(2);
    expect(screen.getByRole("cell", { name: "复核" })).toBeInTheDocument();
  });
});
