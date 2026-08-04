import { useState, useEffect } from "react";
import {
    getPreimageManager,
    requestPermission,
} from "@parity/product-sdk-host";
import {
    SignerManager,
    HostProvider,
    DevProvider,
    HostUnavailableError,
    NoAccountsError,
    type SignerAccount,
} from "@parity/product-sdk-signer";
import { createChainClient } from "@parity/product-sdk-chain-client";
import {
    ContractManager,
    createContractRuntimeFromClient,
    ensureContractAccountMapped,
} from "@parity/product-sdk-contracts";
import type { devnet_asset_hub } from "@parity/product-sdk-descriptors/devnet-asset-hub";
import type { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import type { PolkadotClient, PolkadotSigner } from "polkadot-api";
import { blake2b } from "@noble/hashes/blake2.js";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import type { MultihashDigest } from "multiformats/hashes/interface";

/**
 * Unwrap a product-sdk `Result` to its value, re-throwing the `err` channel as
 * an `Error`. Since product-sdk 0.18 fallible calls return `Result` instead of
 * throwing; this bridges them back onto throw / try-catch control flow. Mirrors
 * the CLI's `unwrapResult` (playground-cli #470).
 */
export function unwrapResult<T>(
    result: { ok: true; value: T } | { ok: false; error: unknown },
): T {
    if (!result.ok) {
        throw result.error instanceof Error ? result.error : new Error(String(result.error));
    }
    return result.value;
}

// ---------------------------------------------------------------------------
// Networks. "paseo-next" is the Paseo Next v2 preview network (para 1500) —
// that's what the CDM `paseo` preset targets, NOT the public Paseo testnet.
// "devnet" is the public products devnet on the Paseo testnet Asset Hub
// (para 1000), with the community-operated CDM registry (reference:
// contract-dependency-manager PR #61). Build with VITE_NETWORK=devnet to
// select it; the default stays paseo-next. Descriptors load dynamically so
// each build ships a single metadata chunk; chain identity comes from the
// descriptor (host-routed chain client, no endpoints or genesis to pin).
// ---------------------------------------------------------------------------

type AssetHubDescriptor = typeof devnet_asset_hub | typeof paseo_asset_hub;

interface NetworkConfig {
    label: string;
    /** IPFS gateways used to read Bulletin content, most specific first. */
    gateways: readonly string[];
    /** CDM ContractRegistry address the contract resolves against. */
    registry: string;
    loadDescriptor(): Promise<AssetHubDescriptor>;
}

// `import.meta.env.VITE_NETWORK` is inlined as a literal at build time, so this
// comparison folds and the unselected network's ~880 kB metadata chunk is
// dropped from the bundle. Keep it a direct literal comparison — routing the
// choice through a lookup table or a normalizing helper leaves both import()s
// reachable, so the build emits both metadata chunks.
export const NETWORK: NetworkConfig =
    import.meta.env.VITE_NETWORK === "devnet"
        ? {
              label: "Devnet (Paseo testnet)",
              // Bulletin Paseo has no dedicated HTTP gateway; read via public IPFS gateways.
              gateways: [
                  "https://ipfs.io/ipfs/",
                  "https://dweb.link/ipfs/",
                  "https://nftstorage.link/ipfs/",
              ],
              registry: "0x59b0245778917af55224e5f8fb55f7f8d452619f",
              loadDescriptor: async () =>
                  (await import("@parity/product-sdk-descriptors/devnet-asset-hub")).devnet_asset_hub,
          }
        : {
              label: "Paseo Next",
              gateways: [
                  "https://paseo-bulletin-next-ipfs.polkadot.io/ipfs/",
                  "https://dweb.link/ipfs/",
                  "https://ipfs.io/ipfs/",
                  "https://nftstorage.link/ipfs/",
              ],
              registry: "0xf62c2ece29cd8df2e10040ecfa5a894a5c5d9cb0",
              loadDescriptor: async () =>
                  (await import("@parity/product-sdk-descriptors/paseo-asset-hub")).paseo_asset_hub,
          };

// Dev only: a typo'd VITE_NETWORK silently falls back to paseo-next, so say so
// while developing. Kept out of the selection above to preserve the fold.
if (import.meta.env.DEV) {
    const configured = import.meta.env.VITE_NETWORK;
    if (configured && configured !== "devnet" && configured !== "paseo" && configured !== "paseo-next") {
        console.warn(`[Network] Unknown VITE_NETWORK "${configured}", falling back to paseo-next`);
    }
}

// ---------------------------------------------------------------------------
// Permissions (RFC-0002)
// ---------------------------------------------------------------------------

const _grantedPermissions = new Set<string>();

async function ensurePermission(tag: "ChainSubmit" | "PreimageSubmit" | "StatementSubmit") {
    if (_grantedPermissions.has(tag)) return;
    try {
        const result = await requestPermission({ tag, value: undefined });
        if (result.ok && result.value) {
            _grantedPermissions.add(tag);
            console.log(`[Permission] ${tag} granted`);
        } else {
            console.warn(`[Permission] ${tag} denied`, result.ok ? "user rejected" : result.error);
        }
    } catch (err) {
        console.warn(`[Permission] ${tag} request failed:`, err);
    }
}

// ---------------------------------------------------------------------------
// Account flow — @parity/product-sdk-signer (SignerManager + HostProvider).
// ---------------------------------------------------------------------------

/**
 * Identifier the host uses to scope our app-scoped product account, following
 * the product-sdk convention (`"<name>.dot"`). It is a fixed constant, NOT
 * derived from `window.location.host` — the same identifier must resolve the
 * same product account whether the app runs on localhost, `<name>.dot` in
 * Polkadot Desktop, or `<name>.dot.li` in a browser. (Reading the host would
 * give `<name>.dot.li` on the gateway and break account resolution there.)
 * When deploying your own mod, change it to `"<your-name>.dot"`.
 */
const PRODUCT_ID = "feedback-board.dot";
const DERIVATION_INDEX = 0;

export function getAppAccountId(): [string, number] {
    return [PRODUCT_ID, DERIVATION_INDEX];
}

/**
 * SignerManager wired to the Host API. The host derives an app-scoped product
 * account from `dotNsIdentifier`; HostProvider pins signing to
 * `createTransaction`, so pallet-revive's Paseo Next v2 signed extensions
 * (AsPgas, AsRingAlias, CheckWeight, WeightReclaim) are forwarded to the host
 * as opaque bytes rather than going through the PJS bridge that rejects unknown
 * extensions. It also requests the host's `ChainSubmit` permission on connect.
 */
export const signerManager = new SignerManager({
    dappName: "feedback-board",
    createProvider: (type) =>
        type === "host"
            ? new HostProvider({
                  productAccount: { dotNsIdentifier: PRODUCT_ID, derivationIndex: DERIVATION_INDEX },
              })
            : new DevProvider(),
});

export interface AppAccount {
    /** SS58 string derived from the host's product public key. */
    address: string;
    /** EVM-style h160 (keccak256(publicKey)[12..]) for pallet-revive contract args. */
    h160Address: `0x${string}`;
    /** 32-byte public key. */
    publicKey: Uint8Array;
    /** Display name (optional). */
    name: string | null;
    /** PolkadotSigner ready for `tx.signSubmitAndWatch`. */
    signer: PolkadotSigner;
    /** [identifier, derivationIndex] used by host-mediated APIs. */
    productAccountId: [string, number];
    /** Backwards-compat: components call account.getSigner(). */
    getSigner(): PolkadotSigner;
}

/** Adapt a SignerAccount from the SDK to the app's AppAccount shape. */
function toAppAccount(sa: SignerAccount): AppAccount {
    const signer = sa.getSigner();
    return {
        address: sa.address,
        h160Address: sa.h160Address,
        publicKey: sa.publicKey,
        name: sa.name,
        signer,
        productAccountId: [PRODUCT_ID, DERIVATION_INDEX],
        getSigner: () => signer,
    };
}

interface AccountState {
    status: "idle" | "connecting" | "ready" | "signed-out" | "error";
    account: AppAccount | null;
    error?: string;
}

let _state: AccountState = { status: "idle", account: null };
const _listeners = new Set<(s: AccountState) => void>();

function setState(next: AccountState) {
    _state = next;
    for (const cb of _listeners) cb(next);
}

export function useAccountState(): AccountState {
    const [state, set] = useState<AccountState>(_state);
    useEffect(() => {
        const cb = (s: AccountState) => set(s);
        _listeners.add(cb);
        return () => { _listeners.delete(cb); };
    }, []);
    return state;
}

export async function connectAccount(): Promise<void> {
    if (_state.status === "connecting") return;
    setState({ status: "connecting", account: null });

    try {
        console.log(`[Account] Connecting product account ${PRODUCT_ID}#${DERIVATION_INDEX}`);
        const result = await signerManager.connect("host");

        if (!result.ok) {
            // Not inside a host / not signed in → prompt sign-in rather than error.
            if (result.error instanceof HostUnavailableError || result.error instanceof NoAccountsError) {
                setState({ status: "signed-out", account: null });
                return;
            }
            console.warn("[Account] connect error:", result.error.message);
            setState({ status: "error", account: null, error: result.error.message });
            return;
        }

        const accounts = result.value;
        if (accounts.length === 0) {
            setState({ status: "signed-out", account: null });
            return;
        }

        // Host product mode returns the single app-scoped account; select it so
        // `signerManager.getSigner()` and persistence track it.
        const selected = signerManager.selectAccount(accounts[0].address);
        const account = toAppAccount(selected.ok ? selected.value : accounts[0]);

        // Wire signer + origin defaults so contract queries don't fall back to
        // the dev Alice account and tx calls don't need explicit `{ signer }`.
        if (_contractManager) {
            _contractManager.setDefaults({ origin: account.address as never, signer: account.signer });
        }

        console.log(`[Account] Ready — ${account.address} (h160 ${account.h160Address}) (${account.name ?? PRODUCT_ID})`);
        setState({ status: "ready", account });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[Account] Connect failed:", msg);
        setState({ status: "error", account: null, error: msg });
    }
}

/** Retry the host connection. The host drives its own sign-in UI. */
export async function signIn(): Promise<void> {
    await connectAccount();
}

// ---------------------------------------------------------------------------
// Bulletin upload — host preimage path (works in dev mode)
// ---------------------------------------------------------------------------

const BLAKE2B_256_CODE = 0xb220;

function encodeVarint(value: number): Uint8Array {
    const bytes: number[] = [];
    let num = value;
    while (num >= 0x80) {
        bytes.push((num & 0x7f) | 0x80);
        num >>= 7;
    }
    bytes.push(num & 0x7f);
    return new Uint8Array(bytes);
}

export function calculateCID(bytes: Uint8Array): string {
    const hash = blake2b(bytes, { dkLen: 32 });
    const codeBytes = encodeVarint(BLAKE2B_256_CODE);
    const lengthBytes = encodeVarint(hash.length);
    const multihash = new Uint8Array(codeBytes.length + lengthBytes.length + hash.length);
    multihash.set(codeBytes, 0);
    multihash.set(lengthBytes, codeBytes.length);
    multihash.set(hash, codeBytes.length + lengthBytes.length);
    const digest: MultihashDigest = {
        code: BLAKE2B_256_CODE,
        size: hash.length,
        bytes: multihash,
        digest: hash,
    };
    return CID.createV1(raw.code, digest).toString();
}

export async function uploadToBulletin(_account: AppAccount, bytes: Uint8Array): Promise<string> {
    await ensurePermission("PreimageSubmit");
    const cid = calculateCID(bytes);
    console.log("[Bulletin] Submitting preimage via host, size:", bytes.length, "expected CID:", cid);
    const preimageManager = await getPreimageManager();
    if (!preimageManager) {
        throw new Error("Preimage manager unavailable — open this app inside a Polkadot host.");
    }
    await preimageManager.submit(bytes);
    console.log("[Bulletin] Preimage stored.");
    return cid;
}

// ---------------------------------------------------------------------------
// Contracts (ContractManager + product-sdk-chain-client). The host routes the
// Asset Hub connection in both dev (localhost in Polkadot Desktop) and prod
// (`.dot.li`), so there is no hardcoded genesis or localhost branching.
// ---------------------------------------------------------------------------

let _contractManager: ContractManager | null = null;
let _contract: any = null;
let _polkadotClient: PolkadotClient | null = null;

/**
 * Wake the Asset Hub chain follow before a contract call. The host container
 * tears down the follow when the tab is backgrounded long enough; the first
 * request after wake bails with "No active follow for this chain" until we
 * touch the client to trigger a re-follow.
 */
export async function wakeChainFollow(): Promise<void> {
    if (!_polkadotClient) return;
    try {
        await _polkadotClient.getBestBlocks();
    } catch (err) {
        console.warn("[CDM] wakeChainFollow failed:", err);
    }
}

const NO_FOLLOW_RE = /no active follow/i;

/**
 * Wrap a contract method handle so each `query()` / `tx()` first wakes the
 * chain follow and retries once on "No active follow for this chain".
 */
function withFollowRetry<T extends Record<string, any>>(method: T): T {
    const wrap = <Fn extends (...a: any[]) => Promise<any>>(fn: Fn): Fn =>
        (async (...args: any[]) => {
            await wakeChainFollow();
            try {
                return await fn(...args);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (!NO_FOLLOW_RE.test(msg)) throw err;
                console.warn("[CDM] follow lost mid-call, retrying once:", msg);
                await wakeChainFollow();
                return await fn(...args);
            }
        }) as Fn;

    return new Proxy(method, {
        get(target, prop) {
            const v = target[prop as keyof T];
            if (typeof v === "function") return wrap(v.bind(target));
            return v;
        },
    });
}

function wrapContract(contract: any): any {
    return new Proxy(contract, {
        get(target, prop) {
            const m = target[prop];
            if (m && typeof m === "object" && ("query" in m || "tx" in m)) {
                return withFollowRetry(m);
            }
            return m;
        },
    });
}

let _cdmJson: any = null;
let _contractInitPromise: Promise<void> | null = null;

/** Stage cdm.json without opening the Asset Hub chain client yet. */
export function stageCdmJson(cdmJson: any): void {
    _cdmJson = cdmJson;
}

export async function initContracts(cdmJson: any): Promise<void> {
    stageCdmJson(cdmJson);
}

/**
 * Lazy contract init. Holding an Asset Hub PolkadotClient open (with its
 * chain-head follow) at app startup interferes with Bulletin preimage submits
 * — only spin up the chain client when a contract call is actually about to
 * happen. This defers `createChainClient` until the first `getContract()`
 * consumer calls a method.
 */
async function ensureContractsReady(): Promise<void> {
    if (_contractManager || !_cdmJson) return;
    if (_contractInitPromise) return _contractInitPromise;
    _contractInitPromise = (async () => {
        await ensurePermission("ChainSubmit");

        // Asset Hub access goes through the host's chain client — both dev
        // (localhost in Polkadot Desktop) and prod (`.dot.li`) run inside a host.
        // `createChainClient` routes every connection through the host provider,
        // so the host never prompts "Allow Access to Web Domains" for a raw RPC
        // endpoint, and the chain identity comes from the descriptor — no
        // hardcoded genesis.
        const descriptor = await NETWORK.loadDescriptor();
        const chainClient = await createChainClient({
            chains: { assetHub: descriptor },
        });
        const client = chainClient.raw.assetHub;
        _polkadotClient = client;
        console.log(`[CDM] Asset Hub chain client ready (host-routed, ${NETWORK.label})`);

        console.log("[CDM] Waking Asset Hub chain follow...");
        await client.getChainSpecData();
        await client.getBestBlocks();
        console.log("[CDM] Chain follow active.");

        // The app gates the board behind sign-in (see App.tsx — content only
        // renders when status === "ready" with a connected account), so contract
        // init is never reached before a mapped product account exists.
        if (!_state.account) {
            throw new Error("[CDM] Contract init reached without a connected account");
        }

        // Map the product account BEFORE live registry resolution. `fromLiveClient`
        // immediately calls `registry.getAddress("@example/feedback")` as a view,
        // and pallet-revive dry-run-fails that call with `Revive::AccountUnmapped`
        // when the query origin isn't mapped. Build a plain runtime (no registry
        // query) to perform the mapping first.
        const initRuntime = createContractRuntimeFromClient(client, descriptor);
        await mapAccountWithRuntime(initRuntime, _state.account);

        // `fromLiveClient` resolves the deployed contract address from the live
        // CDM registry on each init instead of trusting the snapshot baked into
        // cdm.json — a redeploy is picked up without shipping a new cdm.json.
        // Since product-sdk 0.18, fromLiveClient returns a Result instead of
        // throwing on resolution failure. The registry address comes from the
        // selected network, so devnet resolves against the devnet registry.
        const live = await ContractManager.fromLiveClient(
            _cdmJson,
            client,
            descriptor,
            {
                defaultOrigin: _state.account.address as never,
                defaultSigner: _state.account.signer,
                registryAddress: NETWORK.registry as never,
                registryOrigin: _state.account.address as never,
                libraries: ["@example/feedback"],
            },
        );
        if (!live.ok) throw live.error;
        _contractManager = live.value;
        _contract = wrapContract(_contractManager.getContract("@example/feedback"));
        console.log("[CDM] Contract manager ready (live registry resolution)");
    })();
    return _contractInitPromise;
}

/**
 * Get a lazy-initialized contract handle. The Asset Hub chain client doesn't
 * spin up until a method is actually called, so Bulletin preimage submits at
 * startup don't compete with a chain follow.
 */
export function getContract(): any {
    if (!_cdmJson) return null;
    return new Proxy({}, {
        get(_target, prop) {
            return new Proxy({} as any, {
                get(_t, methodProp) {
                    if (methodProp !== "query" && methodProp !== "tx") return undefined;
                    return async (...args: any[]) => {
                        await ensureContractsReady();
                        if (!_contract) throw new Error("Contract init failed");
                        const real = _contract[prop as string];
                        if (!real) throw new Error(`Unknown method: ${String(prop)}`);
                        // Since product-sdk 0.18, `.tx(...)` returns a Result
                        // instead of throwing. Unwrap it (re-throw the `err`
                        // channel) so call sites keep their try/catch flow.
                        // `.query(...)` is unchanged upstream.
                        const outcome = await real[methodProp](...args);
                        return methodProp === "tx" ? unwrapResult(outcome) : outcome;
                    };
                },
            });
        },
    });
}

/**
 * Format a 20-byte H160 for a contract `address` parameter. The product-sdk
 * encoder accepts a `0x...` hex string for both Solidity `address` and `bytes20`.
 */
export function asAddress(hexOrAccount: string | AppAccount): `0x${string}` {
    const hex = typeof hexOrAccount === "string" ? hexOrAccount : hexOrAccount.h160Address;
    if (!hex.startsWith("0x")) return ("0x" + hex) as `0x${string}`;
    return hex as `0x${string}`;
}

// ---------------------------------------------------------------------------
// Account mapping (Revive).
//
// pallet-revive on Paseo Next v2 requires every SS58 origin that calls a
// contract to have an explicit `Revive.map_account()` entry. Product accounts
// are NOT pre-mapped by the host — the first contract call from a fresh product
// account dry-run-fails with `Revive::AccountUnmapped` until we submit the
// mapping tx ourselves. The helper is idempotent: the first-time path costs one
// signature, subsequent calls short-circuit.
// ---------------------------------------------------------------------------

const _mappedAccounts = new Set<string>();

async function mapAccountWithRuntime(
    runtime: Parameters<typeof ensureContractAccountMapped>[0],
    account: AppAccount,
): Promise<void> {
    if (_mappedAccounts.has(account.address)) return;
    try {
        // Since product-sdk 0.18, ensureContractAccountMapped returns a Result
        // (ok(null) = already mapped) instead of throwing. Unwrap it so the
        // catch handles both a returned `err` and any thrown failure with the
        // same cause-chain logging.
        const mapped = unwrapResult(
            await ensureContractAccountMapped(runtime, account.address as never, account.signer),
        );
        if (mapped === null) {
            console.log(`[Revive] Account ${account.address} already mapped`);
        } else {
            console.log(`[Revive] Account mapped in block #${mapped.block.number}`);
        }
        _mappedAccounts.add(account.address);
    } catch (err) {
        console.error("[Revive] ensureContractAccountMapped failed:", err);
        const cause = err && typeof err === "object" ? (err as { cause?: unknown }).cause : undefined;
        if (cause) console.error("[Revive] underlying cause:", cause);
        throw err;
    }
}

export async function ensureMapping(account: AppAccount): Promise<void> {
    if (_mappedAccounts.has(account.address)) return;
    await ensureContractsReady();
    if (!_contractManager) throw new Error("Contract manager not ready");
    await mapAccountWithRuntime(_contractManager.getRuntime(), account);
}

// ---------------------------------------------------------------------------
// Bulletin reads via public IPFS gateways (Promise.any race).
// ---------------------------------------------------------------------------

const GATEWAYS = NETWORK.gateways;

export const IPFS_GATEWAY = GATEWAYS[0];

export async function fetchFromGateway(cid: string, timeoutMs = 30000): Promise<Uint8Array> {
    const master = new AbortController();
    const timer = setTimeout(() => master.abort(), timeoutMs);
    try {
        const winner = await Promise.any(
            GATEWAYS.map(async gw => {
                const resp = await fetch(gw + cid, { signal: master.signal });
                if (!resp.ok) throw new Error(`${gw} -> ${resp.status}`);
                return new Uint8Array(await resp.arrayBuffer());
            }),
        );
        master.abort();
        return winner;
    } finally {
        clearTimeout(timer);
    }
}

export async function fetchJsonFromBulletin<T = unknown>(cid: string): Promise<T> {
    const bytes = await fetchFromGateway(cid);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

// ---------------------------------------------------------------------------
// Misc helpers.
// ---------------------------------------------------------------------------

export const short = (addr: string) => addr.slice(0, 6) + "..." + addr.slice(-4);

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms),
        ),
    ]);
}

export const MAX_FEEDBACK_LENGTH = 280;

const STICKY_PALETTE = [
    "#fff59d", "#f8bbd0", "#bbdefb", "#c8e6c9", "#ffe0b2", "#d1c4e9",
];

function hashString(s: string, seed: number): number {
    let h = seed;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
}

export function colorForCid(cid: string): string {
    return STICKY_PALETTE[hashString(cid, 7) % STICKY_PALETTE.length];
}

export function tiltForCid(cid: string): number {
    const h = hashString(cid, 13);
    return ((h % 1000) / 100) - 5;
}

export function formatTime(unixSec: number): string {
    if (!unixSec) return "";
    const d = new Date(unixSec * 1000);
    const diffMs = Date.now() - d.getTime();
    const min = Math.floor(diffMs / 60000);
    if (min < 1) return "just now";
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d ago`;
    return d.toLocaleDateString();
}
