import { assert } from 'console';
import { IDexHelper } from '../../dex-helper';
import { Logger } from '../../types';
import { getLogger } from '../log4js';
import { MultiResult } from '../multi-wrapper';
import { IStatefulRpcPoller } from './types';

export class StatePollingManager {
  private static __instances: Record<string, StatePollingManager> = {};

  static getInstance(dexHelper: IDexHelper): StatePollingManager {
    const network = dexHelper.config.data.network;
    if (StatePollingManager.__instances[network] === undefined) {
      StatePollingManager.__instances[network] = new StatePollingManager(
        dexHelper,
      );
    }
    return StatePollingManager.__instances[network];
  }

  private logger: Logger;

  // ALl registered instances from identifier to instance
  private _poolsToInstances: Record<string, IStatefulRpcPoller<any, any>> = {};

  // This pools will be updated if we see new block and the time has come
  private _poolsToBeUpdated: Set<string> = new Set();

  // This pools wont be updated before we change _isStateToBeUpdated to true
  private _idlePools: Set<string> = new Set();

  private constructor(protected dexHelper: IDexHelper) {
    this.logger = getLogger(
      `${this.constructor.name}-${dexHelper.config.data.network}`,
    );

    if (this.isMaster) {
    }
  }

  get isMaster() {
    return !this.dexHelper.config.isSlave;
  }

  enableStateTracking(identifierKey: string) {
    assert(
      this._poolsToInstances[identifierKey] !== undefined,
      `enableTracking: pool with identifierKey=${identifierKey} is not initialized`,
    );
    this._poolsToBeUpdated.add(identifierKey);
    this._idlePools.delete(identifierKey);
  }

  disableStateTracking(identifierKey: string) {
    assert(
      this._poolsToInstances[identifierKey] !== undefined,
      `disableStateTracking: pool with identifierKey=${identifierKey} is not initialized`,
    );
    this._poolsToBeUpdated.delete(identifierKey);
    this._idlePools.add(identifierKey);
  }

  async onBlockNumber(blockNumber: number): Promise<void> {
    if (!this.isMaster) {
      return;
    }

    const poolsToBeUpdated: IStatefulRpcPoller<any, any>[] = [];

    Array.from(this._poolsToBeUpdated).forEach(p => {
      const pool = this._keyToPoolInstance(p);

      // We always expect pools in _poolsToBeUpdated to participate in updates
      assert(
        pool.isPoolParticipateInUpdates,
        `onBlockNumber: pool=${p} from ${pool.dexKey} is not participate in updates`,
      );

      if (
        !pool.isPoolInTheMiddleOfUpdate &&
        pool.isTimeToTriggerUpdate(blockNumber)
      ) {
        pool.isPoolInTheMiddleOfUpdate = true;
        poolsToBeUpdated.push(pool);
      }
    });

    if (poolsToBeUpdated.length === 0) {
      this.logger.debug(
        `onBlockNumber=${blockNumber} no pools to be updated. Skipping`,
      );
      return;
    }

    this._updatePoolStates(poolsToBeUpdated)
      .then(receivedBlockNumber => {
        // There is no guarantee that we receive latest state. This is our best effort
        if (receivedBlockNumber < blockNumber) {
          this.logger.warn(
            `onBlockNumber=${blockNumber} at least for some pools receivedBlockNumber=${receivedBlockNumber} is lower than expected`,
          );
        }
      })
      .catch(e =>
        this.logger.error(
          `onBlockNumber=${blockNumber} error while updating pools: ${e}`,
        ),
      )
      .finally(() => {
        poolsToBeUpdated.forEach(pool => {
          pool.isPoolInTheMiddleOfUpdate = false;
        });
      });
  }

  protected async _updatePoolStates(
    poolsToBeUpdated: IStatefulRpcPoller<any, any>[],
    blockNumber: number | 'latest' = 'latest',
    numberOfChunks?: number,
  ): Promise<number> {
    const indexDividers: number[] = [];

    const multiCalls = poolsToBeUpdated
      .map((p, i) => {
        const callData = p.getFetchStateWithBlockInfoMultiCalls();
        indexDividers.push(callData.length);
        return callData;
      })
      .flat();

    assert(
      indexDividers.length === poolsToBeUpdated.length,
      'indexDividers.length === poolsToBeUpdated.length',
    );

    const results = (await this.dexHelper.multiWrapper.tryAggregate(
      false,
      multiCalls,
      blockNumber,
      numberOfChunks,
    )) as [MultiResult<number>, ...MultiResult<any>[]];

    let minBlockNumber = 0;
    const lastUpdatedAtMs = Date.now();

    // Let's pack each result into relevant pools
    const unFlattenedResults: [MultiResult<number>, ...MultiResult<any>[]][] =
      [];

    let accumulatedStart = 0;
    indexDividers.forEach(divider => {
      unFlattenedResults.push(
        results.slice(accumulatedStart, accumulatedStart + divider) as [
          MultiResult<number>,
          ...MultiResult<any>[],
        ],
      );
      accumulatedStart += divider;
    });

    assert(
      unFlattenedResults.length === poolsToBeUpdated.length,
      'unFlattenedResults.length === poolsToBeUpdated.length',
    );

    await Promise.all(
      unFlattenedResults.map(async (result, index) => {
        const pool = poolsToBeUpdated[index];
        try {
          const parsedStateResult =
            pool.parseStateFromMultiResultsWithBlockInfo(
              result,
              lastUpdatedAtMs,
            );

          minBlockNumber = Math.min(
            parsedStateResult.blockNumber,
            minBlockNumber,
          );

          await pool.setState(
            parsedStateResult.value,
            parsedStateResult.blockNumber,
            parsedStateResult.lastUpdatedAtMs,
          );
        } catch (e) {
          this.logger.error(
            `onBlockNumber=${blockNumber} error while parsing state from multicall for pool=${pool.identifierKey} from ${pool.dexKey}: ${e}`,
          );
        }
      }),
    );

    return minBlockNumber;
  }

  // When this method is called, we expect that all pools are initialized
  private _keyToPoolInstance(
    identifierKey: string,
  ): IStatefulRpcPoller<any, any> {
    const pool = this._poolsToInstances[identifierKey];
    assert(
      pool !== undefined,
      `keyToPoolInstance: pool=${identifierKey} is undefined`,
    );
    return pool;
  }

  initializePool<T, M>(statefulRpcPoller: IStatefulRpcPoller<T, M>) {
    const { identifierKey } = statefulRpcPoller;

    if (
      this._idlePools.has(identifierKey) ||
      this._poolsToBeUpdated.has(identifierKey) ||
      this._poolsToInstances.hasOwnProperty(identifierKey)
    ) {
      this.logger.warn(
        `Attempt to reinitialize existing poolIdentifier=` +
          `${identifierKey}. Maybe there is memory leak`,
      );
    } else {
      this._poolsToInstances[identifierKey] = statefulRpcPoller;
      statefulRpcPoller.isPoolParticipateInUpdates
        ? this._poolsToBeUpdated.add(identifierKey)
        : this._idlePools.add(identifierKey);

      const currentBlockNumber =
        this.dexHelper.blockManager.getActiveChainHead()?.number;

      assert(
        currentBlockNumber !== undefined,
        'currentBlockNumber !== undefined',
      );

      // All errors are caught inside fetchLatestStateFromRpc
      statefulRpcPoller.fetchLatestStateFromRpc().then(state => {
        if (state === null) {
          // I don't expect this to happen. Only if RPC is not working. In that case state will be updated when first
          // RPC request happens
          this.logger.error(
            `initializePool: pool=${identifierKey} from ${statefulRpcPoller.dexKey} state is not initialized`,
          );
        } else {
          statefulRpcPoller.setState(
            state.value,
            state.blockNumber,
            state.lastUpdatedAtMs,
          );
        }
      });
    }
  }
}
