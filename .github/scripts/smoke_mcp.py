#!/usr/bin/env python3
"""Exercise stdio initialization, discovery and bridge status without Safari."""
import json
import selectors
import subprocess
import sys
import tempfile
import time


def smoke(binary: str) -> None:
    # File-backed stderr avoids a full pipe blocking the server.
    with tempfile.TemporaryFile(mode="w+") as errors:
        process = subprocess.Popen(
            [binary, "--port", "0"], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=errors, text=True, bufsize=1,
        )
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)

        def send(message):
            process.stdin.write(json.dumps({"jsonrpc": "2.0", **message}) + "\n")
            process.stdin.flush()

        def request(identifier, method, params):
            send({"id": identifier, "method": method, "params": params})
            deadline = time.monotonic() + 15
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    raise RuntimeError(f"Timed out awaiting {method}")
                line = process.stdout.readline()
                if not line:
                    errors.seek(0)
                    raise RuntimeError(f"Server exited during {method}: {errors.read()}")
                reply = json.loads(line)
                if reply.get("id") == identifier:
                    if "error" in reply:
                        raise RuntimeError(f"{method}: {reply['error']}")
                    return reply["result"]

        try:
            initialized = request(1, "initialize", {
                "protocolVersion": "2025-11-25", "capabilities": {},
                "clientInfo": {"name": "mcpsafari-smoke", "version": "1.0"},
            })
            assert initialized["serverInfo"]["name"] == "mcp-safari"
            send({"method": "notifications/initialized"})
            listing = request(2, "tools/list", {})
            assert {"status", "snapshot", "tabs_context"} <= {tool["name"] for tool in listing["tools"]}
            result = request(3, "tools/call", {"name": "status", "arguments": {}})
            assert not result.get("isError")
            status = json.loads(result["content"][0]["text"])
            assert status["listener"] == "listening", status
            assert status["requestedPort"] == 0 and status["port"] > 0, status
            assert status["tokenFileSecure"] is True, status
            print(f"MCP initialize, tools/list, status passed; loopback port {status['port']}")
        finally:
            selector.close()
            process.stdin.close()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            process.stdout.close()


if __name__ == "__main__":
    smoke(sys.argv[1])
