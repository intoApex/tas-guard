#!/usr/bin/env python3
"""Reference vectors for TAS Guard's Hyperliquid signing, produced by the official Python SDK.

TAS Guard signs Hyperliquid actions in plain JavaScript (src/eth-crypto.js, src/hl-sign.js). This script
has the official SDK sign the same actions with the same throwaway keys and nonces, so test/hl.test.js can
assert byte-for-byte equality (msgpack bytes, connectionId, EIP-712 digest, r, s, v and the posted payload).

Reproduce:
  pip install hyperliquid-python-sdk==0.24.0 eth-account==0.13.7 msgpack==1.2.4
  python3 test/fixtures/gen-hl-vectors.py > test/fixtures/hl-vectors.json

No network access: the SDK's Exchange is built with a fixed meta/spotMeta and its HTTP post is replaced by
a function that returns the payload it would have sent.
"""
import json
import random
import sys
from importlib.metadata import version

import msgpack
from eth_account import Account
from eth_account.messages import _hash_eip191_message, encode_typed_data
from eth_utils import keccak, to_checksum_address

import hyperliquid.exchange as hx
from hyperliquid.exchange import Exchange
from hyperliquid.utils import constants
from hyperliquid.utils.signing import (
    action_hash,
    construct_phantom_agent,
    float_to_wire,
    l1_payload,
    user_signed_payload,
)

# Prices in the order cases are valid on Hyperliquid (5 significant figures, decimals within 6 - szDecimals),
# so TAS Guard's tick rounding leaves them unchanged and the whole posted payload can be compared.
# Well-known public test keys (Hardhat accounts #0 and #1). Never use them for real funds.
AGENT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
MAIN_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
# A test builder address (Hardhat #2), mixed case, so the vectors show the SDK lowercasing it in orders.
BUILDER = to_checksum_address("0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc")

META = {
    "universe": [
        {"name": "BTC", "szDecimals": 5, "maxLeverage": 40},
        {"name": "ETH", "szDecimals": 4, "maxLeverage": 25},
        {"name": "SOL", "szDecimals": 2, "maxLeverage": 20},
        {"name": "kPEPE", "szDecimals": 0, "maxLeverage": 10},
    ]
}
SPOT_META = {
    "universe": [
        {"tokens": [1, 0], "name": "PURR/USDC", "index": 0, "isCanonical": True},
        {"tokens": [150, 0], "name": "@107", "index": 107, "isCanonical": False},
    ],
    "tokens": [
        {"name": "USDC", "szDecimals": 8, "weiDecimals": 8, "index": 0, "tokenId": "0x6d1e7cde53ba9467b783cb7c530ce054", "isCanonical": True},
        {"name": "PURR", "szDecimals": 0, "weiDecimals": 5, "index": 1, "tokenId": "0xc1fb593aeffbeb02f85e0308e9956a90", "isCanonical": True},
        {"name": "HYPE", "szDecimals": 2, "weiDecimals": 8, "index": 150, "tokenId": "0x0d01dc56dcaaca66ad901c959b4011ec", "isCanonical": False},
    ],
}

_nonce = [0]


def fixed_nonce():
    return _nonce[0]


hx.get_timestamp_ms = fixed_nonce  # the SDK's exchange module imported it by name


def exchange(key, mainnet):
    ex = Exchange(
        Account.from_key(key),
        constants.MAINNET_API_URL if mainnet else constants.TESTNET_API_URL,
        meta=META,
        spot_meta=SPOT_META,
    )
    ex.post = lambda path, payload: {"path": path, "payload": payload}  # capture instead of sending
    return ex


def digest(data):
    return "0x" + _hash_eip191_message(encode_typed_data(full_message=data)).hex()


def case(name, mainnet, nonce, params, run, key=AGENT_KEY):
    _nonce[0] = nonce
    out = run(exchange(key, mainnet))
    payload = out["payload"]
    action = payload["action"]
    v = {
        "name": name,
        "network": "mainnet" if mainnet else "testnet",
        "nonce": nonce,
        "signer": Account.from_key(key).address.lower(),
        "params": params,
        "payload": payload,
    }
    if action["type"] == "approveBuilderFee":
        types = [
            {"name": "hyperliquidChain", "type": "string"},
            {"name": "maxFeeRate", "type": "string"},
            {"name": "builder", "type": "address"},
            {"name": "nonce", "type": "uint64"},
        ]
        v["kind"] = "user"
        v["digest"] = digest(user_signed_payload("HyperliquidTransaction:ApproveBuilderFee", types, dict(action)))
    else:
        h = action_hash(action, None, nonce, None)
        v["kind"] = "l1"
        v["msgpack"] = msgpack.packb(action).hex()
        v["connection_id"] = "0x" + h.hex()
        v["digest"] = digest(l1_payload(construct_phantom_agent(h, mainnet)))
    return v


def vectors():
    out = []
    for mainnet in (True, False):
        n = 1761739200000 if mainnet else 1761739200500
        out.append(case("order_with_builder", mainnet, n + 1,
                        {"coin": "BTC", "side": "buy", "size": 0.01, "price": 60123.0, "tif": "Gtc", "reduce_only": False, "builder": {"b": BUILDER, "f": 20}},
                        lambda ex: ex.order("BTC", True, 0.01, 60123.0, {"limit": {"tif": "Gtc"}}, False, builder={"b": BUILDER, "f": 20})))
        out.append(case("order_without_builder", mainnet, n + 2,
                        {"coin": "ETH", "side": "sell", "size": 0.5, "price": 2345.6, "tif": "Alo", "reduce_only": True, "builder": None},
                        lambda ex: ex.order("ETH", False, 0.5, 2345.6, {"limit": {"tif": "Alo"}}, True)))
        out.append(case("market_open_with_builder", mainnet, n + 3,
                        {"coin": "ETH", "side": "buy", "size": 0.25, "mid": 2345.678, "slippage": 0.01, "builder": {"b": BUILDER, "f": 20}},
                        lambda ex: ex.market_open("ETH", True, 0.25, px=2345.678, slippage=0.01, builder={"b": BUILDER, "f": 20})))
        out.append(case("spot_order_with_builder", mainnet, n + 4,
                        {"coin": "HYPE/USDC", "side": "sell", "size": 1.5, "price": 41.237, "tif": "Ioc", "reduce_only": False, "builder": {"b": BUILDER, "f": 20}},
                        lambda ex: ex.order("HYPE/USDC", False, 1.5, 41.237, {"limit": {"tif": "Ioc"}}, False, builder={"b": BUILDER, "f": 20})))
        out.append(case("cancel", mainnet, n + 5, {"coin": "BTC", "oid": 123456789012},
                        lambda ex: ex.cancel("BTC", 123456789012)))
        out.append(case("update_leverage", mainnet, n + 6, {"coin": "ETH", "leverage": 5, "is_cross": False},
                        lambda ex: ex.update_leverage(5, "ETH", is_cross=False)))
        out.append(case("approve_builder_fee", mainnet, n + 7, {"builder": BUILDER.lower(), "max_fee_rate": "0.02%"},
                        lambda ex: ex.approve_builder_fee(BUILDER.lower(), "0.02%"), key=MAIN_KEY))
        # A signature whose r or s has a leading zero nibble: the SDK writes r and s as minimal hex (to_hex).
        for k in range(1, 200):
            v = case("order_short_signature", mainnet, n + 100 + k,
                     {"coin": "SOL", "side": "buy", "size": 2, "price": 150.25, "tif": "Gtc", "reduce_only": False, "builder": {"b": BUILDER, "f": 20}},
                     lambda ex: ex.order("SOL", True, 2, 150.25, {"limit": {"tif": "Gtc"}}, False, builder={"b": BUILDER, "f": 20}))
            if len(v["payload"]["signature"]["r"]) < 66 or len(v["payload"]["signature"]["s"]) < 66:
                out.append(v)
                break
    return out


def keccak_vectors():
    out = [{"hex": "", "keccak": keccak(b"").hex()}, {"hex": b"abc".hex(), "keccak": keccak(b"abc").hex()}]
    for n in (1, 55, 56, 135, 136, 137, 271, 272, 273, 1000):
        data = bytes((i * 7 + 3) & 0xFF for i in range(n))
        out.append({"hex": data.hex(), "keccak": keccak(data).hex()})
    return out


def big(x):
    return {"$big": str(x)}


def msgpack_vectors():
    vals = [0, 1, 127, 128, 255, 256, 65535, 65536, 2**32 - 1, 2**32, 2**53, -1, -32, -33, -128, -129, -32768,
            -32769, -(2**31), -(2**31) - 1, True, False, None, "", "a", "x" * 31, "x" * 32, "x" * 255, "x" * 256,
            "x" * 300, "üñí€", 1.5, -0.25, 0.1, [], [1, 2], list(range(16)), {}, {"a": 1, "b": [True, None]},
            {f"k{i}": i for i in range(16)}]
    out = [{"value": v, "msgpack": msgpack.packb(v).hex()} for v in vals]
    for b in (2**64 - 1, 2**63, -(2**63)):
        out.append({"value": big(b), "msgpack": msgpack.packb(b).hex()})
    return out


def f2w_vectors():
    vals = [0, 1, 0.1, 1e-8, 1.23456789, 123456.789, 60123.4, 0.000012345, 1e-9, 2345.6789012, 100, 100.1,
            3.0000000001, 0.1 + 0.2, 123456789.12345678, 1 / 512, 0.5, 99999.99999999, 1e15, 7.5e-5, 41.237]
    out = []
    for v in vals:
        try:
            out.append({"value": v, "wire": float_to_wire(v)})
        except ValueError:
            out.append({"value": v, "error": True})
    return out


def slippage_vectors():
    """The SDK's market-order price: round(float(f"{px:.5g}"), (6 if perp else 8) - szDecimals)."""
    rnd = random.Random(1337)
    cases = [(1.03125, True, 0.0, 0, False), (2345.678, True, 0.01, 4, False), (60000, False, 0.05, 5, False),
             (0.000012345, True, 0.01, 0, False), (41.237, False, 0.01, 2, True), (123456.7, True, 0.0, 5, False),
             (9.99995, True, 0.0, 1, False), (0.00999995, False, 0.0, 0, True)]
    for _ in range(400):
        mag = 10 ** rnd.uniform(-6, 6)
        cases.append((float(f"{mag:.{rnd.randint(1, 9)}g}"), rnd.random() < 0.5, rnd.choice([0, 0.001, 0.005, 0.01, 0.03, 0.05, 0.1]),
                      rnd.randint(0, 5), rnd.random() < 0.3))
    out = []
    for px, is_buy, slip, szd, spot in cases:
        p = px * ((1 + slip) if is_buy else (1 - slip))
        out.append({"mid": px, "is_buy": is_buy, "slippage": slip, "sz_decimals": szd, "spot": spot,
                    "price": round(float(f"{p:.5g}"), (8 if spot else 6) - szd)})
    return out


def main():
    doc = {
        "generated_by": f"test/fixtures/gen-hl-vectors.py with hyperliquid-python-sdk {version('hyperliquid-python-sdk')}, eth-account {version('eth-account')}, msgpack {version('msgpack')}",
        "agent_key": AGENT_KEY,
        "agent_address": Account.from_key(AGENT_KEY).address.lower(),
        "main_key": MAIN_KEY,
        "main_address": Account.from_key(MAIN_KEY).address.lower(),
        "builder": BUILDER,
        "meta": META,
        "spot_meta": SPOT_META,
        "actions": vectors(),
        "keccak": keccak_vectors(),
        "msgpack": msgpack_vectors(),
        "float_to_wire": f2w_vectors(),
        "slippage_price": slippage_vectors(),
    }
    json.dump(doc, sys.stdout, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
