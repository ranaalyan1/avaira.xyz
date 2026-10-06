from fastapi import FastAPI, APIRouter, HTTPException, Query, Request, Depends
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse, RedirectResponse
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import ReturnDocument
from pymongo.errors import ServerSelectionTimeoutError
import os
import logging
import hashlib
import hmac
import json
import secrets
import httpx
import base64
from pathlib import Path
from pydantic import BaseModel, Field, ConfigDict
from typing import List, Optional, Dict, Any
import uuid
import time
import asyncio
import re
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta
from urllib.parse import urlencode, urlparse

try:
    from .agent_runtime import AvairaAgent, RuntimeRiskEnvelope
    from .permit import generate_permit, verify_permit, PermitNonceRegistry
except ImportError:  # pragma: no cover
    from agent_runtime import AvairaAgent, RuntimeRiskEnvelope
    from permit import generate_permit, verify_permit, PermitNonceRegistry

# Core Trust Engine Imports
try:
    from core.intent_logger import IntentLogger
    from core.validator import AvairaValidator
    from core.slash_engine import SlashEngine
    from core.reputation import ReputationEngine
    from core.agent_vault import AgentVault
    from core.sentinel import AvairaSentinel
    from core.zk_vault import ZKAuditVault
    from core.ape_engine import AutonomousPolicyEvolution
    from core.tee_identity import TEEIdentityManager
    from core.marketplace import TrustMarketplace
    from agents.avaira_agent import AvairaAgent as RealAvairaAgent
except ImportError:
    from .core.intent_logger import IntentLogger
    from .core.validator import AvairaValidator
    from .core.slash_engine import SlashEngine
    from .core.reputation import ReputationEngine
    from .core.agent_vault import AgentVault
    from .core.sentinel import AvairaSentinel
    from .core.zk_vault import ZKAuditVault
    from .core.ape_engine import AutonomousPolicyEvolution
    from .core.tee_identity import TEEIdentityManager
    from .core.marketplace import TrustMarketplace
    from .agents.avaira_agent import AvairaAgent as RealAvairaAgent

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

def _get_required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


mongo_url = _get_required_env("MONGO_URL")
db_name = _get_required_env("DB_NAME")
client = AsyncIOMotorClient(mongo_url, serverSelectionTimeoutMS=3000)
db = client[db_name]
# Replay protection for execution permits: every consumed (agent, nonce) pair is
# recorded once (unique index below), so a captured permit cannot be replayed.
permit_nonces = PermitNonceRegistry(db.permit_nonces)
api_router = APIRouter(prefix="/api")
DATABASE_READY = True

# Initialize Core Engines
intent_logger = IntentLogger(db_client=db)
avaira_validator = AvairaValidator()
slash_engine = SlashEngine(db_client=db)
reputation_engine = ReputationEngine(db_client=db)
agent_vault = AgentVault()
avaira_sentinel = AvairaSentinel(db_client=db)
zk_vault = ZKAuditVault()
ape_engine = AutonomousPolicyEvolution(db_client=db)
tee_identity_manager = TEEIdentityManager()
trust_marketplace = TrustMarketplace(db_client=db)

# ─── PROTOCOL CONSTANTS ─────────────────────────────────────────
PROTOCOL_FEE_RATE = 0.005  # 0.5%
TRUST_POOL_SHARE = 0.75
PROTOCOL_REVENUE_SHARE = 0.25
INITIAL_REPUTATION = 100
REP_SUCCESS_BONUS = 2
REP_FAILURE_PENALTY = 5
REP_FREEZE_PENALTY = 20
REP_SLASH_PENALTY = 10
SLASH_RATE = 0.5  # 50% of collateral
AVAIRA_GRADES = [('AAA', 90, 100), ('AA', 80, 89), ('A', 70, 79), ('BBB', 60, 69), ('BB', 50, 59), ('B', 40, 49), ('CCC', 30, 39), ('D', 0, 29)]
MISSION_FEE_AGENT = 0.85
MISSION_FEE_UNDERWRITER = 0.10
MISSION_FEE_PROTOCOL = 0.05
SUBSCRIPTION_TIERS = {
    'free': {'price': 0, 'max_agents': 1, 'features': ['basic_monitoring', 'community_rating']},
    'growth': {'price': 200, 'max_agents': 10, 'features': ['enhanced_monitoring', 'verified_badge', 'priority_support']},
    'enterprise': {'price': 2000, 'max_agents': -1, 'features': ['unlimited_agents', 'custom_risk', 'compliance_reports', 'dedicated_pool']}
}

AGENT_REGISTRY_ADDRESS = os.environ.get("AGENT_REGISTRY_ADDRESS", "")
EXECUTION_WALLET_ADDRESS = os.environ.get("EXECUTION_WALLET_ADDRESS", "")
FREEZE_SLASH_ADDRESS = os.environ.get("FREEZE_SLASH_ADDRESS", "")
TREASURY_ADDRESS = os.environ.get("TREASURY_ADDRESS", "")
REPUTATION_ENGINE_ADDRESS = os.environ.get("REPUTATION_ENGINE_ADDRESS", "")

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')

if "localhost" in mongo_url.lower():
    logger.warning("WARNING: Using local MongoDB. Switch to Atlas for production.")

AVAIRA_ADMIN_KEY = os.environ.get("AVAIRA_ADMIN_KEY", "")
PERMIT_SECRET = _get_required_env("PERMIT_SECRET")
ADMIN_EMAILS = {email.strip().lower() for email in os.environ.get("ADMIN_EMAILS", "").split(",") if email.strip()}
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "true").lower() == "true"
COOKIE_SAMESITE = "none" if COOKIE_SECURE else "lax"
SESSION_MAX_AGE_SECONDS = int(os.environ.get("SESSION_MAX_AGE_SECONDS", str(7 * 24 * 60 * 60)))
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "").strip()
GOOGLE_REDIRECT_URI = os.environ.get("GOOGLE_REDIRECT_URI", "").strip()
X_CLIENT_ID = os.environ.get("X_CLIENT_ID", "").strip()
X_CLIENT_SECRET = os.environ.get("X_CLIENT_SECRET", "").strip()
X_REDIRECT_URI = os.environ.get("X_REDIRECT_URI", "").strip()
DEFAULT_POST_LOGIN_REDIRECT = os.environ.get("DEFAULT_POST_LOGIN_REDIRECT", "http://localhost:3000/dashboard").strip()
ALLOWED_REDIRECT_ORIGINS = {origin.strip() for origin in os.environ.get("ALLOWED_REDIRECT_ORIGINS", "http://localhost:3000").split(",") if origin.strip()}
RATE_LIMIT_STATE: Dict[str, List[float]] = {}
RATE_LIMIT_LOCK = asyncio.Lock()
RATE_LIMIT_LAST_SWEEP = 0.0
EVM_ADDRESS_RE = re.compile(r"^0x[a-fA-F0-9]{40}$")



def _get_client_ip(request: Request) -> str:
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


def _hash_session_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def enforce_rate_limit(request: Request, scope: str, limit: int, window_seconds: int, identity: Optional[str] = None):
    global RATE_LIMIT_LAST_SWEEP
    now = time.time()
    key = f"{scope}:{identity or _get_client_ip(request)}"
    async with RATE_LIMIT_LOCK:
        if now - RATE_LIMIT_LAST_SWEEP > 60:
            stale_keys = []
            for existing_key, existing_timestamps in RATE_LIMIT_STATE.items():
                if not existing_timestamps or now - existing_timestamps[-1] > window_seconds:
                    stale_keys.append(existing_key)
            for stale_key in stale_keys:
                RATE_LIMIT_STATE.pop(stale_key, None)
            RATE_LIMIT_LAST_SWEEP = now

        timestamps = RATE_LIMIT_STATE.get(key, [])
        timestamps = [ts for ts in timestamps if now - ts < window_seconds]
        if len(timestamps) >= limit:
            retry_after = max(1, int(window_seconds - (now - timestamps[0])))
            raise HTTPException(429, f"Rate limit exceeded. Retry in {retry_after} seconds")
        timestamps.append(now)
        RATE_LIMIT_STATE[key] = timestamps


def is_valid_evm_address(address: str) -> bool:
    return bool(EVM_ADDRESS_RE.match(address))


async def ensure_indexes():
    # Core lookup indexes to avoid collection scans in high-frequency APIs.
    await db.agents.create_index("id", unique=True)
    await db.agents.create_index([("status", 1), ("registered_at", -1)])
    await db.agents.create_index("wallet_address")
    await db.executions.create_index("id", unique=True)
    await db.executions.create_index([("agent_id", 1), ("created_at", -1)])
    await db.executions.create_index([("status", 1), ("created_at", -1)])
    await db.freeze_events.create_index([("agent_id", 1), ("timestamp", -1)])
    await db.reputation_history.create_index([("agent_id", 1), ("timestamp", -1)])
    await db.treasury_transactions.create_index("execution_id")
    await db.treasury_transactions.create_index("timestamp")
    await db.missions.create_index("id", unique=True)
    await db.missions.create_index([("status", 1), ("created_at", -1)])
    await db.underwriters.create_index("id", unique=True)
    await db.user_sessions.create_index("session_token_hash")
    await db.user_sessions.create_index("expires_at")
    await db.users.create_index("email", unique=True)
    # Unique per (agent, nonce) — the previous unique index on `agent_id` alone would
    # have allowed exactly one permit *ever* per agent, and still left the nonce unread.
    await db.permit_nonces.create_index([("agent_id", 1), ("nonce", 1)], unique=True)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global DATABASE_READY
    try:
        await ensure_indexes()
        DATABASE_READY = True
    except ServerSelectionTimeoutError as exc:
        DATABASE_READY = False
        logger.warning(f"WARNING: MongoDB unavailable. Starting in degraded mode. {exc}")
    yield
    client.close()


app = FastAPI(title="AVAIRA Protocol API", lifespan=lifespan)

# ─── PYDANTIC MODELS ────────────────────────────────────────────
class RiskEnvelope(BaseModel):
    max_spend_usd: float = 0.0
    max_spend_per_action_usd: float = 0.0
    allowed_actions: List[str] = []
    blocked_actions: List[str] = []
    allowed_targets: List[str] = []
    max_concurrent_tasks: int = 1
    require_human_approval_above_usd: float = 100.0
    custom_rules: List[str] = []

class AgentCreate(BaseModel):
    name: str
    goal: str
    risk_envelope: RiskEnvelope = RiskEnvelope()
    webhook_url: Optional[str] = None

class AgentResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    name: str
    wallet_address: str
    collateral_amount: float
    collateral_remaining: float
    mission_intent: str
    risk_envelope: Dict[str, Any]
    status: str
    reputation: float
    total_executions: int
    successful_executions: int
    failed_executions: int
    registered_at: str
    chain_id: str

class ExecutionRequestCreate(BaseModel):
    agent_id: str
    action: str
    target_address: str = "0x0000000000000000000000000000000000000000"
    value: float = 0.0
    data: str = ""
    chain_id: str = "43113"

class FreezeRequest(BaseModel):
    reason: str

class SlashRequest(BaseModel):
    reason: str
    amount: Optional[float] = None

class UnderwriterCreate(BaseModel):
    name: str
    wallet_address: str = ""
    capital_amount: float

class MissionCreate(BaseModel):
    agent_id: str
    description: str
    target_value: float
    duration_hours: int = 24
    risk_level: str = "medium"

class MissionStake(BaseModel):
    underwriter_id: str
    amount: float


class AgentThinkRequest(BaseModel):
    agent_address: str
    mission_goal: str
    risk_envelope: Dict[str, Any]
    market_context: Dict[str, Any] = Field(default_factory=dict)
    history: List[Dict[str, Any]] = Field(default_factory=list)

class AgentRunRequest(BaseModel):
    task: str
    context: Optional[Dict[str, Any]] = None

# ─── HELPER FUNCTIONS ────────────────────────────────────────────


def _execution_failure_response(execution: Dict[str, Any], error_message: str, status_code: int) -> JSONResponse:
    execution.pop("tx_hash", None)
    execution["execution_failed"] = True
    execution["error_message"] = error_message
    return JSONResponse(status_code=status_code, content=execution)


def _grade_from_score(score: float) -> str:
    if score >= 90:
        return "A+"
    if score >= 80:
        return "A"
    if score >= 70:
        return "B"
    if score >= 60:
        return "C"
    return "D"


async def _normalize_score(agent: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not agent:
        return {"score": 50, "grade": "C"}
    try:
        score_obj = await reputation_engine.compute_score(agent["id"])
        return {"score": score_obj.score, "grade": score_obj.grade}
    except Exception:
        if "avaira_score" in agent:
            score = max(0, min(100, int(round(agent.get("avaira_score", 50)))))
        else:
            score = max(0, min(100, int(round(agent.get("reputation", INITIAL_REPUTATION) / 2))))
        return {"score": score, "grade": agent.get("grade", _grade_from_score(score))}


async def _ensure_ai_agent_record(body: AgentThinkRequest, user_id: Optional[str] = None) -> Dict[str, Any]:
    existing = await db.agents.find_one({"wallet_address": body.agent_address}, {"_id": 0})
    timestamp = datetime.now(timezone.utc).isoformat()
    if existing and user_id:
        owner = existing.get("user_id")
        if owner not in (None, "", "system") and owner != user_id:
            raise HTTPException(403, "You do not own this agent")
    # body.risk_envelope is a Dict[str, Any] as per AgentThinkRequest model
    if existing:
        updates = {
            "mission_intent": body.mission_goal,
            "risk_envelope": body.risk_envelope,
            "updated_at": timestamp,
            "status": existing.get("status", "active"),
        }
        await db.agents.update_one({"wallet_address": body.agent_address}, {"$set": updates})
        existing.update(updates)
        return existing

    agent = {
        "id": str(uuid.uuid4()),
        "name": f"AI Agent {body.agent_address[:6]}",
        "wallet_address": body.agent_address,
        "user_id": user_id or "system",
        "collateral_amount": 0.1,
        "collateral_remaining": 0.1,
        "mission_intent": body.mission_goal,
        "risk_envelope": body.risk_envelope,
        "status": "active",
        "reputation": INITIAL_REPUTATION,
        "avaira_score": 50,
        "grade": "C",
        "runtime_nonce": 0,
        "total_executions": 0,
        "successful_executions": 0,
        "failed_executions": 0,
        "registered_at": timestamp,
        "chain_id": "43113",
        "agent_type": "local-runtime",
    }
    await db.agents.insert_one(agent)
    return agent


async def _write_reputation_snapshot(agent: Dict[str, Any], new_score: int, reason: str):
    score_payload = await _normalize_score(agent)
    previous = score_payload["score"]
    grade = _grade_from_score(new_score)
    await db.agents.update_one(
        {"id": agent["id"]},
        {
            "$set": {
                "avaira_score": new_score,
                "grade": grade,
                "reputation": min(200, max(0, new_score * 2)),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
        },
    )
    await db.reputation_history.insert_one(
        {
            "id": str(uuid.uuid4()),
            "agent_id": agent["id"],
            "agent_name": agent.get("name", agent["wallet_address"]),
            "old_score": previous,
            "new_score": new_score,
            "delta": new_score - previous,
            "reason": reason,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
    )

def validate_risk_envelope(request_data: Dict, risk_envelope: Dict) -> Dict:
    violations = []
    max_spend = risk_envelope.get("max_spend_usd") or risk_envelope.get("max_tx_value", 10.0)
    if request_data.get("value", 0) > max_spend:
        violations.append(f"Value {request_data['value']} exceeds max {max_spend}")
    if request_data.get("action") not in risk_envelope.get("allowed_actions", []):
        violations.append(f"Action '{request_data['action']}' not in allowed actions")
    return {"valid": len(violations) == 0, "violations": violations}

async def update_reputation(agent_id: str, delta: float, reason: str):
    agent = await db.agents.find_one({"id": agent_id}, {"_id": 0})
    if not agent:
        return
    old_score = agent.get("reputation", INITIAL_REPUTATION)
    new_score = max(0, min(200, old_score + delta))
    await db.agents.update_one({"id": agent_id}, {"$set": {"reputation": new_score}})
    history_entry = {
        "id": str(uuid.uuid4()),
        "agent_id": agent_id,
        "agent_name": agent.get("name", "Unknown"),
        "old_score": old_score,
        "new_score": new_score,
        "delta": delta,
        "reason": reason,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    await db.reputation_history.insert_one(history_entry)


async def record_treasury_transaction(execution_id: str, total_fee: float):
    trust_pool = round(total_fee * TRUST_POOL_SHARE, 6)
    protocol_revenue = round(total_fee * PROTOCOL_REVENUE_SHARE, 6)
    tx = {
        "id": str(uuid.uuid4()),
        "execution_id": execution_id,
        "total_fee": round(total_fee, 6),
        "trust_pool_share": trust_pool,
        "protocol_revenue_share": protocol_revenue,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    await db.treasury_transactions.insert_one(tx)


async def record_admin_audit(action: str, admin_user: Dict[str, Any], request: Request, payload: Dict[str, Any]):
    entry = {
        "id": str(uuid.uuid4()),
        "action": action,
        "admin_user_id": admin_user.get("user_id"),
        "admin_email": admin_user.get("email"),
        "ip": request.client.host if request.client else None,
        "user_agent": request.headers.get("user-agent", ""),
        "payload": payload,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    await db.admin_audit_log.insert_one(entry)

# ─── AUTH ENDPOINTS ──────────────────────────────────────────────
def _base64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _base64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def _is_allowed_redirect(target: str) -> bool:
    parsed = urlparse(target)
    if parsed.scheme not in {"http", "https"}:
        return False
    origin = f"{parsed.scheme}://{parsed.netloc}"
    return origin in ALLOWED_REDIRECT_ORIGINS


def _resolve_post_login_redirect(redirect: Optional[str]) -> str:
    target = (redirect or DEFAULT_POST_LOGIN_REDIRECT).strip()
    if not _is_allowed_redirect(target):
        raise HTTPException(400, "Invalid redirect target")
    return target


def _build_oauth_state(provider: str, redirect: str, code_verifier: Optional[str] = None) -> str:
    payload: Dict[str, Any] = {
        "provider": provider,
        "redirect": redirect,
        "exp": int(time.time()) + 600,
        "nonce": secrets.token_urlsafe(12),
    }
    if code_verifier:
        payload["cv"] = code_verifier
    payload_raw = json.dumps(payload, separators=(",", ":")).encode()
    payload_b64 = _base64url_encode(payload_raw)
    sig = hmac.new(PERMIT_SECRET.encode(), payload_b64.encode(), hashlib.sha256).hexdigest()
    return f"{payload_b64}.{sig}"


def _parse_oauth_state(state: str) -> Dict[str, Any]:
    try:
        payload_b64, sig = state.split(".", 1)
    except ValueError as exc:
        raise HTTPException(400, "Invalid OAuth state") from exc
    expected_sig = hmac.new(PERMIT_SECRET.encode(), payload_b64.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected_sig):
        raise HTTPException(400, "Invalid OAuth state signature")
    try:
        payload = json.loads(_base64url_decode(payload_b64).decode())
    except Exception as exc:
        raise HTTPException(400, "Invalid OAuth state payload") from exc
    if int(payload.get("exp", 0)) < int(time.time()):
        raise HTTPException(400, "OAuth state expired")
    return payload


def _pkce_challenge(code_verifier: str) -> str:
    digest = hashlib.sha256(code_verifier.encode()).digest()
    return _base64url_encode(digest)


async def _create_local_session(email: str, name: str, picture: str) -> Dict[str, str]:
    existing = await db.users.find_one({"email": email}, {"_id": 0})
    if existing:
        user_id = existing["user_id"]
        await db.users.update_one({"email": email}, {"$set": {"name": name, "picture": picture}})
    else:
        user_id = f"user_{uuid.uuid4().hex[:12]}"
        await db.users.insert_one({
            "user_id": user_id,
            "email": email,
            "name": name,
            "picture": picture,
            "created_at": datetime.now(timezone.utc).isoformat(),
        })

    session_token = secrets.token_urlsafe(48)
    await db.user_sessions.insert_one({
        "user_id": user_id,
        "session_token_hash": _hash_session_token(session_token),
        "expires_at": (datetime.now(timezone.utc) + timedelta(seconds=SESSION_MAX_AGE_SECONDS)).isoformat(),
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    return {"user_id": user_id, "session_token": session_token, "email": email, "name": name, "picture": picture}


def _set_session_cookie(resp: RedirectResponse, session_token: str):
    resp.set_cookie(
        "session_token",
        session_token,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite=COOKIE_SAMESITE,
        path="/",
        max_age=SESSION_MAX_AGE_SECONDS,
    )


def _require_google_oauth_config():
    if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET or not GOOGLE_REDIRECT_URI:
        raise HTTPException(503, "Google OAuth is not configured")


def _require_x_oauth_config():
    if not X_CLIENT_ID or not X_CLIENT_SECRET or not X_REDIRECT_URI:
        raise HTTPException(503, "X OAuth is not configured")


@api_router.get("/auth/google/login")
async def auth_google_login(redirect: Optional[str] = None):
    _require_google_oauth_config()
    target_redirect = _resolve_post_login_redirect(redirect)
    state = _build_oauth_state("google", target_redirect)
    params = urlencode({
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "access_type": "offline",
        "prompt": "select_account",
    })
    return RedirectResponse(f"https://accounts.google.com/o/oauth2/v2/auth?{params}")


@api_router.get("/auth/google/callback")
async def auth_google_callback(code: str, state: str):
    _require_google_oauth_config()
    parsed_state = _parse_oauth_state(state)
    if parsed_state.get("provider") != "google":
        raise HTTPException(400, "OAuth provider mismatch")

    async with httpx.AsyncClient(timeout=20) as http_client:
        token_resp = await http_client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "code": code,
                "client_id": GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "redirect_uri": GOOGLE_REDIRECT_URI,
                "grant_type": "authorization_code",
            },
        )
        if token_resp.status_code != 200:
            raise HTTPException(401, "Google token exchange failed")
        access_token = token_resp.json().get("access_token", "")
        if not access_token:
            raise HTTPException(401, "Google access token missing")

        user_resp = await http_client.get(
            "https://openidconnect.googleapis.com/v1/userinfo",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        if user_resp.status_code != 200:
            raise HTTPException(401, "Google user profile fetch failed")
        user_data = user_resp.json()

    email = user_data.get("email", "")
    name = user_data.get("name", "Google User")
    picture = user_data.get("picture", "")
    if not email:
        raise HTTPException(401, "Google account email is required")

    session = await _create_local_session(email=email, name=name, picture=picture)
    resp = RedirectResponse(parsed_state["redirect"])
    _set_session_cookie(resp, session["session_token"])
    return resp


@api_router.get("/auth/x/login")
async def auth_x_login(redirect: Optional[str] = None):
    _require_x_oauth_config()
    target_redirect = _resolve_post_login_redirect(redirect)
    code_verifier = secrets.token_urlsafe(64)
    state = _build_oauth_state("x", target_redirect, code_verifier=code_verifier)
    params = urlencode({
        "response_type": "code",
        "client_id": X_CLIENT_ID,
        "redirect_uri": X_REDIRECT_URI,
        "scope": "tweet.read users.read offline.access",
        "state": state,
        "code_challenge": _pkce_challenge(code_verifier),
        "code_challenge_method": "S256",
    })
    return RedirectResponse(f"https://twitter.com/i/oauth2/authorize?{params}")


@api_router.get("/auth/x/callback")
async def auth_x_callback(code: str, state: str):
    _require_x_oauth_config()
    parsed_state = _parse_oauth_state(state)
    if parsed_state.get("provider") != "x":
        raise HTTPException(400, "OAuth provider mismatch")
    code_verifier = parsed_state.get("cv", "")
    if not code_verifier:
        raise HTTPException(400, "Missing PKCE verifier")

    async with httpx.AsyncClient(timeout=20) as http_client:
        token_resp = await http_client.post(
            "https://api.twitter.com/2/oauth2/token",
            data={
                "code": code,
                "grant_type": "authorization_code",
                "redirect_uri": X_REDIRECT_URI,
                "code_verifier": code_verifier,
                "client_id": X_CLIENT_ID,
            },
            auth=(X_CLIENT_ID, X_CLIENT_SECRET),
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        if token_resp.status_code != 200:
            raise HTTPException(401, "X token exchange failed")
        access_token = token_resp.json().get("access_token", "")
        if not access_token:
            raise HTTPException(401, "X access token missing")

        user_resp = await http_client.get(
            "https://api.twitter.com/2/users/me?user.fields=profile_image_url,name,username",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        if user_resp.status_code != 200:
            raise HTTPException(401, "X profile fetch failed")
        x_data = user_resp.json().get("data", {})

    x_user_id = x_data.get("id", "")
    username = x_data.get("username", "")
    if not x_user_id or not username:
        raise HTTPException(401, "X profile is incomplete")

    email = f"x_{x_user_id}@x.avaira.local"
    name = x_data.get("name") or username
    picture = x_data.get("profile_image_url", "")
    session = await _create_local_session(email=email, name=name, picture=picture)
    resp = RedirectResponse(parsed_state["redirect"])
    _set_session_cookie(resp, session["session_token"])
    return resp

@api_router.get("/auth/me")
async def get_current_user(request: Request):
    token = request.cookies.get("session_token")
    if not token:
        auth_header = request.headers.get("Authorization")
        if auth_header and auth_header.startswith("Bearer "):
            token = auth_header.split(" ")[1]
    if not token:
        raise HTTPException(401, "Not authenticated")
    session = await db.user_sessions.find_one({"session_token_hash": _hash_session_token(token)}, {"_id": 0})
    if not session:
        raise HTTPException(401, "Invalid session")
    expires_at = session["expires_at"]
    if isinstance(expires_at, str):
        expires_at = datetime.fromisoformat(expires_at)
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at < datetime.now(timezone.utc):
        raise HTTPException(401, "Session expired")
    user = await db.users.find_one({"user_id": session["user_id"]}, {"_id": 0})
    if not user:
        raise HTTPException(401, "User not found")
    user["is_admin"] = (user.get("email", "").lower() in ADMIN_EMAILS)
    return user


async def require_authenticated_user(request: Request) -> Dict[str, Any]:
    return await get_current_user(request)


async def require_admin_user(request: Request) -> Dict[str, Any]:
    if not ADMIN_EMAILS:
        logger.error("ADMIN_EMAILS is not configured; refusing admin actions")
        raise HTTPException(503, "Server admin configuration missing")
    user = await get_current_user(request)
    email = (user.get("email") or "").lower()
    await enforce_rate_limit(request, "admin_actions", limit=60, window_seconds=60, identity=email or None)
    if email not in ADMIN_EMAILS:
        raise HTTPException(403, "Admin privileges required")
    return user

async def require_agent_access(request: Request, agent: Dict[str, Any]) -> Dict[str, Any]:
    """Authorize the caller to act for `agent`.

    Two legitimate callers exist:

    * the agent itself, presenting its ``X-Avaira-API-Key`` (SDK / runtime path);
    * a signed-in user who owns the agent (dashboard path).

    Anonymous callers are refused: a public endpoint that freezes agents on "envelope
    deviation" let anyone freeze any agent with one request (and dock it 20 reputation).
    """
    api_key = request.headers.get("X-Avaira-API-Key")
    if api_key:
        key_agent = await db.agents.find_one({"api_key_hash": _hash_api_key(api_key)}, {"_id": 0})
        if key_agent and key_agent["id"] == agent["id"]:
            return key_agent
        raise HTTPException(403, "API key does not match this agent")

    try:
        user = await get_current_user(request)
    except HTTPException:
        raise HTTPException(401, "Sign in, or provide the agent's X-Avaira-API-Key")

    owner = agent.get("user_id")
    if owner in (None, "", "system"):
        # Legacy/unclaimed record (created before ownership was recorded): the first
        # authenticated caller claims it, instead of it staying world-writable.
        await db.agents.update_one({"id": agent["id"]}, {"$set": {"user_id": user["user_id"]}})
        agent["user_id"] = user["user_id"]
    elif owner != user["user_id"]:
        raise HTTPException(403, "You do not own this agent")
    return agent


@api_router.post("/auth/logout")
async def logout(request: Request):
    token = request.cookies.get("session_token")
    if token:
        await db.user_sessions.delete_one({"session_token_hash": _hash_session_token(token)})
    resp = JSONResponse({"message": "Logged out"})
    resp.delete_cookie("session_token", path="/")
    return resp

def _hash_api_key(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()

# ─── AGENT ENDPOINTS ────────────────────────────────────────────
@api_router.post("/agents/register")
async def register_agent(body: AgentCreate, request: Request):
    # Registration stays open for the SDK fast path, but it is rate limited and the
    # swallowed exception is narrowed: a bare `except:` also swallowed programming
    # errors (and BaseException), silently registering agents as "system".
    await enforce_rate_limit(request, "agent_register", limit=10, window_seconds=60)

    user_id = "system"
    try:
        user = await get_current_user(request)
        user_id = user["user_id"]
    except Exception as exc:  # noqa: BLE001 - registration must not fail on optional auth
        # Anonymous registration is allowed on purpose (agent-first onboarding), so any
        # failure to resolve a session degrades to `user_id="system"`. Never a bare
        # `except:`: BaseException (interrupts, shutdowns) must still propagate, and the
        # reason is logged instead of being swallowed silently.
        logger.debug("registration without a resolved session: %s", exc)

    agent_id = str(uuid.uuid4())
    api_key = secrets.token_urlsafe(32)
    api_key_hash = _hash_api_key(api_key)

    # Generate Virtual Vault Card for Chainless Spend
    vault_card = await agent_vault.generate_virtual_card(agent_id, body.risk_envelope.max_spend_usd)

    # Generate Hardware-Anchored Identity (TEE-DID)
    did_doc = tee_identity_manager.generate_agent_did(agent_id, api_key_hash)

    agent = {
        "id": agent_id,
        "api_key_hash": api_key_hash,
        "user_id": user_id,
        "did_doc": did_doc.model_dump(),
        "name": body.name,
        "goal": body.goal,
        "risk_envelope": body.risk_envelope.model_dump(),
        "vault_card": vault_card.model_dump(),
        "webhook_url": body.webhook_url,
        "status": "active",
        "reputation": INITIAL_REPUTATION,
        "total_executions": 0,
        "successful_executions": 0,
        "failed_executions": 0,
        "registered_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.agents.insert_one(agent)

    # Initial Autonomous Policy Evolution (APE) sync
    await ape_engine.sync_threat_intelligence(agent_id)

    agent.pop("_id", None)
    return {"agent_id": agent_id, "api_key": api_key}



@api_router.get("/agents")
async def list_agents(status: Optional[str] = None, limit: int = Query(100, ge=1, le=500)):
    query = {}
    if status:
        query["status"] = status
    agents = await db.agents.find(query, {"_id": 0}).sort("registered_at", -1).to_list(limit)
    return agents

@api_router.get("/agents/{agent_id}")
async def get_agent(agent_id: str):
    agent = await db.agents.find_one({"id": agent_id}, {"_id": 0})
    if not agent:
        raise HTTPException(404, "Agent not found")
    return agent

@api_router.patch("/agents/{agent_id}/status")
async def update_agent_status(agent_id: str, request: Request, status: str = Query(...), admin_user: Dict[str, Any] = Depends(require_admin_user)):
    if status not in ["active", "paused", "frozen"]:
        raise HTTPException(400, "Invalid status")
    result = await db.agents.update_one({"id": agent_id}, {"$set": {"status": status}})
    if result.matched_count == 0:
        raise HTTPException(404, "Agent not found")
    await record_admin_audit("agent_status_update", admin_user, request, {"agent_id": agent_id, "status": status})
    return {"message": f"Agent status updated to {status}"}

# ─── EXECUTION ENDPOINTS ────────────────────────────────────────
@api_router.post("/executions/request")
async def create_execution_request(body: ExecutionRequestCreate, request: Request):
    await enforce_rate_limit(request, "execution_request", limit=60, window_seconds=60)
    agent = await db.agents.find_one({"id": body.agent_id}, {"_id": 0})
    if not agent:
        raise HTTPException(404, "Agent not found")
    await require_agent_access(request, agent)
    if agent["status"] == "frozen":
        raise HTTPException(403, "Agent is frozen. Execution blocked.")
    if agent["status"] != "active":
        raise HTTPException(403, f"Agent status is '{agent['status']}'. Must be 'active'.")

    execution = {
        "id": str(uuid.uuid4()),
        "agent_id": body.agent_id,
        "agent_name": agent["name"],
        "action": body.action,
        "target_address": body.target_address,
        "value": body.value,
        "data": body.data,
        "status": "pending_validation",
        "lifecycle": [{
            "step": "request_submitted",
            "status": "completed",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "details": "Execution request received by AVAIRA backend"
        }],
        "fee_deducted": 0.0,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat()
    }

    # Step 2: Validate risk envelope
    validation = validate_risk_envelope(
        {"value": body.value, "action": body.action},
        agent["risk_envelope"]
    )

    if not validation["valid"]:
        execution["status"] = "rejected_deviation"
        execution["lifecycle"].append({
            "step": "risk_validation",
            "status": "failed",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "details": f"Deviation detected: {'; '.join(validation['violations'])}"
        })
        await db.executions.insert_one(execution)
        execution.pop("_id", None)

        # Freeze agent on deviation
        await db.agents.update_one({"id": body.agent_id}, {"$set": {"status": "frozen"}})
        freeze_event = {
            "id": str(uuid.uuid4()),
            "agent_id": body.agent_id,
            "agent_name": agent["name"],
            "type": "freeze",
            "reason": f"Risk envelope violation: {'; '.join(validation['violations'])}",
            "collateral_slashed": 0.0,
            "timestamp": datetime.now(timezone.utc).isoformat()
        }
        await db.freeze_events.insert_one(freeze_event)
        await update_reputation(body.agent_id, -REP_FREEZE_PENALTY, "Frozen: risk envelope deviation")
        await db.agents.update_one({"id": body.agent_id}, {"$inc": {"total_executions": 1, "failed_executions": 1}})
        return execution

    # Validation passed
    execution["lifecycle"].append({
        "step": "risk_validation",
        "status": "completed",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "details": "Request within declared risk envelope"
    })

    # Step 3: Execution (Chainless)
    execution["status"] = "completed"
    execution["lifecycle"].append({
        "step": "execution",
        "status": "completed",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "details": "Chainless execution completed successfully"
    })

    # Step 4: Deduct fee
    fee = round(body.value * PROTOCOL_FEE_RATE, 6)
    execution["fee_deducted"] = fee
    execution["lifecycle"].append({
        "step": "fee_deducted",
        "status": "completed",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "details": f"Protocol fee: {fee} USD (0.5%). TrustPool: {round(fee * TRUST_POOL_SHARE, 6)}, Revenue: {round(fee * PROTOCOL_REVENUE_SHARE, 6)}"
    })
    execution["updated_at"] = datetime.now(timezone.utc).isoformat()

    await db.executions.insert_one(execution)
    execution.pop("_id", None)

    # Update treasury
    await record_treasury_transaction(execution["id"], fee)

    # Update reputation
    await update_reputation(body.agent_id, REP_SUCCESS_BONUS, "Successful execution")
    await db.agents.update_one({"id": body.agent_id}, {"$inc": {"total_executions": 1, "successful_executions": 1}})

    return execution

@api_router.get("/executions")
async def list_executions(agent_id: Optional[str] = None, status: Optional[str] = None, limit: int = Query(100, ge=1, le=500)):
    query = {}
    if agent_id:
        query["agent_id"] = agent_id
    if status:
        query["status"] = status
    executions = await db.executions.find(query, {"_id": 0}).sort("created_at", -1).to_list(limit)
    return executions

@api_router.get("/executions/{execution_id}")
async def get_execution(execution_id: str):
    ex = await db.executions.find_one({"id": execution_id}, {"_id": 0})
    if not ex:
        raise HTTPException(404, "Execution not found")
    return ex

# ─── FREEZE / SLASH ENDPOINTS ───────────────────────────────────
@api_router.post("/freeze/{agent_id}")
async def freeze_agent(agent_id: str, body: FreezeRequest, request: Request, admin_user: Dict[str, Any] = Depends(require_admin_user)):
    agent = await db.agents.find_one({"id": agent_id}, {"_id": 0})
    if not agent:
        raise HTTPException(404, "Agent not found")
    if agent["status"] == "frozen":
        raise HTTPException(400, "Agent is already frozen")

    await db.agents.update_one({"id": agent_id}, {"$set": {"status": "frozen"}})
    event = {
        "id": str(uuid.uuid4()),
        "agent_id": agent_id,
        "agent_name": agent["name"],
        "type": "freeze",
        "reason": body.reason,
        "collateral_slashed": 0.0,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    await db.freeze_events.insert_one(event)

    await update_reputation(agent_id, -REP_FREEZE_PENALTY, f"Frozen: {body.reason}")
    await record_admin_audit("agent_freeze", admin_user, request, {"agent_id": agent_id, "reason": body.reason})
    event.pop("_id", None)
    return event

@api_router.post("/slash/{agent_id}")
async def slash_agent(agent_id: str, body: SlashRequest, request: Request, admin_user: Dict[str, Any] = Depends(require_admin_user)):
    agent = await db.agents.find_one({"id": agent_id}, {"_id": 0})
    if not agent:
        raise HTTPException(404, "Agent not found")

    slash_amount = body.amount if body.amount else round(agent["collateral_remaining"] * SLASH_RATE, 6)
    slash_amount = min(slash_amount, agent["collateral_remaining"])

    new_collateral = round(agent["collateral_remaining"] - slash_amount, 6)
    await db.agents.update_one({"id": agent_id}, {
        "$set": {"collateral_remaining": new_collateral, "status": "frozen"}
    })

    event = {
        "id": str(uuid.uuid4()),
        "agent_id": agent_id,
        "agent_name": agent["name"],
        "type": "slash",
        "reason": body.reason,
        "collateral_slashed": slash_amount,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    await db.freeze_events.insert_one(event)

    await update_reputation(agent_id, -REP_SLASH_PENALTY, f"Slashed: {body.reason}")

    # Trigger Marketplace Slashing Bridge (Economic Finality)
    await trust_marketplace.trigger_slashing_bridge(agent_id, body.reason, "high")

    await record_admin_audit("agent_slash", admin_user, request, {"agent_id": agent_id, "reason": body.reason, "amount": slash_amount})
    event.pop("_id", None)
    return {**event, "collateral_remaining": new_collateral}

@api_router.get("/freeze/events")
async def list_freeze_events(agent_id: Optional[str] = None, limit: int = Query(100, ge=1, le=500)):
    query = {}
    if agent_id:
        query["agent_id"] = agent_id
    events = await db.freeze_events.find(query, {"_id": 0}).sort("timestamp", -1).to_list(limit)
    return events

# ─── TREASURY ENDPOINTS ─────────────────────────────────────────
@api_router.get("/treasury/stats")
async def get_treasury_stats():
    pipeline = [
        {"$group": {
            "_id": None,
            "total_fees": {"$sum": "$total_fee"},
            "total_trust_pool": {"$sum": "$trust_pool_share"},
            "total_protocol_revenue": {"$sum": "$protocol_revenue_share"},
            "transaction_count": {"$sum": 1}
        }}
    ]
    result = await db.treasury_transactions.aggregate(pipeline).to_list(1)
    if result:
        stats = result[0]
        stats.pop("_id", None)
        return {
            "total_fees": round(stats.get("total_fees", 0), 6),
            "total_trust_pool": round(stats.get("total_trust_pool", 0), 6),
            "total_protocol_revenue": round(stats.get("total_protocol_revenue", 0), 6),
            "transaction_count": stats.get("transaction_count", 0)
        }
    return {"total_fees": 0, "total_trust_pool": 0, "total_protocol_revenue": 0, "transaction_count": 0}

@api_router.get("/treasury/transactions")
async def list_treasury_transactions(limit: int = Query(100, ge=1, le=500)):
    txs = await db.treasury_transactions.find({}, {"_id": 0}).sort("timestamp", -1).to_list(limit)
    return txs

# ─── REPUTATION ENDPOINTS ───────────────────────────────────────
@api_router.get("/leaderboard")
async def get_leaderboard(limit: int = Query(20, ge=1, le=200)):
    # Returns top agents by Avaira score
    agents = await db.agents.find({}, {"_id": 0}).to_list(100)
    results = []
    for agent in agents:
        try:
            score = await reputation_engine.compute_score(agent["id"])
            results.append({
                "agent_id": agent["id"],
                "name": agent["name"],
                "score": score.score,
                "grade": score.grade,
                "status": agent["status"]
            })
        except:
            continue
    results.sort(key=lambda x: x["score"], reverse=True)
    return results[:limit]

@api_router.get("/reputation/leaderboard")
async def get_leaderboard_legacy(limit: int = Query(20, ge=1, le=200)):
    return await get_leaderboard(limit)

@api_router.get("/reputation/{agent_id}/history")
async def get_reputation_history(agent_id: str, limit: int = Query(50, ge=1, le=500)):
    history = await db.reputation_history.find({"agent_id": agent_id}, {"_id": 0}).sort("timestamp", -1).to_list(limit)
    return history

@api_router.get("/reputation/history")
async def get_all_reputation_history(limit: int = Query(100, ge=1, le=500)):
    history = await db.reputation_history.find({}, {"_id": 0}).sort("timestamp", -1).to_list(limit)
    return history

# ─── DASHBOARD ENDPOINTS ────────────────────────────────────────
@api_router.get("/dashboard/stats")
async def get_dashboard_stats():
    total_agents = await db.agents.count_documents({})
    active_agents = await db.agents.count_documents({"status": "active"})
    frozen_agents = await db.agents.count_documents({"status": "frozen"})
    total_executions = await db.executions.count_documents({})
    completed_executions = await db.executions.count_documents({"status": "completed"})
    failed_executions = await db.executions.count_documents({"status": {"$in": ["rejected_deviation", "permit_invalid"]}})
    pending_executions = await db.executions.count_documents({"status": {"$in": ["pending_validation", "permit_signed"]}})

    treasury = await get_treasury_stats()
    total_collateral_pipeline = [{"$group": {"_id": None, "total": {"$sum": "$collateral_remaining"}}}]
    collateral_result = await db.agents.aggregate(total_collateral_pipeline).to_list(1)
    total_collateral = round(collateral_result[0]["total"], 6) if collateral_result else 0

    return {
        "total_agents": total_agents,
        "active_agents": active_agents,
        "frozen_agents": frozen_agents,
        "total_executions": total_executions,
        "completed_executions": completed_executions,
        "failed_executions": failed_executions,
        "pending_executions": pending_executions,
        "total_fees_collected": treasury["total_fees"],
        "trust_pool_balance": treasury["total_trust_pool"],
        "protocol_revenue": treasury["total_protocol_revenue"],
        "total_collateral_staked": total_collateral
    }

@api_router.get("/dashboard/activity")
async def get_recent_activity(limit: int = Query(20, ge=1, le=100)):
    activities = []
    recent_execs = await db.executions.find({}, {"_id": 0}).sort("created_at", -1).to_list(10)
    for ex in recent_execs:
        activities.append({
            "type": "execution",
            "description": f"Agent '{ex.get('agent_name', 'Unknown')}' - {ex['action']} ({ex['status']})",
            "status": ex["status"],
            "timestamp": ex["created_at"],
            "id": ex["id"]
        })
    recent_freezes = await db.freeze_events.find({}, {"_id": 0}).sort("timestamp", -1).to_list(10)
    for fe in recent_freezes:
        activities.append({
            "type": fe["type"],
            "description": f"Agent '{fe.get('agent_name', 'Unknown')}' - {fe['type'].upper()}: {fe['reason']}",
            "status": fe["type"],
            "timestamp": fe["timestamp"],
            "id": fe["id"]
        })
    activities.sort(key=lambda x: x["timestamp"], reverse=True)
    return activities[:limit]

# ─── SMART CONTRACT ARCHITECTURE ────────────────────────────────
@api_router.get("/architecture")
async def get_architecture():
    return {
        "contracts": [
            {
                "name": "AgentRegistry",
                "address": AGENT_REGISTRY_ADDRESS or "Not deployed",
                "description": "Central registry for all AI agents. Manages registration, collateral staking, and agent status.",
                "state_variables": [
                    {"name": "agents", "type": "mapping(bytes32 => Agent)", "description": "Agent ID to Agent struct"},
                    {"name": "agentCollateral", "type": "mapping(bytes32 => uint256)", "description": "Agent collateral balances"},
                    {"name": "agentStatus", "type": "mapping(bytes32 => AgentStatus)", "description": "Agent operational status"},
                    {"name": "reputationScores", "type": "mapping(bytes32 => uint256)", "description": "Agent reputation scores"},
                    {"name": "totalAgents", "type": "uint256", "description": "Total registered agents"},
                    {"name": "minCollateral", "type": "uint256", "description": "Minimum collateral required (0.1 USD)"}
                ],
                "functions": [
                    {"name": "registerAgent", "params": "(string name, bytes32 missionHash, RiskEnvelope envelope)", "returns": "bytes32 agentId", "modifier": "payable", "description": "Register new agent with collateral stake"},
                    {"name": "stakeCollateral", "params": "(bytes32 agentId)", "returns": "bool", "modifier": "payable", "description": "Add additional collateral"},
                    {"name": "updateAgentStatus", "params": "(bytes32 agentId, AgentStatus status)", "returns": "bool", "modifier": "onlyProtocol", "description": "Update agent operational status"},
                    {"name": "getAgent", "params": "(bytes32 agentId)", "returns": "Agent memory", "modifier": "view", "description": "Get agent details"},
                    {"name": "isAgentActive", "params": "(bytes32 agentId)", "returns": "bool", "modifier": "view", "description": "Check if agent can execute"}
                ],
                "events": [
                    "AgentRegistered(bytes32 indexed agentId, address indexed owner, uint256 collateral)",
                    "CollateralStaked(bytes32 indexed agentId, uint256 amount, uint256 total)",
                    "AgentStatusUpdated(bytes32 indexed agentId, AgentStatus oldStatus, AgentStatus newStatus)",
                    "ReputationUpdated(bytes32 indexed agentId, uint256 oldScore, uint256 newScore)"
                ]
            },
            {
                "name": "ExecutionWallet",
                "address": EXECUTION_WALLET_ADDRESS or "Not deployed",
                "description": "Verifies EIP-712 signed permits and executes approved transactions. Deducts 0.5% protocol fee.",
                "state_variables": [
                    {"name": "DOMAIN_SEPARATOR", "type": "bytes32", "description": "EIP-712 domain separator"},
                    {"name": "executionNonces", "type": "mapping(bytes32 => uint256)", "description": "Per-agent nonces to prevent replay"},
                    {"name": "protocolFeeRate", "type": "uint256", "description": "Fee rate in basis points (50 = 0.5%)"},
                    {"name": "treasury", "type": "address", "description": "Treasury contract address"},
                    {"name": "registry", "type": "address", "description": "AgentRegistry contract address"},
                    {"name": "permitTypehash", "type": "bytes32", "description": "EIP-712 type hash for permit struct"}
                ],
                "functions": [
                    {"name": "verifyPermitSignature", "params": "(ExecutionPermit permit, bytes signature)", "returns": "bool", "modifier": "view", "description": "Verify EIP-712 permit signature"},
                    {"name": "executeApprovedTransaction", "params": "(ExecutionPermit permit, bytes signature, bytes callData)", "returns": "bool", "modifier": "nonReentrant", "description": "Execute transaction after permit verification"},
                    {"name": "deductProtocolFee", "params": "(uint256 value)", "returns": "uint256 fee", "modifier": "internal", "description": "Calculate and deduct 0.5% fee"},
                    {"name": "sendFeeToTreasury", "params": "(uint256 fee)", "returns": "bool", "modifier": "internal", "description": "Transfer fee to Treasury contract"}
                ],
                "events": [
                    "PermitVerified(bytes32 indexed executionId, bytes32 indexed agentId, bytes32 permitHash)",
                    "TransactionExecuted(bytes32 indexed executionId, bytes32 indexed agentId, uint256 value, uint256 fee)",
                    "FeeDeducted(bytes32 indexed executionId, uint256 fee, uint256 trustPoolShare, uint256 revenueShare)"
                ]
            },
            {
                "name": "FreezeSlash",
                "address": FREEZE_SLASH_ADDRESS or "Not deployed",
                "description": "Emergency freeze and collateral slashing mechanism. Triggered on risk envelope deviation.",
                "state_variables": [
                    {"name": "frozenAgents", "type": "mapping(bytes32 => bool)", "description": "Agent frozen status"},
                    {"name": "slashHistory", "type": "mapping(bytes32 => SlashEvent[])", "description": "Per-agent slash history"},
                    {"name": "slashRate", "type": "uint256", "description": "Default slash rate (50%)"},
                    {"name": "registry", "type": "address", "description": "AgentRegistry contract reference"}
                ],
                "functions": [
                    {"name": "freezeAgent", "params": "(bytes32 agentId, string reason)", "returns": "bool", "modifier": "onlyProtocol", "description": "Instantly freeze agent execution"},
                    {"name": "slashCollateral", "params": "(bytes32 agentId, uint256 amount, string reason)", "returns": "bool", "modifier": "onlyProtocol", "description": "Slash agent collateral"},
                    {"name": "unfreezeAgent", "params": "(bytes32 agentId)", "returns": "bool", "modifier": "onlyGovernance", "description": "Restore agent after review"},
                    {"name": "isAgentFrozen", "params": "(bytes32 agentId)", "returns": "bool", "modifier": "view", "description": "Check freeze status"}
                ],
                "events": [
                    "AgentFrozen(bytes32 indexed agentId, string reason, uint256 timestamp)",
                    "CollateralSlashed(bytes32 indexed agentId, uint256 amount, string reason)",
                    "AgentUnfrozen(bytes32 indexed agentId, uint256 timestamp)"
                ]
            },
            {
                "name": "Treasury",
                "address": TREASURY_ADDRESS or "Not deployed",
                "description": "Receives protocol fees and splits them: 75% to TrustPool, 25% to ProtocolRevenue.",
                "state_variables": [
                    {"name": "trustPoolBalance", "type": "uint256", "description": "Accumulated TrustPool funds"},
                    {"name": "protocolRevenueBalance", "type": "uint256", "description": "Accumulated Protocol Revenue"},
                    {"name": "trustPoolShare", "type": "uint256", "description": "TrustPool share (75%)"},
                    {"name": "revenueShare", "type": "uint256", "description": "Revenue share (25%)"},
                    {"name": "totalFeesReceived", "type": "uint256", "description": "Total lifetime fees"}
                ],
                "functions": [
                    {"name": "receiveFees", "params": "()", "returns": "bool", "modifier": "payable onlyExecutionWallet", "description": "Receive fees from ExecutionWallet"},
                    {"name": "splitFee", "params": "(uint256 amount)", "returns": "(uint256, uint256)", "modifier": "internal", "description": "Split fee into TrustPool and Revenue"},
                    {"name": "withdrawRevenue", "params": "(address to, uint256 amount)", "returns": "bool", "modifier": "onlyGovernance", "description": "Withdraw protocol revenue"},
                    {"name": "getTreasuryStats", "params": "()", "returns": "(uint256, uint256, uint256)", "modifier": "view", "description": "Get treasury balances"}
                ],
                "events": [
                    "FeeReceived(uint256 amount, uint256 trustPool, uint256 revenue)",
                    "RevenueWithdrawn(address indexed to, uint256 amount)",
                    "TrustPoolUpdated(uint256 newBalance)"
                ]
            },
            {
                "name": "ReputationEngine",
                "address": REPUTATION_ENGINE_ADDRESS or "Not deployed",
                "description": "Tracks and updates agent reputation scores based on execution outcomes.",
                "state_variables": [
                    {"name": "scores", "type": "mapping(bytes32 => uint256)", "description": "Agent reputation scores"},
                    {"name": "successBonus", "type": "uint256", "description": "Points gained on success (+2)"},
                    {"name": "failurePenalty", "type": "uint256", "description": "Points lost on failure (-5)"},
                    {"name": "freezePenalty", "type": "uint256", "description": "Points lost on freeze (-20)"},
                    {"name": "maxScore", "type": "uint256", "description": "Maximum reputation (200)"}
                ],
                "functions": [
                    {"name": "increaseScoreOnSuccess", "params": "(bytes32 agentId)", "returns": "uint256", "modifier": "onlyProtocol", "description": "Reward successful execution"},
                    {"name": "decreaseScoreOnFailure", "params": "(bytes32 agentId)", "returns": "uint256", "modifier": "onlyProtocol", "description": "Penalize failed execution"},
                    {"name": "penalizeOnFreeze", "params": "(bytes32 agentId)", "returns": "uint256", "modifier": "onlyProtocol", "description": "Heavy penalty on freeze"},
                    {"name": "getScore", "params": "(bytes32 agentId)", "returns": "uint256", "modifier": "view", "description": "Get current score"}
                ],
                "events": [
                    "ScoreIncreased(bytes32 indexed agentId, uint256 oldScore, uint256 newScore, string reason)",
                    "ScoreDecreased(bytes32 indexed agentId, uint256 oldScore, uint256 newScore, string reason)"
                ]
            },
            {
                "name": "InsurancePool",
                "address": "Not deployed",
                "description": "Compensates backers if agent execution fails and causes losses.",
                "state_variables": [
                    {"name": "poolBalance", "type": "uint256", "description": "Total insurance pool funds"},
                    {"name": "claims", "type": "mapping(bytes32 => Claim[])", "description": "Filed claims"},
                    {"name": "maxClaimRate", "type": "uint256", "description": "Max claim percentage per incident"}
                ],
                "functions": [
                    {"name": "coverBackersIfExecutionFails", "params": "(bytes32 executionId, address[] backers, uint256[] amounts)", "returns": "bool", "modifier": "onlyProtocol", "description": "Process insurance claim"},
                    {"name": "fundPool", "params": "()", "returns": "bool", "modifier": "payable", "description": "Add funds to insurance pool"},
                    {"name": "getPoolBalance", "params": "()", "returns": "uint256", "modifier": "view", "description": "Get current pool balance"}
                ],
                "events": [
                    "ClaimProcessed(bytes32 indexed executionId, uint256 totalPayout, uint256 backerCount)",
                    "PoolFunded(address indexed funder, uint256 amount)"
                ]
            }
        ],
        "security_assumptions": [
            "Permit signer (backend) private key is stored securely in HSM/KMS",
            "EIP-712 domain separator includes chainId to prevent cross-chain replay",
            "Nonces are strictly monotonic per agent to prevent replay attacks",
            "FreezeSlash can be called by protocol-authorized addresses only",
            "Re-entrancy guards on all state-changing functions in ExecutionWallet",
            "Collateral withdrawal requires cooldown period after unstake request"
        ],
        "attack_surfaces": [
            "Permit replay: Mitigated by nonces and deadline timestamps",
            "Front-running: Mitigated by commit-reveal scheme for high-value txs",
            "Signer key compromise: Requires multi-sig rotation mechanism",
            "Flash loan attacks on collateral: Minimum lock period enforced",
            "Griefing via false freeze: onlyProtocol modifier + governance override",
            "MEV extraction: Private mempool submission recommended"
        ],
        "gas_considerations": [
            "Batch agent operations to amortize base gas costs",
            "Use events instead of storage for historical data",
            "Minimize storage writes in hot paths (execution verification)",
            "Consider EIP-2929 access list for frequently accessed storage slots",
            "Proxy pattern for upgradeability without redeployment costs"
        ]
    }

# ─── SIMULATION ENDPOINT ────────────────────────────────────────
@api_router.post("/simulate/lifecycle")
async def simulate_protocol_lifecycle(request: Request, admin_user: Dict[str, Any] = Depends(require_admin_user)):
    """Simulates the complete AVAIRA execution lifecycle end-to-end."""
    steps = []

    # Step 1: Register agent
    agent_data = AgentCreate(
        name=f"SimBot-{secrets.token_hex(3).upper()}",
        goal="Automated DeFi yield optimization on Avalanche",
        risk_envelope=RiskEnvelope(max_spend_usd=50.0, allowed_actions=["transfer", "swap", "stake"]),
        webhook_url=None
    )
    # register_agent(body: AgentCreate, request: Request)
    agent_reg_res = await register_agent(agent_data, request=request)
    agent_id = agent_reg_res["agent_id"]
    agent = await db.agents.find_one({"id": agent_id}, {"_id": 0})

    steps.append({"step": 1, "action": "Agent Registered", "details": f"Agent '{agent['name']}' registered with {agent.get('collateral_amount', 0.1)} USD collateral", "agent_id": agent_id})

    # Step 2: Submit valid execution
    exec_data = ExecutionRequestCreate(agent_id=agent_id, action="swap", target_address="0x" + secrets.token_hex(20), value=2.5, chain_id="43113")
    execution = await create_execution_request(exec_data)
    steps.append({"step": 2, "action": "Execution Completed", "details": f"Swap of 2.5 USD executed successfully. Fee: {execution['fee_deducted']} USD", "execution_id": execution["id"], "status": execution["status"]})

    # Step 3: Submit another valid execution
    exec_data2 = ExecutionRequestCreate(agent_id=agent_id, action="transfer", target_address="0x" + secrets.token_hex(20), value=1.0, chain_id="43113")
    execution2 = await create_execution_request(exec_data2)
    steps.append({"step": 3, "action": "Execution Completed", "details": f"Transfer of 1.0 USD executed. Fee: {execution2['fee_deducted']} USD", "execution_id": execution2["id"], "status": execution2["status"]})

    # Step 4: Submit deviation (value exceeds risk envelope)
    # First unfreeze agent if frozen and re-check
    await db.agents.update_one({"id": agent_id}, {"$set": {"status": "active"}})
    exec_data3 = ExecutionRequestCreate(agent_id=agent_id, action="liquidate", target_address="0x" + secrets.token_hex(20), value=150.0, chain_id="43113")
    execution3 = await create_execution_request(exec_data3)
    steps.append({"step": 4, "action": "Deviation Detected", "details": f"Action 'liquidate' outside risk envelope. Agent FROZEN.", "execution_id": execution3["id"], "status": execution3["status"]})

    # Step 5: Slash collateral
    slash_result = await slash_agent(
        agent_id,
        SlashRequest(reason="Repeated deviation from declared mission intent"),
        request=request,
        admin_user=admin_user,
    )
    steps.append({"step": 5, "action": "Collateral Slashed", "details": f"Slashed {slash_result['collateral_slashed']} USD. Remaining: {slash_result['collateral_remaining']} USD"})

    # Get final agent state
    final_agent = await db.agents.find_one({"id": agent["id"]}, {"_id": 0})
    treasury_stats = await get_treasury_stats()

    result = {
        "simulation_id": str(uuid.uuid4()),
        "steps": steps,
        "final_agent_state": final_agent,
        "treasury_stats": treasury_stats,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    await record_admin_audit("simulate_lifecycle", admin_user, request, {"simulation_id": result["simulation_id"], "agent_id": agent["id"]})
    return result

# ─── AVAIRA SCORE ENGINE ─────────────────────────────────────────
def calculate_avaira_score(agent: Dict) -> Dict:
    total_ex = max(agent.get("total_executions", 0), 1)
    success_rate = (agent.get("successful_executions", 0) / total_ex) * 100
    base_rep = agent.get("reputation", INITIAL_REPUTATION)
    collateral_ratio = min((agent.get("collateral_remaining", 0) / max(agent.get("collateral_amount", 1), 0.01)) * 100, 100)
    complexity = min(agent.get("total_executions", 0) * 2, 100)
    reg_date = agent.get("registered_at", datetime.now(timezone.utc).isoformat())
    try:
        days_on_network = (datetime.now(timezone.utc) - datetime.fromisoformat(reg_date.replace("Z", "+00:00"))).days
    except Exception:
        days_on_network = 0
    time_score = min(days_on_network * 3, 100)
    deviation_count = agent.get("failed_executions", 0)
    deviation_score = max(100 - (deviation_count * 15), 0)
    composite = (success_rate * 0.30 + (base_rep / 2) * 0.20 + collateral_ratio * 0.15 + complexity * 0.15 + time_score * 0.10 + deviation_score * 0.10)
    grade = "D"
    for g, low, high in AVAIRA_GRADES:
        if low <= composite <= high:
            grade = g
            break
    return {
        "composite_score": round(composite, 1),
        "grade": grade,
        "factors": {
            "success_rate": round(success_rate, 1),
            "behavioral_consistency": round(base_rep / 2, 1),
            "collateral_ratio": round(collateral_ratio, 1),
            "mission_complexity": round(complexity, 1),
            "time_on_network": round(time_score, 1),
            "deviation_penalty": round(deviation_score, 1)
        },
        "weights": {"success_rate": 0.30, "behavioral_consistency": 0.20, "collateral_ratio": 0.15, "mission_complexity": 0.15, "time_on_network": 0.10, "deviation_penalty": 0.10}
    }

# ─── AVAIRA SCORE ENDPOINTS ─────────────────────────────────────
@api_router.get("/agents/{agent_id}/score")
async def get_agent_score(agent_id: str):
    try:
        score = await reputation_engine.compute_score(agent_id)
        agent = await db.agents.find_one({"id": agent_id})
        return {**score.model_dump(), "agent_id": agent_id, "agent_name": agent["name"], "status": agent["status"]}
    except ValueError as e:
        raise HTTPException(404, str(e))

@api_router.get("/scores/all")
async def get_all_scores():
    agents = await db.agents.find({}, {"_id": 0}).to_list(200)
    results = []
    for agent in agents:
        score = calculate_avaira_score(agent)
        results.append({"agent_id": agent["id"], "agent_name": agent["name"], "status": agent["status"], "grade": score["grade"], "composite_score": score["composite_score"], "reputation": agent["reputation"]})
    results.sort(key=lambda x: x["composite_score"], reverse=True)
    return results

# ─── UNDERWRITER ENDPOINTS ──────────────────────────────────────
@api_router.post("/underwriters/register")
async def register_underwriter(body: UnderwriterCreate, request: Request, _user: Dict[str, Any] = Depends(require_authenticated_user)):
    if body.capital_amount < 0.5:
        raise HTTPException(400, "Minimum capital is 0.5 USD")
    if body.wallet_address and not is_valid_evm_address(body.wallet_address):
        raise HTTPException(400, "Invalid wallet address format")
    uw = {
        "id": str(uuid.uuid4()),
        "name": body.name,
        "wallet_address": body.wallet_address or ("0x" + secrets.token_hex(20)),
        "capital_amount": body.capital_amount,
        "capital_available": body.capital_amount,
        "capital_staked": 0.0,
        "total_earnings": 0.0,
        "missions_underwritten": 0,
        "missions_successful": 0,
        "status": "active",
        "registered_at": datetime.now(timezone.utc).isoformat()
    }
    await db.underwriters.insert_one(uw)
    uw.pop("_id", None)
    return uw

@api_router.get("/underwriters")
async def list_underwriters(limit: int = Query(100, ge=1, le=500)):
    uws = await db.underwriters.find({}, {"_id": 0}).sort("total_earnings", -1).to_list(limit)
    return uws

@api_router.get("/underwriters/{uw_id}")
async def get_underwriter(uw_id: str):
    uw = await db.underwriters.find_one({"id": uw_id}, {"_id": 0})
    if not uw:
        raise HTTPException(404, "Underwriter not found")
    return uw

# ─── MISSION ENDPOINTS ──────────────────────────────────────────
@api_router.post("/missions/create")
async def create_mission(body: MissionCreate):
    agent = await db.agents.find_one({"id": body.agent_id}, {"_id": 0})
    if not agent:
        raise HTTPException(404, "Agent not found")
    if agent["status"] != "active":
        raise HTTPException(403, f"Agent is {agent['status']}")
    score = calculate_avaira_score(agent)
    mission = {
        "id": str(uuid.uuid4()),
        "agent_id": body.agent_id,
        "agent_name": agent["name"],
        "agent_grade": score["grade"],
        "agent_score": score["composite_score"],
        "description": body.description,
        "target_value": body.target_value,
        "duration_hours": body.duration_hours,
        "risk_level": body.risk_level,
        "status": "open",
        "total_staked": 0.0,
        "underwriters": [],
        "fee_split": {"agent": MISSION_FEE_AGENT, "underwriter": MISSION_FEE_UNDERWRITER, "protocol": MISSION_FEE_PROTOCOL},
        "result": None,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "settled_at": None
    }
    await db.missions.insert_one(mission)
    mission.pop("_id", None)
    return mission

@api_router.get("/missions")
async def list_missions(status: Optional[str] = None, limit: int = Query(100, ge=1, le=500)):
    query = {}
    if status:
        query["status"] = status
    missions = await db.missions.find(query, {"_id": 0}).sort("created_at", -1).to_list(limit)
    return missions

@api_router.get("/missions/{mission_id}")
async def get_mission(mission_id: str):
    mission = await db.missions.find_one({"id": mission_id}, {"_id": 0})
    if not mission:
        raise HTTPException(404, "Mission not found")
    return mission

@api_router.post("/missions/{mission_id}/stake")
async def stake_on_mission(mission_id: str, body: MissionStake):
    mission = await db.missions.find_one({"id": mission_id}, {"_id": 0})
    if not mission:
        raise HTTPException(404, "Mission not found")
    if mission["status"] != "open":
        raise HTTPException(400, "Mission not open for staking")
    uw = await db.underwriters.find_one({"id": body.underwriter_id}, {"_id": 0})
    if not uw:
        raise HTTPException(404, "Underwriter not found")
    if uw["capital_available"] < body.amount:
        raise HTTPException(400, "Insufficient capital")
    await db.underwriters.update_one({"id": body.underwriter_id}, {"$inc": {"capital_available": -body.amount, "capital_staked": body.amount}})
    stake_entry = {"underwriter_id": body.underwriter_id, "underwriter_name": uw["name"], "amount": body.amount, "staked_at": datetime.now(timezone.utc).isoformat()}
    await db.missions.update_one({"id": mission_id}, {"$push": {"underwriters": stake_entry}, "$inc": {"total_staked": body.amount}})
    updated = await db.missions.find_one({"id": mission_id}, {"_id": 0})
    return updated

@api_router.post("/missions/{mission_id}/settle")
async def settle_mission(mission_id: str, request: Request, success: bool = True, admin_user: Dict[str, Any] = Depends(require_admin_user)):
    settled_at = datetime.now(timezone.utc).isoformat()
    result_label = "success" if success else "failed"
    mission = await db.missions.find_one_and_update(
        {"id": mission_id, "status": {"$ne": "settled"}},
        {"$set": {"status": "settled", "result": result_label, "settled_at": settled_at}},
        projection={"_id": 0},
        return_document=ReturnDocument.BEFORE,
    )
    if not mission:
        exists = await db.missions.find_one({"id": mission_id}, {"_id": 0})
        if not exists:
            raise HTTPException(404, "Mission not found")
        raise HTTPException(400, "Already settled")
    total_value = mission["target_value"]
    if success:
        agent_payout = round(total_value * MISSION_FEE_AGENT, 6)
        uw_total = round(total_value * MISSION_FEE_UNDERWRITER, 6)
        protocol_fee = round(total_value * MISSION_FEE_PROTOCOL, 6)
        for uw_stake in mission.get("underwriters", []):
            share = uw_stake["amount"] / max(mission["total_staked"], 0.001)
            earnings = round(uw_total * share, 6)
            await db.underwriters.update_one({"id": uw_stake["underwriter_id"]}, {"$inc": {"capital_staked": -uw_stake["amount"], "capital_available": uw_stake["amount"] + earnings, "total_earnings": earnings, "missions_underwritten": 1, "missions_successful": 1}})
        await update_reputation(mission["agent_id"], REP_SUCCESS_BONUS, f"Mission settled: {mission['description'][:40]}")
        rev_entry = {"id": str(uuid.uuid4()), "type": "underwriting", "mission_id": mission_id, "amount": protocol_fee, "timestamp": datetime.now(timezone.utc).isoformat()}
        await db.revenue_events.insert_one(rev_entry)
        await record_admin_audit("mission_settle", admin_user, request, {"mission_id": mission_id, "success": True})
        return {"status": "settled", "result": "success", "agent_payout": agent_payout, "underwriter_payout": uw_total, "protocol_fee": protocol_fee}
    else:
        slash_total = mission["total_staked"] * 0.5
        for uw_stake in mission.get("underwriters", []):
            share = uw_stake["amount"] / max(mission["total_staked"], 0.001)
            loss = round(slash_total * share, 6)
            await db.underwriters.update_one({"id": uw_stake["underwriter_id"]}, {"$inc": {"capital_staked": -uw_stake["amount"], "capital_available": uw_stake["amount"] - loss, "missions_underwritten": 1}})
        await update_reputation(mission["agent_id"], -REP_FAILURE_PENALTY, f"Mission failed: {mission['description'][:40]}")
        await record_admin_audit("mission_settle", admin_user, request, {"mission_id": mission_id, "success": False})
        return {"status": "settled", "result": "failed", "coverage_provided": slash_total}

# ─── REVENUE STREAMS ENDPOINT ───────────────────────────────────
@api_router.get("/revenue/streams")
async def get_revenue_streams():
    treasury = await get_treasury_stats()
    uw_pipeline = [{"$match": {"type": "underwriting"}}, {"$group": {"_id": None, "total": {"$sum": "$amount"}, "count": {"$sum": 1}}}]
    uw_result = await db.revenue_events.aggregate(uw_pipeline).to_list(1)
    uw_rev = uw_result[0]["total"] if uw_result else 0
    uw_count = uw_result[0]["count"] if uw_result else 0
    slash_pipeline = [{"$match": {"type": "slash"}}, {"$group": {"_id": None, "total": {"$sum": "$collateral_slashed"}}}]
    slash_events = await db.freeze_events.find({"type": "slash"}, {"_id": 0}).to_list(200)
    slash_rev = sum(e.get("collateral_slashed", 0) * 0.2 for e in slash_events)
    agent_count = await db.agents.count_documents({})
    reg_revenue = agent_count * 0
    return {
        "streams": [
            {"name": "Transaction Fees", "description": "0.5% on every execution", "amount": round(treasury["total_fees"], 6), "transactions": treasury["transaction_count"], "icon": "zap"},
            {"name": "Underwriting Spread", "description": "5% protocol fee on settled missions", "amount": round(uw_rev, 6), "transactions": uw_count, "icon": "shield"},
            {"name": "Slashing Revenue", "description": "20% of slashed collateral", "amount": round(slash_rev, 6), "transactions": len(slash_events), "icon": "scissors"},
            {"name": "Data & Analytics", "description": "API queries and insights subscriptions", "amount": 0, "transactions": 0, "icon": "database"}
        ],
        "total_revenue": round(treasury["total_fees"] + uw_rev + slash_rev, 6),
        "subscription_tiers": SUBSCRIPTION_TIERS
    }

# ─── SDK DOCUMENTATION ENDPOINT ─────────────────────────────────
@api_router.get("/sdk/docs")
async def get_sdk_docs():
    return {
        "sdk_name": "Avaira Python SDK",
        "languages": ["Python"],
        "version": "0.1.0",
        "install": {"python": "pip install avaira-sdk"},
        "functions": [
            {"name": "register", "description": "Register an AI agent with Avaira", "params": [{"name": "name", "type": "string"}, {"name": "goal", "type": "string"}], "returns": "str",
             "example": "agent_id = await avaira.register(name='ResearchBot', goal='Market analysis')"},
            {"name": "run", "description": "Run a task with Avaira protection", "params": [{"name": "task", "type": "string"}, {"name": "execute_fn", "type": "callable"}], "returns": "RunResult",
             "example": "result = await avaira.run(task='Search news', execute_fn=my_fn)"},
            {"name": "validate", "description": "Standalone intent validation", "params": [{"name": "intent", "type": "dict"}], "returns": "ValidationResult",
             "example": "val = await avaira.validate(my_intent)"}
        ],
        "quick_start": "from avaira import AvairaClient, AvairaConfig, RiskEnvelope\n\n# 1. Define boundaries\nenvelope = RiskEnvelope(max_spend_usd=50.0, allowed_actions=['search'])\nconfig = AvairaConfig(api_key='your_api_key', risk_envelope=envelope)\navaira = AvairaClient(config)\n\n# 2. Wrap your agent\nresult = await avaira.run(\n    task='Search for YC news',\n    execute_fn=lambda: my_agent.run('Search for YC news')\n)\n\nprint(result['status'])"
    }


async def _get_agent_from_key(request: Request):
    api_key = request.headers.get("X-Avaira-API-Key")
    if not api_key:
        raise HTTPException(401, "Missing X-Avaira-API-Key")

    api_key_hash = _hash_api_key(api_key)
    agent = await db.agents.find_one({"api_key_hash": api_key_hash})

    if not agent:
        raise HTTPException(401, "Invalid API Key")
    if agent.get("status") == "frozen":
        raise HTTPException(403, f"Agent is frozen due to a policy violation")
    return agent

@api_router.post("/agents/{agent_id}/run")
async def agent_run(agent_id: str, body: AgentRunRequest, agent: Dict = Depends(_get_agent_from_key)):
    if agent["id"] != agent_id:
        raise HTTPException(403, "API Key does not match agent ID")

    real_agent = RealAvairaAgent(agent["id"], agent["risk_envelope"], db_client=db)
    result = await real_agent.run(body.task)
    return result

@api_router.post("/agents/{agent_id}/log")
async def agent_log_outcome(agent_id: str, body: Dict[str, Any], agent: Dict = Depends(_get_agent_from_key)):
    if agent["id"] != agent_id:
        raise HTTPException(403, "API Key does not match agent ID")

    intent = body.get("intent")
    status = body.get("status")
    result = body.get("result")

    await intent_logger.log(intent, agent_id, agent["risk_envelope"])
    await db.executions.insert_one({
        "trace_id": str(uuid.uuid4()),
        "agent_id": agent_id,
        "intent": intent,
        "status": status,
        "result": result,
        "timestamp": datetime.now(timezone.utc).isoformat()
    })
    return {"status": "logged"}

@api_router.get("/agents/{agent_id}/trust-proof")
async def get_agent_trust_proof(agent_id: str, agent: Dict = Depends(_get_agent_from_key)):
    if agent["id"] != agent_id:
        raise HTTPException(403, "API Key does not match agent ID")

    # Get last N entries to build a condensed proof
    trail = await intent_logger.collection.find({"agent_id": agent_id}).sort("issuanceDate", -1).limit(10).to_list(None)
    if not trail:
        raise HTTPException(404, "No history found")

    latest = trail[0]
    return {
        "agent_id": agent_id,
        "agent_did": f"did:avaira:{agent_id}",
        "merkle_root": latest["merkle_root"],
        "intent_hash": latest["intent_hash"],
        "timestamp": latest["issuanceDate"],
        "witness_signatures": latest["witness_signatures"],
        "proof": latest["proof"]
    }

@api_router.post("/verify-proof")
async def verify_trust_proof(body: Dict[str, Any], request: Request):
    await enforce_rate_limit(request, "verify_proof", limit=30, window_seconds=60)
    agent_id = body.get("agent_id")
    if not agent_id: raise HTTPException(400, "Missing agent_id")

    # Verify witness signatures
    merkle_root = body.get("merkle_root")
    timestamp = body.get("timestamp")
    witness_sigs = body.get("witness_signatures", [])

    from core.witness_network import WitnessNetwork, WitnessSignature
    wn = WitnessNetwork()

    valid_sigs = 0
    for sig_data in witness_sigs:
        sig = WitnessSignature(**sig_data)
        if wn.verify_witness_signature(merkle_root, timestamp, sig):
            valid_sigs += 1

    # Consensus: requires at least 2 witnesses
    trusted = (valid_sigs >= 2)

    # `simulated` is True while the witness keyring is a local simulation: the caller
    # must not treat it as an independent third-party quorum.
    if trusted and wn.simulated:
        return {
            "trusted": True,
            "witness_count": valid_sigs,
            "simulated": True,
            "detail": "Co-signatures verified against the local witness keyring (simulation, "
                      "not an independent quorum). Set AVAIRA_WITNESS_SEED with real witness keys."
        }
    return {
        "trusted": trusted,
        "witness_count": valid_sigs,
        "simulated": wn.simulated,
        "detail": "Quorum of co-signatures verified" if trusted else "Insufficient witness co-signatures"
    }

@api_router.get("/agents/{agent_id}/audit")
async def get_agent_audit(agent_id: str, agent: Dict = Depends(_get_agent_from_key)):
    if agent["id"] != agent_id:
        raise HTTPException(403, "API Key does not match agent ID")

    trail = await intent_logger.get_audit_trail(agent_id,
                                               datetime.now(timezone.utc) - timedelta(days=30),
                                               datetime.now(timezone.utc))
    return [e.model_dump() for e in trail]

@api_router.get("/executions/{execution_id}/zk-proof")
async def get_execution_zk_proof(execution_id: str):
    ex = await db.executions.find_one({"id": execution_id})
    if not ex:
        raise HTTPException(404, "Execution not found")

    proof = ex.get("zk_proof")
    if not proof:
        raise HTTPException(404, "ZK-proof not found for this execution")

    return proof

@api_router.get("/agents/{agent_id}/drift")
async def get_agent_drift(agent_id: str, agent: Dict = Depends(_get_agent_from_key)):
    if agent["id"] != agent_id:
        raise HTTPException(403, "API Key does not match agent ID")

    # Return the drift analysis from the latest execution
    last_exec = await db.executions.find_one(
        {"agent_id": agent_id},
        sort=[("timestamp", -1)]
    )

    if not last_exec or "drift_analysis" not in last_exec:
        # Fallback to a fresh analysis if no history in executions
        # In a real app, we might store the current 'drift state' in the agent record
        return await avaira_sentinel.analyze_drift(agent_id, {"task": "periodic_check"})

    return last_exec["drift_analysis"]

class InsuranceRequest(BaseModel):
    agent_id: str
    underwriter_id: str
    coverage_amount: float

@api_router.post("/marketplace/insurance")
async def issue_insurance(body: InsuranceRequest, _user: Dict[str, Any] = Depends(require_authenticated_user)):
    policy = await trust_marketplace.issue_policy(
        body.agent_id, body.underwriter_id, body.coverage_amount
    )
    return policy.model_dump()

@api_router.post("/agents/{agent_id}/slash")
async def slash_agent_internal(agent_id: str, request: Request):
    await enforce_rate_limit(request, "admin_actions", limit=60, window_seconds=60)
    admin_key = request.headers.get("X-Avaira-Admin-Key") or ""
    # Constant-time comparison: `!=` on secrets leaks the shared key byte by byte.
    if not AVAIRA_ADMIN_KEY or not hmac.compare_digest(admin_key, AVAIRA_ADMIN_KEY):
        raise HTTPException(401, "Unauthorized admin action")

    body = await request.json()
    reason = body.get("reason", "manual")
    severity = body.get("severity", "medium")

    result = await slash_engine.slash(agent_id, reason, severity)

    # Trigger Marketplace Slashing Bridge
    await trust_marketplace.trigger_slashing_bridge(agent_id, reason, severity)

    return result.model_dump()

@api_router.get("/agents/{agent_id}/slash-history")
async def get_agent_slash_history(agent_id: str, agent: Dict = Depends(_get_agent_from_key)):
    if agent["id"] != agent_id:
        raise HTTPException(403, "API Key does not match agent ID")

    slashes = await db.slash_events.find({"agent_id": agent_id}, {"_id": 0}).sort("timestamp", -1).to_list(100)
    return slashes

@api_router.post("/appeal/{slash_id}")
async def appeal_slash(slash_id: str, body: Dict[str, Any], request: Request):
    slash = await db.slash_events.find_one({"id": slash_id})
    if not slash: raise HTTPException(404, "Slash not found")

    # Only the slashed agent's operator (API key or owning session) may appeal.
    agent = await db.agents.find_one({"id": slash["agent_id"]}, {"_id": 0})
    if not agent: raise HTTPException(404, "Agent not found")
    await require_agent_access(request, agent)

    result = await slash_engine.appeal(slash["agent_id"], slash_id, body.get("evidence", ""))
    return result.model_dump()

@api_router.post("/agent/think")
async def agent_think(body: AgentThinkRequest, request: Request, user: Dict[str, Any] = Depends(require_authenticated_user)):
    await enforce_rate_limit(request, "agent_think", limit=30, window_seconds=60, identity=user.get("user_id"))
    agent = await db.agents.find_one({"id": body.agent_address})
    if not agent:
        agent = await db.agents.find_one({"wallet_address": body.agent_address})
    if not agent: raise HTTPException(404, "Agent not found")

    real_agent = RealAvairaAgent(agent["id"], agent["risk_envelope"], db_client=db)
    intent = await real_agent.think(body.mission_goal)
    return intent.model_dump()


@api_router.post("/agent/simulate-full-lifecycle")
async def simulate_full_lifecycle(body: AgentThinkRequest, request: Request, user: Dict[str, Any] = Depends(require_authenticated_user)):
    await enforce_rate_limit(request, "simulate_lifecycle", limit=10, window_seconds=60, identity=user.get("user_id"))
    if not is_valid_evm_address(body.agent_address):
        raise HTTPException(400, "Invalid agent wallet address")

    agent = await _ensure_ai_agent_record(body, user_id=user.get("user_id"))
    runtime = AvairaAgent(body.agent_address, body.risk_envelope, body.mission_goal)
    lifecycle = []

    lifecycle.append({
        "stage": 1,
        "name": "register",
        "status": "completed",
        "details": {
            "agent_id": agent["id"],
            "wallet_address": agent["wallet_address"],
            "risk_envelope": agent["risk_envelope"],
        },
    })

    intent = await runtime.think(body.market_context, body.history)
    lifecycle.append({"stage": 2, "name": "think", "status": "completed", "details": intent.model_dump()})

    validation = runtime.validate(intent)
    lifecycle.append({"stage": 3, "name": "validate", "status": "completed" if validation["valid"] else "failed", "details": validation})

    permit_bundle = None
    tx_hash = None
    final_status = "completed"
    score_payload_before = await _normalize_score(agent)
    score_before = score_payload_before["score"]

    if validation["valid"]:
        # Reserve the next nonce atomically and persist it: the old code derived the
        # nonce from a field it never wrote back, so every run reused the same nonce
        # (and could regenerate the same permit).
        counter = await db.agents.find_one_and_update(
            {"id": agent["id"]},
            {"$inc": {"runtime_nonce": 1}},
            return_document=ReturnDocument.AFTER,
        )
        nonce = int((counter or {}).get("runtime_nonce", 1))
        permit_bundle = generate_permit(body.agent_address, intent.action, intent.target, intent.value_usd, nonce)
        permit_ok = verify_permit(permit_bundle["permit"], permit_bundle["signature"], body.agent_address)
        if permit_ok:
            # One execution per permit, even if the signature is replayed later.
            permit_ok = await permit_nonces.consume(body.agent_address, nonce)
        lifecycle.append({
            "stage": 4,
            "name": "permit",
            "status": "completed" if permit_ok else "failed",
            "details": {"signature": permit_bundle["signature"], "deadline": permit_bundle["deadline"], "verified": permit_ok},
        })

        if not permit_ok:
            final_status = "rejected"
            new_score = max(0, score_before - 5)
            await db.agents.update_one(
                {"id": agent["id"]},
                {"$inc": {"total_executions": 1, "failed_executions": 1}},
            )
            await _write_reputation_snapshot(agent, new_score, "permit_verification_failed")
            lifecycle.append({"stage": 5, "name": "execute", "status": "skipped", "details": {"reason": "permit verification failed"}})
            lifecycle.append({"stage": 6, "name": "score_update", "status": "completed", "details": {"before": score_before, "after": new_score, "grade": _grade_from_score(new_score)}})
            lifecycle.append({"stage": 7, "name": "final_state", "status": "completed", "details": {"status": "rejected"}})
            await db.executions.insert_one(
                {
                    "id": str(uuid.uuid4()),
                    "agent_id": agent["id"],
                    "agent_name": agent["name"],
                    "action": intent.action,
                    "target_address": intent.target,
            "value": intent.value_usd,
                    "permit": permit_bundle,
                    "tx_hash": None,
                    "status": final_status,
                    "source": "simulate_full_lifecycle",
                    "lifecycle": lifecycle,
                    "created_at": datetime.now(timezone.utc).isoformat(),
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
            )
            latest = await db.agents.find_one({"id": agent["id"]}, {"_id": 0})
            return {
                "status": final_status,
                "agent": latest,
                "intent": intent.model_dump(),
                "lifecycle": lifecycle,
                "permit": permit_bundle,
                "avaira_score": await _normalize_score(latest),
            }

        tx_hash = "0x" + hashlib.sha256(f"{body.agent_address}:{nonce}:{intent.action}:{intent.target}:{intent.value_usd}".encode()).hexdigest()
        lifecycle.append({
            "stage": 5,
            "name": "execute",
            "status": "completed",
            "details": {"tx_hash": tx_hash, "network": "fuji", "explorer": f"https://avaira.xyz/audit/tx/{tx_hash}"},
        })

        fee = round(intent.value_usd * PROTOCOL_FEE_RATE, 6)
        await record_treasury_transaction(tx_hash, fee)
        lifecycle.append({"stage": 6, "name": "fee_deducted", "status": "completed", "details": {"fee_usd": fee}})

        new_score = min(100, score_before + 8)
        await db.agents.update_one(
            {"id": agent["id"]},
            {"$set": {"runtime_nonce": nonce, "status": "active"}, "$inc": {"total_executions": 1, "successful_executions": 1}},
        )
        await _write_reputation_snapshot(agent, new_score, "full_lifecycle_success")
        lifecycle.append({"stage": 7, "name": "score_update", "status": "completed", "details": {"before": score_before, "after": new_score, "grade": _grade_from_score(new_score)}})
        lifecycle.append({"stage": 8, "name": "freeze_check", "status": "completed", "details": {"frozen": False, "reason": "no deviation detected"}})
    else:
        slash_amount = round(float(agent.get("collateral_remaining", 0.1)) * SLASH_RATE, 6)
        final_status = "rejected"
        await db.agents.update_one(
            {"id": agent["id"]},
            {
                "$set": {"status": "frozen", "collateral_remaining": max(0.0, float(agent.get("collateral_remaining", 0.1)) - slash_amount)},
                "$inc": {"total_executions": 1, "failed_executions": 1},
            },
        )
        await db.freeze_events.insert_one(
            {
                "id": str(uuid.uuid4()),
                "agent_id": agent["id"],
                "agent_name": agent["name"],
                "type": "freeze",
                "reason": validation["reason"],
                "collateral_slashed": slash_amount,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
        )
        new_score = max(0, score_before - 15)
        await _write_reputation_snapshot(agent, new_score, "full_lifecycle_rejection")
        lifecycle.append({"stage": 4, "name": "permit", "status": "skipped", "details": {"reason": validation["reason"]}})
        lifecycle.append({"stage": 5, "name": "execute", "status": "skipped", "details": {"reason": "execution blocked by risk envelope"}})
        lifecycle.append({"stage": 6, "name": "score_update", "status": "completed", "details": {"before": score_before, "after": new_score, "grade": _grade_from_score(new_score)}})
        lifecycle.append({"stage": 7, "name": "freeze", "status": "completed", "details": {"slash_amount": slash_amount, "reason": validation["reason"]}})
        lifecycle.append({"stage": 8, "name": "final_state", "status": "completed", "details": {"status": "frozen"}})

    await db.executions.insert_one(
        {
            "id": str(uuid.uuid4()),
            "agent_id": agent["id"],
            "agent_name": agent["name"],
            "action": intent.action,
            "target_address": intent.target,
            "value": intent.value_usd,
            "permit": permit_bundle,
            "tx_hash": tx_hash,
            "status": final_status,
            "source": "simulate_full_lifecycle",
            "lifecycle": lifecycle,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
    )

    latest = await db.agents.find_one({"id": agent["id"]}, {"_id": 0})
    return {
        "status": final_status,
        "agent": latest,
        "intent": intent.model_dump(),
        "lifecycle": lifecycle,
        "permit": permit_bundle,
        "avaira_score": await _normalize_score(latest),
    }


@api_router.get("/agent/leaderboard")
async def agent_leaderboard():
    return await get_leaderboard()

# ─── NEURAL INTENT VALIDATION ───────────────────────────────────
class IntentValidateRequest(BaseModel):
    intent: Dict[str, Any]
    risk_envelope: Dict[str, Any]

@api_router.post("/validate")
async def validate_intent_endpoint(body: IntentValidateRequest, request: Request):
    """
    Two-layer intent validation using AvairaValidator (Claude-powered).
    """
    await enforce_rate_limit(request, "validate_intent", limit=30, window_seconds=60)
    result = await avaira_validator.validate(body.intent, body.risk_envelope)
    return result

# ─── HEALTH ──────────────────────────────────────────────────────
@api_router.get("/anchor-state")
async def anchor_state_endpoint():
    """
    Internal cron endpoint for state anchoring.
    """
    result = await reputation_engine.anchor_state()
    return result

@api_router.get("/health")
async def health_check():
    """Returns service health status for monitoring and CI smoke tests."""
    db_ok = "ok"
    try:
        await db.command("ping")
    except Exception:
        db_ok = "error"
    return {
        "status": "ok" if db_ok == "ok" else "degraded",
        "version": "1.0.0",
        "db": db_ok,
        "chain": "mainnet" if os.environ.get("CHAIN_ID", "43114") == "43114" else "fuji",
    }

# ─── ROOT ────────────────────────────────────────────────────────
@api_router.get("/")
async def root():
    return {"message": "AVAIRA Protocol API v1.0", "status": "operational"}

app.include_router(api_router)


@app.middleware("http")
async def database_guard(request: Request, call_next):
    if not DATABASE_READY and request.url.path.startswith("/api") and request.url.path != "/api/":
        return JSONResponse({"detail": "Database unavailable"}, status_code=503)
    return await call_next(request)

cors_origins = [origin.strip() for origin in os.environ.get('CORS_ORIGINS', 'http://localhost:3000').split(',') if origin.strip()]
allow_credentials = '*' not in cors_origins
if not allow_credentials:
    logger.warning("CORS_ORIGINS includes '*'; credentialed cross-origin requests are disabled.")

app.add_middleware(
    CORSMiddleware,
    allow_credentials=allow_credentials,
    allow_origins=cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
