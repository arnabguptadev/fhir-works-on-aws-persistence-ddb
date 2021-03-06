/*
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *  SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable class-methods-use-this */
import DynamoDB from 'aws-sdk/clients/dynamodb';
import {
    BatchRequest,
    TransactionRequest,
    BundleResponse,
    BatchReadWriteRequest,
    BatchReadWriteResponse,
    BatchReadWriteErrorType,
    Bundle,
    chunkArray,
    ResourceNotFoundError,
} from 'fhir-works-on-aws-interface';
import DOCUMENT_STATUS from './documentStatus';
import DynamoDbBundleServiceHelper, { ItemRequest } from './dynamoDbBundleServiceHelper';
import DynamoDbParamBuilder from './dynamoDbParamBuilder';

import DynamoDbHelper from './dynamoDbHelper';

export class DynamoDbBundleService implements Bundle {
    private readonly MAX_TRANSACTION_SIZE: number = 25;

    private readonly ELAPSED_TIME_WARNING_MESSAGE =
        'Transaction time is greater than max allowed code execution time. Please reduce your bundle size by sending fewer Bundle entries.';

    private dynamoDbHelper: DynamoDbHelper;

    private dynamoDb: DynamoDB;

    private maxExecutionTimeMs: number;

    private static readonly dynamoDbMaxBatchSize = 25;

    // Allow Mocking DDB
    constructor(dynamoDb: DynamoDB, maxExecutionTimeMs?: number) {
        this.dynamoDbHelper = new DynamoDbHelper(dynamoDb);
        this.dynamoDb = dynamoDb;
        this.maxExecutionTimeMs = maxExecutionTimeMs || 26 * 1000;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async batch(request: BatchRequest): Promise<BundleResponse> {
        throw new Error('Batch operation is not supported.');
    }

    async transaction(request: TransactionRequest): Promise<BundleResponse> {
        const { requests, startTime } = request;
        if (requests.length === 0) {
            return {
                success: true,
                message: 'No requests to process',
                batchReadWriteResponses: [],
            };
        }

        // 1. Put a lock on all requests
        const lockItemsResponse = await this.lockItems(requests);
        const { successfulLock } = lockItemsResponse;
        let { lockedItems } = lockItemsResponse;

        let elapsedTimeInMs = this.getElapsedTime(startTime);
        if (elapsedTimeInMs > this.maxExecutionTimeMs || !successfulLock) {
            await this.unlockItems(lockedItems, true);
            if (elapsedTimeInMs > this.maxExecutionTimeMs) {
                console.log(
                    'Locks were rolled back because elapsed time is longer than max code execution time. Elapsed time',
                    elapsedTimeInMs,
                );
                return {
                    success: false,
                    message: this.ELAPSED_TIME_WARNING_MESSAGE,
                    batchReadWriteResponses: [],
                    errorType: 'USER_ERROR',
                };
            }
            console.log('Locks were rolled back because failed to lock resources');
            const { errorType, errorMessage } = lockItemsResponse;
            return {
                success: false,
                message: errorMessage || 'Failed to lock resources for transaction',
                batchReadWriteResponses: [],
                errorType,
            };
        }

        // 2.  Stage resources
        const stageItemResponse = await this.stageItems(requests, lockedItems);
        const { batchReadWriteResponses } = stageItemResponse;
        const successfullyStageItems = stageItemResponse.success;
        lockedItems = stageItemResponse.lockedItems;

        elapsedTimeInMs = this.getElapsedTime(startTime);
        if (elapsedTimeInMs > this.maxExecutionTimeMs || !successfullyStageItems) {
            lockedItems = await this.rollbackItems(batchReadWriteResponses, lockedItems);
            await this.unlockItems(lockedItems, true);

            if (elapsedTimeInMs > this.maxExecutionTimeMs) {
                console.log(
                    'Rolled changes back because elapsed time is longer than max code execution time. Elapsed time',
                    elapsedTimeInMs,
                );
                return {
                    success: false,
                    message: this.ELAPSED_TIME_WARNING_MESSAGE,
                    batchReadWriteResponses: [],
                    errorType: 'USER_ERROR',
                };
            }
            console.log('Rolled changes back because staging of items failed');
            return {
                success: false,
                message: 'Failed to stage resources for transaction',
                batchReadWriteResponses: [],
                errorType: 'SYSTEM_ERROR',
            };
        }

        // 3. unlockItems
        await this.unlockItems(lockedItems, false);

        return {
            success: true,
            message: 'Successfully committed requests to DB',
            batchReadWriteResponses,
        };
    }

    private async lockItems(
        requests: BatchReadWriteRequest[],
    ): Promise<{
        successfulLock: boolean;
        errorType?: BatchReadWriteErrorType;
        errorMessage?: string;
        lockedItems: ItemRequest[];
    }> {
        // We don't need to put a lock on CREATE requests because there are no Documents in the DB for the CREATE
        // request yet
        const allNonCreateRequests = requests.filter(request => {
            return request.operation !== 'create';
        });

        const itemsToLock: ItemRequest[] = allNonCreateRequests.map(request => {
            return {
                resourceType: request.resourceType,
                id: request.id,
                operation: request.operation,
            };
        });

        if (itemsToLock.length > DynamoDbBundleService.dynamoDbMaxBatchSize) {
            const message = `Cannot lock more than ${DynamoDbBundleService.dynamoDbMaxBatchSize} items`;
            console.error(message);
            return Promise.resolve({
                successfulLock: false,
                errorType: 'SYSTEM_ERROR',
                errorMessage: message,
                lockedItems: [],
            });
        }

        console.log('Locking begins');
        const lockedItems: ItemRequest[] = [];

        // We need to read the items so we can find the versionId of each item
        const itemReadPromises = itemsToLock.map(async itemToLock => {
            const projectionExpression = 'id, resourceType, meta';
            try {
                return await this.dynamoDbHelper.getMostRecentResource(
                    itemToLock.resourceType,
                    itemToLock.id,
                    projectionExpression,
                );
            } catch (e) {
                if (e instanceof ResourceNotFoundError) {
                    return e;
                }
                throw e;
            }
        });
        const itemResponses = await Promise.all(itemReadPromises);

        const idItemsFailedToRead: string[] = [];
        for (let i = 0; i < itemResponses.length; i += 1) {
            const itemResponse = itemResponses[i];
            if (itemResponse instanceof ResourceNotFoundError) {
                idItemsFailedToRead.push(`${itemsToLock[i].resourceType}/${itemsToLock[i].id}`);
            }
        }
        if (idItemsFailedToRead.length > 0) {
            return Promise.resolve({
                successfulLock: false,
                errorType: 'USER_ERROR',
                errorMessage: `Failed to find resources: ${idItemsFailedToRead}`,
                lockedItems: [],
            });
        }

        const addLockRequests = [];
        for (let i = 0; i < itemResponses.length; i += 1) {
            const itemResponse = itemResponses[i];
            if (itemResponse instanceof ResourceNotFoundError) {
                // eslint-disable-next-line no-continue
                continue;
            }
            const { resourceType, id, meta } = itemResponse.resource;

            const lockedItem: ItemRequest = {
                resourceType,
                id,
                vid: meta.versionId,
                operation: allNonCreateRequests[i].operation,
            };
            if (lockedItem.operation === 'update') {
                lockedItem.isOriginalUpdateItem = true;
            }
            lockedItems.push(lockedItem);

            addLockRequests.push(
                DynamoDbParamBuilder.buildUpdateDocumentStatusParam(
                    DOCUMENT_STATUS.AVAILABLE,
                    DOCUMENT_STATUS.LOCKED,
                    id,
                    meta.versionId,
                ),
            );
        }

        const params = {
            TransactItems: addLockRequests,
        };

        let itemsLockedSuccessfully: ItemRequest[] = [];
        try {
            if (params.TransactItems.length > 0) {
                await this.dynamoDb.transactWriteItems(params).promise();
                itemsLockedSuccessfully = itemsLockedSuccessfully.concat(lockedItems);
            }
            console.log('Finished locking');
            return Promise.resolve({
                successfulLock: true,
                lockedItems: itemsLockedSuccessfully,
            });
        } catch (e) {
            console.error('Failed to lock', e);
            return Promise.resolve({
                successfulLock: false,
                errorType: 'SYSTEM_ERROR',
                errorMessage: `Failed to lock resources for transaction. Please try again after ${DynamoDbParamBuilder.LOCK_DURATION_IN_MS /
                    1000} seconds.`,
                lockedItems: itemsLockedSuccessfully,
            });
        }
    }

    /*
     * Change documentStatus for resources from LOCKED/PENDING to AVAILABLE
     * Change documentStatus for resources from PENDING_DELETE TO DELETED
     * Also change documentStatus for old resource to be DELETED
     *   After a resource has been updated, the original versioned resource should be marked as DELETED
     *   Exp. abcd_1 was updated, and we now have abcd_1 and abcd_2. abcd_1's documentStatus should be DELETED, and abcd_2's documentStatus should be AVAILABLE
     * If rollback === true, rollback PENDING_DELETE to AVAILABLE
     */
    private async unlockItems(
        lockedItems: ItemRequest[],
        rollBack: boolean,
    ): Promise<{ successfulUnlock: boolean; locksFailedToRelease: ItemRequest[] }> {
        if (lockedItems.length === 0) {
            return { successfulUnlock: true, locksFailedToRelease: [] };
        }
        console.log('Unlocking begins');

        const updateRequests: any[] = lockedItems.map(lockedItem => {
            let newStatus = DOCUMENT_STATUS.AVAILABLE;
            // If the lockedItem was a result of a delete operation or if the lockedItem was the original version of an item that was UPDATED then
            // set the lockedItem's status to be "DELETED"
            if (
                (lockedItem.operation === 'delete' ||
                    (lockedItem.operation === 'update' && lockedItem.isOriginalUpdateItem)) &&
                !rollBack
            ) {
                newStatus = DOCUMENT_STATUS.DELETED;
            }
            return DynamoDbParamBuilder.buildUpdateDocumentStatusParam(
                null,
                newStatus,
                lockedItem.id,
                lockedItem.vid || '0',
            );
        });

        const updateRequestChunks = chunkArray(updateRequests, this.MAX_TRANSACTION_SIZE);
        const lockedItemChunks = chunkArray(lockedItems, this.MAX_TRANSACTION_SIZE);
        const params = updateRequestChunks.map(requestChunk => {
            return {
                TransactItems: requestChunk,
            };
        });

        for (let i = 0; i < params.length; i += 1) {
            try {
                // eslint-disable-next-line no-await-in-loop
                await this.dynamoDb.transactWriteItems(params[i]).promise();
            } catch (e) {
                console.error('Failed to unlock items', e);
                let locksFailedToRelease: ItemRequest[] = [];
                for (let j = i; j < lockedItemChunks.length; j += 1) {
                    locksFailedToRelease = locksFailedToRelease.concat(lockedItemChunks[j]);
                }
                return Promise.resolve({ successfulUnlock: false, locksFailedToRelease });
            }
        }
        console.log('Finished unlocking');
        return Promise.resolve({ successfulUnlock: true, locksFailedToRelease: [] });
    }

    private async rollbackItems(
        batchReadWriteEntryResponses: BatchReadWriteResponse[],
        lockedItems: ItemRequest[],
    ): Promise<ItemRequest[]> {
        console.log('Starting unstage items');

        const { transactionRequests, itemsToRemoveFromLock } = DynamoDbBundleServiceHelper.generateRollbackRequests(
            batchReadWriteEntryResponses,
        );

        const newLockedItems = this.removeLocksFromArray(lockedItems, itemsToRemoveFromLock);

        try {
            const params = {
                TransactItems: transactionRequests,
            };
            await this.dynamoDb.transactWriteItems(params).promise();
            return newLockedItems;
        } catch (e) {
            console.error('Failed to unstage items', e);
            return newLockedItems;
        }
    }

    private generateFullId(id: string, vid: string) {
        return `${id}_${vid}`;
    }

    private removeLocksFromArray(
        originalLocks: ItemRequest[],
        locksToRemove: { id: string; vid: string; resourceType: string }[],
    ) {
        const fullIdToLockedItem: Record<string, ItemRequest> = {};
        originalLocks.forEach(lockedItem => {
            fullIdToLockedItem[this.generateFullId(lockedItem.id, lockedItem.vid || '0')] = lockedItem;
        });

        locksToRemove.forEach(itemToRemove => {
            const fullId = this.generateFullId(itemToRemove.id, itemToRemove.vid);
            if (fullIdToLockedItem[fullId]) {
                delete fullIdToLockedItem[fullId];
            }
        });

        return Object.values(fullIdToLockedItem);
    }

    private async stageItems(requests: BatchReadWriteRequest[], lockedItems: ItemRequest[]) {
        console.log('Start Staging of Items');

        const idToVersionId: Record<string, string> = {};
        lockedItems.forEach((idItemLocked: ItemRequest) => {
            idToVersionId[idItemLocked.id] = idItemLocked.vid || '0';
        });

        const {
            deleteRequests,
            createRequests,
            updateRequests,
            readRequests,
            newLocks,
            newStagingResponses,
        } = DynamoDbBundleServiceHelper.generateStagingRequests(requests, idToVersionId);

        // Order that Bundle specifies
        // https://www.hl7.org/fhir/http.html#trules
        const editRequests: any[] = [...deleteRequests, ...createRequests, ...updateRequests];
        const writeParams =
            editRequests.length > 0
                ? {
                      TransactItems: editRequests,
                  }
                : null;

        const readParams =
            readRequests.length > 0
                ? {
                      TransactItems: readRequests,
                  }
                : null;

        let batchReadWriteResponses: BatchReadWriteResponse[] = [];
        let allLockedItems: ItemRequest[] = lockedItems;
        try {
            if (writeParams) {
                await this.dynamoDb.transactWriteItems(writeParams).promise();
            }

            // Keep track of items successfully staged
            allLockedItems = lockedItems.concat(newLocks);
            batchReadWriteResponses = batchReadWriteResponses.concat(newStagingResponses);

            if (readParams) {
                const readResult = await this.dynamoDb.transactGetItems(readParams).promise();
                batchReadWriteResponses = DynamoDbBundleServiceHelper.populateBundleEntryResponseWithReadResult(
                    batchReadWriteResponses,
                    readResult,
                );
            }

            console.log('Successfully staged items');
            return Promise.resolve({ success: true, batchReadWriteResponses, lockedItems: allLockedItems });
        } catch (e) {
            console.error('Failed to stage items', e);
            return Promise.resolve({ success: false, batchReadWriteResponses, lockedItems: allLockedItems });
        }
    }

    private getElapsedTime(startTime: Date) {
        return Date.now() - startTime.getTime();
    }
}
