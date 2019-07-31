import Web3 from 'web3';
import { soliditySha3 } from 'web3-utils';
import { promisify } from 'es6-promisify';
import { Contracts } from '../lib/Contracts';
import {
  toString,
} from '../lib/Helpers';
import {
  addressToBytes32,
  hashBytes,
  hashString,
  stripHexPrefix,
  addressesAreEqual,
} from '../lib/BytesHelper';
import {
  address,
  Action,
  AssetAmount,
  Operation,
  SignedOperation,
  ContractCallOptions,
  ContractConstantCallOptions,
} from '../../src/types';
import {
  SIGNATURE_TYPES,
  EIP712_DOMAIN_STRING,
  EIP712_DOMAIN_STRUCT,
  createTypedSignature,
  ecRecoverTypedSignature,
} from '../lib/SignatureHelper';

const EIP712_OPERATION_STRUCT = [
  { type: 'Action[]', name: 'actions' },
  { type: 'uint256', name: 'expiration' },
  { type: 'uint256', name: 'salt' },
  { type: 'address', name: 'sender' },
];

const EIP712_ACTION_STRUCT = [
  { type: 'uint8', name: 'actionType' },
  { type: 'address', name: 'accountOwner' },
  { type: 'uint256', name: 'accountNumber' },
  { type: 'AssetAmount', name: 'assetAmount' },
  { type: 'uint256', name: 'primaryMarketId' },
  { type: 'uint256', name: 'secondaryMarketId' },
  { type: 'address', name: 'otherAddress' },
  { type: 'address', name: 'otherAccountOwner' },
  { type: 'uint256', name: 'otherAccountNumber' },
  { type: 'bytes', name: 'data' },
];

const EIP712_ASSET_AMOUNT_STRUCT = [
  { type: 'bool', name: 'sign' },
  { type: 'uint8', name: 'denomination' },
  { type: 'uint8', name: 'ref' },
  { type: 'uint256', name: 'value' },
];

const EIP712_ASSET_AMOUNT_STRING =
  'AssetAmount(' +
  'bool sign,' +
  'uint8 denomination,' +
  'uint8 ref,' +
  'uint256 value' +
  ')';

const EIP712_ACTION_STRING =
  'Action(' + // tslint:disable-line
  'uint8 actionType,' +
  'address accountOwner,' +
  'uint256 accountNumber,' +
  'AssetAmount assetAmount,' +
  'uint256 primaryMarketId,' +
  'uint256 secondaryMarketId,' +
  'address otherAddress,' +
  'address otherAccountOwner,' +
  'uint256 otherAccountNumber,' +
  'bytes data' +
  ')' +
  EIP712_ASSET_AMOUNT_STRING;

const EIP712_OPERATION_STRING =
  'Operation(' + // tslint:disable-line
  'Action[] actions,' +
  'uint256 expiration,' +
  'uint256 salt,' +
  'address sender' +
  ')' +
  EIP712_ACTION_STRING;

export class SignedOperations {
  private contracts: Contracts;
  private web3: Web3;
  private networkId: number;

  // ============ Constructor ============

  constructor(
    contracts: Contracts,
    web3: Web3,
    networkId: number,
  ) {
    this.contracts = contracts;
    this.web3 = web3;
    this.networkId = networkId;
  }

  // ============ On-Chain Cancel ============

  /**
   * Sends an transaction to cancel an operation on-chain.
   */
  public async cancelOperation(
    operation: Operation,
    options?: ContractCallOptions,
  ): Promise<any> {
    const operationHash = this.getOperationHash(operation);
    const cco = options || {};
    cco.from = operation.signer;
    return this.cancelOperationByHash(operationHash, cco);
  }

  /**
   * Sends an transaction to cancel an operation (by hash) on-chain.
   */
  public async cancelOperationByHash(
    operationHash: string,
    options?: ContractCallOptions,
  ): Promise<any> {
    return this.contracts.callContractFunction(
      this.contracts.signedOperationProxy.methods.cancel(operationHash),
      options,
    );
  }

  // ============ Getter Contract Methods ============

  /**
   * Returns true if the contract can process operations.
   */
  public async isOperational(
    options?: ContractConstantCallOptions,
  ): Promise<boolean> {
    return this.contracts.callConstantContractFunction(
      this.contracts.signedOperationProxy.methods.g_isOperational(),
      options,
    );
  }

  /**
   * Gets the status and the current filled amount (in makerAmount) of all given orders.
   */
  public async getOperationsAreInvalid(
    operations: Operation[],
    options?: ContractConstantCallOptions,
  ): Promise<boolean[]> {
    const inputQuery = operations.map((operation) => {
      return {
        operationHash: this.getOperationHash(operation),
        operationSigner: operation.signer,
      };
    });
    return this.contracts.callConstantContractFunction(
      this.contracts.signedOperationProxy.methods.getOperationsAreInvalid(inputQuery),
      options,
    );
  }

  // ============ Signing Methods ============

  /**
   * Sends operation to current provider for signing. Uses the 'eth_signTypedData_v3' rpc call which
   * is compatible only with Metamask.
   */
  public async ethSignTypedOperationWithMetamask(
    operation: Operation,
  ): Promise<string> {
    return this.ethSignTypedOperationInternal(
      operation,
      'eth_signTypedData_v3',
    );
  }

  /**
   * Sends operation to current provider for signing. Uses the 'eth_signTypedData' rpc call. This
   * should be used for any provider that is not Metamask.
   */
  public async ethSignTypedOperation(
    operation: Operation,
  ): Promise<string> {
    return this.ethSignTypedOperationInternal(
      operation,
      'eth_signTypedData',
    );
  }

  /**
   * Uses web3.eth.sign to sign the hash of the operation.
   */
  public async ethSignOperation(
    operation: Operation,
  ): Promise<string> {
    const hash = this.getOperationHash(operation);
    const signature = await this.web3.eth.sign(hash, operation.signer);
    return createTypedSignature(signature, SIGNATURE_TYPES.DECIMAL);
  }

  /**
   * Uses web3.eth.sign to sign a cancel message for an operation. This signature is not used
   * on-chain,but allows dYdX backend services to verify that the cancel operation api call is from
   * the original maker of the operation.
   */
  public async ethSignCancelOperation(
    operation: Operation,
  ): Promise<string> {
    return this.ethSignCancelOperationByHash(
      this.getOperationHash(operation),
      operation.signer,
    );
  }

  /**
   * Uses web3.eth.sign to sign a cancel message for an operation hash. This signature is not used
   * on-chain, but allows dYdX backend services to verify that the cancel operation api call is from
   * the original maker of the operation.
   */
  public async ethSignCancelOperationByHash(
    operationHash: string,
    signer: address,
  ): Promise<string> {
    const cancelHash = this.operationHashToCancelOperationHash(operationHash);
    const signature = await this.web3.eth.sign(cancelHash, signer);
    return createTypedSignature(signature, SIGNATURE_TYPES.DECIMAL);
  }

  // ============ Signature Verification ============

  /**
   * Returns true if the operation object has a non-null valid signature from the maker of the
   * operation.
   */
  public operationHasValidSignature(
    signedOperation: SignedOperation,
  ): boolean {
    return this.operationByHashHasValidSignature(
      this.getOperationHash(signedOperation),
      signedOperation.typedSignature,
      signedOperation.signer,
    );
  }

  /**
   * Returns true if the operation hash has a non-null valid signature from a particular signer.
   */
  public operationByHashHasValidSignature(
    operationHash: string,
    typedSignature: string,
    expectedSigner: address,
  ): boolean {
    const signer = ecRecoverTypedSignature(operationHash, typedSignature);
    return addressesAreEqual(signer, expectedSigner);
  }

  /**
   * Returns true if the cancel operation message has a valid signature.
   */
  public cancelOperationHasValidSignature(
    operation: Operation,
    typedSignature: string,
  ): boolean {
    return this.cancelOperationByHashHasValidSignature(
      this.getOperationHash(operation),
      typedSignature,
      operation.signer,
    );
  }

  /**
   * Returns true if the cancel operation message has a valid signature.
   */
  public cancelOperationByHashHasValidSignature(
    operationHash: string,
    typedSignature: string,
    expectedSigner: address,
  ): boolean {
    const cancelHash = this.operationHashToCancelOperationHash(operationHash);
    const signer = ecRecoverTypedSignature(cancelHash, typedSignature);
    return addressesAreEqual(signer, expectedSigner);
  }

  // ============ Hashing Functions ============

  /**
   * Returns the final signable EIP712 hash for approving an operation.
   */
  public getOperationHash(operation: Operation): string {
    const basicHash = soliditySha3(
      { t: 'bytes32', v: hashString(EIP712_OPERATION_STRING) },
      { t: 'bytes32', v: this.getActionsHash(operation.actions) },
      { t: 'uint256', v: toString(operation.expiration) },
      { t: 'uint256', v: toString(operation.salt) },
      { t: 'bytes32', v: addressToBytes32(operation.sender) },
    );

    const retVal = soliditySha3(
      { t: 'bytes', v: '0x1901' },
      { t: 'bytes32', v: this.getDomainHash() },
      { t: 'bytes32', v: basicHash },
    );

    return retVal;
  }

  /**
   * Returns the EIP712 domain separator hash.
   */
  public getDomainHash(): string {
    return soliditySha3(
      { t: 'bytes32', v: hashString(EIP712_DOMAIN_STRING) },
      { t: 'bytes32', v: hashString('SignedOperationProxy') },
      { t: 'bytes32', v: hashString('1.0') },
      { t: 'uint256', v: this.networkId },
      { t: 'bytes32', v: addressToBytes32(this.contracts.signedOperationProxy.options.address) },
    );
  }

  /**
   * Returns the EIP712 hash of the actions array.
   */
  public getActionsHash(
    actions: Action[],
  ): string {
    const actionsAsHashes = actions.map(
      action => ({ t: 'bytes32', v: this.getActionHash(action) }),
    );
    return soliditySha3(...actionsAsHashes);
  }

  /**
   * Returns the EIP712 hash of a single Action struct.
   */
  public getActionHash(
    action: Action,
  ): string {
    return soliditySha3(
      { t: 'bytes32', v: hashString(EIP712_ACTION_STRING) },
      { t: 'uint256', v: toString(action.actionType) },
      { t: 'bytes32', v: addressToBytes32(action.primaryAccountOwner) },
      { t: 'uint256', v: toString(action.primaryAccountNumber) },
      { t: 'bytes32', v: this.getAssetAmountHash(action.amount) },
      { t: 'uint256', v: toString(action.primaryMarketId) },
      { t: 'uint256', v: toString(action.secondaryMarketId) },
      { t: 'bytes32', v: addressToBytes32(action.otherAddress) },
      { t: 'bytes32', v: addressToBytes32(action.secondaryAccountOwner) },
      { t: 'uint256', v: toString(action.secondaryAccountNumber) },
      { t: 'bytes32', v: hashBytes(action.data) },
    );
  }

  /**
   * Returns the EIP712 hash of an AssetAmount struct.
   */
  public getAssetAmountHash(
    amount: AssetAmount,
  ): string {
    return soliditySha3(
      { t: 'bytes32', v: hashString(EIP712_ASSET_AMOUNT_STRING) },
      { t: 'uint256', v: toString(amount.sign ? 1 : 0) },
      { t: 'uint256', v: toString(amount.denomination) },
      { t: 'uint256', v: toString(amount.ref) },
      { t: 'uint256', v: toString(amount.value) },
    );
  }

  /**
   * Given some operation hash, returns the hash of a cancel-operation message.
   */
  public operationHashToCancelOperationHash(
    operationHash: string,
  ): string {
    return soliditySha3(
      { t: 'string', v: 'cancel' },
      { t: 'bytes32', v: operationHash },
    );
  }

  // ============ Private Helper Functions ============s

  private async ethSignTypedOperationInternal(
    operation: Operation,
    rpcMethod: string,
  ): Promise<string> {
    const domainData = {
      name: 'SignedOperationProxy',
      version: '1.0',
      chainId: this.networkId,
      verifyingContract: this.contracts.signedOperationProxy.options.address,
    };
    const actionsData = operation.actions.map((action) => {
      return {
        actionType: toString(action.actionType),
        accountOwner: action.primaryAccountOwner,
        accountNumber: toString(action.primaryAccountNumber),
        assetAmount: {
          sign: action.amount.sign,
          denomination: toString(action.amount.denomination),
          ref: toString(action.amount.ref),
          value: toString(action.amount.value),
        },
        primaryMarketId: toString(action.primaryMarketId),
        secondaryMarketId: toString(action.secondaryMarketId),
        otherAddress: toString(action.otherAddress),
        otherAccountOwner: action.secondaryAccountOwner,
        otherAccountNumber: toString(action.secondaryAccountNumber),
        data: action.data,
      };
    });
    const operationData = {
      actions: actionsData,
      expiration: operation.expiration.toFixed(0),
      salt: operation.salt.toFixed(0),
      sender: operation.sender,
    };
    const data = {
      types: {
        EIP712Domain: EIP712_DOMAIN_STRUCT,
        Operation: EIP712_OPERATION_STRUCT,
        Action: EIP712_ACTION_STRUCT,
        AssetAmount: EIP712_ASSET_AMOUNT_STRUCT,
      },
      domain: domainData,
      primaryType: 'Operation',
      message: operationData,
    };
    const sendAsync = promisify(this.web3.currentProvider.send).bind(this.web3.currentProvider);
    const response = await sendAsync({
      method: rpcMethod,
      params: [operation.signer, data],
      jsonrpc: '2.0',
      id: new Date().getTime(),
    });
    if (response.error) {
      throw new Error(response.error.message);
    }
    return `0x${stripHexPrefix(response.result)}0${SIGNATURE_TYPES.NO_PREPEND}`;
  }
}