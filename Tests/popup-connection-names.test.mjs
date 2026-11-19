import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const popup = readFileSync(
    new URL("../MCPSafari/MCPSafari Extension/Resources/popup.js", import.meta.url),
    "utf8"
);

// Each connection's row names the server behind it: the name it was given, or
// the last part of the folder it was started in, and that folder in full on a
// second line. The tooltip carries the state and the MCP client. Everything a
// server says is its own claim, so it is escaped on the way into the markup.

function loadPopup() {
    // The module's top level touches the DOM, so only the pure renderers are
    // taken; everything below them needs a document to exist.
    const source = popup.slice(0, popup.indexOf("async function refreshSite"));
    const context = vm.createContext({});
    vm.runInContext(source, context);
    return {
        row: (status) => vm.runInContext("connectionRowMarkup", context)(status),
        tooltip: (status) => vm.runInContext("connectionTooltip", context)(status),
        shortFolder: (folder) => vm.runInContext("shortFolder", context)(folder),
    };
}

const named = {
    port: 8089,
    state: "connected",
    manual: false,
    label: "bookof",
    folder: "/Users/me/work/bookof",
    client: { name: "claude-code", version: "2.1.0" },
};

test("a named connection shows its name, and its folder with the home folder as ~", () => {
    const { row } = loadPopup();

    const markup = row(named);

    assert.match(markup, /<span class="conn-port">8089<\/span>/);
    assert.match(markup, /<span class="conn-name">bookof<\/span>/);
    assert.match(markup, /<span class="conn-folder">~\/work\/bookof<\/span>/);
    // The name takes the state's place; the dot and the tooltip still say it.
    assert.doesNotMatch(markup, /conn-state/);
    assert.match(markup, /auto-badge/);
});

test("a --name and the folder it was started in are both shown", () => {
    const { row } = loadPopup();

    const markup = row({ ...named, label: "marketing", folder: "/Users/me/work/site", manual: true });

    assert.match(markup, /conn-name">marketing</);
    assert.match(markup, /conn-folder">~\/work\/site</);
    assert.doesNotMatch(markup, /auto-badge/);
});

test("a name with no folder is shown on its own", () => {
    const { row } = loadPopup();

    const markup = row({ ...named, label: "alpha", folder: null });

    assert.match(markup, /conn-name">alpha</);
    assert.doesNotMatch(markup, /conn-folder/);
});

test("a connection that has not said who it is shows its state, as before", () => {
    const { row } = loadPopup();

    // An older server: the background names it by its port.
    const older = row({ port: 8089, state: "connected", manual: false, label: "port 8089", folder: null, client: null });
    assert.match(older, /<span class="conn-state">connected<\/span>/);
    assert.doesNotMatch(older, /conn-name|conn-folder/);

    // A port that is not connected carries no name at all.
    const waiting = row({ port: 8090, state: "connecting", manual: false, label: null, folder: null, client: null });
    assert.match(waiting, /<span class="conn-state">connecting<\/span>/);

    // And a popup talking to an older background, which sends neither field.
    const bare = row({ port: 8091, state: "disconnected", manual: true });
    assert.match(bare, /<span class="conn-state">disconnected<\/span>/);
});

test("the tooltip has the state and the client, and whatever the row may cut short", () => {
    const { tooltip } = loadPopup();

    assert.equal(tooltip(named), "bookof\n~/work/bookof\nconnected · claude-code 2.1.0");
    assert.equal(tooltip({ ...named, client: { name: "claude-code", version: null } }),
        "bookof\n~/work/bookof\nconnected · claude-code");
    // A server with no name or folder can still have a client behind it.
    assert.equal(tooltip({ ...named, label: "port 8089", folder: null }), "connected · claude-code 2.1.0");
    assert.equal(tooltip({ port: 8090, state: "connecting", label: null, folder: null, client: null }), "connecting");
});

test("a hostile name or folder cannot inject markup", () => {
    const { row } = loadPopup();

    const markup = row({
        ...named,
        label: '<img src=x onerror=alert(1)>',
        folder: '/Users/me/"><script>alert(1)</script>',
    });

    assert.doesNotMatch(markup, /<img|<script/);
    assert.match(markup, /conn-name">&lt;img src=x onerror=alert\(1\)&gt;</);
    assert.match(markup, /conn-folder">~\/&quot;&gt;&lt;script&gt;/);
});

test("only a home folder is shortened", () => {
    const { shortFolder } = loadPopup();

    assert.equal(shortFolder("/Users/me/work/bookof"), "~/work/bookof");
    assert.equal(shortFolder("/Users/me"), "~");
    // /Users/Shared belongs to everyone, and these are not under /Users at all.
    assert.equal(shortFolder("/Users/Shared/builds"), "/Users/Shared/builds");
    assert.equal(shortFolder("/Users"), "/Users");
    assert.equal(shortFolder("/Usersfoo/me/x"), "/Usersfoo/me/x");
    assert.equal(shortFolder("/opt/work/app"), "/opt/work/app");
    // Someone's home folder that merely starts with "Shared" is still a home.
    assert.equal(shortFolder("/Users/SharedLab/app"), "~/app");
});
