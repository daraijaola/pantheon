// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

struct V5PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

library AscendV5Key {
    function keyOf(address token, address quote, address hook) internal pure returns (V5PoolKey memory) {
        return V5PoolKey(token < quote ? token : quote, token < quote ? quote : token, 0x800000, 200, hook);
    }
}

interface IV5PoolManager {
    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }

    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(V5PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        external
        returns (int256 delta);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
}

interface IV5StateView {
    function getSlot0(bytes32 id)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
}

interface IV5LaunchState {
    function paused() external view returns (bool);
}

interface ICreatorSeatV5 {
    function harvest() external;
    function claim(uint256 i, bool tokenSide) external returns (uint256 amount);
    function claimable(uint256 i, bool tokenSide) external view returns (uint256);
    function slot(uint256 i) external view returns (address account, uint16 bps, address pending, uint40 lastSeen);
    function quote() external view returns (address);
    function escrow() external view returns (address);
    function token() external view returns (address);
    function poolId() external view returns (bytes32);
}

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

    function predict(address payer, LaunchParams calldata p, Route calldata r)
        external
        view
        returns (address escrow, address token);
    function ruleSet() external view returns (address);
    function launchpad() external view returns (address);
    function escrowOf(bytes32 pool) external view returns (address);
}

interface ISeatFactoryV5 {
    struct SeatConfig {
        uint16 holderBpsQuote;
        uint16 holderBpsToken;
        uint16 buybackBps;
        bool burnBought;
        address devBuyTo;
        address[] payees;
        uint16[] bps;
    }

    function predict(address deployer, SeatConfig calldata c, bytes32 salt) external view returns (address);
    function launchChecked(
        IEscrowFactoryV5.LaunchParams calldata p,
        SeatConfig calldata c,
        bytes32 seatSalt,
        address builder,
        address expectedRuleSet,
        int24 expectedStartTick
    ) external returns (address token, bytes32 poolId, address seat, address escrow);
    function launchpad() external view returns (address);
    function escrowFactory() external view returns (address);
}
