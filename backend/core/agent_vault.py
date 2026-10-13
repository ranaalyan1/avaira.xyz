import os
import uuid
from typing import Dict, Any, Optional

from pydantic import BaseModel


class VirtualCard(BaseModel):
    card_id: str
    last4: str
    spend_limit_usd: float
    merchant_whitelist: list[str]
    status: str


class AgentVault:
    """
    Chainless AgentVault using virtual fiat instead of crypto collateral.

    The vault is a *simulator* today (no PSP is called), but it must still enforce the
    wall it advertises. ``execute_payment`` previously approved anything under a
    hard-coded $10 without ever looking at the card it was handed — ignoring both the
    card's own limit and the merchant whitelist — so the "hard spend wall" was not a
    wall at all. The checks below mirror what a real card processor (Stripe Issuing /
    Lithic) enforces: card exists and is active, merchant whitelisted, per-card balance
    never exceeded, amounts positive and finite.

    ``processor`` in the response makes the simulation explicit.
    """

    def __init__(self):
        self.api_key = os.environ.get("STRIPE_API_KEY")  # Example provider
        self.base_url = "https://api.stripe.com/v1/issuing"
        self._cards: Dict[str, VirtualCard] = {}
        self._spent: Dict[str, float] = {}

    async def generate_virtual_card(self, agent_id: str, limit_usd: float) -> VirtualCard:
        """
        In production, this would call Stripe/Lithic to create a real virtual card.
        For this prototype, we simulate the vault response.
        """
        card_id = f"ic_{uuid.uuid4().hex[:12]}"

        limit = max(0.0, float(limit_usd or 0.0))
        card = VirtualCard(
            card_id=card_id,
            last4="4242",
            spend_limit_usd=limit,
            merchant_whitelist=["AWS", "OpenAI", "Anthropic"],
            status="active",
        )
        self._cards[card_id] = card
        self._spent[card_id] = 0.0
        return card

    async def execute_payment(self, card_id: str, amount_usd: float, merchant: str) -> Dict[str, Any]:
        """
        Enforce the fiat wall on the card the caller actually presented.

        Returns a decline (never an exception) so callers can branch on ``status``:
        ``unknown_card``, ``card_inactive``, ``invalid_amount``, ``merchant_not_whitelisted``
        or ``insufficient_fiat_limit``.
        """
        card = self._cards.get(card_id)
        if card is None:
            return {"status": "declined", "reason": "unknown_card", "processor": "simulated"}
        if card.status != "active":
            return {"status": "declined", "reason": "card_inactive", "processor": "simulated"}

        try:
            amount = float(amount_usd)
        except (TypeError, ValueError):
            return {"status": "declined", "reason": "invalid_amount", "processor": "simulated"}
        if not (amount > 0) or amount != amount or amount in (float("inf"), float("-inf")):
            return {"status": "declined", "reason": "invalid_amount", "processor": "simulated"}

        whitelist = {m.strip().lower() for m in card.merchant_whitelist}
        requested = (merchant or "").strip().lower()
        # Exact merchant match (optionally "<whitelisted> <anything>", e.g. "AWS EU-West").
        if not any(requested == w or requested.startswith(w + " ") or requested.startswith(w + "-") for w in whitelist):
            return {
                "status": "declined",
                "reason": "merchant_not_whitelisted",
                "merchant": merchant,
                "processor": "simulated",
            }

        spent = self._spent.get(card_id, 0.0)
        remaining = card.spend_limit_usd - spent
        if amount > remaining + 1e-9:
            return {
                "status": "declined",
                "reason": "insufficient_fiat_limit",
                "remaining_usd": round(max(remaining, 0.0), 6),
                "processor": "simulated",
            }

        self._spent[card_id] = spent + amount
        return {
            "status": "approved",
            "transaction_id": f"txn_{uuid.uuid4().hex[:12]}",
            "amount_usd": amount,
            "remaining_usd": round(card.spend_limit_usd - self._spent[card_id], 6),
            "processor": "simulated",
        }

    def card_status(self, card_id: str) -> Optional[Dict[str, Any]]:
        """Remaining headroom for a card, for callers that need to pre-flight a payment."""
        card = self._cards.get(card_id)
        if card is None:
            return None
        spent = self._spent.get(card_id, 0.0)
        return {
            "card_id": card_id,
            "status": card.status,
            "spend_limit_usd": card.spend_limit_usd,
            "spent_usd": round(spent, 6),
            "remaining_usd": round(card.spend_limit_usd - spent, 6),
        }
