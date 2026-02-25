import { describe, expect, it } from "vitest";
import { renderAppSkeleton } from "../src/app";

describe("mockup-web app skeleton", () => {
  it("renders required simplified panels", () => {
    document.body.innerHTML = '<div id="root"></div>';
    const root = document.getElementById("root") as HTMLElement;
    renderAppSkeleton(root);

    expect(document.getElementById("panel-connection")).not.toBeNull();
    expect(document.getElementById("panel-topic")).not.toBeNull();
    expect(document.getElementById("panel-service")).not.toBeNull();
    expect(document.getElementById("panel-action")).not.toBeNull();
    expect(document.getElementById("publish-btn")).not.toBeNull();
    expect(document.getElementById("service-ok-btn")).not.toBeNull();
    expect(document.getElementById("codec-select")).not.toBeNull();
    expect(document.getElementById("compression-select")).not.toBeNull();
    expect(document.getElementById("smoke-json-btn")).not.toBeNull();
    expect(document.getElementById("smoke-cbor-btn")).not.toBeNull();
    expect(document.getElementById("panel-cli")).not.toBeNull();
    expect(document.getElementById("cli-send-btn")).not.toBeNull();
    expect(document.getElementById("cli-command")).not.toBeNull();
  });
});
