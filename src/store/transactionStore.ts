import { ContractTransaction, ethers, BigNumberish } from 'ethers';
import { action, observable } from 'mobx';
import { LINKS_CONFIG, RESTRICTED_TOKENS } from 'src/config';
import BigNumber from 'bignumber.js';
import { Wallet, Provider, types as SyncTypes } from 'zksync';

export class TransactionStore {
  @observable recepientAddress = '';
  @observable amountShowedValue = '';
  @observable amountValue = 0;
  @observable amountBigValue: ethers.BigNumberish = 0;
  @observable pureAmountInputValue = '';
  @observable changePubKeyFee = 0;
  @observable changePubKeyFees: any = {};
  @observable conditionError = '';
  @observable gas: ethers.BigNumberish = 0;
  @observable fee: any = {};
  @observable isTransactionExecuted = false;
  @observable transferFeeToken = '';
  @observable feeTokenSelection = false;
  @observable filteredContacts: any = [];
  @observable isBalancesListOpen = false;
  @observable isContactsListOpen = false;
  @observable symbolName = '';
  @observable tokenAddress = '';
  @observable transactionHash: string | ContractTransaction | undefined = '';
  @observable fastFee: ethers.BigNumberish = 0;
  @observable maxValue = 0;
  @observable isLoading = false;
  @observable fastWithdrawal = false;
  @observable withdrawalProcessingTime = 0;
  @observable fastWithdrawalProcessingTime = 0;
  @observable withCloseMintModal = true;
  @observable tokenInUnlockingProgress: string[] = [];
  @observable propsMaxValue: any;
  @observable propsSymbolName: any;
  @observable propsToken: any;
  @observable waitingCalculation = false;

  /**
   * Setting up the token filter
   * @param {string} symbol
   * @param {string} defaultSymbol
   * @return {string}
   */
  @action
  setTransferFeeToken(symbol: string, defaultSymbol = '') {
    symbol = symbol ? symbol : this.symbolName;
    return (this.transferFeeToken = RESTRICTED_TOKENS?.includes(symbol)
      ? defaultSymbol
      : symbol);
  }

  /**
   * Get fee token or replace it with symbolName if empty
   * @return {string}
   */
  @action
  getFeeToken() {
    if (!this.transferFeeToken) {
      this.setTransferFeeToken(this.symbolName);
    }
    return this.transferFeeToken;
  }

  /**
   * @return {any}
   */
  @action
  getFeeBasedOnType() {
    return this.fastWithdrawal ? this.fastFee : this.fee[this.getFeeToken()];
  }

  /**
   * Get gas amount needed for the transaction
   * @return {Promise<unknown>}
   */
  @action
  getGas() {
    return new Promise((resolve, reject) => {
      if (!this.gas) {
        ethers
          .getDefaultProvider(LINKS_CONFIG.network)
          .getGasPrice()
          .then(res => {
            this.gas = ethers.BigNumber.from(res.toString());
            resolve(this.gas);
          })
          .catch(error => {
            reject(error.message);
          });
      } else {
        resolve(this.gas);
      }
    });
  }
}

/*

These classes are private in zksync.js and we've got no choice,
but to copy-paste them

*/

class ZKSyncTxError extends Error {
  constructor(
    message: string,
    public value:
      | SyncTypes.PriorityOperationReceipt
      | SyncTypes.TransactionReceipt,
  ) {
    super(message);
  }
}

class Transaction {
  state: 'Sent' | 'Committed' | 'Verified' | 'Failed';
  error?: ZKSyncTxError;

  constructor(
    public txData: any,
    public txHash: string,
    public sidechainProvider: Provider,
  ) {
    this.state = 'Sent';
  }

  async awaitReceipt(): Promise<SyncTypes.TransactionReceipt> {
    this.throwErrorIfFailedState();

    // Got absolutely no idea how it compiled in zksync.js
    /* @ts-ignore */
    if (this.state !== 'Sent') return;

    const receipt = await this.sidechainProvider.notifyTransaction(
      this.txHash,
      'COMMIT',
    );

    if (!receipt.success) {
      this.setErrorState(
        new ZKSyncTxError(
          `zkSync transaction failed: ${receipt.failReason}`,
          receipt,
        ),
      );
      this.throwErrorIfFailedState();
    }

    this.state = 'Committed';
    return receipt;
  }

  async awaitVerifyReceipt(): Promise<SyncTypes.TransactionReceipt> {
    await this.awaitReceipt();
    const receipt = await this.sidechainProvider.notifyTransaction(
      this.txHash,
      'VERIFY',
    );

    this.state = 'Verified';
    return receipt;
  }

  private setErrorState(error: ZKSyncTxError) {
    this.state = 'Failed';
    this.error = error;
  }

  private throwErrorIfFailedState() {
    if (this.state === 'Failed') throw this.error;
  }
}

async function setRequiredAccountIdFromServer(
  wallet: Wallet,
  actionName: string,
) {
  if (wallet.accountId === undefined) {
    const accountIdFromServer = await wallet.getAccountId();
    if (accountIdFromServer == null) {
      throw new Error(
        `Failed to ${actionName}: Account does not exist in the zkSync network`,
      );
    } else {
      wallet.accountId = accountIdFromServer;
    }
  }
}

export async function syncMultiTransferWithdrawal(
  wallet: Wallet,
  withdrawals: {
    ethAddress: string;
    token: string;
    amount: BigNumberish;
    fee: BigNumberish;
    nonce?: number | 'committed';
  }[],
  transfers: {
    to: string;
    token: string;
    amount: BigNumberish;
    fee: BigNumberish;
    nonce?: number | 'committed';
  }[],
): Promise<Transaction[]> {
  if (!wallet.signer) {
    throw new Error(
      'ZKSync signer is required for sending zksync transactions.',
    );
  }

  if (transfers.length == 0) return [];

  await setRequiredAccountIdFromServer(wallet, 'Transfer funds');

  const signedTransactions: any[] = [];

  let nextNonce =
    transfers[0].nonce != null
      ? await wallet.getNonce(transfers[0].nonce)
      : await wallet.getNonce();

  for (let i = 0; i < withdrawals.length; i++) {
    const withdrawal = withdrawals[i];
    const nonce = nextNonce;
    nextNonce += 1;

    const {
      tx,
      ethereumSignature,
    } = await wallet.signWithdrawFromSyncToEthereum({
      ...withdrawal,
      nonce,
    });

    signedTransactions.push({ tx, signature: ethereumSignature });
  }

  for (let i = 0; i < transfers.length; i++) {
    const transfer = transfers[i];
    const nonce = nextNonce;
    nextNonce += 1;

    const { tx, ethereumSignature } = await wallet.signSyncTransfer({
      ...transfer,
      nonce,
    });

    signedTransactions.push({ tx, signature: ethereumSignature });
  }

  const transactionHashes = await wallet.provider.submitTxsBatch(
    signedTransactions,
  );
  return transactionHashes.map(
    (txHash, idx) =>
      new Transaction(signedTransactions[idx], txHash, wallet.provider),
  );
}
