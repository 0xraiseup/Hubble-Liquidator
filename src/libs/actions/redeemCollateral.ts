import {
  Transaction,
  PublicKey,
  Connection,
  Account,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  Token,
} from '@solana/spl-token';
import _ from 'underscore';
import BN from 'bn.js';
import { config } from 'config';
import { redeemReserveCollateralInstruction, refreshReserveInstruction } from 'models/instructions';
import { getTokenInfo, toBaseUnit } from 'libs/utils';

export async function redeemCollateral(
  connection: Connection,
  payer: Account,
  amount: string,
  symbol: string,
  lendingMarket,
) {
  // redeem all our collaterals
  const amountBase = toBaseUnit(amount, symbol);

  const reserve = _.findWhere(lendingMarket!.reserves, { asset: symbol });
  if (!reserve) {
    console.error(`Withdraw: Could not find asset ${symbol} in reserves`);
  }
  const tokenInfo = getTokenInfo(symbol);
  const oracleInfo = _.findWhere(config.oracles.assets, { asset: symbol });
  if (!oracleInfo) {
    console.error(`Withdraw: Could not find oracle for ${symbol}`);
  }

  const ixs = [] as any;

  // refreshed reserve is required
  const refreshReserveIx = refreshReserveInstruction(
    new PublicKey(reserve.address),
    new PublicKey(oracleInfo!.priceAddress),
    new PublicKey(oracleInfo!.switchboardFeedAddress),
  );
  ixs.push(refreshReserveIx);

  // Get collateral account address
  const userCollateralAccountAddress = await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    new PublicKey(reserve.collateralMintAddress),
    payer.publicKey,
  );

  // Get or create user token account
  const userTokenAccountAddress = await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    new PublicKey(tokenInfo!.mintAddress),
    payer.publicKey,
  );
  const userTokenAccountInfo = await connection.getAccountInfo(
    userTokenAccountAddress,
  );
  // If token is SOL, we don't want to create the account here because we just created it above
  if (symbol !== 'SOL' && !userTokenAccountInfo) {
    const createUserTokenAccountIx = Token.createAssociatedTokenAccountInstruction(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      new PublicKey(tokenInfo!.mintAddress),
      userTokenAccountAddress,
      payer.publicKey,
      payer.publicKey,
    );
    ixs.push(createUserTokenAccountIx);
  }
  const withdrawObligationCollateralAndRedeemReserveLiquidityIx = redeemReserveCollateralInstruction(
    new BN(amountBase),
    userCollateralAccountAddress, // source collateral account
    userTokenAccountAddress, // destinationLiquidity
    new PublicKey(reserve.address),
    new PublicKey(reserve.collateralMintAddress),
    new PublicKey(reserve.liquidityAddress),
    new PublicKey(lendingMarket.address),
    new PublicKey(lendingMarket.authorityAddress),
    payer.publicKey, // transferAuthority
  );
  ixs.push(withdrawObligationCollateralAndRedeemReserveLiquidityIx);

  const tx = new Transaction().add(...ixs);
  const { blockhash } = await connection.getRecentBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer);

  try {
    const txHash = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(txHash);
    console.log(`successfully redeemed ${symbol} collaterals`);
  } catch (err) {
    console.error('error redeeming collateral: ', err);
  }
}
