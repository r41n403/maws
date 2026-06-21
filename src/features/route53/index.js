'use strict';

/**
 * Route53 feature
 *
 * Lists hosted zones and their DNS records.
 * Route53 is a global service — always uses us-east-1 regardless of session region.
 */

const {
  Route53Client,
  ListHostedZonesCommand,
  ListResourceRecordSetsCommand,
} = require('@aws-sdk/client-route-53');

const awsAuth = require('../../main/aws-auth');

async function getClient() {
  const provider = awsAuth.getCredentialProvider();
  if (!provider) throw new Error('Not authenticated');
  const credentials = await provider();
  return new Route53Client({ credentials, region: 'us-east-1' });
}

module.exports = {
  id:          'route53',
  name:        'Route53',
  icon:        '🌍',
  description: 'Browse hosted zones and DNS records',
  version:     '1.0.0',

  handlers: {
    'route53:list-zones': async () => {
      try {
        const client = await getClient();
        const zones = [];
        let marker;

        // Paginate through all zones
        do {
          const resp = await client.send(new ListHostedZonesCommand({ Marker: marker }));
          for (const z of resp.HostedZones || []) {
            zones.push({
              id:           z.Id.replace('/hostedzone/', ''),
              name:         z.Name,
              recordCount:  z.ResourceRecordSetCount,
              privateZone:  z.Config?.PrivateZone || false,
              comment:      z.Config?.Comment || '',
            });
          }
          marker = resp.NextMarker;
        } while (marker);

        return { ok: true, zones };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    'route53:list-records': async (_e, { zoneId }) => {
      try {
        const client = await getClient();
        const records = [];
        let nextName, nextType;

        // Paginate through all record sets
        do {
          const resp = await client.send(new ListResourceRecordSetsCommand({
            HostedZoneId:          zoneId,
            StartRecordName:       nextName,
            StartRecordType:       nextType,
          }));

          for (const r of resp.ResourceRecordSets || []) {
            records.push({
              name:    r.Name,
              type:    r.Type,
              ttl:     r.TTL ?? null,
              values:  r.ResourceRecords?.map((rr) => rr.Value) || [],
              alias:   r.AliasTarget?.DNSName || null,
            });
          }

          nextName = resp.NextRecordName;
          nextType = resp.NextRecordType;
        } while (nextName);

        return { ok: true, records };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  },
};
