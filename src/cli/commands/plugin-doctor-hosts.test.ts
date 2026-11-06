import { expect, test } from "bun:test";
import { pluginHostChecks } from "./plugins";

// The web proxies the hosts a plugin exports and the directory shows
// gloom.json's, so doctor has to hold the source to one and the two to each
// other, without asking for a page the plugin only links to.
test("plugin doctor checks source hosts against the export, gloom.json and its link hosts", () => {
  const source = `
    const API = "https://hacker-news.firebaseio.com/v0";
    const page = (id: number) => \`https://news.ycombinator.com/item?id=\${id}\`;
  `;

  expect(pluginHostChecks([source], ["hacker-news.firebaseio.com"], {
    hosts: ["hacker-news.firebaseio.com"],
    linkHosts: ["news.ycombinator.com"],
  })).toEqual([{ status: "ok", message: "hacker-news.firebaseio.com" }]);

  const onlyInGloomJson = pluginHostChecks([source], [], {
    hosts: ["hacker-news.firebaseio.com"],
    linkHosts: [],
  });
  expect(onlyInGloomJson.map((check) => check.message.split(":")[0])).toEqual([
    "In source but not declared",
    "In gloom.json but not in the plugin's hosts",
  ]);
  expect(onlyInGloomJson[0]!.message).toContain("news.ycombinator.com.");
  expect(onlyInGloomJson[0]!.message).not.toContain("firebaseio");

  // Without a gloom.json there is no directory listing to agree with.
  expect(pluginHostChecks([source], ["firebaseio.com"], { hosts: null, linkHosts: ["news.ycombinator.com"] }))
    .toEqual([{ status: "ok", message: "firebaseio.com" }]);
});
