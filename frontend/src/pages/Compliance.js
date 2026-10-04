import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  RefreshCw,
  Fingerprint,
  ArrowRightLeft,
  Ban,
  ExternalLink,
  Server,
} from "lucide-react";
import { createPublicClient, http, parseAbi } from "viem";
import { toast } from "sonner";

import { API } from "@/lib/api";

/**
 * Compliance — Cleanverse CVI / CVA cockpit (Workstream 1).
 *
 * Shows the three things a reviewer needs to see to believe the coupling is real:
 *   • per-wallet CVI credential status (wallet-bound, issuer-signed, expiring)
 *   • every gated CVA movement the token has allowed or refused
 *   • every `cva.*` intent the pre-execution gate evaluated (CVI_UNVERIFIED denials)
 *
 * Reads come straight from the chain over JSON-RPC; the CVI service (services/cvi) is used
 * only for the "register / refresh credential" action, so the page still renders when the
 * service is offline.
 */

const RPC_URL =
  process.env.REACT_APP_MONAD_RPC ||
  process.env.REACT_APP_RPC_URL ||
  "https://testnet-rpc.monad.xyz";
// Addresses are read from the deployment manifest when the backend exposes it, otherwise
// from the build-time env — never hardcoded here.
const GATE_ADDRESS = process.env.REACT_APP_COMPLIANCE_GATE || "";
const CVA_ADDRESS = process.env.REACT_APP_CVA_TOKEN || "";
const CVI_SERVICE = process.env.REACT_APP_CVI_SERVICE_URL || "";
const EXPLORER = process.env.REACT_APP_EXPLORER_URL || "https://testnet.monadscan.com";
const START_BLOCK = BigInt(process.env.REACT_APP_DEPLOYMENT_BLOCK || "0");
const LOG_WINDOW = BigInt(process.env.REACT_APP_LOG_WINDOW || "20000");

const COMPLIANCE_GATE_ABI = parseAbi([
  "function credentialStatusOf(address wallet) view returns (uint8)",
  "function credentialOf(address wallet) view returns (address wallet_, bytes32 credentialHash, uint64 expiry, uint8 status, address issuer, uint64 verifiedAt)",
  "function isCVIValid(address wallet) view returns (bool)",
  "function gatedTransferCount() view returns (uint256)",
  "function defaultValidity() view returns (uint64)",
  "event CVIVerified(address indexed wallet, bytes32 credentialHash, uint256 expiry)",
  "event CVIRevoked(address indexed wallet, bytes32 credentialHash)",
  "event CVATransferGated(address indexed from, address indexed to, uint256 amount, bool allowed)",
]);

const INTENT_VAULT_ABI = parseAbi([
  "event CVIRequirementChecked(uint256 indexed agentId, bytes32 indexed intentHash, address wallet, bool verified)",
]);

const CVI_STATUS = {
  0: { label: "NOT VERIFIED", tone: "text-avaira-dim border-avaira-border", icon: ShieldAlert },
  1: { label: "VALID", tone: "text-avaira-green border-avaira-green/50", icon: ShieldCheck },
  2: { label: "EXPIRED", tone: "text-avaira-yellow border-avaira-yellow/50", icon: ShieldAlert },
  3: { label: "REVOKED", tone: "text-avaira-red border-avaira-red/50", icon: ShieldX },
};

const short = (value) => (value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "—");

export default function Compliance() {
  const [wallets, setWallets] = useState([]);
  const [walletInput, setWalletInput] = useState("");
  const [credentials, setCredentials] = useState([]);
  const [transfers, setTransfers] = useState([]);
  const [intentChecks, setIntentChecks] = useState([]);
  const [gateAddress, setGateAddress] = useState(GATE_ADDRESS);
  const [cvaAddress, setCvaAddress] = useState(CVA_ADDRESS);
  const [gatedCount, setGatedCount] = useState(null);
  const [loading, setLoading] = useState(false);
  const [serviceStatus, setServiceStatus] = useState(null);
  const [manifest, setManifest] = useState(null);

  const client = useMemo(() => createPublicClient({ transport: http(RPC_URL) }), []);

  /* Pick up addresses from the backend manifest when the build-time env is empty. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await axiosGetManifest();
        if (cancelled || !data) return;
        setManifest(data);
        if (!gateAddress && data.complianceGate) setGateAddress(data.complianceGate);
        if (!cvaAddress && data.cvaToken) setCvaAddress(data.cvaToken);
      } catch {
        /* manifest endpoint is optional */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadCredentials = useCallback(
    async (list) => {
      if (!gateAddress || list.length === 0) return;
      try {
        const rows = await Promise.all(
          list.map(async (wallet) => {
            const [status, credential] = await Promise.all([
              client.readContract({
                address: gateAddress,
                abi: COMPLIANCE_GATE_ABI,
                functionName: "credentialStatusOf",
                args: [wallet],
              }),
              client
                .readContract({
                  address: gateAddress,
                  abi: COMPLIANCE_GATE_ABI,
                  functionName: "credentialOf",
                  args: [wallet],
                })
                .catch(() => null),
            ]);
            return {
              wallet,
              status: Number(status),
              credentialHash: credential?.[1],
              expiry: credential?.[2] ? Number(credential[2]) : null,
              issuer: credential?.[4],
              verifiedAt: credential?.[5] ? Number(credential[5]) : null,
            };
          }),
        );
        setCredentials(rows);
      } catch (error) {
        toast.error(`Could not read credentials: ${error.shortMessage || error.message}`);
      }
    },
    [client, gateAddress],
  );

  const loadEvents = useCallback(async () => {
    if (!gateAddress) return;
    setLoading(true);
    try {
      const head = await client.getBlockNumber();
      const from = head - LOG_WINDOW > START_BLOCK ? head - LOG_WINDOW : START_BLOCK;

      const [gateLogs, vaultLogs] = await Promise.all([
        client.getLogs({
          address: gateAddress,
          fromBlock: from,
          toBlock: "latest",
          events: COMPLIANCE_GATE_ABI.filter((entry) => entry.type === "event"),
        }),
        manifest?.intentVault
          ? client
              .getLogs({
                address: manifest.intentVault,
                fromBlock: from,
                toBlock: "latest",
                events: INTENT_VAULT_ABI,
              })
              .catch(() => [])
          : Promise.resolve([]),
      ]);

      setTransfers(
        gateLogs
          .filter((log) => log.eventName === "CVATransferGated")
          .map((log) => ({
            from: log.args.from,
            to: log.args.to,
            amount: log.args.amount,
            allowed: log.args.allowed,
            block: Number(log.blockNumber),
            txHash: log.transactionHash,
          }))
          .reverse(),
      );
      setIntentChecks(
        vaultLogs
          .filter((log) => log.eventName === "CVIRequirementChecked")
          .map((log) => ({
            agentId: log.args.agentId,
            intentHash: log.args.intentHash,
            wallet: log.args.wallet,
            verified: log.args.verified,
            block: Number(log.blockNumber),
            txHash: log.transactionHash,
          }))
          .reverse(),
      );

      const count = await client.readContract({
        address: gateAddress,
        abi: COMPLIANCE_GATE_ABI,
        functionName: "gatedTransferCount",
      });
      setGatedCount(count);
    } catch (error) {
      toast.error(`RPC error: ${error.shortMessage || error.message}`);
    } finally {
      setLoading(false);
    }
  }, [client, gateAddress, manifest]);

  useEffect(() => {
    if (gateAddress) {
      loadCredentials(wallets);
      loadEvents();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateAddress, wallets.join(",")]);

  useEffect(() => {
    if (!CVI_SERVICE) return;
    fetch(`${CVI_SERVICE}/health`)
      .then((response) => (response.ok ? response.json() : null))
      .then(setServiceStatus)
      .catch(() => setServiceStatus(null));
  }, []);

  const addWallet = (event) => {
    event.preventDefault();
    const value = walletInput.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
      toast.error("Enter a 20-byte hex wallet address");
      return;
    }
    if (!wallets.some((wallet) => wallet.toLowerCase() === value.toLowerCase())) {
      setWallets([...wallets, value]);
    }
    setWalletInput("");
  };

  const refresh = () => {
    loadCredentials(wallets);
    loadEvents();
    toast.success("Refreshed from chain");
  };

  const configured = Boolean(gateAddress);

  return (
    <div className="p-6 space-y-6" data-testid="compliance-page">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl tracking-tight">COMPLIANCE</h1>
          <p className="page-subtitle font-mono text-xs text-avaira-muted mt-1">
            Cleanverse CVI/CVA — identity verification structurally coupled to asset movement
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-widest text-avaira-dim">
            rpc {short(RPC_URL.replace(/^https?:\/\//, ""))}
          </span>
          <button
            type="button"
            onClick={refresh}
            className="cyber-btn border border-avaira-purple text-avaira-purple px-3 py-2 font-heading text-xs flex items-center gap-1.5"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> REFRESH
          </button>
        </div>
      </div>

      {/* ── gate overview ─────────────────────────────────────────────────────────── */}
      <div className="grid gap-4 md:grid-cols-4">
        <Stat label="COMPLIANCE GATE" value={configured ? short(gateAddress) : "not configured"} mono />
        <Stat label="CVA TOKEN" value={cvaAddress ? short(cvaAddress) : "not configured"} mono />
        <Stat label="GATED TRANSFERS" value={gatedCount === null ? "—" : gatedCount.toString()} />
        <Stat
          label="CVI SERVICE"
          value={serviceStatus ? `${serviceStatus.mode.toUpperCase()} · :${8403}` : CVI_SERVICE ? "offline" : "not configured"}
          hint={serviceStatus ? `gate ${short(serviceStatus.complianceGate)}` : undefined}
        />
      </div>

      {!configured && (
        <div className="border border-avaira-yellow/40 bg-avaira-card p-4 font-mono text-xs text-avaira-yellow">
          Set REACT_APP_COMPLIANCE_GATE (and REACT_APP_CVA_TOKEN) to the addresses written by
          <span className="text-avaira-dim"> make deploy-monad</span>, or expose the manifest from the backend, to light up this page.
        </div>
      )}

      {/* ── credential inspector ──────────────────────────────────────────────────── */}
      <section className="border border-avaira-border bg-avaira-card">
        <header className="flex items-center justify-between border-b border-avaira-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Fingerprint size={14} className="text-avaira-data" />
            <h2 className="font-heading text-sm tracking-wide">WALLET CVI CREDENTIALS</h2>
          </div>
          <span className="font-mono text-[10px] text-avaira-dim">
            wallet-bound · issuer-signed · expiring
          </span>
        </header>

        <form onSubmit={addWallet} className="flex flex-wrap gap-2 border-b border-avaira-border px-4 py-3">
          <input
            value={walletInput}
            onChange={(event) => setWalletInput(event.target.value)}
            placeholder="0x wallet address to inspect"
            className="flex-1 min-w-[280px] bg-avaira-bg border border-avaira-border px-3 py-2 font-mono text-xs text-avaira-muted focus:border-avaira-primary outline-none"
          />
          <button
            type="submit"
            className="cyber-btn border border-avaira-data text-avaira-data px-3 py-2 font-heading text-xs"
          >
            INSPECT
          </button>
        </form>

        {credentials.length === 0 ? (
          <p className="px-4 py-6 font-mono text-xs text-avaira-dim">
            No wallets tracked yet. Add the agent, operator or counterparty wallet you want to watch.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full font-mono text-xs">
              <thead className="text-avaira-muted">
                <tr className="border-b border-avaira-border">
                  <th className="px-4 py-2 text-left">WALLET</th>
                  <th className="px-4 py-2 text-left">STATUS</th>
                  <th className="px-4 py-2 text-left">EXPIRY</th>
                  <th className="px-4 py-2 text-left">CREDENTIAL HASH</th>
                  <th className="px-4 py-2 text-left">ISSUER</th>
                </tr>
              </thead>
              <tbody>
                {credentials.map((row) => {
                  const meta = CVI_STATUS[row.status] || CVI_STATUS[0];
                  const Icon = meta.icon;
                  return (
                    <tr key={row.wallet} className="border-b border-avaira-border/50">
                      <td className="px-4 py-2 text-avaira-muted">{short(row.wallet)}</td>
                      <td className="px-4 py-2">
                        <span className={`inline-flex items-center gap-1 border px-2 py-0.5 ${meta.tone}`}>
                          <Icon size={11} /> {meta.label}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-avaira-muted">
                        {row.expiry ? new Date(row.expiry * 1000).toISOString().slice(0, 19).replace("T", " ") : "—"}
                      </td>
                      <td className="px-4 py-2 text-avaira-dim">{short(row.credentialHash)}</td>
                      <td className="px-4 py-2 text-avaira-dim">{short(row.issuer)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── gated movements ───────────────────────────────────────────────────────── */}
      <section className="border border-avaira-border bg-avaira-card">
        <header className="flex items-center justify-between border-b border-avaira-border px-4 py-3">
          <div className="flex items-center gap-2">
            <ArrowRightLeft size={14} className="text-avaira-purple" />
            <h2 className="font-heading text-sm tracking-wide">GATED CVA MOVEMENTS</h2>
          </div>
          <span className="font-mono text-[10px] text-avaira-dim">
            last {LOG_WINDOW.toString()} blocks · CVATransferGated
          </span>
        </header>
        {transfers.length === 0 ? (
          <p className="px-4 py-6 font-mono text-xs text-avaira-dim">
            No CVA movement in the scanned window. Allowed transfers are emitted by the token
            itself; refusals are recorded with <span className="text-avaira-muted">recordGatedTransfer</span>.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full font-mono text-xs">
              <thead className="text-avaira-muted">
                <tr className="border-b border-avaira-border">
                  <th className="px-4 py-2 text-left">BLOCK</th>
                  <th className="px-4 py-2 text-left">FROM</th>
                  <th className="px-4 py-2 text-left">TO</th>
                  <th className="px-4 py-2 text-left">AMOUNT (CVA)</th>
                  <th className="px-4 py-2 text-left">DECISION</th>
                  <th className="px-4 py-2 text-left">TX</th>
                </tr>
              </thead>
              <tbody>
                {transfers.map((row) => (
                  <tr key={`${row.txHash}-${row.block}`} className="border-b border-avaira-border/50">
                    <td className="px-4 py-2 text-avaira-dim">{row.block}</td>
                    <td className="px-4 py-2 text-avaira-muted">{short(row.from)}</td>
                    <td className="px-4 py-2 text-avaira-muted">{short(row.to)}</td>
                    <td className="px-4 py-2 text-avaira-muted">{(Number(row.amount) / 1e18).toFixed(2)}</td>
                    <td className="px-4 py-2">
                      {row.allowed ? (
                        <span className="inline-flex items-center gap-1 text-avaira-green">
                          <ShieldCheck size={11} /> ALLOWED
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-avaira-red">
                          <Ban size={11} /> CVI_MISSING / CVI_EXPIRED / CVI_REVOKED
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <a
                        href={`${EXPLORER}/tx/${row.txHash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-avaira-data hover:underline"
                      >
                        {short(row.txHash)} <ExternalLink size={10} />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── intent gate decisions ─────────────────────────────────────────────────── */}
      <section className="border border-avaira-border bg-avaira-card">
        <header className="flex items-center justify-between border-b border-avaira-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Server size={14} className="text-avaira-green" />
            <h2 className="font-heading text-sm tracking-wide">CVI GATE DECISIONS (cva.* INTENTS)</h2>
          </div>
          <span className="font-mono text-[10px] text-avaira-dim">CVIRequirementChecked</span>
        </header>
        {intentChecks.length === 0 ? (
          <p className="px-4 py-6 font-mono text-xs text-avaira-dim">
            No `cva.*` intent has been traced yet. Run{" "}
            <span className="text-avaira-muted">npm run demo:cvi-cva</span> — scenario 4 records a
            CVI_UNVERIFIED denial on-chain.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full font-mono text-xs">
              <thead className="text-avaira-muted">
                <tr className="border-b border-avaira-border">
                  <th className="px-4 py-2 text-left">AGENT</th>
                  <th className="px-4 py-2 text-left">INTENT</th>
                  <th className="px-4 py-2 text-left">WALLET</th>
                  <th className="px-4 py-2 text-left">CVI</th>
                  <th className="px-4 py-2 text-left">TX</th>
                </tr>
              </thead>
              <tbody>
                {intentChecks.map((row) => (
                  <tr key={`${row.txHash}-${row.wallet}`} className="border-b border-avaira-border/50">
                    <td className="px-4 py-2 text-avaira-muted">#{row.agentId.toString()}</td>
                    <td className="px-4 py-2 text-avaira-dim">{short(row.intentHash)}</td>
                    <td className="px-4 py-2 text-avaira-muted">{short(row.wallet)}</td>
                    <td className="px-4 py-2">
                      {row.verified ? (
                        <span className="text-avaira-green">VERIFIED</span>
                      ) : (
                        <span className="text-avaira-red">CVI_UNVERIFIED</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <a
                        href={`${EXPLORER}/tx/${row.txHash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-avaira-data hover:underline"
                      >
                        {short(row.txHash)} <ExternalLink size={10} />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, hint, mono }) {
  return (
    <div className="border border-avaira-border bg-avaira-card p-4">
      <span className="font-mono text-[10px] text-avaira-muted uppercase tracking-widest block mb-1">{label}</span>
      <span className={`text-sm text-avaira-muted ${mono ? "font-mono" : "font-heading"}`}>{value}</span>
      {hint ? <span className="block font-mono text-[10px] text-avaira-dim mt-1">{hint}</span> : null}
    </div>
  );
}

/** The backend may expose the deployment manifest; the page degrades gracefully when absent. */
async function axiosGetManifest() {
  try {
    const response = await fetch(`${API}/deployments/active`);
    if (!response.ok) return { data: null };
    return { data: await response.json() };
  } catch {
    return { data: null };
  }
}
