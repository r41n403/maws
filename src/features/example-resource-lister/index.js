'use strict';

/**
 * Resource Lister feature
 *
 * Lists AWS resources by type for the authenticated account/region.
 */

const { S3Client, ListBucketsCommand }                                                        = require('@aws-sdk/client-s3');
const { EC2Client, DescribeInstancesCommand, DescribeSecurityGroupsCommand, DescribeVpcsCommand } = require('@aws-sdk/client-ec2');
const { RDSClient, DescribeDBInstancesCommand }                                               = require('@aws-sdk/client-rds');
const { ACMClient, ListCertificatesCommand }                                                  = require('@aws-sdk/client-acm');
const { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand }                          = require('@aws-sdk/client-elastic-load-balancing-v2');
const { AutoScalingClient, DescribeAutoScalingGroupsCommand }                                 = require('@aws-sdk/client-auto-scaling');
const { CloudFrontClient, ListDistributionsCommand }                                          = require('@aws-sdk/client-cloudfront');
const { DynamoDBClient, ListTablesCommand, DescribeTableCommand }                             = require('@aws-sdk/client-dynamodb');
const { SNSClient, ListTopicsCommand, GetTopicAttributesCommand }                             = require('@aws-sdk/client-sns');
const { IAMClient, ListRolesCommand }                                                         = require('@aws-sdk/client-iam');
const awsAuth = require('../../main/aws-auth');

async function getCredsAndRegion() {
  const provider = awsAuth.getCredentialProvider();
  if (!provider) throw new Error('Not authenticated');
  const credentials = await provider();
  const region = awsAuth.getRegion();
  return { credentials, region };
}

module.exports = {
  id: 'resource-lister',
  name: 'Resource Lister',
  icon: '🗂',
  description: 'Browse and copy ARNs for AWS resources in the authenticated account',
  version: '3.0.0',

  handlers: {
    'resource-lister:list-s3': async () => {
      try {
        const { credentials, region } = await getCredsAndRegion();
        const client = new S3Client({ credentials, region });
        const resp = await client.send(new ListBucketsCommand({}));
        return {
          ok: true,
          resources: (resp.Buckets || []).map((b) => ({
            name: b.Name,
            arn:  `arn:aws:s3:::${b.Name}`,
            meta: b.CreationDate ? new Date(b.CreationDate).toLocaleDateString() : '—',
          })),
        };
      } catch (err) { return { ok: false, error: err.message }; }
    },

    'resource-lister:list-ec2': async () => {
      try {
        const { credentials, region } = await getCredsAndRegion();
        const accountId = awsAuth.getSession()?.accountId || '';
        const client = new EC2Client({ credentials, region });
        const resp = await client.send(new DescribeInstancesCommand({}));
        const instances = [];
        for (const r of resp.Reservations || []) {
          for (const i of r.Instances || []) {
            const nameTag = (i.Tags || []).find((t) => t.Key === 'Name');
            instances.push({
              name: nameTag?.Value || i.InstanceId,
              arn:  `arn:aws:ec2:${region}:${accountId}:instance/${i.InstanceId}`,
              meta: i.State?.Name || '—',
            });
          }
        }
        return { ok: true, resources: instances };
      } catch (err) { return { ok: false, error: err.message }; }
    },

    'resource-lister:list-rds': async () => {
      try {
        const { credentials, region } = await getCredsAndRegion();
        const client = new RDSClient({ credentials, region });
        const resp = await client.send(new DescribeDBInstancesCommand({}));
        return {
          ok: true,
          resources: (resp.DBInstances || []).map((db) => ({
            name: db.DBInstanceIdentifier,
            arn:  db.DBInstanceArn,
            meta: `${db.DBInstanceClass} · ${db.DBInstanceStatus}`,
          })),
        };
      } catch (err) { return { ok: false, error: err.message }; }
    },

    'resource-lister:list-security-groups': async () => {
      try {
        const { credentials, region } = await getCredsAndRegion();
        const accountId = awsAuth.getSession()?.accountId || '';
        const client = new EC2Client({ credentials, region });
        const resp = await client.send(new DescribeSecurityGroupsCommand({}));
        return {
          ok: true,
          resources: (resp.SecurityGroups || []).map((sg) => ({
            name: sg.GroupName,
            arn:  `arn:aws:ec2:${region}:${accountId}:security-group/${sg.GroupId}`,
            meta: sg.VpcId || 'no VPC',
          })),
        };
      } catch (err) { return { ok: false, error: err.message }; }
    },

    'resource-lister:list-vpcs': async () => {
      try {
        const { credentials, region } = await getCredsAndRegion();
        const accountId = awsAuth.getSession()?.accountId || '';
        const client = new EC2Client({ credentials, region });
        const resp = await client.send(new DescribeVpcsCommand({}));
        return {
          ok: true,
          resources: (resp.Vpcs || []).map((v) => {
            const nameTag = (v.Tags || []).find((t) => t.Key === 'Name');
            return {
              name: nameTag?.Value || v.VpcId,
              arn:  `arn:aws:ec2:${region}:${accountId}:vpc/${v.VpcId}`,
              meta: v.IsDefault ? 'default' : v.CidrBlock || '—',
            };
          }),
        };
      } catch (err) { return { ok: false, error: err.message }; }
    },

    'resource-lister:list-acm': async () => {
      try {
        const { credentials, region } = await getCredsAndRegion();
        const client = new ACMClient({ credentials, region });
        const resp = await client.send(new ListCertificatesCommand({}));
        return {
          ok: true,
          resources: (resp.CertificateSummaryList || []).map((c) => ({
            name: c.DomainName,
            arn:  c.CertificateArn,
            meta: c.Status || '—',
          })),
        };
      } catch (err) { return { ok: false, error: err.message }; }
    },

    'resource-lister:list-albs': async () => {
      try {
        const { credentials, region } = await getCredsAndRegion();
        const client = new ElasticLoadBalancingV2Client({ credentials, region });
        const resp = await client.send(new DescribeLoadBalancersCommand({}));
        return {
          ok: true,
          resources: (resp.LoadBalancers || []).map((lb) => ({
            name: lb.LoadBalancerName,
            arn:  lb.LoadBalancerArn,
            meta: `${lb.Type} · ${lb.State?.Code || '—'}`,
          })),
        };
      } catch (err) { return { ok: false, error: err.message }; }
    },

    'resource-lister:list-asg': async () => {
      try {
        const { credentials, region } = await getCredsAndRegion();
        const client = new AutoScalingClient({ credentials, region });
        const resp = await client.send(new DescribeAutoScalingGroupsCommand({}));
        return {
          ok: true,
          resources: (resp.AutoScalingGroups || []).map((g) => ({
            name: g.AutoScalingGroupName,
            arn:  g.AutoScalingGroupARN,
            meta: `${g.DesiredCapacity} desired · ${g.MinSize}–${g.MaxSize}`,
          })),
        };
      } catch (err) { return { ok: false, error: err.message }; }
    },

    'resource-lister:list-cloudfront': async () => {
      try {
        const { credentials } = await getCredsAndRegion();
        // CloudFront is a global service — always us-east-1
        const client = new CloudFrontClient({ credentials, region: 'us-east-1' });
        const resp = await client.send(new ListDistributionsCommand({}));
        const items = resp.DistributionList?.Items || [];
        return {
          ok: true,
          resources: items.map((d) => ({
            name: d.DomainName,
            arn:  d.ARN,
            meta: `${d.Status} · ${(d.Aliases?.Items || []).join(', ') || 'no alias'}`,
          })),
        };
      } catch (err) { return { ok: false, error: err.message }; }
    },

    'resource-lister:list-dynamodb': async () => {
      try {
        const { credentials, region } = await getCredsAndRegion();
        const client = new DynamoDBClient({ credentials, region });
        // ListTables only returns names; fetch ARN per table
        const listResp = await client.send(new ListTablesCommand({}));
        const tableNames = listResp.TableNames || [];
        const resources = await Promise.all(tableNames.map(async (name) => {
          try {
            const desc = await client.send(new DescribeTableCommand({ TableName: name }));
            return {
              name,
              arn:  desc.Table?.TableArn || '',
              meta: `${desc.Table?.TableStatus || '—'} · ${desc.Table?.ItemCount ?? '?'} items`,
            };
          } catch {
            return { name, arn: '', meta: '—' };
          }
        }));
        return { ok: true, resources };
      } catch (err) { return { ok: false, error: err.message }; }
    },

    'resource-lister:list-sns': async () => {
      try {
        const { credentials, region } = await getCredsAndRegion();
        const client = new SNSClient({ credentials, region });
        const resp = await client.send(new ListTopicsCommand({}));
        return {
          ok: true,
          resources: (resp.Topics || []).map((t) => {
            const parts = t.TopicArn.split(':');
            return {
              name: parts[parts.length - 1],
              arn:  t.TopicArn,
              meta: '—',
            };
          }),
        };
      } catch (err) { return { ok: false, error: err.message }; }
    },

    'resource-lister:list-iam-roles': async () => {
      try {
        const { credentials } = await getCredsAndRegion();
        // IAM is a global service
        const client = new IAMClient({ credentials, region: 'us-east-1' });
        const roles = [];
        let marker;
        do {
          const resp = await client.send(new ListRolesCommand({ Marker: marker }));
          for (const r of resp.Roles || []) {
            roles.push({
              name: r.RoleName,
              arn:  r.Arn,
              meta: r.Description || r.Path || '—',
            });
          }
          marker = resp.IsTruncated ? resp.Marker : undefined;
        } while (marker);
        return { ok: true, resources: roles };
      } catch (err) { return { ok: false, error: err.message }; }
    },
  },
};
