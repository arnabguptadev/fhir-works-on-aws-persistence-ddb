/*
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *  SPDX-License-Identifier: Apache-2.0
 */

import uuidv4 from 'uuid/v4';
import { BatchReadWriteResponse, TypeOperation } from 'fhir-works-on-aws-interface';
import DynamoDbParamBuilder from '../src/dataServices/dynamoDbParamBuilder';

export default class GenerateRollbackRequestsFactory {
    static buildBundleEntryResponse(operation: TypeOperation, vid: string): BatchReadWriteResponse {
        let resource = {};
        if (operation === 'read') {
            resource = {
                active: true,
                resourceType: 'Patient',
                birthDate: '1995-09-24',
                meta: {
                    lastUpdated: '2020-04-10T20:41:39.912Z',
                    versionId: '1',
                },
                managingOrganization: {
                    reference: 'Organization/2.16.840.1.113883.19.5',
                    display: 'Good Health Clinic',
                },
                text: {
                    div: '<div xmlns="http://www.w3.org/1999/xhtml"><p></p></div>',
                    status: 'generated',
                },
                id: '47135b80-b721-430b-9d4b-1557edc64947',
                vid,
                name: [
                    {
                        family: 'Langard',
                        given: ['Abby'],
                    },
                ],
                gender: 'female',
            };
        }
        const id = uuidv4();
        const resourceType = 'Patient';
        const bundleEntryResponse: BatchReadWriteResponse = {
            id,
            vid,
            operation,
            lastModified: '2020-04-23T15:19:35.843Z',
            resourceType,
            resource,
        };

        return bundleEntryResponse;
    }

    static buildExpectedBundleEntryResult(bundleEntryResponse: BatchReadWriteResponse) {
        const { id, vid, resourceType, operation } = bundleEntryResponse;

        let expectedResult: any = {};
        if (operation === 'create' || operation === 'update') {
            expectedResult = {
                transactionRequests: [DynamoDbParamBuilder.buildDeleteParam(id, vid)],
                itemsToRemoveFromLock: [
                    {
                        id,
                        vid,
                        resourceType,
                    },
                ],
            };
        } else if (operation === 'read' || operation === 'delete') {
            expectedResult = { transactionRequests: [], itemsToRemoveFromLock: [] };
        }
        return expectedResult;
    }
}
