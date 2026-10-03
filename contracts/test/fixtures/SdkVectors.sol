// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ┌────────────────────────────────────────────────────────────────────────────────────┐
// │  GENERATED FILE — do not edit by hand.                                             │
// │  Regenerate with:  cd sdk/typescript && npm run vectors                            │
// │                                                                                    │
// │  Produced by the TypeScript SDK (@avaira/sdk), consumed by                         │
// │  contracts/test/MerkleParity.t.sol. Proves the offchain audit trail is admissible  │
// │  onchain: identical leaf encoding, identical sorted-pair tree, identical roots.    │
// └────────────────────────────────────────────────────────────────────────────────────┘

/// @notice Parity vectors for the SDK↔Solidity audit-trail commitment.
library SdkVectors {
    struct Leaf {
        uint256 agentId;
        bytes32 intentHash;
        string action;
        uint256 spendUsd;
        uint256 nonce;
    }

    struct Set {
        string name;
        Leaf[] leaves;
        bytes32[] rawLeaves;
        bytes32 root;
        bytes32[][] proofs;
    }

    /// @notice Number of vector sets.
    function setCount() internal pure returns (uint256) {
        return 5;
    }

    /// @notice Every vector set: leaves, their SDK-computed leaf hashes, root and proofs.
    function sets() internal pure returns (Set[] memory out) {
        out = new Set[](5);
        uint256 i;
        out[0].name = "single";
        out[0].leaves = new Leaf[](1);
        out[0].leaves[0] = Leaf(7, 0x638b3a1275cfcfc4583e45a574fd3dbba0e22c80d594bac8ebfa01dda35925c7, "email.send", 1005468, 0);
        out[0].rawLeaves = new bytes32[](1);
        out[0].rawLeaves[0] = 0xae3d1d8710dc43bda5bfa4d8ae79474ecb0d0747d268c31480fd19467b5967a3;
        out[0].root = 0xed5922fc5cb207059c4822b5e127dea61bd661c3df106e077cfbb6dd6ed70a55;
        out[0].proofs = new bytes32[][](1);
        out[0].proofs[0] = new bytes32[](0);
        out[1].name = "pair";
        out[1].leaves = new Leaf[](2);
        out[1].leaves[0] = Leaf(7, 0x638b3a1275cfcfc4583e45a574fd3dbba0e22c80d594bac8ebfa01dda35925c7, "email.send", 575173, 0);
        out[1].leaves[1] = Leaf(7, 0x638b3a1275cfcfc4583e45a574fd3dbba0e22c80d594bac8ebfa01dda35925c7, "db.write", 1434647, 1);
        out[1].rawLeaves = new bytes32[](2);
        out[1].rawLeaves[0] = 0xd54acba6f4a99786c629532c47d133f0251e2326d432be373879e13bc4882fbf;
        out[1].rawLeaves[1] = 0x7b43303212abb54425a8ebdd9676f238ac543f94a9fac8e9fc80a3158b18afa6;
        out[1].root = 0xa338b837f8d3a4fc80474e4e20a5383176e1be49216da46d6caf6b5594fafe64;
        out[1].proofs = new bytes32[][](2);
        out[1].proofs[0] = new bytes32[](1);
        out[1].proofs[0][0] = 0x03de773a0085028d62896c05a5269ed090524443d616d9fe40d945ddc8abc11a;
        out[1].proofs[1] = new bytes32[](1);
        out[1].proofs[1][0] = 0x9b8028053f6a6e8974b8bcde64be8156c202f9d290cb09f81495c9b8a29cfc68;
        out[2].name = "odd-three";
        out[2].leaves = new Leaf[](3);
        out[2].leaves[0] = Leaf(7, 0x638b3a1275cfcfc4583e45a574fd3dbba0e22c80d594bac8ebfa01dda35925c7, "email.send", 144878, 0);
        out[2].leaves[1] = Leaf(7, 0x638b3a1275cfcfc4583e45a574fd3dbba0e22c80d594bac8ebfa01dda35925c7, "mcp.call", 418728, 1);
        out[2].leaves[2] = Leaf(7, 0x638b3a1275cfcfc4583e45a574fd3dbba0e22c80d594bac8ebfa01dda35925c7, "email.send", 4889394, 2);
        out[2].rawLeaves = new bytes32[](3);
        out[2].rawLeaves[0] = 0x04d32148f695436411c66d7d1dba2683d45ba82fc528f5092c400ab5d41d39a3;
        out[2].rawLeaves[1] = 0xc81c0e9cc9c6f24685b21c7985915d3d96c953661444480f27c98666b1df2944;
        out[2].rawLeaves[2] = 0x014507b0e9644653fc5e320b28ce35cf2e507308ddd6900926263ba0863d3fae;
        out[2].root = 0xbbe2078ee7ae9f2a301dd20525dc27f16c061abf9fc50abd261e6a049eb093e4;
        out[2].proofs = new bytes32[][](3);
        out[2].proofs[0] = new bytes32[](2);
        out[2].proofs[0][0] = 0xa70ed936c2e70a4950ac8a430299e0437ed8a0756e2be0cef74617a7bbabd10d;
        out[2].proofs[0][1] = 0xb3d5d9a15d5ab2805d435db5b3a68d0140acfd7ad3b9fb1340589d6ca39c8824;
        out[2].proofs[1] = new bytes32[](2);
        out[2].proofs[1][0] = 0x8955718ebb20519ad00ec29d2cd0fd7815acee3e931173ceb424333ffd232f32;
        out[2].proofs[1][1] = 0xb3d5d9a15d5ab2805d435db5b3a68d0140acfd7ad3b9fb1340589d6ca39c8824;
        out[2].proofs[2] = new bytes32[](1);
        out[2].proofs[2][0] = 0x0e8961893a2d1ef269787a5d5b1ef468716e58b1e16dc5f6179404ddf9a7547f;
        out[3].name = "odd-five";
        out[3].leaves = new Leaf[](5);
        out[3].leaves[0] = Leaf(7, 0x638b3a1275cfcfc4583e45a574fd3dbba0e22c80d594bac8ebfa01dda35925c7, "email.send", 4284288, 0);
        out[3].leaves[1] = Leaf(7, 0x638b3a1275cfcfc4583e45a574fd3dbba0e22c80d594bac8ebfa01dda35925c7, "email.send", 3386890, 1);
        out[3].leaves[2] = Leaf(7, 0x638b3a1275cfcfc4583e45a574fd3dbba0e22c80d594bac8ebfa01dda35925c7, "db.write", 2742244, 2);
        out[3].leaves[3] = Leaf(7, 0x638b3a1275cfcfc4583e45a574fd3dbba0e22c80d594bac8ebfa01dda35925c7, "swap.execute", 3330574, 3);
        out[3].leaves[4] = Leaf(7, 0x638b3a1275cfcfc4583e45a574fd3dbba0e22c80d594bac8ebfa01dda35925c7, "web.search", 2498440, 4);
        out[3].rawLeaves = new bytes32[](5);
        out[3].rawLeaves[0] = 0x5a5bece081aa3ae924b440a26617a6a094e5492605a7d9f970807153a2a9cb2d;
        out[3].rawLeaves[1] = 0x28f72732a154f2f2feaa50dd7f8c5403ef0b204b0222dac5cbf0249d0a6cd804;
        out[3].rawLeaves[2] = 0x2352dfcdae0eb34e58957406af52ce349b6af65eeb8f74e4f523d66a668a8cad;
        out[3].rawLeaves[3] = 0xaa513435c275f5127873d05f51db7c7ea0f0ff51cad263815248edb0f7b56e1f;
        out[3].rawLeaves[4] = 0x3c1655f54319c8cc5c8f26689f8e88e34ce29157be43acd5fce494df489c25fe;
        out[3].root = 0x33a55df8e7fb37258e89107171eae8f7b3f60b140c63d776cb571c671286c849;
        out[3].proofs = new bytes32[][](5);
        out[3].proofs[0] = new bytes32[](3);
        out[3].proofs[0][0] = 0xc6ab39bd23916a816f26597024c785b56630412783f3b7449066a291898fa278;
        out[3].proofs[0][1] = 0x2b38453c6a35c8c5371a4122923bb0a59a85f4683938cbc56f00124755ddc8f6;
        out[3].proofs[0][2] = 0x32219756414f1bb553f44e01f2656e1facf6a7a7465b265335480fc620404fb2;
        out[3].proofs[1] = new bytes32[](3);
        out[3].proofs[1][0] = 0xdcdfa3ab7458588f9f7752053aa4002fd1b38d7f6521926136df9439f8745cff;
        out[3].proofs[1][1] = 0x2b38453c6a35c8c5371a4122923bb0a59a85f4683938cbc56f00124755ddc8f6;
        out[3].proofs[1][2] = 0x32219756414f1bb553f44e01f2656e1facf6a7a7465b265335480fc620404fb2;
        out[3].proofs[2] = new bytes32[](3);
        out[3].proofs[2][0] = 0xbd062a33089b88dee3d54ca78dc0932a0d57387433a56a11413945f801459a85;
        out[3].proofs[2][1] = 0xeb62fc6c6c182226f650ce380949fd6b0b0d0fc3edf3fdea5ab9589bb9d48c5a;
        out[3].proofs[2][2] = 0x32219756414f1bb553f44e01f2656e1facf6a7a7465b265335480fc620404fb2;
        out[3].proofs[3] = new bytes32[](3);
        out[3].proofs[3][0] = 0x47766105f7ec8296622ea2080db154eba770a15cbf08213db0ccde2cf75e5b7f;
        out[3].proofs[3][1] = 0xeb62fc6c6c182226f650ce380949fd6b0b0d0fc3edf3fdea5ab9589bb9d48c5a;
        out[3].proofs[3][2] = 0x32219756414f1bb553f44e01f2656e1facf6a7a7465b265335480fc620404fb2;
        out[3].proofs[4] = new bytes32[](1);
        out[3].proofs[4][0] = 0x937ce914f8e4f4e5904f9ab34ab55c04a9130259b475271703314d792b4f3786;
        out[4].name = "even-eight";
        out[4].leaves = new Leaf[](8);
        out[4].leaves[0] = Leaf(7, 0x638b3a1275cfcfc4583e45a574fd3dbba0e22c80d594bac8ebfa01dda35925c7, "email.send", 3026107, 0);
        out[4].leaves[1] = Leaf(7, 0x638b3a1275cfcfc4583e45a574fd3dbba0e22c80d594bac8ebfa01dda35925c7, "swap.execute", 339133, 1);
        out[4].leaves[2] = Leaf(7, 0x638b3a1275cfcfc4583e45a574fd3dbba0e22c80d594bac8ebfa01dda35925c7, "web.search", 1988815, 2);
        out[4].leaves[3] = Leaf(7, 0x638b3a1275cfcfc4583e45a574fd3dbba0e22c80d594bac8ebfa01dda35925c7, "swap.execute", 2937009, 3);
        out[4].leaves[4] = Leaf(7, 0x638b3a1275cfcfc4583e45a574fd3dbba0e22c80d594bac8ebfa01dda35925c7, "swap.execute", 2749347, 4);
        out[4].leaves[5] = Leaf(7, 0x638b3a1275cfcfc4583e45a574fd3dbba0e22c80d594bac8ebfa01dda35925c7, "mcp.call", 2983333, 5);
        out[4].leaves[6] = Leaf(7, 0x638b3a1275cfcfc4583e45a574fd3dbba0e22c80d594bac8ebfa01dda35925c7, "mcp.call", 1010551, 6);
        out[4].leaves[7] = Leaf(7, 0x638b3a1275cfcfc4583e45a574fd3dbba0e22c80d594bac8ebfa01dda35925c7, "swap.execute", 878361, 7);
        out[4].rawLeaves = new bytes32[](8);
        out[4].rawLeaves[0] = 0x717df009a40fbb601e8135881fc20aa47b85b2ce04c4232ffb766284cf53d22e;
        out[4].rawLeaves[1] = 0xcfbcbb2919e70817c0ce0ce4693028c79dcb7224f7efc5929cc0ea4090a4580f;
        out[4].rawLeaves[2] = 0x93e69f5e0b728abd17319da2fc2e4923410fbf94ff862c5471dcd7a4d6bf3086;
        out[4].rawLeaves[3] = 0xa2dd244f284d2ebcdb7e3cb35841967680fb557c75fc4dd3a94bd6ea2d237dab;
        out[4].rawLeaves[4] = 0xd70d2f0381285b689a23044929a397efc2e48bc3c73fd551a39ca7de9694c9ec;
        out[4].rawLeaves[5] = 0x864afef68aa70feb29b20d051061f44fb3ad729adb87b10535f6729f08f54f10;
        out[4].rawLeaves[6] = 0xf4f03ac9de5ba9b85e3fe5875ec12fc9f8c8f2d9a512f7d29c54e5a3e9a3403c;
        out[4].rawLeaves[7] = 0xf40bec2784ae1c2832ae643973e145ac7c0bc90a10e0b9c89b5bc589302fac70;
        out[4].root = 0xc4e039003b1da732f94d70d17f1f12a9e1623fbcdfa207326445fc70375f076a;
        out[4].proofs = new bytes32[][](8);
        out[4].proofs[0] = new bytes32[](3);
        out[4].proofs[0][0] = 0x7e3fb88a3944907785dbe5a5f5bfbcc8ac43914e752db1c1a8ab6fb606e5424a;
        out[4].proofs[0][1] = 0x7038131a302747bf2fb3d83777963694fb71bf1fa4ec0882d3a33824f6b9d836;
        out[4].proofs[0][2] = 0x33d45ed9c344818112a6b7713b6b92b11ed3cdfa54b7b594cf576b13c522a0d7;
        out[4].proofs[1] = new bytes32[](3);
        out[4].proofs[1][0] = 0x636c9ededd6b8945a77a28868dd840df3a01d78d1bbbd2c134a30e97d0477558;
        out[4].proofs[1][1] = 0x7038131a302747bf2fb3d83777963694fb71bf1fa4ec0882d3a33824f6b9d836;
        out[4].proofs[1][2] = 0x33d45ed9c344818112a6b7713b6b92b11ed3cdfa54b7b594cf576b13c522a0d7;
        out[4].proofs[2] = new bytes32[](3);
        out[4].proofs[2][0] = 0xa23921998198c5e4c3cb63bfc0a50eb59fa69749ba95e02496a6882fb2f8b0bc;
        out[4].proofs[2][1] = 0xbff56c9e770831f28d0c4c6e35db64167ac55ec283612cda74f6d3774418a513;
        out[4].proofs[2][2] = 0x33d45ed9c344818112a6b7713b6b92b11ed3cdfa54b7b594cf576b13c522a0d7;
        out[4].proofs[3] = new bytes32[](3);
        out[4].proofs[3][0] = 0x1a56eab5043ae4921263798e1291a7ca6eeb9faa87a0d6ded9528f83ecf8ed42;
        out[4].proofs[3][1] = 0xbff56c9e770831f28d0c4c6e35db64167ac55ec283612cda74f6d3774418a513;
        out[4].proofs[3][2] = 0x33d45ed9c344818112a6b7713b6b92b11ed3cdfa54b7b594cf576b13c522a0d7;
        out[4].proofs[4] = new bytes32[](3);
        out[4].proofs[4][0] = 0x7f6094b30617f05d7d377c823496b3e57d6b0872a7c4efe6c81d0189d2459f63;
        out[4].proofs[4][1] = 0x26b254c4af991b7689bffa042f7162fb55ff81b15a2b36b8aefaf47bc630962e;
        out[4].proofs[4][2] = 0x2712326577213004222b4154dcb0de210a27e96d142a1696473163f4c5e54511;
        out[4].proofs[5] = new bytes32[](3);
        out[4].proofs[5][0] = 0xdfd6e560fabf8f0eebb61c48b2857d92feb053450561e73164c069a1d5424fb2;
        out[4].proofs[5][1] = 0x26b254c4af991b7689bffa042f7162fb55ff81b15a2b36b8aefaf47bc630962e;
        out[4].proofs[5][2] = 0x2712326577213004222b4154dcb0de210a27e96d142a1696473163f4c5e54511;
        out[4].proofs[6] = new bytes32[](3);
        out[4].proofs[6][0] = 0x2eb32762af211d3e2f8418c0995b6089b942d16f42d64de709965a333765fd03;
        out[4].proofs[6][1] = 0x3d9cedc420c571216a4e48dd5750f1a4862b22e8a73ee351eef020607c4ae594;
        out[4].proofs[6][2] = 0x2712326577213004222b4154dcb0de210a27e96d142a1696473163f4c5e54511;
        out[4].proofs[7] = new bytes32[](3);
        out[4].proofs[7][0] = 0x065e4d3f22d1c8d94677678ae438a1c2d636b91ab0050fae19b260dc0a3179de;
        out[4].proofs[7][1] = 0x3d9cedc420c571216a4e48dd5750f1a4862b22e8a73ee351eef020607c4ae594;
        out[4].proofs[7][2] = 0x2712326577213004222b4154dcb0de210a27e96d142a1696473163f4c5e54511;
    }

    /// @notice A risk envelope and the SDK's EIP-712-style hash of it.
    function envelope() internal pure returns (uint256 maxSpendUsd, string[] memory allowedActions, uint64 deadline, bytes32 expectedHash) {
        maxSpendUsd = 5000000;
        deadline = 1893456000;
        allowedActions = new string[](2);
        allowedActions[0] = "web.search";
        allowedActions[1] = "mcp.call";
        expectedHash = 0xc7adf0f3625fee35af3788d34d4b237db40e3818dca0560cf2abd52046112e9d;
    }

}
