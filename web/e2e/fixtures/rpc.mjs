import { decodeAbiParameters, decodeFunctionData, encodeFunctionResult, erc20Abi, erc6492SignatureValidatorByteCode, parseAbi, recoverAddress, toFunctionSelector, zeroAddress } from 'viem';
import * as contracts from '../../src/lib/chain/abi.ts';
import deployment from '../../../deployments/elysium-testnet.json' with { type: 'json' };
import { emptyWallet } from './data.mjs';

const extra = parseAbi([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])',
  'function poolManager() view returns(address)', 'function vault() view returns(address)',
  'function emaSqrtPrice(bytes32) view returns(uint160)', 'function claimed(address) view returns(bool)',
  'function amount() view returns(uint256)', 'function paused() view returns(bool)',
  'function getEthBalance(address) view returns(uint256)',
]);
const abi = [...Object.values(contracts).flat(), ...erc20Abi, ...extra].filter(x => x.type === 'function');
const functions = new Map(abi.map(item => [toFunctionSelector(item), item]));
const one = 10n ** 18n;
function empty(output) {
  if (output.type.endsWith('[]')) return [];
  if (output.type === 'tuple') return output.components.map(empty);
  if (output.type === 'address') return zeroAddress;
  if (output.type === 'bool') return false;
  if (output.type === 'string') return 'PACT';
  if (output.type.startsWith('bytes')) return `0x${'00'.repeat(Number(output.type.slice(5)) || 0)}`;
  return 0n;
}
function call(to, data, overrides) {
  const item = functions.get(data.slice(0, 10));
  if (!item) throw new Error(`Unconfigured fixture contract selector ${data.slice(0, 10)}`);
  const { functionName, args } = decodeFunctionData({ abi: [item], data });
  let result;
  if (Object.hasOwn(overrides, functionName)) result = overrides[functionName];
  else switch (functionName) {
    case 'aggregate3': result = args[0].map(c => ({ success: true, returnData: call(c.target, c.callData, overrides) })); break;
    case 'balanceOf': result = args[0].toLowerCase() === emptyWallet ? 0n : to.toLowerCase() === deployment.usdc.toLowerCase() ? 1_000n * 10n ** 6n : 10_000n * one; break;
    case 'accounts': result = [100n * one, 0n, 100n * one, 0n, 1794000000n]; break;
    case 'totalStaked': case 'totalWorking': case 'workingOf': result = 100n * one; break;
    case 'multiplierOf': result = one; break;
    case 'getEthBalance': result = 100n * one; break;
    case 'poolManager': result = '0x12E84206cB53aE0df055482ebc4658635096E1aA'; break;
    case 'vault': result = '0x0000000000000000000000000000000000000001'; break;
    case 'emaSqrtPrice': result = 2n ** 96n; break;
    case 'decimals': result = 18; break;
    default: result = item.outputs.length === 1 ? empty(item.outputs[0]) : item.outputs.map(empty);
  }
  return encodeFunctionResult({ abi: [item], functionName, result });
}
export async function rpc(request, overrides = {}) {
  const { id, method, params = [] } = request;
  try {
    let result;
    switch (method) {
      case 'eth_chainId': result = '0x185d9'; break;
      case 'net_version': result = '99801'; break;
      case 'eth_blockNumber': result = '0x989680'; break;
      case 'eth_getBalance': result = `0x${(100n * one).toString(16)}`; break;
      case 'eth_getCode': result = '0x'; break;
      case 'eth_getLogs': result = []; break;
      case 'eth_call': {
        const { to, data } = params[0];
        if (!to && data.startsWith(erc6492SignatureValidatorByteCode)) {
          const [address, hash, signature] = decodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }, { type: 'bytes' }], `0x${data.slice(erc6492SignatureValidatorByteCode.length)}`);
          result = (await recoverAddress({ hash, signature })).toLowerCase() === address.toLowerCase() ? '0x01' : '0x00';
        } else result = call(to, data, overrides);
        break;
      }
      case 'eth_estimateGas': result = '0x30d40'; break;
      case 'eth_gasPrice': case 'eth_maxPriorityFeePerGas': result = '0x3b9aca00'; break;
      case 'eth_getTransactionCount': result = '0x0'; break;
      case 'eth_getBlockByNumber': result = { number: '0x989680', timestamp: '0x6aee0000', hash: `0x${'1'.repeat(64)}`, parentHash: `0x${'0'.repeat(64)}`, gasLimit: '0x1c9c380', gasUsed: '0x0', baseFeePerGas: '0x3b9aca00', transactions: [], extraData: '0x', miner: zeroAddress, difficulty: '0x0', totalDifficulty: '0x0', nonce: '0x0000000000000000', size: '0x0', logsBloom: `0x${'0'.repeat(512)}`, receiptsRoot: `0x${'0'.repeat(64)}`, stateRoot: `0x${'0'.repeat(64)}`, transactionsRoot: `0x${'0'.repeat(64)}`, uncles: [], sha3Uncles: `0x${'0'.repeat(64)}` }; break;
      default: throw new Error(`Unconfigured fixture RPC method ${method}`);
    }
    return { jsonrpc: '2.0', id, result };
  } catch (error) {
    throw new Error(`${method}: ${error.message}`);
  }
}
