// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {IAscendLaunchpad} from "ascend/interfaces/IAscendLaunchpad.sol";
import {LaunchpadKey} from "ascend/libraries/LaunchpadKey.sol";
import {PoolId} from "infinity-core/src/types/PoolId.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";

interface IEscrowFactoryV5 {
    struct LaunchParams {
        string name;
        string symbol;
        address quote;
        uint256 devBuyQuote;
        uint256 minDevOut;
        bytes32 salt;
        address creator;
        uint24 fee;
        uint24 builderFee;
    }

    struct Route {
        address recipient;
        address dev;
        address builder;
        bool cto;
    }

    function ruleSet() external view returns (address);
    function escrowOf(bytes32 pool) external view returns (address);
    function launchChecked(LaunchParams calldata p, Route calldata r, address ruleSet, int24 tick)
        external
        returns (address token, bytes32 pool, address escrow);
}

struct V4PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

interface IV4Quoter {
    struct Params {
        V4PoolKey poolKey;
        bool zeroForOne;
        uint128 exactAmount;
        bytes hookData;
    }

    function quoteExactInputSingle(Params calldata params) external returns (uint256 amountOut, uint256 gasEstimate);
}

interface IUniversalRouterV220 {
    struct ExactInputSingle {
        V4PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        uint256 minHopPriceX36;
        bytes hookData;
    }

    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2Allowance {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

contract AscendMainnetCompatibilityTest is Test {
    IAscendLaunchpad constant LAUNCHPAD = IAscendLaunchpad(0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC);
    IEscrowFactoryV5 constant FACTORY = IEscrowFactoryV5(0x63f6a8A8d0257c0363251a50cdE8A8b1046e4d19);
    address constant USDC = 0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65;
    address constant ROUTER = 0x1B341FDD55d56F8E08409A2C25DDFad93Eb03C1a;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant QUOTER = 0x379F556c5a748BD7Cc9baF0F7A344094Ac1814f5;

    modifier mainnetFork() {
        string memory rpc = vm.envOr("ASCEND_MAINNET_FORK_RPC", string(""));
        vm.skip(bytes(rpc).length == 0);
        vm.createSelectFork(rpc, 3_120_548);
        assertEq(block.chainid, 99901);
        _;
    }

    function test_currentDeployRejectsMainnetVaultAPI() public mainnetFork {
        assertEq(LAUNCHPAD.baseQuote(), USDC);
        assertGt(address(LAUNCHPAD.poolManager()).code.length, 0);
        (bool ok, bytes memory result) = address(LAUNCHPAD).staticcall(abi.encodeWithSignature("vault()"));
        assertFalse(ok);
        assertEq(result.length, 0);
        vm.setEnv("DEPLOYMENT_FILE", "deployments/elysium-mainnet.json");
        vm.setEnv("LAUNCHPAD", vm.toString(address(LAUNCHPAD)));
        vm.setEnv("USDC", vm.toString(USDC));
        vm.setEnv("BURN_SINK", "0x9F0b0e3B362937b07Cd1E869b50687961e0c7741");
        Deploy script = new Deploy();
        vm.expectRevert(bytes(""));
        script.run();
    }

    function test_escrowLaunchWorksButLegacyKeyAndLaunchDoNot() public mainnetFork {
        (address token, bytes32 pool, address escrow, V4PoolKey memory key) = _launch();
        assertEq(keccak256(abi.encode(key)), pool);
        assertEq(FACTORY.escrowOf(pool), escrow);
        assertEq(LAUNCHPAD.poolCreator(PoolId.wrap(pool)), escrow);
        assertTrue(escrow != address(this));
        assertGt(token.code.length, 0);
        assertGt(escrow.code.length, 0);
        assertTrue(
            keccak256(abi.encode(LaunchpadKey.keyOf(token, USDC, address(LAUNCHPAD), address(LAUNCHPAD.poolManager()))))
                != pool
        );
        vm.expectRevert();
        LAUNCHPAD.launch(IAscendLaunchpad.LaunchParams("Legacy", "OLD", USDC, 0, 0, bytes32(0), address(this)));
    }

    function test_documentedV220RouterQuoteAndBuy() public mainnetFork {
        (address token,,, V4PoolKey memory key) = _launch();
        uint128 amount = 1e6;
        bool zeroForOne = key.currency0 == USDC;
        (uint256 quoted,) = IV4Quoter(QUOTER).quoteExactInputSingle(IV4Quoter.Params(key, zeroForOne, amount, ""));
        assertGt(quoted, 0);
        uint128 minimum = uint128(quoted * 99 / 100);
        deal(USDC, address(this), amount);
        ERC20(USDC).approve(PERMIT2, amount);
        IPermit2Allowance(PERMIT2).approve(USDC, ROUTER, amount, type(uint48).max);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(IUniversalRouterV220.ExactInputSingle(key, zeroForOne, amount, minimum, 0, ""));
        params[1] = abi.encode(USDC, uint256(amount));
        params[2] = abi.encode(token, uint256(minimum));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(hex"060c0f", params);
        IUniversalRouterV220(ROUTER).execute(hex"10", inputs, block.timestamp + 300);
        assertGe(ERC20(token).balanceOf(address(this)), minimum);
        assertEq(ERC20(USDC).balanceOf(address(this)), 0);
    }

    function _launch() internal returns (address token, bytes32 pool, address escrow, V4PoolKey memory key) {
        IAscendLaunchpad.QuoteConfig memory quote = LAUNCHPAD.quoteConfig(USDC);
        assertTrue(quote.allowed);
        (token, pool, escrow) = FACTORY.launchChecked(
            IEscrowFactoryV5.LaunchParams(
                "Fork probe", "PROBE", USDC, 0, 0, keccak256("fork-only"), address(0), 20_000, 0
            ),
            IEscrowFactoryV5.Route(address(this), address(this), address(0), false),
            FACTORY.ruleSet(),
            quote.startTick
        );
        key = V4PoolKey(token < USDC ? token : USDC, token < USDC ? USDC : token, 0x800000, 200, address(LAUNCHPAD));
    }
}
