'use strict';

/**
 * Example Feature: Resource Lister
 *
 * Lists S3 buckets for the authenticated account.
 * Use this as a template for new features.
 *
 * To add a new feature:
 *   1. cp -r src/features/example-resource-lister src/features/my-new-feature
 *   2. Edit index.js (id, name, handlers)
 *   3. Edit the renderer view in src/renderer/features/my-new-feature/
 *   4. Restart the app — it auto-loads
 */

const { S3Client, ListBucketsCommand } = require('@aws-sdk/client-s3');
const awsAuth = require('../../main/aws-auth');

module.exports = {
  id: 'resource-lister',
  name: 'Resource Lister',
  icon: '🪣',
  description: 'List S3 buckets in the authenticated account',
  version: '1.0.0',

  handlers: {
    'resource-lister:list-buckets': async (_event) => {
      const provider = awsAuth.getCredentialProvider();
      if (!provider) return { ok: false, error: 'Not authenticated' };

      try {
        const credentials = await provider();
        const client = new S3Client({ credentials, region: awsAuth.getRegion() });
        const resp = await client.send(new ListBucketsCommand({}));
        return {
          ok: true,
          buckets: (resp.Buckets || []).map((b) => ({
            name: b.Name,
            created: b.CreationDate,
          })),
        };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  },
};
