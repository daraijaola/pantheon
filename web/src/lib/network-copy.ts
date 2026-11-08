import { network } from "./chain/deployments";

export const networkLabel = network.testnet ? "Elysium testnet" : network.name;
export const networkText = (testnet: string, mainnet: string) => network.testnet ? testnet : mainnet;
