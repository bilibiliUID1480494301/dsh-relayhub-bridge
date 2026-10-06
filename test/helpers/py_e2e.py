# -*- coding: utf-8 -*-
"""Cross-verification bridge for dsh-relayhub-bridge e2e tests.

Loads hubrelay's Python implementation (relayhub/gateway/e2e.py) by file path —
no package import side effects — and acts as the other end of the wire:

  argv[1] = "open"  : stdin {"envelope", "credential", "raw_private", "key_id"}
                      -> hubrelay `open_envelope` -> {"ok": true, "payload": ...}
  argv[1] = "seal"  : stdin {"payload", "credential", "key_id"}
                      -> fresh X25519 identity + `seal_envelope`
                      -> {"ok": true, "envelope": ..., "raw_private": hex, "key_id": ...}

Any failure prints {"ok": false, "error": "..."} and exits 0 — the JS test
asserts on the JSON, not the exit code. All output is ASCII (ensure_ascii), so
Windows console encodings cannot corrupt it.

Env override: RH_E2E_SRC points at e2e.py (default: the rh-oss-dev source tree).
"""
import importlib.util
import json
import os
import sys

SRC = os.environ.get(
    "RH_E2E_SRC",
    r"E:\dev\.tmp-asar\rh-oss-dev\relayhub\gateway\e2e.py",
)


def load_e2e():
    spec = importlib.util.spec_from_file_location("rh_e2e", SRC)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class AllowAll:
    """ReplayGuard stand-in: accepts every nonce (replay is tested in JS)."""

    def check(self, *args):
        return True


def main():
    mod = load_e2e()
    mode = sys.argv[1]
    data = json.loads(sys.stdin.read())
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

    if mode == "open":
        private = X25519PrivateKey.from_private_bytes(bytes.fromhex(data["raw_private"]))
        identity = mod.E2eIdentity(
            data["key_id"], private, private.public_key().public_bytes_raw()
        )
        payload = mod.open_envelope(identity, data["envelope"], data["credential"], AllowAll())
        print(json.dumps({"ok": True, "payload": payload}))
    elif mode == "seal":
        private = X25519PrivateKey.generate()
        raw_hex = private.private_bytes_raw().hex()
        identity = mod.E2eIdentity(
            data["key_id"], private, private.public_key().public_bytes_raw()
        )
        envelope = mod.seal_envelope(
            identity.public_b64(), identity.key_id, data["payload"], data["credential"]
        )
        print(json.dumps(
            {"ok": True, "envelope": envelope, "raw_private": raw_hex, "key_id": data["key_id"]}
        ))
    else:
        print(json.dumps({"ok": False, "error": f"unknown mode {mode}"}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 — report every failure as JSON
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
