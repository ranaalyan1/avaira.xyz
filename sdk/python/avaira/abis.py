"""Minimal ABIs — the contract surface an agent needs, and nothing else.

Kept hand-written for the same reason as the TypeScript SDK: an agent runtime should not
break because a dashboard build artefact changed.
"""

INTENT_VAULT_ABI = [
    {
        "type": "function",
        "name": "commitIntent",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "agentId", "type": "uint256"},
            {"name": "intentHash", "type": "bytes32"},
            {
                "name": "envelope",
                "type": "tuple",
                "components": [
                    {"name": "maxSpendUsd", "type": "uint256"},
                    {"name": "allowedActions", "type": "string[]"},
                    {"name": "deadline", "type": "uint64"},
                ],
            },
        ],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "attestOutcome",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "agentId", "type": "uint256"},
            {"name": "intentHash", "type": "bytes32"},
            {"name": "outcomeHash", "type": "bytes32"},
            {"name": "merkleRoot", "type": "bytes32"},
        ],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "recordGateDecision",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "agentId", "type": "uint256"},
            {"name": "intentHash", "type": "bytes32"},
            {"name": "allowed", "type": "bool"},
            {"name": "reason", "type": "uint8"},
            {"name": "latencyMs", "type": "uint32"},
        ],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "challengeDeviation",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "agentId", "type": "uint256"},
            {"name": "intentHash", "type": "bytes32"},
            {
                "name": "leaf",
                "type": "tuple",
                "components": [
                    {"name": "agentId", "type": "uint256"},
                    {"name": "intentHash", "type": "bytes32"},
                    {"name": "action", "type": "string"},
                    {"name": "spendUsd", "type": "uint256"},
                    {"name": "nonce", "type": "uint256"},
                ],
            },
            {"name": "merkleProof", "type": "bytes32[]"},
        ],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "getIntent",
        "stateMutability": "view",
        "inputs": [
            {"name": "agentId", "type": "uint256"},
            {"name": "intentHash", "type": "bytes32"},
        ],
        "outputs": [
            {
                "name": "",
                "type": "tuple",
                "components": [
                    {"name": "agentId", "type": "uint256"},
                    {"name": "intentHash", "type": "bytes32"},
                    {"name": "envelopeHash", "type": "bytes32"},
                    {"name": "maxSpendUsd", "type": "uint256"},
                    {"name": "deadline", "type": "uint64"},
                    {"name": "committedAt", "type": "uint64"},
                    {"name": "challengeEndsAt", "type": "uint64"},
                    {"name": "outcomeHash", "type": "bytes32"},
                    {"name": "outcomeRoot", "type": "bytes32"},
                    {"name": "committer", "type": "address"},
                    {"name": "executed", "type": "bool"},
                    {"name": "challenged", "type": "bool"},
                    {"name": "deviationUpheld", "type": "bool"},
                ],
            }
        ],
    },
    {
        "type": "function",
        "name": "checkGate",
        "stateMutability": "view",
        "inputs": [{"name": "agentId", "type": "uint256"}],
        "outputs": [
            {"name": "allowed", "type": "bool"},
            {"name": "score", "type": "uint8"},
            {"name": "reason", "type": "uint8"},
        ],
    },
    {
        "type": "function",
        "name": "checkGate",
        "stateMutability": "view",
        "inputs": [
            {"name": "agentId", "type": "uint256"},
            {"name": "intentHash", "type": "bytes32"},
            {"name": "envelopeHash", "type": "bytes32"},
        ],
        "outputs": [
            {"name": "allowed", "type": "bool"},
            {"name": "score", "type": "uint8"},
            {"name": "reason", "type": "uint8"},
        ],
    },
    {
        "type": "function",
        "name": "isChallengeOpen",
        "stateMutability": "view",
        "inputs": [
            {"name": "agentId", "type": "uint256"},
            {"name": "intentHash", "type": "bytes32"},
        ],
        "outputs": [{"name": "", "type": "bool"}],
    },
    {
        "type": "event",
        "name": "IntentCommitted",
        "inputs": [
            {"name": "agentId", "type": "uint256", "indexed": True},
            {"name": "intentHash", "type": "bytes32", "indexed": True},
            {"name": "envelopeHash", "type": "bytes32", "indexed": False},
            {"name": "deadline", "type": "uint64", "indexed": False},
            {"name": "maxSpendUsd", "type": "uint256", "indexed": False},
        ],
        "anonymous": False,
    },
    {
        "type": "event",
        "name": "OutcomeAttested",
        "inputs": [
            {"name": "agentId", "type": "uint256", "indexed": True},
            {"name": "intentHash", "type": "bytes32", "indexed": True},
            {"name": "outcomeHash", "type": "bytes32", "indexed": False},
            {"name": "merkleRoot", "type": "bytes32", "indexed": False},
            {"name": "challengeEndsAt", "type": "uint64", "indexed": False},
        ],
        "anonymous": False,
    },
    {
        "type": "event",
        "name": "DeviationUpheld",
        "inputs": [
            {"name": "agentId", "type": "uint256", "indexed": True},
            {"name": "intentHash", "type": "bytes32", "indexed": True},
            {"name": "challenger", "type": "address", "indexed": True},
            {"name": "bounty", "type": "uint256", "indexed": False},
            {"name": "slashed", "type": "uint256", "indexed": False},
        ],
        "anonymous": False,
    },
    {
        "type": "event",
        "name": "GateDecisionRecorded",
        "inputs": [
            {"name": "agentId", "type": "uint256", "indexed": True},
            {"name": "intentHash", "type": "bytes32", "indexed": True},
            {"name": "allowed", "type": "bool", "indexed": False},
            {"name": "reason", "type": "uint8", "indexed": False},
            {"name": "latencyMs", "type": "uint32", "indexed": False},
        ],
        "anonymous": False,
    },
]

STAKE_REGISTRY_ABI = [
    {
        "type": "function",
        "name": "stake",
        "stateMutability": "nonpayable",
        "inputs": [{"name": "agentId", "type": "uint256"}, {"name": "amount", "type": "uint256"}],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "unstake",
        "stateMutability": "nonpayable",
        "inputs": [{"name": "agentId", "type": "uint256"}, {"name": "amount", "type": "uint256"}],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "isEligible",
        "stateMutability": "view",
        "inputs": [{"name": "agentId", "type": "uint256"}],
        "outputs": [{"name": "", "type": "bool"}],
    },
    {
        "type": "function",
        "name": "scoreOf",
        "stateMutability": "view",
        "inputs": [{"name": "agentId", "type": "uint256"}],
        "outputs": [{"name": "", "type": "uint8"}],
    },
    {
        "type": "function",
        "name": "statusOf",
        "stateMutability": "view",
        "inputs": [{"name": "agentId", "type": "uint256"}],
        "outputs": [{"name": "", "type": "uint8"}],
    },
    {
        "type": "function",
        "name": "stakeOf",
        "stateMutability": "view",
        "inputs": [{"name": "agentId", "type": "uint256"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "type": "function",
        "name": "minStake",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "type": "function",
        "name": "minScore",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "uint8"}],
    },
    {
        "type": "event",
        "name": "AgentSlashed",
        "inputs": [
            {"name": "agentId", "type": "uint256", "indexed": True},
            {"name": "level", "type": "uint8", "indexed": False},
            {"name": "amountSlashed", "type": "uint256", "indexed": False},
            {"name": "beneficiary", "type": "address", "indexed": True},
            {"name": "bounty", "type": "uint256", "indexed": False},
            {"name": "evidenceHash", "type": "bytes32", "indexed": False},
            {"name": "reason", "type": "string", "indexed": False},
        ],
        "anonymous": False,
    },
]

IDENTITY_REGISTRY_ABI = [
    {
        "type": "function",
        "name": "register",
        "stateMutability": "payable",
        "inputs": [{"name": "agentURI", "type": "string"}],
        "outputs": [{"name": "agentId", "type": "uint256"}],
    },
    {
        "type": "function",
        "name": "getAgentWallet",
        "stateMutability": "view",
        "inputs": [{"name": "agentId", "type": "uint256"}],
        "outputs": [{"name": "", "type": "address"}],
    },
    {
        "type": "function",
        "name": "ownerOf",
        "stateMutability": "view",
        "inputs": [{"name": "tokenId", "type": "uint256"}],
        "outputs": [{"name": "", "type": "address"}],
    },
    {
        "type": "function",
        "name": "statusOf",
        "stateMutability": "view",
        "inputs": [{"name": "agentId", "type": "uint256"}],
        "outputs": [{"name": "", "type": "uint8"}],
    },
]

REPUTATION_REGISTRY_ABI = [
    {
        "type": "function",
        "name": "scoreOf",
        "stateMutability": "view",
        "inputs": [{"name": "agentId", "type": "uint256"}],
        "outputs": [{"name": "", "type": "uint8"}],
    },
    {
        "type": "function",
        "name": "gradeOf",
        "stateMutability": "view",
        "inputs": [{"name": "agentId", "type": "uint256"}],
        "outputs": [{"name": "", "type": "string"}],
    },
]

ERC20_ABI = [
    {
        "type": "function",
        "name": "approve",
        "stateMutability": "nonpayable",
        "inputs": [{"name": "spender", "type": "address"}, {"name": "amount", "type": "uint256"}],
        "outputs": [{"name": "", "type": "bool"}],
    },
    {
        "type": "function",
        "name": "balanceOf",
        "stateMutability": "view",
        "inputs": [{"name": "account", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "type": "function",
        "name": "allowance",
        "stateMutability": "view",
        "inputs": [{"name": "owner", "type": "address"}, {"name": "spender", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "type": "function",
        "name": "mint",
        "stateMutability": "nonpayable",
        "inputs": [{"name": "to", "type": "address"}, {"name": "amount", "type": "uint256"}],
        "outputs": [],
    },
]
