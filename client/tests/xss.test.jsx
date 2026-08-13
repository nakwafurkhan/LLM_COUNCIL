import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import MessageList from "../src/components/MessageList.jsx";

describe("XSS sanitization", () => {
  it("does not render script tags from message content", () => {
    const msg = {
      id: "xss1",
      role: "assistant",
      content: `Hello <script>alert('xss')</script> world`,
      createdAt: new Date().toISOString(),
    };
    const { container } = render(<MessageList messages={[msg]} streamingText="" />);
    expect(container.querySelector("script")).toBeNull();
  });

  it("strips onerror attribute from img tags", () => {
    const msg = {
      id: "xss2",
      role: "assistant",
      content: `<img src=x onerror="alert('xss')">`,
      createdAt: new Date().toISOString(),
    };
    const { container } = render(<MessageList messages={[msg]} streamingText="" />);
    const imgs = container.querySelectorAll("img");
    // Either no img rendered, or onerror is stripped
    imgs.forEach((img) => {
      expect(img.getAttribute("onerror")).toBeNull();
    });
  });

  it("strips inline event handlers from any element", () => {
    const msg = {
      id: "xss3",
      role: "assistant",
      content: `<a onclick="alert('xss')" href="#">click me</a>`,
      createdAt: new Date().toISOString(),
    };
    const { container } = render(<MessageList messages={[msg]} streamingText="" />);
    const anchors = container.querySelectorAll("a");
    anchors.forEach((a) => {
      expect(a.getAttribute("onclick")).toBeNull();
    });
  });

  it("does not execute script content via streaming text", () => {
    const { container } = render(
      <MessageList
        messages={[]}
        streamingText={`<script>window.__xss_executed = true</script>`}
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(typeof window.__xss_executed).toBe("undefined");
  });
});
