/**
 * Contract ABIs for the 0G Galileo deployment.
 *
 * GENERATED from contracts-evm/out/*.json — regenerate with the snippet in
 * docs/superpowers/plans/2026-08-30-0g-galileo-migration.md Task 9 whenever a
 * contract entrypoint changes. `as const` is required: viem derives its
 * argument and return types from the literal tuple, so a widened `Abi` would
 * silently degrade every call to `unknown`.
 */

export const REGISTRY_ABI = [
  {
    "type": "function",
    "name": "MAX_ATTESTATIONS",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MIN_PRICE_WEI",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getAttestations",
    "inputs": [
      {
        "name": "serviceId",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [
      {
        "name": "out",
        "type": "tuple[]",
        "internalType": "struct AgentGateRegistry.Attestation[]",
        "components": [
          {
            "name": "paymentTxHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "success",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "timestamp",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getScore",
    "inputs": [
      {
        "name": "serviceId",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [
      {
        "name": "total",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "success",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getService",
    "inputs": [
      {
        "name": "serviceId",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct AgentGateRegistry.Service",
        "components": [
          {
            "name": "name",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "description",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "gatewayBaseUrl",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "accepts",
            "type": "tuple[]",
            "internalType": "struct AgentGateRegistry.PaymentOption[]",
            "components": [
              {
                "name": "asset",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "amount",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "decimals",
                "type": "uint8",
                "internalType": "uint8"
              },
              {
                "name": "symbol",
                "type": "string",
                "internalType": "string"
              },
              {
                "name": "name",
                "type": "string",
                "internalType": "string"
              },
              {
                "name": "version",
                "type": "string",
                "internalType": "string"
              }
            ]
          },
          {
            "name": "paymentTarget",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "owner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "attestor",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "active",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "createdAt",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "recordAttestation",
    "inputs": [
      {
        "name": "serviceId",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "paymentTxHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "success",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "registerService",
    "inputs": [
      {
        "name": "name",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "description",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "gatewayBaseUrl",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "accepts",
        "type": "tuple[]",
        "internalType": "struct AgentGateRegistry.PaymentOption[]",
        "components": [
          {
            "name": "asset",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "amount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "decimals",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "symbol",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "name",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "version",
            "type": "string",
            "internalType": "string"
          }
        ]
      },
      {
        "name": "paymentTarget",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "attestor",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "serviceId",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "seenPayments",
    "inputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "servicesCount",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "setActive",
    "inputs": [
      {
        "name": "serviceId",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "active",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setAttestor",
    "inputs": [
      {
        "name": "serviceId",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "attestor",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "successCalls",
    "inputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "totalCalls",
    "inputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "AttestationRecorded",
    "inputs": [
      {
        "name": "serviceId",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      },
      {
        "name": "paymentTxHash",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "success",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      },
      {
        "name": "totalCalls",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "successCalls",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ServiceAttestorChanged",
    "inputs": [
      {
        "name": "serviceId",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      },
      {
        "name": "attestor",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ServiceRegistered",
    "inputs": [
      {
        "name": "serviceId",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      },
      {
        "name": "owner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "name",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      },
      {
        "name": "accepts",
        "type": "tuple[]",
        "indexed": false,
        "internalType": "struct AgentGateRegistry.PaymentOption[]",
        "components": [
          {
            "name": "asset",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "amount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "decimals",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "symbol",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "name",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "version",
            "type": "string",
            "internalType": "string"
          }
        ]
      },
      {
        "name": "paymentTarget",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "attestor",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ServiceStatusChanged",
    "inputs": [
      {
        "name": "serviceId",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      },
      {
        "name": "active",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "DuplicateAttestation",
    "inputs": []
  },
  {
    "type": "error",
    "name": "EmptyName",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidPrice",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotAuthorized",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ServiceInactive",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ServiceNotFound",
    "inputs": []
  }
] as const;

export const PAYMENT_ROUTER_ABI = [
  {
    "type": "function",
    "name": "nonceKey",
    "inputs": [
      {
        "name": "serviceId",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "nonce",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "pay",
    "inputs": [
      {
        "name": "serviceId",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "nonce",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "payTo",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "seenNonce",
    "inputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "Paid",
    "inputs": [
      {
        "name": "serviceId",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      },
      {
        "name": "nonce",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "payer",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "payTo",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "timestamp",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "DuplicateNonce",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TransferFailed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAmount",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroPayTo",
    "inputs": []
  }
] as const;

export const SPEND_GUARD_ABI = [
  {
    "type": "function",
    "name": "debit",
    "inputs": [
      {
        "name": "policyId",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "serviceId",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "payTo",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "paymentRef",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "trustTier",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "deposit",
    "inputs": [
      {
        "name": "policyId",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "getPolicy",
    "inputs": [
      {
        "name": "policyId",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct SpendGuard.Policy",
        "components": [
          {
            "name": "owner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "gate",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "budget",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "spent",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "balance",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "perCallCap",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "windowMs",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "maxCallsInWindow",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "minTrustTier",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "paused",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "createdAt",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getRemaining",
    "inputs": [
      {
        "name": "policyId",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "openPolicy",
    "inputs": [
      {
        "name": "gate",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "budget",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "perCallCap",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "windowMs",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "maxCallsInWindow",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "minTrustTier",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [
      {
        "name": "policyId",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "pause",
    "inputs": [
      {
        "name": "policyId",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "paused",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "policiesCount",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "seenRefs",
    "inputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "withdraw",
    "inputs": [
      {
        "name": "policyId",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "DebitApproved",
    "inputs": [
      {
        "name": "policyId",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      },
      {
        "name": "serviceId",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "payTo",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "paymentRef",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "remaining",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Deposited",
    "inputs": [
      {
        "name": "policyId",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "newBalance",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PolicyOpened",
    "inputs": [
      {
        "name": "policyId",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      },
      {
        "name": "owner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "gate",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "budget",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "perCallCap",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "windowMs",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "maxCallsInWindow",
        "type": "uint32",
        "indexed": false,
        "internalType": "uint32"
      },
      {
        "name": "minTrustTier",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PolicyPaused",
    "inputs": [
      {
        "name": "policyId",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      },
      {
        "name": "paused",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Withdrawn",
    "inputs": [
      {
        "name": "policyId",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "remaining",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "DuplicateRef",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidConfig",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotAuthorized",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OverBudget",
    "inputs": []
  },
  {
    "type": "error",
    "name": "Paused",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PerCallExceeded",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PolicyNotFound",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RateExceeded",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TransferFailed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UntrustedService",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAmount",
    "inputs": []
  }
] as const;
