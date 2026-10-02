/**
 * Deploy EthFlow Contract
 *
 * EthFlow allows users to place CoW Protocol orders with native ETH.
 * The contract wraps ETH into WETH and creates the order atomically.
 */

import { execSync } from 'child_process';
import { DeploymentConfig } from './types';
import { printSection } from './utils';
import { logger, indent } from './logger';

// Must match ETHFLOW_CONTRACTS in offline-mode/.env so the driver/autopilot index orders from this address.
const ETHFLOW_ADDRESS = process.env.ETHFLOW_CONTRACTS || '0x04501b9b1d52e67f6862d157e00d13419d2d6e95';
// Source of EthFlow bytecode — the canonical mainnet deployment.
const ETHFLOW_MAINNET_ADDRESS = '0xD02De8Da0B71E1B59489794F423FaBBa2AdC4d93';
const MAINNET_RPC = 'https://eth.llamarpc.com';

export async function deployEthFlow(config: DeploymentConfig): Promise<string> {
  printSection('STEP 12: Deploying EthFlow Contract');

  logger.debug('EthFlow allows native ETH swaps by wrapping to WETH atomically');

  // Fetch EthFlow bytecode from the canonical mainnet deployment
  logger.debug(indent(`Fetching EthFlow bytecode from mainnet (${ETHFLOW_MAINNET_ADDRESS})...`));
  const bytecode = execSync(
    `cast code ${ETHFLOW_MAINNET_ADDRESS} --rpc-url ${MAINNET_RPC}`,
    { encoding: 'utf8' }
  ).trim();

  if (!bytecode || bytecode === '0x') {
    throw new Error('Failed to fetch EthFlow bytecode from mainnet');
  }

  logger.trace(indent(`Bytecode length: ${bytecode.length} characters`, 2));

  // Deploy bytecode at the same address on local chain
  logger.debug(indent(`Deploying EthFlow at ${ETHFLOW_ADDRESS}...`));
  execSync(
    `cast rpc anvil_setCode ${ETHFLOW_ADDRESS} ${bytecode} --rpc-url ${config.rpcUrl}`,
    { stdio: 'inherit' }
  );

  // Verify deployment
  const deployedBytecode = execSync(
    `cast code ${ETHFLOW_ADDRESS} --rpc-url ${config.rpcUrl}`,
    { encoding: 'utf8' }
  ).trim();

  if (deployedBytecode === bytecode) {
    logger.info(indent(`✅ EthFlow deployed successfully at ${ETHFLOW_ADDRESS}`));
  } else {
    throw new Error('EthFlow bytecode verification failed');
  }

  // Fund EthFlow with ETH for gas fees
  logger.debug(indent('Funding EthFlow with ETH for gas fees...'));
  execSync(
    `cast send ${ETHFLOW_ADDRESS} --value 1ether --private-key ${config.deployerPrivateKey} --rpc-url ${config.rpcUrl}`,
    { stdio: 'inherit' }
  );
  logger.info(indent('✅ EthFlow funded with 1 ETH for gas'));

  // Get VaultRelayer and WETH addresses from environment
  const VAULT_RELAYER = process.env.VAULT_RELAYER_ADDRESS || '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110';
  const WETH_ADDRESS = process.env.WETH_ADDRESS || '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

  // Impersonate EthFlow to approve VaultRelayer
  logger.debug(indent('Setting up WETH approval for VaultRelayer...'));
  execSync(
    `cast rpc anvil_impersonateAccount ${ETHFLOW_ADDRESS} --rpc-url ${config.rpcUrl}`,
    { encoding: 'utf8' }
  );

  // Approve VaultRelayer to spend WETH (max uint256 for unlimited approval)
  execSync(
    `cast send ${WETH_ADDRESS} "approve(address,uint256)" ${VAULT_RELAYER} 115792089237316195423570985008687907853269984665640564039457584007913129639935 --from ${ETHFLOW_ADDRESS} --rpc-url ${config.rpcUrl} --unlocked`,
    { stdio: 'inherit' }
  );

  // Stop impersonating
  execSync(
    `cast rpc anvil_stopImpersonatingAccount ${ETHFLOW_ADDRESS} --rpc-url ${config.rpcUrl}`,
    { encoding: 'utf8' }
  );

  logger.info(indent('✅ VaultRelayer approved to spend WETH from EthFlow'));
  logger.info('EthFlow contract deployed and initialized successfully');
  logger.info('Users can now swap native ETH directly through the frontend');

  return ETHFLOW_ADDRESS;
}

// If run directly
if (require.main === module) {
  const config: DeploymentConfig = {
    rpcUrl: process.env.RPC_URL || 'http://localhost:8545',
    deployerPrivateKey: process.env.DEPLOYER_PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    chainId: 1,
  };

  deployEthFlow(config)
    .then((address) => {
      logger.info(`EthFlow deployment complete at ${address}`);
      process.exit(0);
    })
    .catch(error => {
      logger.error({ error }, 'EthFlow deployment failed');
      process.exit(1);
    });
}
