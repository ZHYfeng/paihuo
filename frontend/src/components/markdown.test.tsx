import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./markdown";

describe("Markdown", () => {
  it("renders formatting and removes executable markup", () => {
    const { container } = render(<Markdown>{"# Result\n\n<script>alert(1)</script>\n\n**safe**"}</Markdown>);
    expect(screen.getByRole("heading", { name: "Result" })).toBeInTheDocument();
    expect(screen.getByText("safe")).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
  });
});
